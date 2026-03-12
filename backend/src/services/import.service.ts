/**
 * Import Service
 * Pulls all listings, reservations, and messages from Hostaway and upserts into DB.
 * Fully idempotent — safe to run multiple times.
 */

import { PrismaClient, Channel, ReservationStatus, MessageRole } from '@prisma/client';
import * as hostawayService from './hostaway.service';
import { ImportResult } from '../types';
import { setProgress } from './progress.service';

type ProgressFn = (update: { phase?: string; completed?: number; total?: number; message?: string; lastSyncedAt?: string }) => void;

let _debugLoggedMessage = false;

function parseHostawayDate(val: unknown): Date {
  if (!val) return new Date();
  if (typeof val === 'number') {
    // Unix timestamp — if it's in seconds (< year 3000 in ms), multiply by 1000
    return val > 1e12 ? new Date(val) : new Date(val * 1000);
  }
  if (typeof val === 'string') {
    // Hostaway sends UTC times without timezone suffix — append Z to force UTC parsing
    const iso = val.replace(' ', 'T');
    return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  }
  return new Date();
}

const PLAN_LIMITS: Record<string, number> = {
  FREE: Infinity,
  PRO: Infinity,
  SCALE: Infinity,
};

function mapChannel(channelName?: string): Channel {
  if (!channelName) return Channel.OTHER;
  const name = channelName.toLowerCase();
  if (name.includes('airbnb')) return Channel.AIRBNB;
  if (name.includes('booking')) return Channel.BOOKING;
  if (name.includes('direct')) return Channel.DIRECT;
  return Channel.OTHER;
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
    case 'checked_in':
      return ReservationStatus.CHECKED_IN;
    case 'checkedout':
    case 'checked_out':
      return ReservationStatus.CHECKED_OUT;
    case 'cancelled':
    case 'canceled':
      return ReservationStatus.CANCELLED;
    default:
      return ReservationStatus.CONFIRMED;
  }
}

export async function deleteAllData(tenantId: string, prisma: PrismaClient): Promise<void> {
  // Delete in dependency order
  await prisma.pendingAiReply.deleteMany({ where: { tenantId } });
  // MessageRating has no tenantId — delete via message IDs
  const msgIds = await prisma.message.findMany({ where: { tenantId }, select: { id: true } });
  if (msgIds.length > 0) {
    await prisma.messageRating.deleteMany({ where: { messageId: { in: msgIds.map(m => m.id) } } });
  }
  await prisma.message.deleteMany({ where: { tenantId } });
  await prisma.knowledgeSuggestion.deleteMany({ where: { tenantId } });
  await prisma.task.deleteMany({ where: { tenantId } });
  await prisma.conversation.deleteMany({ where: { tenantId } });
  await prisma.reservation.deleteMany({ where: { tenantId } });
  await prisma.guest.deleteMany({ where: { tenantId } });
  await prisma.property.deleteMany({ where: { tenantId } });
}

export async function runImport(
  tenantId: string,
  hostawayAccountId: string,
  hostawayApiKey: string,
  plan: string,
  prisma: PrismaClient,
  listingsOnly = false,
  onProgress?: ProgressFn
): Promise<ImportResult> {
  const report = (update: Parameters<ProgressFn>[0]) => {
    setProgress(tenantId, update as Parameters<typeof setProgress>[1]);
    onProgress?.(update);
  };

  const result: ImportResult = { properties: 0, reservations: 0, messages: 0 };

  function formatHour(h: number | undefined): string {
    if (h === undefined || h === null) return '';
    if (h === 0) return '12:00 AM';
    if (h === 12) return '12:00 PM';
    return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
  }

  // ── 0. Delete existing data for clean slate ────────────────────────────────
  report({ phase: 'deleting', completed: 0, total: 0, message: 'Clearing previous data…' });
  await deleteAllData(tenantId, prisma);

  // ── 1. Import listings → properties ───────────────────────────────────────
  report({ phase: 'listings', message: 'Fetching properties from Hostaway…' });
  console.log(`[Import] [${tenantId}] Fetching listings...`);
  const listingsRes = await hostawayService.listListings(hostawayAccountId, hostawayApiKey);
  const listings = listingsRes.result || [];

  const limit = PLAN_LIMITS[plan] ?? Infinity;
  const listingsToImport = listings.slice(0, limit === Infinity ? listings.length : limit);

  for (const listing of listingsToImport) {
    const name = listing.internalListingName || listing.name || `Listing ${listing.id}`;
    const address = [listing.address, listing.city].filter(Boolean).join(', ');

    const kb: Record<string, string | number> = {};
    if (listing.doorSecurityCode) kb.doorCode = listing.doorSecurityCode;
    if (listing.wifiUsername) kb.wifiName = listing.wifiUsername;
    if (listing.wifiPassword) kb.wifiPassword = listing.wifiPassword;
    if (listing.checkInTimeStart !== undefined) kb.checkInTime = formatHour(listing.checkInTimeStart);
    if (listing.checkOutTime !== undefined) kb.checkOutTime = formatHour(listing.checkOutTime);
    if (listing.houseRules) kb.houseRules = listing.houseRules;
    if (listing.specialInstruction) kb.specialInstruction = listing.specialInstruction;
    if (listing.keyPickup) kb.keyPickup = listing.keyPickup;

    await prisma.property.upsert({
      where: { tenantId_hostawayListingId: { tenantId, hostawayListingId: String(listing.id) } },
      create: {
        tenantId,
        hostawayListingId: String(listing.id),
        name,
        address,
        listingDescription: listing.description || '',
        customKnowledgeBase: kb,
      },
      update: {
        name,
        address,
        listingDescription: listing.description || '',
        customKnowledgeBase: kb,
      },
    });
    result.properties++;
  }

  // ── 1b. Sync automated message templates from Hostaway ─────────────────────
  try {
    const { result: automatedMsgs } = await hostawayService.listAutomatedMessages(hostawayAccountId, hostawayApiKey);
    for (const am of automatedMsgs) {
      await prisma.messageTemplate.upsert({
        where: { tenantId_hostawayId: { tenantId, hostawayId: String(am.id) } },
        update: { name: am.name, body: am.body, triggerType: am.triggerType, triggerOffset: am.triggerOffset, isEnabled: am.isEnabled },
        create: { tenantId, hostawayId: String(am.id), name: am.name, body: am.body, triggerType: am.triggerType, triggerOffset: am.triggerOffset, isEnabled: am.isEnabled },
      });
    }
    console.log(`[Import] [${tenantId}] Synced ${automatedMsgs.length} automated message templates`);
  } catch (err) {
    console.warn(`[Import] [${tenantId}] Could not sync automated messages:`, err);
  }

  if (listingsOnly) {
    const now = new Date();
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { propertyCount: result.properties, lastSyncedAt: now },
    });
    report({ phase: 'done', message: `Synced ${result.properties} properties.`, lastSyncedAt: now.toISOString() });
    console.log(`[Import] [${tenantId}] Listings-only mode — done.`);
    return result;
  }

  // Update tenant propertyCount
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { propertyCount: result.properties },
  });

  console.log(`[Import] [${tenantId}] Imported ${result.properties} properties`);

  // ── 2. Import reservations ─────────────────────────────────────────────────
  report({ phase: 'reservations', message: 'Fetching reservations from Hostaway…' });
  console.log(`[Import] [${tenantId}] Fetching reservations...`);
  const reservationsRes = await hostawayService.listReservations(hostawayAccountId, hostawayApiKey);
  const reservations = reservationsRes.result || [];

  // Only import reservations for properties we imported, and skip cancelled/past ones
  const importedListingIds = new Set(listingsToImport.map(l => String(l.id)));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const filteredReservations = reservations.filter(r => {
    if (!importedListingIds.has(String(r.listingMapId))) return false;
    const status = (r.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'canceled') return false;
    // Skip past reservations (checkout already happened)
    if (r.departureDate && new Date(r.departureDate) < today) return false;
    return true;
  });
  const totalReservations = filteredReservations.length;
  let completedReservations = 0;
  report({ phase: 'messages', total: totalReservations, completed: 0, message: `Importing 0 / ${totalReservations} reservations…` });

  // Process reservations in parallel batches of 5 to stay within Hostaway rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < filteredReservations.length; i += BATCH_SIZE) {
    const batch = filteredReservations.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async res => {
      try {
      const property = await prisma.property.findUnique({
        where: { tenantId_hostawayListingId: { tenantId, hostawayListingId: String(res.listingMapId) } },
      });
      if (!property) return;

      const guestName = res.guestName || [res.guestFirstName, res.guestLastName].filter(Boolean).join(' ') || 'Unknown Guest';
      const hostawayGuestId = String(res.id);
      const guestEmail = res.guestEmail || '';
      const guestPhone = res.guestPhone || '';
      // Skip Hostaway proxy emails (they are useless — real guest email not shared)
      const realEmail = guestEmail.includes('@guest.hostaway') ? '' : guestEmail;
      const nationality = res.guestCountry || '';

      const guest = await prisma.guest.upsert({
        where: { tenantId_hostawayGuestId: { tenantId, hostawayGuestId } },
        create: {
          tenantId,
          hostawayGuestId,
          name: guestName,
          email: realEmail,
          phone: guestPhone,
          nationality,
        },
        update: {
          name: guestName,
          email: realEmail,
          phone: guestPhone,
          nationality,
        },
      });

      const checkIn = res.arrivalDate ? new Date(res.arrivalDate) : new Date();
      const checkOut = res.departureDate ? new Date(res.departureDate) : new Date();

      await prisma.reservation.upsert({
        where: { tenantId_hostawayReservationId: { tenantId, hostawayReservationId: String(res.id) } },
        create: {
          tenantId,
          propertyId: property.id,
          guestId: guest.id,
          hostawayReservationId: String(res.id),
          checkIn,
          checkOut,
          guestCount: res.numberOfGuests || 1,
          channel: mapChannel(res.channelName),
          status: mapReservationStatus(res.status),
          aiEnabled: true,
        },
        update: {
          checkIn,
          checkOut,
          guestCount: res.numberOfGuests || 1,
          channel: mapChannel(res.channelName),
          status: mapReservationStatus(res.status),
        },
      });

      result.reservations++;

      try {
        await importConversationMessages(tenantId, hostawayAccountId, hostawayApiKey, res.id, property.id, guest.id, prisma, result);
      } catch (err) {
        console.warn(`[Import] [${tenantId}] Could not import messages for reservation ${res.id}:`, err);
      }
      completedReservations++;
      report({
        phase: 'messages',
        completed: completedReservations,
        total: totalReservations,
        message: `Importing ${completedReservations} / ${totalReservations} reservations…`,
      });
      } catch (err) {
        completedReservations++;
        console.warn(`[Import] [${tenantId}] Skipped reservation ${res.id}:`, (err as Error).message);
      }
    }));
  }

  const now = new Date();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { lastSyncedAt: now },
  });

  report({ phase: 'done', completed: totalReservations, total: totalReservations, message: 'Sync complete.', lastSyncedAt: now.toISOString() });
  console.log(`[Import] [${tenantId}] Done. Properties: ${result.properties}, Reservations: ${result.reservations}, Messages: ${result.messages}`);
  return result;
}

async function importConversationMessages(
  tenantId: string,
  hostawayAccountId: string,
  hostawayApiKey: string,
  hostawayReservationId: number | string,
  propertyId: string,
  guestId: string,
  prisma: PrismaClient,
  result: ImportResult
): Promise<void> {
  const reservation = await prisma.reservation.findUnique({
    where: { tenantId_hostawayReservationId: { tenantId, hostawayReservationId: String(hostawayReservationId) } },
  });
  if (!reservation) return;

  // Always ensure a conversation exists for this reservation (even if no Hostaway thread yet)
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, reservationId: reservation.id },
  });

  // Try to get the Hostaway conversation ID
  let hostawayConvId = '';
  try {
    const convRes = await hostawayService.getConversationByReservation(hostawayAccountId, hostawayApiKey, hostawayReservationId);
    const hostawayConvs = convRes.result || [];
    if (hostawayConvs.length > 0) {
      hostawayConvId = String(hostawayConvs[0].id || hostawayConvs[0].conversationId || '');
    }
  } catch {
    // No Hostaway conversation yet — that's fine
  }

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        tenantId,
        reservationId: reservation.id,
        guestId,
        propertyId,
        channel: reservation.channel,
        hostawayConversationId: hostawayConvId,
        status: 'OPEN',
        unreadCount: 0,
        lastMessageAt: reservation.checkIn,  // sort by arrival when no messages
      },
    });
  } else if (hostawayConvId && !conversation.hostawayConversationId) {
    // Update with the Hostaway conversation ID if we now have it
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { hostawayConversationId: hostawayConvId },
    });
  }

  if (!hostawayConvId) return;

  // Fetch and import messages
  const msgsRes = await hostawayService.listConversationMessages(
    hostawayAccountId, hostawayApiKey, hostawayConvId, 100, true
  );
  const messages = msgsRes.result || [];

  if (!_debugLoggedMessage && messages.length > 0) {
    _debugLoggedMessage = true;
    console.log('[Import] Sample Hostaway message fields:', JSON.stringify(messages[0]));
  }

  for (const msg of messages) {
    if (!msg.body && !msg.id) continue;

    const hostawayMsgId = String(msg.id);
    const existing = await prisma.message.findFirst({
      where: { conversationId: conversation.id, hostawayMessageId: hostawayMsgId },
    });
    if (existing) continue;

    const role: MessageRole = msg.isIncoming === 1 ? MessageRole.GUEST : MessageRole.HOST;
    const sentAt = parseHostawayDate(msg.insertedOn ?? msg.createdAt ?? (msg as Record<string, unknown>)['date'] ?? (msg as Record<string, unknown>)['sentAt'] ?? (msg as Record<string, unknown>)['timestamp']);

    // Use per-message communicationType from Hostaway when available (whatsapp, sms, etc.)
    const commType = (msg.communicationType as string | undefined)?.toLowerCase();
    const msgChannel = commType === 'whatsapp' ? Channel.WHATSAPP : reservation.channel;

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        tenantId,
        role,
        content: msg.body || '',
        channel: msgChannel,
        communicationType: commType || 'channel',
        sentAt,
        hostawayMessageId: hostawayMsgId,
        imageUrls: (msg.imagesUrls as string[] | undefined) || [],
      },
    });
    result.messages++;
  }

  // Update lastMessageAt to most recent message
  if (messages.length > 0) {
    const latest = messages.reduce((a, b) => {
      const aTime = parseHostawayDate(a.insertedOn ?? a.createdAt).getTime();
      const bTime = parseHostawayDate(b.insertedOn ?? b.createdAt).getTime();
      return bTime > aTime ? b : a;
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: parseHostawayDate(latest.insertedOn ?? latest.createdAt) },
    });
  }
}
