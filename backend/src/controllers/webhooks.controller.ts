/**
 * Webhooks Controller
 * Handles incoming Hostaway webhooks per tenant.
 * Verifies signature, returns 200 immediately, processes async.
 *
 * Gap fixes: G1–G10 (see plan for details)
 */

import { Request, Response } from 'express';
import { PrismaClient, MessageRole, Channel, ReservationStatus } from '@prisma/client';
import { scheduleAiReply, cancelPendingAiReply } from '../services/debounce.service';
import { broadcastToTenant } from '../services/sse.service';
import { getReservation } from '../services/hostaway.service';

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
    arrivalDate?: string;
    departureDate?: string;
    numberOfGuests?: number;
    channelName?: string;
    status?: string;
    [key: string]: unknown;
  };
}

function mapChannel(channelName?: string): Channel {
  if (!channelName) return Channel.OTHER;
  const name = channelName.toLowerCase();
  if (name.includes('airbnb')) return Channel.AIRBNB;
  if (name.includes('booking')) return Channel.BOOKING;
  if (name.includes('direct')) return Channel.DIRECT;
  if (name.includes('whatsapp')) return Channel.WHATSAPP;
  return Channel.OTHER;
}

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
    case 'inquiry':
    case 'pending':
      return ReservationStatus.INQUIRY;
    case 'new':
    case 'confirmed':
    case 'accepted':
      return ReservationStatus.CONFIRMED;
    case 'checkedin':
      return ReservationStatus.CHECKED_IN;
    case 'checkedout':
      return ReservationStatus.CHECKED_OUT;
    case 'cancelled':
    case 'canceled':
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
      phone: res.guestPhone || undefined,
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
  const { event, data } = payload;
  console.log(`[Webhook] [${tenantId}] Event: ${event} | res=${data.reservationId || data.id} status=${data.status} arrival=${data.arrivalDate} departure=${data.departureDate} guests=${data.numberOfGuests} channel=${data.channelName} listing=${data.listingMapId}`);
  // Debug: log full payload for reservation events to diagnose status mapping
  if (event.startsWith('reservation.')) {
    console.log(`[Webhook] [${tenantId}] Full reservation payload:`, JSON.stringify(data).substring(0, 500));
  }

  switch (event) {
    case 'message.received':
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
      console.log(`[Webhook] [${tenantId}] Unhandled event: ${event} | payload: ${JSON.stringify(data).substring(0, 300)}`);
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
    include: { reservation: true, guest: true },
  });

  // Fallback: look up via reservationId when hostawayConversationId doesn't match
  // Try all ID formats (webhook compound vs import short numeric)
  if (!conversation && (data.reservationId || data.id)) {
    const found = await findReservationByAnyId(tenantId, data, prisma);
    const reservation = found?.reservation || null;
    if (reservation) {
      conversation = await prisma.conversation.findFirst({
        where: { tenantId, reservationId: reservation.id },
        include: { reservation: true, guest: true },
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
        include: { reservation: true, guest: true },
      });
      if (!conversation) {
        // Try by reservationId (all ID formats)
        const foundRes = await findReservationByAnyId(tenantId, data, prisma);
        const res = foundRes?.reservation || null;
        if (res) {
          conversation = await prisma.conversation.findFirst({
            where: { tenantId, reservationId: res.id },
            include: { reservation: true, guest: true },
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
  if (conversation.reservation && data.reservationId) {
    const ONE_HOUR = 60 * 60 * 1000;
    const reservationAge = Date.now() - new Date(conversation.reservation.updatedAt).getTime();
    if (reservationAge > ONE_HOUR) {
      console.log(`[Webhook] [${tenantId}] Reservation ${conversation.reservation.id} stale (${Math.round(reservationAge / 60000)}min) — resyncing from Hostaway API`);
      const fresh = await enrichGuestFromHostaway(tenantId, String(data.reservationId), prisma);
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
        }
      }
    }
  }

  // Generate a unique hostawayMessageId even when Hostaway sends empty/missing id
  const hostawayMsgId = data.id ? String(data.id) : `empty-${Date.now()}`;

  // Determine the channel for this specific message (WhatsApp overrides conversation channel)
  const msgChannel = data.communicationType?.toLowerCase() === 'whatsapp'
    ? Channel.WHATSAPP
    : conversation.channel;

  // G5: Use conditional role — GUEST for incoming, HOST for outgoing
  const role = isGuest ? MessageRole.GUEST : MessageRole.HOST;

  // Deduplicate via create + P2002 catch (atomic, no race window)
  try {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        role,
        content: data.body || '',
        channel: msgChannel,
        communicationType: data.communicationType?.toLowerCase() || 'channel',
        sentAt: data.date ? parseHostawayDate(data.date) : new Date(),
        hostawayMessageId: hostawayMsgId,
        imageUrls: (data.attachments || []).map((a: { url: string }) => a.url).filter(Boolean),
      },
    });
  } catch (err: any) {
    // P2002 = Prisma unique constraint violation — duplicate webhook delivery
    if (err?.code === 'P2002') {
      console.log(`[Webhook] Duplicate message ${hostawayMsgId} skipped`);
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
  broadcastToTenant(tenantId, 'message', {
    conversationId: conversation.id,
    message: {
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
      phone: data.guestPhone || '',
    },
    update: { name: guestName, email: data.guestEmail || '', phone: data.guestPhone || '' },
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
      channel: mapChannel(data.channelName),
      status: mapReservationStatus(data.status),
      aiEnabled: true,
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
        channel: mapChannel(data.channelName),
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
  if (newGuestName || data.guestEmail || data.guestPhone) {
    await prisma.guest.update({
      where: { id: reservation.guestId },
      data: {
        ...(newGuestName && { name: newGuestName }),
        ...(data.guestEmail && { email: data.guestEmail }),
        ...(data.guestPhone && { phone: data.guestPhone }),
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

  console.log(`[Webhook] [${tenantId}] Reservation ${hostawayReservationId} updated`);
}
