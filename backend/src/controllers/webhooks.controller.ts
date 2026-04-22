/**
 * Webhooks Controller
 * Handles incoming Hostaway webhooks per tenant.
 * Verifies signature, returns 200 immediately, processes async.
 *
 * Gap fixes: G1–G10 (see plan for details)
 */

import { Request, Response } from 'express';
import { PrismaClient, MessageRole, Channel, ReservationStatus, AlterationStatus } from '@prisma/client';
import { scheduleAiReply, cancelPendingAiReply } from '../services/debounce.service';
import { broadcastToTenant, broadcastCritical } from '../services/socket.service';
import { getReservation } from '../services/hostaway.service';
import { sendPushToTenantAll } from '../services/push.service';
import { fetchAlteration } from '../services/hostaway-alterations.service';
import { captionMessageImages } from '../services/image-caption.service';
import { compactMessageAsync } from '../services/message-compaction.service';
import { decrypt } from '../lib/encryption';
import { mapHostawayChannel } from '../lib/channel-mapper';

interface HostawayWebhookPayload {
  event: string;
  data: {
    id?: number;
    conversationId?: number;
    reservationId?: number;
    listingMapId?: number;
    isIncoming?: number;
    body?: string;
    date?: string;
    communicationType?: string;
    attachments?: Array<{ url: string; name?: string; mimeType?: string }>;
    // Reservation fields
    guestName?: string;
    guestFirstName?: string;
    guestLastName?: string;
    guestEmail?: string;
    guestPhone?: string;
    phone?: string; // some Hostaway payloads put it under `phone` instead of `guestPhone`
    arrivalDate?: string;
    departureDate?: string;
    numberOfGuests?: number;
    channelName?: string;
    channelId?: number;
    status?: string;
    [key: string]: unknown;
  };
}

const mapChannel = mapHostawayChannel;

function toHostawayCommunicationType(channel: Channel): string {
  if (channel === Channel.WHATSAPP) return 'whatsapp';
  return 'channel';
}

function mapReservationStatus(status?: string): ReservationStatus {
  // SECURITY: Default to INQUIRY (most restrictive) — never default to CONFIRMED.
  // CONFIRMED exposes door codes and WiFi to the guest. An unknown or missing status
  // must NOT grant access to sensitive information.
  if (!status) return ReservationStatus.INQUIRY;
  switch (status.toLowerCase()) {
    // Inquiry lifecycle — guest asking questions
    case 'inquiry':
    case 'inquirypreapproved':
    case 'inquirydenied':
    case 'inquirytimedout':
    case 'inquirynotpossible':
    case 'unknown':
      return ReservationStatus.INQUIRY;
    // Pending — guest requested to book, awaiting host/payment/verification
    case 'pending':          // Airbnb Request to Book
    case 'unconfirmed':      // Vrbo Request to Book
    case 'awaitingpayment':
    case 'awaitingguestverification':
      return ReservationStatus.PENDING;
    // Active booking — confirmed, blocks calendar
    case 'new':
    case 'confirmed':
    case 'accepted':
    case 'modified':         // Guest modified dates/guests on confirmed booking
      return ReservationStatus.CONFIRMED;
    case 'checkedin':
      return ReservationStatus.CHECKED_IN;
    case 'checkedout':
      return ReservationStatus.CHECKED_OUT;
    case 'cancelled':
    case 'canceled':
    case 'declined':         // Host declined Request to Book
    case 'expired':          // Inquiry/request expired
    case 'ownerstay':        // Owner block
      return ReservationStatus.CANCELLED;
    default:
      console.warn(`[Webhook] Unknown reservation status "${status}" — defaulting to INQUIRY (safe)`);
      return ReservationStatus.INQUIRY;
  }
}

function parseHostawayDate(dateStr: string): Date {
  const iso = String(dateStr).replace(' ', 'T');
  return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
}

export function makeWebhooksController(prisma: PrismaClient) {
  return {
    // POST /webhooks/hostaway/:tenantId
    async handleHostaway(req: Request, res: Response): Promise<void> {
      const { tenantId } = req.params;

      // Verify tenant exists
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        res.status(404).json({ error: 'Unknown tenant' });
        return;
      }

      // Auth handled by webhook-auth middleware (FR-001)

      // Return 200 immediately
      res.status(200).json({ ok: true });

      // Process async
      const payload = req.body as HostawayWebhookPayload;
      processWebhook(tenantId, payload, prisma).catch(err => {
        console.error(`[Webhook] [${tenantId}] Error processing event "${payload.event}":`, err);
      });
    },
  };
}

// ── Guest name enrichment via Hostaway API ────────────────────────────────────
// Called when webhook payload lacks a guest name. Fetches the full reservation
// from Hostaway to get guestName/guestFirstName/guestLastName + dates.
// Non-fatal: returns null on any error.

async function enrichGuestFromHostaway(
  tenantId: string,
  hostawayReservationId: string,
  prisma: PrismaClient
): Promise<{ name?: string; email?: string; phone?: string; checkIn?: Date; checkOut?: Date; numberOfGuests?: number; status?: string } | null> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { hostawayAccountId: true, hostawayApiKey: true },
    });
    if (!tenant?.hostawayAccountId || !tenant?.hostawayApiKey) return null;

    const { result: res } = await getReservation(tenant.hostawayAccountId, tenant.hostawayApiKey, hostawayReservationId);

    const name = res.guestName
      || [res.guestFirstName, res.guestLastName].filter(Boolean).join(' ')
      || '';

    console.log(`[Webhook] [${tenantId}] Enriched guest from Hostaway API for reservation ${hostawayReservationId}: name="${name}"`);

    return {
      name: name || undefined,
      email: res.guestEmail || undefined,
      phone: res.phone || res.guestPhone || undefined,
      checkIn: res.arrivalDate ? new Date(res.arrivalDate) : undefined,
      checkOut: res.departureDate ? new Date(res.departureDate) : undefined,
      numberOfGuests: res.numberOfGuests || undefined,
      status: res.status || undefined,
    };
  } catch (err: any) {
    console.warn(`[Webhook] [${tenantId}] enrichGuestFromHostaway failed (non-fatal): ${err.message}`);
    return null;
  }
}

async function processWebhook(
  tenantId: string,
  payload: HostawayWebhookPayload,
  prisma: PrismaClient
): Promise<void> {
  const { event: eventType, data } = payload;
  const webhookStartMs = Date.now();
  console.log(`[Webhook] [${tenantId}] Event: ${eventType} | res=${data.reservationId || data.id} status=${data.status} arrival=${data.arrivalDate} departure=${data.departureDate} guests=${data.numberOfGuests} channel=${data.channelName} listing=${data.listingMapId}`);
  // Debug: log full payload for reservation events to diagnose status mapping
  if (eventType.startsWith('reservation.')) {
    console.log(`[Webhook] [${tenantId}] Full reservation payload:`, JSON.stringify(data).substring(0, 500));
  }

  try {
    switch (eventType) {
      case 'message.received':
      case 'message.updated':
        await handleNewMessage(tenantId, data, prisma);
        break;
      case 'reservation.created':
        await handleNewReservation(tenantId, data, prisma);
        break;
      // 'reservation.modified' is not a documented Hostaway event (only 'reservation.updated'),
      // but kept as a harmless alias in case Hostaway ever sends it.
      case 'reservation.modified':
      case 'reservation.updated':
        await handleReservationUpdated(tenantId, data, prisma);
        break;
      default:
        console.log(`[Webhook] [${tenantId}] Unhandled event: ${eventType} | payload: ${JSON.stringify(data).substring(0, 300)}`);
    }

    // Log webhook (fire-and-forget)
    prisma.webhookLog.create({
      data: {
        tenantId,
        event: eventType,
        hostawayId: String(data.id || data.reservationId || ''),
        status: 'processed',
        payload: data as any,
        durationMs: Date.now() - webhookStartMs,
      },
    }).catch(err => console.warn('[Webhook] Log save failed:', err.message));
  } catch (err: any) {
    // Log webhook error (fire-and-forget)
    prisma.webhookLog.create({
      data: {
        tenantId,
        event: eventType,
        hostawayId: String(data.id || data.reservationId || ''),
        status: 'error',
        payload: data as any,
        error: err.message,
        durationMs: Date.now() - webhookStartMs,
      },
    }).catch(() => {});

    throw err; // Re-throw so the outer .catch() in handleHostaway still logs it
  }
}

// ── handleNewMessage ──────────────────────────────────────────────────────────
// G2: fallback conversation lookup via reservationId
// G3: backfill hostawayConversationId
// G5: record outgoing messages as HOST

async function handleNewMessage(
  tenantId: string,
  data: HostawayWebhookPayload['data'],
  prisma: PrismaClient
): Promise<void> {
  const isGuest = data.isIncoming === 1;

  const hasBody = data.body && data.body.trim() !== '';
  const hasAttachment = data.attachments && data.attachments.length > 0;
  if (!hasBody && !hasAttachment) return;

  const hostawayConvId = String(data.conversationId ?? '');
  if (!hostawayConvId) return;

  // G2: Conversation lookup with fallback chain
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, hostawayConversationId: hostawayConvId },
    include: { reservation: true, guest: true, property: true },
  });

  // Fallback: look up via reservationId when hostawayConversationId doesn't match
  // Try all ID formats (webhook compound vs import short numeric)
  if (!conversation && (data.reservationId || data.id)) {
    const found = await findReservationByAnyId(tenantId, data, prisma);
    const reservation = found?.reservation || null;
    if (reservation) {
      conversation = await prisma.conversation.findFirst({
        where: { tenantId, reservationId: reservation.id },
        include: { reservation: true, guest: true, property: true },
      });
      // G3: Backfill hostawayConversationId
      if (conversation && !conversation.hostawayConversationId) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { hostawayConversationId: hostawayConvId },
        });
      }
    }
  }

  // Auto-create reservation + conversation if neither exists (handles out-of-order webhooks,
  // inquiry-first messages, or missing reservation.created events from Hostaway)
  if (!conversation && data.reservationId) {
    console.log(`[Webhook] [${tenantId}] No conversation for conv=${hostawayConvId} res=${data.reservationId} — auto-creating from message webhook`);
    try {
      await handleNewReservation(tenantId, { ...data, id: data.reservationId }, prisma);
      // Retry lookup after creation
      conversation = await prisma.conversation.findFirst({
        where: { tenantId, hostawayConversationId: hostawayConvId },
        include: { reservation: true, guest: true, property: true },
      });
      if (!conversation) {
        // Try by reservationId (all ID formats)
        const foundRes = await findReservationByAnyId(tenantId, data, prisma);
        const res = foundRes?.reservation || null;
        if (res) {
          conversation = await prisma.conversation.findFirst({
            where: { tenantId, reservationId: res.id },
            include: { reservation: true, guest: true, property: true },
          });
          if (conversation && !conversation.hostawayConversationId) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { hostawayConversationId: hostawayConvId },
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[Webhook] [${tenantId}] Auto-create failed:`, err);
    }
  }

  if (!conversation) {
    console.warn(
      `[Webhook] [${tenantId}] No conversation for conv=${hostawayConvId} res=${data.reservationId} — dropped (auto-create also failed)`
    );
    return;
  }

  // S2/S5: If guest is "Unknown Guest", try to enrich from Hostaway API now,
  // before message is saved and before AI reply fires.
  if (conversation.guest?.name === 'Unknown Guest' && data.reservationId) {
    const enriched = await enrichGuestFromHostaway(tenantId, String(data.reservationId), prisma);
    if (enriched?.name) {
      await prisma.guest.update({
        where: { id: conversation.guest.id },
        data: {
          name: enriched.name,
          ...(enriched.email && { email: enriched.email }),
          ...(enriched.phone && { phone: enriched.phone }),
        },
      });
      // Update local reference so AI reply uses the real name
      conversation.guest.name = enriched.name;
      console.log(`[Webhook] [${tenantId}] Backfilled guest name: "${enriched.name}" for conv ${conversation.id}`);
    }
  }

  // Resync reservation data if stale (>1 hour) — fallback for unreliable reservation webhooks
  // Use data.reservationId if available, otherwise fall back to the reservation's hostawayReservationId
  const resyncReservationId = data.reservationId ? String(data.reservationId) : conversation.reservation?.hostawayReservationId;
  if (conversation.reservation && resyncReservationId) {
    const ONE_HOUR = 60 * 60 * 1000;
    const reservationAge = Date.now() - new Date(conversation.reservation.updatedAt).getTime();
    if (reservationAge > ONE_HOUR) {
      console.log(`[Webhook] [${tenantId}] Reservation ${conversation.reservation.id} stale (${Math.round(reservationAge / 60000)}min) — resyncing from Hostaway API`);
      const fresh = await enrichGuestFromHostaway(tenantId, resyncReservationId, prisma);
      if (fresh) {
        const freshStatus = fresh.status ? mapReservationStatus(fresh.status) : undefined;
        const isCancelledOrCheckedOut = freshStatus === ReservationStatus.CANCELLED || freshStatus === ReservationStatus.CHECKED_OUT;

        const updates: Record<string, unknown> = {};
        if (fresh.checkIn && fresh.checkIn.getTime() !== new Date(conversation.reservation.checkIn).getTime()) {
          updates.checkIn = fresh.checkIn;
        }
        if (fresh.checkOut && fresh.checkOut.getTime() !== new Date(conversation.reservation.checkOut).getTime()) {
          updates.checkOut = fresh.checkOut;
        }
        if (fresh.numberOfGuests && fresh.numberOfGuests !== conversation.reservation.guestCount) {
          updates.guestCount = fresh.numberOfGuests;
        }
        if (freshStatus && freshStatus !== conversation.reservation.status) {
          updates.status = freshStatus;
        }
        // Re-enable AI if reservation is no longer cancelled/checked-out
        if (!isCancelledOrCheckedOut && !conversation.reservation.aiEnabled) {
          updates.aiEnabled = true;
        }
        // Disable AI if reservation became cancelled/checked-out
        if (isCancelledOrCheckedOut && conversation.reservation.aiEnabled) {
          updates.aiEnabled = false;
        }

        if (Object.keys(updates).length > 0) {
          await prisma.reservation.update({
            where: { id: conversation.reservation.id },
            data: updates,
          });
          // Update local reference so AI reply logic uses fresh data
          Object.assign(conversation.reservation, updates);

          // Feature 044: reschedule doc-handoff rows if dates/status changed.
          try {
            const { rescheduleOnReservationChange } = await import('../services/doc-handoff.service');
            void rescheduleOnReservationChange(conversation.reservation.id, prisma).catch(() => {});
          } catch { /* ignore */ }

          console.log(`[Webhook] [${tenantId}] Resynced reservation ${conversation.reservation.id}: ${JSON.stringify(updates)}`);

          // Broadcast so frontend reflects changes without page refresh
          const convs = await prisma.conversation.findMany({
            where: { reservationId: conversation.reservation.id },
            select: { id: true },
          });
          broadcastToTenant(tenantId, 'reservation_updated', {
            reservationId: conversation.reservation.id,
            conversationIds: convs.map(c => c.id),
            status: updates.status ?? conversation.reservation.status,
            checkIn: (updates.checkIn as Date)?.toISOString?.() ?? conversation.reservation.checkIn,
            checkOut: (updates.checkOut as Date)?.toISOString?.() ?? conversation.reservation.checkOut,
            guestCount: updates.guestCount ?? conversation.reservation.guestCount,
          });

          // Web Push for resync status changes — fire-and-forget
          if (updates.status) {
            const resyncGuestName = conversation.guest?.name || 'Guest';
            const resyncPropertyName = conversation.property?.name || 'Property';
            if (updates.status === ReservationStatus.CANCELLED) {
              sendPushToTenantAll(tenantId, {
                title: 'Booking Cancelled',
                body: `${resyncGuestName} — ${resyncPropertyName}`,
                data: { type: 'reservation' },
              }, prisma).catch(err => console.warn('[Push] Resync cancel notification failed:', err));
            } else {
              sendPushToTenantAll(tenantId, {
                title: 'Booking Modified',
                body: `${resyncGuestName} — ${resyncPropertyName}`,
                data: { type: 'reservation' },
              }, prisma).catch(err => console.warn('[Push] Resync update notification failed:', err));
            }
          }
        }
      }
    }
  }

  // Generate a unique hostawayMessageId even when Hostaway sends empty/missing id.
  // Bugfix (2026-04-23): the previous fallback `empty-${Date.now()}`
  // produced a different id on every webhook delivery, so two duplicate
  // Hostaway webhooks within retry windows (system notifications,
  // alteration retries, even regular messages with a deliverer that
  // dropped the `id` field) inserted twice → duplicate tasks, duplicate
  // AI triggers, duplicate alteration records. Now we hash the
  // (conversationId + sentAt + role + body) tuple so identical retries
  // collide on the unique index instead.
  let hostawayMsgId: string;
  if (data.id) {
    hostawayMsgId = String(data.id);
  } else {
    const dedupeBasis = JSON.stringify({
      c: conversation.id,
      t: data.date ?? data.createdAt ?? data.sentAt ?? '',
      r: data.isIncoming ?? data.role ?? '',
      b: (data.body ?? '').slice(0, 500),
    });
    // Cheap non-cryptographic hash; collisions across DIFFERENT messages
    // are vanishingly unlikely with a 500-char body sample, and even a
    // collision degrades safely (the unique-index conflict is caught
    // and treated as a duplicate, which is the intended dedup behaviour).
    let hash = 0;
    for (let i = 0; i < dedupeBasis.length; i++) {
      hash = ((hash << 5) - hash + dedupeBasis.charCodeAt(i)) | 0;
    }
    hostawayMsgId = `nopid-${(hash >>> 0).toString(36)}`;
  }

  // Detect Airbnb system notifications (alteration requests, etc.) — not real guest messages
  const messageBody = (data.body || '').toLowerCase();
  const isAlterationRequest = isGuest && (
    messageBody.includes('alteration request') ||
    messageBody.includes('reservation alteration') ||
    messageBody.includes('modification request') ||
    messageBody.includes('wants to change') ||
    messageBody.includes('alteration has been')
  );

  if (isAlterationRequest) {
    // Save the message, create a task, fetch alteration details, then trigger AI
    console.log(`[Webhook] [${tenantId}] Alteration request detected in conv ${conversation.id}`);
    let savedMsg: any;
    try {
      savedMsg = await prisma.message.create({
        data: {
          conversationId: conversation.id, tenantId,
          role: MessageRole.GUEST, content: data.body || '',
          channel: conversation.channel,
          communicationType: data.communicationType?.toLowerCase() || 'channel',
          sentAt: data.date ? parseHostawayDate(data.date) : new Date(),
          hostawayMessageId: hostawayMsgId,
        },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
    }
    // Create task for manager
    const guestName = conversation.guest?.name || 'Guest';
    const propertyName = conversation.property?.name || 'Property';
    const task = await prisma.task.create({
      data: {
        tenantId, conversationId: conversation.id, propertyId: conversation.propertyId,
        title: 'alteration-request',
        note: `${guestName} (${propertyName}) submitted a booking alteration request. Review and accept/reject in GuestPilot inbox. Message: "${(data.body || '').substring(0, 200)}"`,
        urgency: 'modification_request',
        source: 'system',
      },
    });
    broadcastToTenant(tenantId, 'new_task', { conversationId: conversation.id, task });

    // Broadcast the raw message immediately for real-time UI
    broadcastCritical(tenantId, 'message', {
      conversationId: conversation.id,
      message: { ...(savedMsg?.id ? { id: savedMsg.id } : {}), role: 'GUEST', content: data.body || '', sentAt: new Date().toISOString(), channel: String(conversation.channel), imageUrls: [] },
      lastMessageRole: 'GUEST', lastMessageAt: new Date().toISOString(),
    });
    sendPushToTenantAll(tenantId, {
      title: 'Alteration Request',
      body: `${guestName} (${propertyName}) submitted a booking modification.`,
      data: { conversationId: conversation.id, taskId: task.id, type: 'task' },
    }, prisma).catch(err => console.warn('[Push] Alteration notification failed:', err));

    // Fetch alteration details, enrich message, then trigger AI (fire-and-forget — does not block webhook response)
    const hostawayResId = conversation.reservation?.hostawayReservationId;
    (async () => {
      try {
        let alterationData: {
          hostawayAlterationId: string;
          originalCheckIn: string | null;
          originalCheckOut: string | null;
          originalGuestCount: number | null;
          proposedCheckIn: string | null;
          proposedCheckOut: string | null;
          proposedGuestCount: number | null;
        } | null = null;
        let fetchError: string | null = null;

        if (hostawayResId) {
          const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { dashboardJwt: true, dashboardJwtExpiresAt: true },
          });

          if (tenant?.dashboardJwt && !(tenant.dashboardJwtExpiresAt && tenant.dashboardJwtExpiresAt < new Date())) {
            const decryptedJwt = decrypt(tenant.dashboardJwt);
            const result = await fetchAlteration(decryptedJwt, hostawayResId);
            if ('error' in result) {
              fetchError = result.error;
            } else {
              alterationData = result.alteration;
            }
          } else {
            fetchError = 'Hostaway dashboard not connected';
          }

          await prisma.bookingAlteration.upsert({
            where: { reservationId: conversation.reservationId },
            create: {
              tenantId,
              reservationId: conversation.reservationId,
              hostawayAlterationId: alterationData?.hostawayAlterationId ?? '',
              originalCheckIn: alterationData?.originalCheckIn ? new Date(alterationData.originalCheckIn) : null,
              originalCheckOut: alterationData?.originalCheckOut ? new Date(alterationData.originalCheckOut) : null,
              originalGuestCount: alterationData?.originalGuestCount ?? null,
              proposedCheckIn: alterationData?.proposedCheckIn ? new Date(alterationData.proposedCheckIn) : null,
              proposedCheckOut: alterationData?.proposedCheckOut ? new Date(alterationData.proposedCheckOut) : null,
              proposedGuestCount: alterationData?.proposedGuestCount ?? null,
              status: AlterationStatus.PENDING,
              fetchError,
            },
            update: {
              hostawayAlterationId: alterationData?.hostawayAlterationId ?? '',
              originalCheckIn: alterationData?.originalCheckIn ? new Date(alterationData.originalCheckIn) : null,
              originalCheckOut: alterationData?.originalCheckOut ? new Date(alterationData.originalCheckOut) : null,
              originalGuestCount: alterationData?.originalGuestCount ?? null,
              proposedCheckIn: alterationData?.proposedCheckIn ? new Date(alterationData.proposedCheckIn) : null,
              proposedCheckOut: alterationData?.proposedCheckOut ? new Date(alterationData.proposedCheckOut) : null,
              proposedGuestCount: alterationData?.proposedGuestCount ?? null,
              status: AlterationStatus.PENDING,
              fetchError,
            },
          });
          console.log(`[Webhook] [${tenantId}] Alteration detail ${alterationData ? 'saved' : 'saved with fetchError'} for reservation ${conversation.reservationId}`);
        }

        // Enrich the saved message with structured alteration details
        if (savedMsg && alterationData) {
          const fmtD = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
          const lines = [
            `Guest requested a booking alteration.`,
            `Check-in: ${fmtD(alterationData.originalCheckIn)} → ${fmtD(alterationData.proposedCheckIn)}`,
            `Check-out: ${fmtD(alterationData.originalCheckOut)} → ${fmtD(alterationData.proposedCheckOut)}`,
          ];
          if (alterationData.originalGuestCount !== null || alterationData.proposedGuestCount !== null) {
            lines.push(`Guests: ${alterationData.originalGuestCount ?? '—'} → ${alterationData.proposedGuestCount ?? '—'}`);
          }
          lines.push(`Status: Pending manager review.`);
          await prisma.message.update({
            where: { id: savedMsg.id },
            data: { content: lines.join('\n') },
          });
          console.log(`[Webhook] [${tenantId}] Enriched alteration message ${savedMsg.id}`);
        }

        // Update unread count
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { unreadCount: { increment: 1 }, lastMessageAt: new Date() },
        });

        // Trigger AI pipeline so it can acknowledge the alteration
        if (conversation.reservation.aiEnabled && conversation.reservation.aiMode !== 'off') {
          await scheduleAiReply(conversation.id, tenantId, prisma);
          console.log(`[Webhook] [${tenantId}] AI reply scheduled for alteration in conv ${conversation.id}`);
        }
      } catch (err) {
        console.warn(`[Webhook] [${tenantId}] Alteration enrichment/AI failed:`, err);
      }
    })();
    return;
  }

  // Determine the channel for this specific message (WhatsApp overrides conversation channel)
  const msgChannel = data.communicationType?.toLowerCase() === 'whatsapp'
    ? Channel.WHATSAPP
    : conversation.channel;

  // G5: Use conditional role — GUEST for incoming, HOST for outgoing
  const role = isGuest ? MessageRole.GUEST : MessageRole.HOST;

  // Deduplicate via create + P2002 catch (atomic, no race window)
  const msgImageUrls: string[] = (data.attachments || []).map((a: { url: string }) => a.url).filter(Boolean);
  let savedMessageId: string | undefined;
  try {
    const savedMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        role,
        content: data.body || '',
        channel: msgChannel,
        communicationType: data.communicationType?.toLowerCase() || 'channel',
        sentAt: data.date ? parseHostawayDate(data.date) : new Date(),
        hostawayMessageId: hostawayMsgId,
        imageUrls: msgImageUrls,
      },
    });

    savedMessageId = savedMessage.id;
    compactMessageAsync(savedMessage.id, role, data.body || '', prisma);

    // Fire-and-forget: caption images so conversation history shows "[Image: description]"
    if (msgImageUrls.length > 0) {
      captionMessageImages(savedMessage.id, msgImageUrls, data.body || '', prisma)
        .catch(err => console.warn(`[Webhook] Image captioning failed:`, err));
    }
  } catch (err: any) {
    // P2002 = unique constraint violation — message already exists (inserted by sync or duplicate webhook)
    if (err?.code === 'P2002') {
      console.log(`[Webhook] Duplicate message ${hostawayMsgId} — checking for content edit + AI trigger`);

      // Check if this is a message edit (same hostawayMessageId, different content)
      const newBody = data.body || '';
      const existing = await prisma.message.findFirst({
        where: { conversationId: conversation.id, hostawayMessageId: hostawayMsgId },
        select: { id: true, content: true },
      });
      if (existing && existing.content !== newBody) {
        await prisma.message.update({
          where: { id: existing.id },
          data: { content: newBody },
        });
        console.log(`[Webhook] [${tenantId}] Updated edited message ${existing.id} (hostawayMsgId=${hostawayMsgId})`);
        // Broadcast the updated content so open inboxes refresh in real-time
        broadcastCritical(tenantId, 'message', {
          conversationId: conversation.id,
          message: {
            id: existing.id,
            role: isGuest ? 'GUEST' : 'HOST',
            content: newBody,
            sentAt: data.date ? parseHostawayDate(data.date).toISOString() : new Date().toISOString(),
            channel: String(msgChannel),
            imageUrls: (data.attachments || []).map((a: { url: string }) => a.url).filter(Boolean),
          },
          lastMessageRole: isGuest ? 'GUEST' : 'HOST',
          lastMessageAt: new Date().toISOString(),
        });
      }

      // Message exists, but AI may not have been triggered yet (sync doesn't trigger AI).
      // Only schedule AI if no PendingAiReply exists or was recently fired for this conversation.
      if (isGuest && conversation.reservation.aiEnabled && conversation.reservation.aiMode !== 'off') {
        const existingReply = await prisma.pendingAiReply.findFirst({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
        });
        // Schedule AI only if there's no pending/recent reply (avoid duplicate AI responses)
        if (!existingReply || (existingReply.fired && Date.now() - existingReply.createdAt.getTime() > 60_000)) {
          await scheduleAiReply(conversation.id, tenantId, prisma);
          console.log(`[Webhook] [${tenantId}] AI reply scheduled for duplicate message in conv ${conversation.id}`);
        } else {
          console.log(`[Webhook] [${tenantId}] AI reply already pending/recent for conv ${conversation.id} — skipping`);
        }
      }
      return;
    }
    throw err;
  }

  if (isGuest) {
    // Update conversation: increment unread, update timestamp
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    });

    // Schedule AI reply if aiEnabled and aiMode is not off
    if (conversation.reservation.aiEnabled && conversation.reservation.aiMode !== 'off') {
      await scheduleAiReply(conversation.id, tenantId, prisma);
      console.log(`[Webhook] [${tenantId}] AI reply scheduled for conv ${conversation.id} (aiMode=${conversation.reservation.aiMode})`);
    } else {
      console.log(`[Webhook] [${tenantId}] AI DISABLED for conv ${conversation.id} — reservation.aiEnabled=false (reservationId=${conversation.reservationId}). Toggle AI on in the dashboard.`);
    }

    // Web Push notification for guest messages — fire-and-forget
    const guestName = conversation.guest?.name || 'Guest';
    const propertyName = conversation.property?.name || 'Property';
    const messageBody = data.body || '';
    sendPushToTenantAll(tenantId, {
      title: `${guestName} — ${propertyName}`,
      body: messageBody.substring(0, 200),
      data: { conversationId: conversation.id, type: 'message' },
    }, prisma).catch(err => console.warn('[Push] Message notification failed:', err));
  } else {
    // G5: Still update lastMessageAt for outgoing messages
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    // T022: Cancel pending AI reply when host sends — host has taken over
    await cancelPendingAiReply(conversation.id, prisma);
    broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId: conversation.id });
  }

  // Push real-time event to connected browser tabs
  const msgContent = data.body || '';
  const msgSentAt = data.date ? parseHostawayDate(data.date).toISOString() : new Date().toISOString();
  const roleStr = isGuest ? 'GUEST' : 'HOST';
  broadcastCritical(tenantId, 'message', {
    conversationId: conversation.id,
    message: {
      ...(savedMessageId ? { id: savedMessageId } : {}),
      role: roleStr,
      content: msgContent,
      sentAt: msgSentAt,
      channel: String(msgChannel),
      imageUrls: (data.attachments || []).map((a: { url: string }) => a.url).filter(Boolean),
    },
    lastMessageRole: roleStr,
    lastMessageAt: new Date().toISOString(),
  });
}

// ── Reservation ID resolution ─────────────────────────────────────────────────
// Hostaway uses different ID formats:
//   - REST API (import): short numeric ID like "56333389"
//   - Webhook payload: compound ID like "162575-426150-2013-5793830996"
// The import stores the short ID. Webhooks send the compound. We must find
// the reservation regardless of which format arrives.

async function findReservationByAnyId(
  tenantId: string,
  data: HostawayWebhookPayload['data'],
  prisma: PrismaClient
): Promise<{ reservation: any; hostawayReservationId: string } | null> {
  // Collect all candidate IDs to try
  const candidates: string[] = [];

  // 1. Compound reservationId (webhook format)
  if (data.reservationId) candidates.push(String(data.reservationId));

  // 2. Short numeric id (API format)
  if (data.id && String(data.id) !== String(data.reservationId)) {
    candidates.push(String(data.id));
  }

  // 3. Extract last segment of compound ID (sometimes the actual reservation number)
  if (data.reservationId && String(data.reservationId).includes('-')) {
    const segments = String(data.reservationId).split('-');
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && !candidates.includes(lastSegment)) {
      candidates.push(lastSegment);
    }
  }

  // Try each candidate
  for (const candidateId of candidates) {
    const reservation = await prisma.reservation.findUnique({
      where: { tenantId_hostawayReservationId: { tenantId, hostawayReservationId: candidateId } },
    });
    if (reservation) {
      return { reservation, hostawayReservationId: candidateId };
    }
  }

  return null;
}

// The canonical ID to use when creating a new reservation — prefer short numeric ID
function getCanonicalReservationId(data: HostawayWebhookPayload['data']): string {
  // Prefer data.id (short numeric from Hostaway API) over data.reservationId (compound from webhook)
  // This matches what the import service stores
  if (data.id) return String(data.id);
  return String(data.reservationId || '');
}

// ── handleNewReservation ──────────────────────────────────────────────────────
// G1: Create Conversation if one doesn't exist
// G8: SSE broadcast for new reservations

async function handleNewReservation(
  tenantId: string,
  data: HostawayWebhookPayload['data'],
  prisma: PrismaClient
): Promise<void> {
  if (!data.reservationId && !data.id) return;

  // Check if reservation already exists under any ID format (import vs webhook)
  const existing = await findReservationByAnyId(tenantId, data, prisma);
  const hostawayReservationId = existing?.hostawayReservationId || getCanonicalReservationId(data);
  const hostawayListingId = String(data.listingMapId || '');

  const property = hostawayListingId
    ? await prisma.property.findUnique({
        where: { tenantId_hostawayListingId: { tenantId, hostawayListingId } },
      })
    : null;

  if (!property) {
    console.log(`[Webhook] [${tenantId}] Property not found for listing ${hostawayListingId}`);
    return;
  }

  // S1/S2: Try guestName → first+last → Hostaway API → sentinel
  // (mirrors import.service.ts logic)
  let guestName = data.guestName
    || [data.guestFirstName, data.guestLastName].filter(Boolean).join(' ')
    || '';

  let enrichedCheckIn: Date | undefined;
  let enrichedCheckOut: Date | undefined;

  if (!guestName && hostawayReservationId) {
    const enriched = await enrichGuestFromHostaway(tenantId, hostawayReservationId, prisma);
    if (enriched) {
      guestName = enriched.name || '';
      if (enriched.checkIn) enrichedCheckIn = enriched.checkIn;
      if (enriched.checkOut) enrichedCheckOut = enriched.checkOut;
    }
  }

  guestName = guestName || 'Unknown Guest';

  const hostawayGuestId = hostawayReservationId;

  const guest = await prisma.guest.upsert({
    where: { tenantId_hostawayGuestId: { tenantId, hostawayGuestId } },
    create: {
      tenantId,
      hostawayGuestId,
      name: guestName,
      email: data.guestEmail || '',
      phone: data.phone || data.guestPhone || '',
    },
    update: { name: guestName, email: data.guestEmail || '', phone: data.phone || data.guestPhone || '' },
  });

  const reservation = await prisma.reservation.upsert({
    where: { tenantId_hostawayReservationId: { tenantId, hostawayReservationId } },
    create: {
      tenantId,
      propertyId: property.id,
      guestId: guest.id,
      hostawayReservationId,
      // S4: Use API-enriched dates if available; sentinel 2999 for inquiries
      // with no dates (avoids defaulting to today → "Checked Out" badge)
      checkIn: enrichedCheckIn ?? (data.arrivalDate ? new Date(data.arrivalDate) : new Date('2999-01-01')),
      checkOut: enrichedCheckOut ?? (data.departureDate ? new Date(data.departureDate) : new Date('2999-12-31')),
      guestCount: data.numberOfGuests || 1,
      channel: mapChannel(data.channelName, data.channelId),
      status: mapReservationStatus(data.status),
      aiEnabled: true,
      // Inherit AI mode from property's most recent reservation (so property-level toggle persists)
      aiMode: await (async () => {
        try {
          const recent = await prisma.reservation.findFirst({
            where: { tenantId, propertyId: property.id, NOT: { hostawayReservationId } },
            orderBy: { createdAt: 'desc' },
            select: { aiMode: true, aiEnabled: true },
          });
          return recent?.aiMode || 'copilot';
        } catch { return 'copilot'; }
      })(),
    },
    update: {
      checkIn: data.arrivalDate ? new Date(data.arrivalDate) : undefined,
      checkOut: data.departureDate ? new Date(data.departureDate) : undefined,
      guestCount: data.numberOfGuests || 1,
      status: mapReservationStatus(data.status),
      // Re-enable AI for re-bookings: if a prior cancellation set aiEnabled=false,
      // a new reservation.created webhook should re-activate it.
      ...(!['CANCELLED', 'CHECKED_OUT'].includes(data.status || '') && { aiEnabled: true }),
    },
  });

  // Feature 044: schedule or reschedule doc-handoff WhatsApp messages for this reservation.
  // Fire-and-forget — any failure is logged inside the service, never propagates.
  try {
    const { scheduleOnReservationUpsert } = await import('../services/doc-handoff.service');
    void scheduleOnReservationUpsert(reservation.id, prisma).catch(() => {});
  } catch { /* ignore */ }

  // G1: Create Conversation if one doesn't exist for this reservation.
  // Use create + P2002 catch instead of findFirst + create to avoid a race condition:
  // reservation.created and message.received can both fire within milliseconds of each other,
  // both pass the findFirst check before either commits, and both create a conversation.
  try {
    await prisma.conversation.create({
      data: {
        tenantId,
        reservationId: reservation.id,
        guestId: guest.id,
        propertyId: property.id,
        channel: mapChannel(data.channelName, data.channelId),
        hostawayConversationId: '', // backfilled on first message (G3)
        unreadCount: 0,
        lastMessageAt: new Date(),
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Unique constraint violation — another concurrent handler already created this conversation.
      // This is expected when reservation.created and message.received race. Safe to ignore.
      console.log(`[Webhook] [${tenantId}] Conversation for reservation ${reservation.id} already exists (concurrent create) — skipping`);
    } else {
      throw err;
    }
  }

  // G8: SSE broadcast
  broadcastToTenant(tenantId, 'reservation_created', {
    reservationId: reservation.id,
  });

  // Web Push notification for new bookings — fire-and-forget
  const checkInStr = data.arrivalDate || 'TBD';
  const checkOutStr = data.departureDate || 'TBD';
  sendPushToTenantAll(tenantId, {
    title: 'New Booking',
    body: `${guestName} — ${property.name}, ${checkInStr} to ${checkOutStr}`,
    data: { type: 'reservation' },
  }, prisma).catch(err => console.warn('[Push] Reservation notification failed:', err));

  console.log(`[Webhook] [${tenantId}] Reservation ${hostawayReservationId} created/updated`);
}

// ── handleReservationUpdated ──────────────────────────────────────────────────
// G4: Disable AI on cancellation/checkout
// G6: Propagate guest name/email/phone changes
// G7: Fall back to create when reservation doesn't exist
// G8: SSE broadcast

async function handleReservationUpdated(
  tenantId: string,
  data: HostawayWebhookPayload['data'],
  prisma: PrismaClient
): Promise<void> {
  if (!data.reservationId && !data.id) return;

  // Try all ID formats (webhook sends compound, import stores short numeric)
  const found = await findReservationByAnyId(tenantId, data, prisma);

  // G7: Fall back to handleNewReservation if reservation doesn't exist (out-of-order)
  if (!found) {
    const fallbackId = String(data.reservationId || data.id || '');
    console.warn(
      `[Webhook] [${tenantId}] Reservation not found for update (tried all ID formats: ${data.reservationId}, ${data.id}) — treating as create`
    );
    return handleNewReservation(tenantId, data, prisma);
  }

  const { reservation, hostawayReservationId } = found;
  console.log(`[Webhook] [${tenantId}] Matched reservation ${hostawayReservationId} for update (webhook sent: ${data.reservationId || data.id})`);

  // S3/S6: If existing guest is still "Unknown Guest", enrich from API now
  const existingGuest = await prisma.guest.findUnique({ where: { id: reservation.guestId } });
  if (existingGuest?.name === 'Unknown Guest' && hostawayReservationId) {
    const enriched = await enrichGuestFromHostaway(tenantId, hostawayReservationId, prisma);
    if (enriched?.name) {
      await prisma.guest.update({
        where: { id: reservation.guestId },
        data: {
          name: enriched.name,
          ...(enriched.email && { email: enriched.email }),
          ...(enriched.phone && { phone: enriched.phone }),
        },
      });
      console.log(`[Webhook] [${tenantId}] Backfilled guest name on reservation update: "${enriched.name}"`);
    }
  }

  const newStatus = data.status ? mapReservationStatus(data.status) : undefined;
  const isCancelledOrCheckedOut =
    newStatus === ReservationStatus.CANCELLED || newStatus === ReservationStatus.CHECKED_OUT;

  // G4: Disable AI on cancellation or checkout
  await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      ...(data.arrivalDate && { checkIn: new Date(data.arrivalDate) }),
      ...(data.departureDate && { checkOut: new Date(data.departureDate) }),
      ...(data.numberOfGuests && { guestCount: data.numberOfGuests }),
      ...(newStatus && { status: newStatus }),
      ...(isCancelledOrCheckedOut && { aiEnabled: false }),
      ...(!isCancelledOrCheckedOut && newStatus && { aiEnabled: true }),
    },
  });

  // Feature 044: on status-change / date-change / cancellation, keep doc-handoff rows in sync.
  try {
    const { rescheduleOnReservationChange, markCancelled } = await import('../services/doc-handoff.service');
    if (newStatus === ReservationStatus.CANCELLED) {
      void markCancelled(reservation.id, prisma).catch(() => {});
    } else {
      void rescheduleOnReservationChange(reservation.id, prisma).catch(() => {});
    }
  } catch { /* ignore */ }

  // Always fetch convs — needed for SSE broadcast and (conditionally) AI reply cancellation
  const convs = await prisma.conversation.findMany({
    where: { reservationId: reservation.id },
    select: { id: true },
  });

  // G4: Cancel pending AI replies on cancellation/checkout
  if (isCancelledOrCheckedOut) {
    for (const c of convs) {
      await cancelPendingAiReply(c.id, prisma);
    }
  }

  // G6: Update guest info if provided (includes first+last name fallback)
  const newGuestName = data.guestName
    || [data.guestFirstName, data.guestLastName].filter(Boolean).join(' ')
    || '';
  const phoneFromWebhook = data.phone || data.guestPhone;
  if (newGuestName || data.guestEmail || phoneFromWebhook) {
    await prisma.guest.update({
      where: { id: reservation.guestId },
      data: {
        ...(newGuestName && { name: newGuestName }),
        ...(data.guestEmail && { email: data.guestEmail }),
        ...(phoneFromWebhook && { phone: phoneFromWebhook }),
      },
    });
  }

  // G8: SSE broadcast — include all updated fields so frontend reflects changes
  broadcastToTenant(tenantId, 'reservation_updated', {
    reservationId: reservation.id,
    conversationIds: convs.map(c => c.id),
    status: newStatus,
    ...(data.arrivalDate && { checkIn: new Date(data.arrivalDate).toISOString() }),
    ...(data.departureDate && { checkOut: new Date(data.departureDate).toISOString() }),
    ...(data.numberOfGuests && { guestCount: data.numberOfGuests }),
  });

  // Web Push notification for reservation status changes — fire-and-forget
  if (newStatus) {
    const displayGuestName = newGuestName || existingGuest?.name || 'Guest';
    // Fetch property name for push payload
    const resProperty = await prisma.property.findUnique({
      where: { id: reservation.propertyId },
      select: { name: true },
    });
    const displayPropertyName = resProperty?.name || 'Property';

    if (newStatus === ReservationStatus.CANCELLED) {
      sendPushToTenantAll(tenantId, {
        title: 'Booking Cancelled',
        body: `${displayGuestName} — ${displayPropertyName}`,
        data: { type: 'reservation' },
      }, prisma).catch(err => console.warn('[Push] Reservation cancel notification failed:', err));
    } else {
      const checkInStr = data.arrivalDate || 'TBD';
      const checkOutStr = data.departureDate || 'TBD';
      sendPushToTenantAll(tenantId, {
        title: 'Booking Modified',
        body: `${displayGuestName} — ${displayPropertyName}, ${checkInStr} to ${checkOutStr}`,
        data: { type: 'reservation' },
      }, prisma).catch(err => console.warn('[Push] Reservation update notification failed:', err));
    }
  }

  console.log(`[Webhook] [${tenantId}] Reservation ${hostawayReservationId} updated`);
}
