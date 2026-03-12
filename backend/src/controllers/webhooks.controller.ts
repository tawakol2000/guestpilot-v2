/**
 * Webhooks Controller
 * Handles incoming Hostaway webhooks per tenant.
 * Verifies signature, returns 200 immediately, processes async.
 *
 * Gap fixes: G1–G10 (see plan for details)
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { PrismaClient, MessageRole, Channel, ReservationStatus } from '@prisma/client';
import { scheduleAiReply, cancelPendingAiReply } from '../services/debounce.service';
import { broadcastToTenant } from '../services/sse.service';

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
  if (!status) return ReservationStatus.CONFIRMED;
  switch (status.toLowerCase()) {
    case 'inquiry':
    case 'pending':
      return ReservationStatus.INQUIRY;
    case 'new':
    case 'confirmed':
      return ReservationStatus.CONFIRMED;
    case 'checkedin':
      return ReservationStatus.CHECKED_IN;
    case 'checkedout':
      return ReservationStatus.CHECKED_OUT;
    case 'cancelled':
    case 'canceled':
      return ReservationStatus.CANCELLED;
    default:
      return ReservationStatus.CONFIRMED;
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

      // G9/G10: Signature verification — require signature when secret is configured
      if (tenant.webhookSecret) {
        const signature = req.headers['x-hostaway-signature'] as string | undefined;
        if (!signature) {
          res.status(401).json({ error: 'Missing webhook signature' });
          return;
        }
        const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
        const expected = crypto
          .createHmac('sha256', tenant.webhookSecret)
          .update(rawBody)
          .digest('hex');
        if (signature !== expected) {
          res.status(401).json({ error: 'Invalid webhook signature' });
          return;
        }
      }

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

async function processWebhook(
  tenantId: string,
  payload: HostawayWebhookPayload,
  prisma: PrismaClient
): Promise<void> {
  const { event, data } = payload;
  console.log(`[Webhook] [${tenantId}] Event: ${event}`);

  switch (event) {
    case 'message.received':
      await handleNewMessage(tenantId, data, prisma);
      break;
    case 'reservation.created':
      await handleNewReservation(tenantId, data, prisma);
      break;
    case 'reservation.modified':
    case 'reservation.updated':
      await handleReservationUpdated(tenantId, data, prisma);
      break;
    default:
      console.log(`[Webhook] [${tenantId}] Unhandled event: ${event}`);
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

  const hostawayConvId = String(data.conversationId || '');
  if (!hostawayConvId) return;

  // G2: Conversation lookup with fallback chain
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, hostawayConversationId: hostawayConvId },
    include: { reservation: true },
  });

  // Fallback: look up via reservationId when hostawayConversationId doesn't match
  if (!conversation && data.reservationId) {
    const reservation = await prisma.reservation.findUnique({
      where: {
        tenantId_hostawayReservationId: {
          tenantId,
          hostawayReservationId: String(data.reservationId),
        },
      },
    });
    if (reservation) {
      conversation = await prisma.conversation.findFirst({
        where: { tenantId, reservationId: reservation.id },
        include: { reservation: true },
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

  if (!conversation) {
    console.warn(
      `[Webhook] [${tenantId}] No conversation for conv=${hostawayConvId} res=${data.reservationId} — dropped`
    );
    return;
  }

  const hostawayMsgId = String(data.id || '');

  // Deduplicate: check if message already saved
  if (hostawayMsgId) {
    const existing = await prisma.message.findFirst({
      where: { conversationId: conversation.id, hostawayMessageId: hostawayMsgId },
    });
    if (existing) return;
  }

  // Determine the channel for this specific message (WhatsApp overrides conversation channel)
  const msgChannel = data.communicationType?.toLowerCase() === 'whatsapp'
    ? Channel.WHATSAPP
    : conversation.channel;

  // G5: Use conditional role — GUEST for incoming, HOST for outgoing
  const role = isGuest ? MessageRole.GUEST : MessageRole.HOST;

  // Save message
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

  if (isGuest) {
    // Update conversation: increment unread, update timestamp
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    });

    // Schedule AI reply if aiEnabled
    if (conversation.reservation.aiEnabled) {
      await scheduleAiReply(conversation.id, tenantId, prisma);
      console.log(`[Webhook] [${tenantId}] AI reply scheduled for conv ${conversation.id}`);
    }
  } else {
    // G5: Still update lastMessageAt for outgoing messages
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
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

// ── handleNewReservation ──────────────────────────────────────────────────────
// G1: Create Conversation if one doesn't exist
// G8: SSE broadcast for new reservations

async function handleNewReservation(
  tenantId: string,
  data: HostawayWebhookPayload['data'],
  prisma: PrismaClient
): Promise<void> {
  if (!data.reservationId && !data.id) return;

  const hostawayReservationId = String(data.reservationId || data.id);
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

  const guestName = data.guestName || 'Unknown Guest';
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
      checkIn: data.arrivalDate ? new Date(data.arrivalDate) : new Date(),
      checkOut: data.departureDate ? new Date(data.departureDate) : new Date(),
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
    },
  });

  // G1: Create Conversation if one doesn't exist for this reservation
  const existingConv = await prisma.conversation.findFirst({
    where: { tenantId, reservationId: reservation.id },
  });
  if (!existingConv) {
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
  const hostawayReservationId = String(data.reservationId || data.id || '');
  if (!hostawayReservationId) return;

  const reservation = await prisma.reservation.findUnique({
    where: { tenantId_hostawayReservationId: { tenantId, hostawayReservationId } },
  });

  // G7: Fall back to handleNewReservation if reservation doesn't exist (out-of-order)
  if (!reservation) {
    console.warn(
      `[Webhook] [${tenantId}] Reservation ${hostawayReservationId} not found for update — treating as create`
    );
    return handleNewReservation(tenantId, data, prisma);
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
    },
  });

  // G4: Cancel pending AI replies on cancellation/checkout
  if (isCancelledOrCheckedOut) {
    const convs = await prisma.conversation.findMany({
      where: { reservationId: reservation.id },
    });
    for (const c of convs) {
      await cancelPendingAiReply(c.id, prisma);
    }
  }

  // G6: Update guest info if provided
  if (data.guestName || data.guestEmail || data.guestPhone) {
    await prisma.guest.update({
      where: { id: reservation.guestId },
      data: {
        ...(data.guestName && { name: data.guestName }),
        ...(data.guestEmail && { email: data.guestEmail }),
        ...(data.guestPhone && { phone: data.guestPhone }),
      },
    });
  }

  // G8: SSE broadcast
  broadcastToTenant(tenantId, 'reservation_updated', {
    reservationId: reservation.id,
    status: newStatus,
  });

  console.log(`[Webhook] [${tenantId}] Reservation ${hostawayReservationId} updated`);
}
