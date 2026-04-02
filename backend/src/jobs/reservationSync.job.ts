/**
 * Reservation Sync Job — Polls Hostaway for new/updated reservations.
 *
 * Hostaway webhooks are unreliable (delays of 10-45+ minutes).
 * This job runs every 2 minutes, fetches active reservations from
 * Hostaway API, and creates/updates any missing in our DB.
 *
 * Lightweight: only fetches reservations, not messages (message sync handles that).
 */

import { PrismaClient, ReservationStatus, Channel } from '@prisma/client';
import * as hostawayService from '../services/hostaway.service';
import { broadcastToTenant } from '../services/socket.service';

function mapReservationStatus(status?: string): ReservationStatus {
  if (!status) return ReservationStatus.INQUIRY;
  switch (status.toLowerCase()) {
    case 'inquiry': case 'inquirypreapproved': case 'inquirydenied': case 'unknown':
      return ReservationStatus.INQUIRY;
    case 'pending': case 'unconfirmed': case 'awaitingpayment': case 'awaitingguestverification':
      return ReservationStatus.PENDING;
    case 'new': case 'confirmed': case 'accepted': case 'modified':
      return ReservationStatus.CONFIRMED;
    case 'checkedin':
      return ReservationStatus.CHECKED_IN;
    case 'checkedout':
      return ReservationStatus.CHECKED_OUT;
    case 'cancelled': case 'canceled': case 'declined': case 'expired':
      return ReservationStatus.CANCELLED;
    default:
      return ReservationStatus.INQUIRY;
  }
}

function mapChannel(channelName?: string): Channel {
  if (!channelName) return Channel.OTHER;
  const lower = channelName.toLowerCase();
  if (lower.includes('airbnb')) return Channel.AIRBNB;
  if (lower.includes('booking')) return Channel.BOOKING;
  if (lower.includes('whatsapp')) return Channel.WHATSAPP;
  if (lower === 'direct') return Channel.DIRECT;
  return Channel.OTHER;
}

export function startReservationSyncJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[ReservationSync] Background sync job started (interval: 120s)');

  return setInterval(async () => {
    try {
      // Get all tenants with Hostaway credentials
      const tenants = await prisma.tenant.findMany({
        where: {
          hostawayAccountId: { not: '' },
          hostawayApiKey: { not: '' },
        },
        select: { id: true, hostawayAccountId: true, hostawayApiKey: true },
      });

      for (const tenant of tenants) {
        try {
          // Fetch active reservations from Hostaway
          const { result: reservations } = await hostawayService.listReservations(
            tenant.hostawayAccountId, tenant.hostawayApiKey,
            ['new', 'confirmed', 'inquiry', 'pending']
          );

          // Get existing reservation IDs for this tenant
          const existingIds = new Set(
            (await prisma.reservation.findMany({
              where: { tenantId: tenant.id },
              select: { hostawayReservationId: true },
            })).map(r => r.hostawayReservationId)
          );

          let newCount = 0;
          let updatedCount = 0;

          for (const res of reservations) {
            const hwResId = String(res.id);
            const status = mapReservationStatus(res.status);

            if (!existingIds.has(hwResId)) {
              // NEW reservation — create it
              const property = await prisma.property.findFirst({
                where: { tenantId: tenant.id, hostawayListingId: String(res.listingMapId) },
              });
              if (!property) continue;

              const guestName = res.guestName || [res.guestFirstName, res.guestLastName].filter(Boolean).join(' ') || 'Unknown Guest';
              const guestEmail = (res.guestEmail || '').includes('@guest.hostaway') ? '' : (res.guestEmail || '');

              const guest = await prisma.guest.upsert({
                where: { tenantId_hostawayGuestId: { tenantId: tenant.id, hostawayGuestId: hwResId } },
                create: {
                  tenantId: tenant.id, hostawayGuestId: hwResId,
                  name: guestName, email: guestEmail,
                  phone: res.guestPhone || '', nationality: res.guestCountry || '',
                },
                update: { name: guestName, email: guestEmail, phone: res.guestPhone || '', nationality: res.guestCountry || '' },
              });

              const reservation = await prisma.reservation.create({
                data: {
                  tenantId: tenant.id, propertyId: property.id, guestId: guest.id,
                  hostawayReservationId: hwResId,
                  checkIn: res.arrivalDate ? new Date(res.arrivalDate) : new Date(),
                  checkOut: res.departureDate ? new Date(res.departureDate) : new Date(),
                  guestCount: res.numberOfGuests || 1,
                  channel: mapChannel(res.channelName),
                  status,
                  aiEnabled: true,
                  aiMode: property.customKnowledgeBase && (property.customKnowledgeBase as any).defaultAiMode || 'copilot',
                },
              });

              // Create conversation for the new reservation
              try {
                await prisma.conversation.create({
                  data: {
                    tenantId: tenant.id, reservationId: reservation.id,
                    guestId: guest.id, propertyId: property.id,
                    channel: mapChannel(res.channelName),
                    lastMessageAt: new Date(),
                  },
                });
              } catch (err: any) {
                if (err?.code !== 'P2002') throw err; // ignore duplicate
              }

              // Fetch messages for the new conversation
              const conv = await prisma.conversation.findFirst({
                where: { reservationId: reservation.id },
                select: { id: true, hostawayConversationId: true },
              });
              if (conv) {
                try {
                  // Get Hostaway conversation ID if not yet set
                  if (!conv.hostawayConversationId) {
                    const { result: hwConvs } = await hostawayService.getConversationByReservation(
                      tenant.hostawayAccountId, tenant.hostawayApiKey, res.id
                    );
                    const hwConvId = hwConvs?.[0]?.id || hwConvs?.[0]?.conversationId;
                    if (hwConvId) {
                      await prisma.conversation.update({
                        where: { id: conv.id },
                        data: { hostawayConversationId: String(hwConvId) },
                      });
                      // Sync messages from Hostaway
                      const { syncConversationMessages } = await import('../services/message-sync.service');
                      const syncResult = await syncConversationMessages(
                        prisma, conv.id, String(hwConvId),
                        tenant.id, tenant.hostawayAccountId, tenant.hostawayApiKey,
                        { force: true },
                      );
                      if (syncResult.newMessages > 0) {
                        console.log(`[ReservationSync] Synced ${syncResult.newMessages} messages for new reservation ${hwResId}`);
                      }
                    }
                  }
                } catch (err: any) {
                  console.warn(`[ReservationSync] Message sync failed for new reservation ${hwResId}: ${err.message}`);
                }
              }

              broadcastToTenant(tenant.id, 'reservation_created', { reservationId: reservation.id });
              newCount++;

            } else {
              // EXISTING reservation — check if status changed
              const existing = await prisma.reservation.findFirst({
                where: { tenantId: tenant.id, hostawayReservationId: hwResId },
                select: { id: true, status: true, checkIn: true, checkOut: true, guestCount: true },
              });
              if (!existing) continue;

              const needsUpdate =
                existing.status !== status ||
                (res.arrivalDate && existing.checkIn.toISOString().slice(0, 10) !== new Date(res.arrivalDate).toISOString().slice(0, 10)) ||
                (res.departureDate && existing.checkOut.toISOString().slice(0, 10) !== new Date(res.departureDate).toISOString().slice(0, 10)) ||
                (res.numberOfGuests && existing.guestCount !== res.numberOfGuests);

              if (needsUpdate) {
                const isCancelledOrCheckedOut = status === 'CANCELLED' || status === 'CHECKED_OUT';
                await prisma.reservation.update({
                  where: { id: existing.id },
                  data: {
                    status,
                    ...(res.arrivalDate && { checkIn: new Date(res.arrivalDate) }),
                    ...(res.departureDate && { checkOut: new Date(res.departureDate) }),
                    ...(res.numberOfGuests && { guestCount: res.numberOfGuests }),
                    ...(isCancelledOrCheckedOut && { aiEnabled: false }),
                  },
                });

                // Find conversation to broadcast update
                const conv = await prisma.conversation.findFirst({
                  where: { reservationId: existing.id },
                  select: { id: true },
                });
                if (conv) {
                  broadcastToTenant(tenant.id, 'reservation_updated', {
                    reservationId: existing.id,
                    conversationIds: [conv.id],
                    status,
                    ...(res.arrivalDate && { checkIn: new Date(res.arrivalDate).toISOString().slice(0, 10) }),
                    ...(res.departureDate && { checkOut: new Date(res.departureDate).toISOString().slice(0, 10) }),
                    ...(res.numberOfGuests && { guestCount: res.numberOfGuests }),
                  });
                }
                updatedCount++;
              }
            }
          }

          if (newCount > 0 || updatedCount > 0) {
            console.log(`[ReservationSync] tenant=${tenant.id} new=${newCount} updated=${updatedCount}`);
          }
        } catch (err: any) {
          console.warn(`[ReservationSync] Failed for tenant ${tenant.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error('[ReservationSync] Job cycle failed:', err.message);
    }
  }, 120_000);
}
