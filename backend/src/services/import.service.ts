/**
 * Import Service
 * Pulls all listings, reservations, and messages from Hostaway and upserts into DB.
 * Fully idempotent — safe to run multiple times.
 */

import { PrismaClient, Prisma, Channel, ReservationStatus, MessageRole } from '@prisma/client';
import * as hostawayService from './hostaway.service';
import { ImportResult } from '../types';
import { setProgress } from './progress.service';
import { mapHostawayChannel } from '../lib/channel-mapper';

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

const mapChannel = mapHostawayChannel;

function mapReservationStatus(status?: string): ReservationStatus {
  // SECURITY: Default to INQUIRY (most restrictive) — never default to CONFIRMED.
  // Same policy as webhooks.controller.ts mapReservationStatus().
  if (!status) return ReservationStatus.INQUIRY;
  switch (status.toLowerCase()) {
    // Inquiry lifecycle
    case 'inquiry':
    case 'inquirypreapproved':
    case 'inquirydenied':
    case 'inquirytimedout':
    case 'inquirynotpossible':
    case 'unknown':
      return ReservationStatus.INQUIRY;
    // Pending — awaiting host/payment/verification
    case 'pending':
    case 'unconfirmed':
    case 'awaitingpayment':
    case 'awaitingguestverification':
      return ReservationStatus.PENDING;
    // Active booking
    case 'new':
    case 'confirmed':
    case 'accepted':
    case 'modified':
      return ReservationStatus.CONFIRMED;
    case 'checkedin':
    case 'checked_in':
      return ReservationStatus.CHECKED_IN;
    case 'checkedout':
    case 'checked_out':
      return ReservationStatus.CHECKED_OUT;
    case 'cancelled':
    case 'canceled':
    case 'declined':
    case 'expired':
    case 'ownerstay':
      return ReservationStatus.CANCELLED;
    default:
      console.warn(`[Import] Unknown reservation status "${status}" — defaulting to INQUIRY (safe)`);
      return ReservationStatus.INQUIRY;
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

export interface ImportOptions {
  listingsOnly?: boolean;
  conversationsOnly?: boolean;
}

export async function runImport(
  tenantId: string,
  hostawayAccountId: string,
  hostawayApiKey: string,
  plan: string,
  prisma: PrismaClient,
  listingsOnlyOrOpts: boolean | ImportOptions = false,
  onProgress?: ProgressFn
): Promise<ImportResult> {
  // Support both old boolean signature and new options object
  const opts: ImportOptions = typeof listingsOnlyOrOpts === 'boolean'
    ? { listingsOnly: listingsOnlyOrOpts }
    : listingsOnlyOrOpts;
  const listingsOnly = opts.listingsOnly ?? false;
  const conversationsOnly = opts.conversationsOnly ?? false;
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

  // ── 0. Delete existing data for clean slate ──
  // Full sync: wipe everything and rebuild.
  // listingsOnly: DO NOT wipe — property.upsert is idempotent and conversations/messages
  //   must be preserved (pre-fix bug: this branch destroyed all messages when only
  //   listings were requested).
  // conversationsOnly: wipe only conversations/messages/tasks, preserve properties+reservations+guests+RAG.
  if (listingsOnly) {
    report({ phase: 'deleting', completed: 0, total: 0, message: 'Preparing listings sync (no data cleared)…' });
  } else if (conversationsOnly) {
    report({ phase: 'deleting', completed: 0, total: 0, message: 'Clearing conversations…' });
    await prisma.pendingAiReply.deleteMany({ where: { tenantId } });
    const msgIds = await prisma.message.findMany({ where: { tenantId }, select: { id: true } });
    if (msgIds.length > 0) {
      await prisma.messageRating.deleteMany({ where: { messageId: { in: msgIds.map(m => m.id) } } });
    }
    await prisma.message.deleteMany({ where: { tenantId } });
    await prisma.task.deleteMany({ where: { tenantId } });
    await prisma.conversation.deleteMany({ where: { tenantId } });
  } else {
    report({ phase: 'deleting', completed: 0, total: 0, message: 'Clearing previous data…' });
    await deleteAllData(tenantId, prisma);
  }

  // ── 1. Import listings → properties (skip for conversationsOnly) ──────────
  let listingsToImport: any[];

  if (conversationsOnly) {
    console.log(`[Import] [${tenantId}] Conversations-only mode — skipping property sync.`);
    const existingProperties = await prisma.property.findMany({
      where: { tenantId },
      select: { hostawayListingId: true },
    });
    listingsToImport = existingProperties.map(p => ({ id: Number(p.hostawayListingId) }));
  } else {
  report({ phase: 'listings', message: 'Fetching properties from Hostaway…' });
  console.log(`[Import] [${tenantId}] Fetching listings...`);
  const listingsRes = await hostawayService.listListings(hostawayAccountId, hostawayApiKey);
  const listings = listingsRes.result || [];

  listingsToImport = listings;

  for (const listing of listingsToImport) {
    const name = listing.internalListingName || listing.name || `Listing ${listing.id}`;
    const address = [listing.address, listing.city].filter(Boolean).join(', ');

    const kb: Record<string, string | number> = {};
    if (listing.internalListingName) kb.internalListingName = listing.internalListingName;
    if (listing.personCapacity) kb.personCapacity = listing.personCapacity;
    if (listing.roomType) kb.roomType = listing.roomType;
    if (listing.bedroomsNumber) kb.bedroomsNumber = listing.bedroomsNumber;
    if (listing.bathroomsNumber) kb.bathroomsNumber = listing.bathroomsNumber;
    if (listing.doorSecurityCode) kb.doorCode = listing.doorSecurityCode;
    if (listing.wifiUsername) kb.wifiName = listing.wifiUsername;
    if (listing.wifiPassword) kb.wifiPassword = listing.wifiPassword;
    if (listing.checkInTimeStart !== undefined) kb.checkInTime = formatHour(listing.checkInTimeStart);
    if (listing.checkOutTime !== undefined) kb.checkOutTime = formatHour(listing.checkOutTime);
    if (listing.houseRules) kb.houseRules = listing.houseRules;
    if (listing.specialInstruction) kb.specialInstruction = listing.specialInstruction;
    if (listing.keyPickup) kb.keyPickup = listing.keyPickup;
    // Amenities: Hostaway returns as array of objects [{amenityName: "..."}, ...] or strings
    const rawAmenities = listing.amenities ?? (listing as any).listingAmenities;
    if (rawAmenities) {
      if (Array.isArray(rawAmenities)) {
        const names = rawAmenities.map((a: any) => typeof a === 'string' ? a : (a.amenityName || a.name || a.title || JSON.stringify(a))).filter(Boolean);
        if (names.length > 0) kb.amenities = names.join(', ');
      } else {
        kb.amenities = String(rawAmenities);
      }
    }
    if (!kb.amenities) {
      // Log first listing to debug what fields are available
      if (result.properties === 0) {
        const amenityFields = Object.keys(listing).filter(k => /ameni/i.test(k));
        console.log(`[Import] Amenity-related fields on listing: ${amenityFields.join(', ') || 'none'}. Sample keys: ${Object.keys(listing).slice(0, 30).join(', ')}`);
      }
    }
    if (listing.airbnbListingUrl) kb.airbnbListingUrl = String(listing.airbnbListingUrl);
    if (listing.vrboListingUrl) kb.vrboListingUrl = String(listing.vrboListingUrl);
    if (listing.bookingEngineUrls) {
      const urls = Array.isArray(listing.bookingEngineUrls) ? listing.bookingEngineUrls : [];
      if (urls.length > 0) kb.bookingEngineUrl = String(urls[0]);
    }
    if (listing.cleaningFee) kb.cleaningFee = String(listing.cleaningFee);
    if (listing.squareMeters) kb.squareMeters = String(listing.squareMeters);
    if (listing.bedTypes) kb.bedTypes = Array.isArray(listing.bedTypes) ? (listing.bedTypes as string[]).join(', ') : String(listing.bedTypes);

    // Merge Hostaway KB into existing KB, preserving user-managed keys
    // (amenityClassifications, summarizedDescription, originalDescription, etc.)
    const USER_MANAGED_KEYS = ['amenityClassifications', 'summarizedDescription', 'originalDescription', 'variableOverrides'];
    const existing = await prisma.property.findUnique({
      where: { tenantId_hostawayListingId: { tenantId, hostawayListingId: String(listing.id) } },
      select: { customKnowledgeBase: true },
    });
    const existingKb = (existing?.customKnowledgeBase as Record<string, unknown>) || {};
    const mergedKb: Record<string, unknown> = { ...kb };
    for (const key of USER_MANAGED_KEYS) {
      if (existingKb[key] !== undefined) mergedKb[key] = existingKb[key];
    }

    const property = await prisma.property.upsert({
      where: { tenantId_hostawayListingId: { tenantId, hostawayListingId: String(listing.id) } },
      create: {
        tenantId,
        hostawayListingId: String(listing.id),
        name,
        address,
        listingDescription: listing.description || '',
        customKnowledgeBase: mergedKb as never,
      },
      update: {
        name,
        address,
        listingDescription: listing.description || '',
        customKnowledgeBase: mergedKb as never,
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

  } // end of conversationsOnly else block (property sync)

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
  // Skip dead states: cancelled, already-checked-out, and expired/denied/timed-out inquiries.
  // These exist in Hostaway forever and should not create inbox entries on re-sync.
  const DEAD_STATUSES = new Set([
    'cancelled', 'canceled', 'declined', 'expired', 'ownerstay',
    'checkedout', 'checked_out',
    'inquirytimedout', 'inquirynotpossible', 'inquirydenied', 'inquiryexpired',
  ]);
  const filteredReservations = reservations.filter(r => {
    if (!importedListingIds.has(String(r.listingMapId))) return false;
    const status = (r.status || '').toLowerCase();
    if (DEAD_STATUSES.has(status)) return false;
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
          channel: mapChannel(res.channelName, res.channelId),
          status: mapReservationStatus(res.status),
          aiEnabled: true,
          aiMode: 'copilot',
        },
        update: {
          checkIn,
          checkOut,
          guestCount: res.numberOfGuests || 1,
          channel: mapChannel(res.channelName, res.channelId),
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

  // Do not create empty conversation shells. If Hostaway has no thread for this
  // reservation, skip — the conversation will materialize via webhook when the
  // first message arrives. (Previously, every synced reservation got an empty
  // "Checked Out" inbox row even when no messages existed.)
  if (!hostawayConvId) {
    if (!conversation) return;
    // Existing conversation with no Hostaway link — nothing new to fetch.
    return;
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
        lastMessageAt: reservation.checkIn,
      },
    });
  } else if (!conversation.hostawayConversationId) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { hostawayConversationId: hostawayConvId },
    });
  }

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
