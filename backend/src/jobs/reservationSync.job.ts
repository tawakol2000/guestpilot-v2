/**
 * Reservation Sync Job — Polls Hostaway for RECENTLY CREATED reservations only.
 *
 * SAFETY: Only fetches reservations created in the last 24 hours.
 * Never imports old/historical reservations. Never triggers AI for synced messages.
 * Only creates reservations that don't already exist in our DB.
 *
 * Runs every 2 minutes.
 */

import { PrismaClient, ReservationStatus, Channel } from '@prisma/client';
import * as hostawayService from '../services/hostaway.service';
import { broadcastToTenant } from '../services/socket.service';
import { mapHostawayChannel } from '../lib/channel-mapper';

function mapStatus(status?: string): ReservationStatus {
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

const mapChannel = mapHostawayChannel;

export function startReservationSyncJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[ReservationSync] Background sync job started (interval: 120s, lookback: 24h)');

  return setInterval(async () => {
    try {
      const tenants = await prisma.tenant.findMany({
        where: { hostawayAccountId: { not: '' }, hostawayApiKey: { not: '' } },
        select: { id: true, hostawayAccountId: true, hostawayApiKey: true },
      });

      for (const tenant of tenants) {
        try {
          // SAFETY: Only fetch reservations created in the last 24 hours
          const { result: reservations } = await hostawayService.listRecentReservations(
            tenant.hostawayAccountId, tenant.hostawayApiKey, 24
          );

          if (!reservations || reservations.length === 0) continue;

          // Skip cancelled/checked-out — only import active reservations
          const activeReservations = reservations.filter(r => {
            const s = (r.status || '').toLowerCase();
            return !['cancelled', 'canceled', 'declined', 'expired', 'checkedout'].includes(s);
          });

          const existingIds = new Set(
            (await prisma.reservation.findMany({
              where: { tenantId: tenant.id },
              select: { hostawayReservationId: true },
            })).map(r => r.hostawayReservationId)
          );

          let newCount = 0;
          let updatedCount = 0;

          for (const res of activeReservations) {
            const hwResId = String(res.id);
            const status = mapStatus(res.status);

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
                  phone: res.phone || res.guestPhone || '', nationality: res.guestCountry || '',
                },
                update: { name: guestName, email: guestEmail, phone: res.phone || res.guestPhone || '', nationality: res.guestCountry || '' },
              });

              try {
                // Inherit AI mode from property's most recent reservation (so property-level toggle persists)
                let inheritedAiMode = 'copilot';
                let inheritedAiEnabled = true;
                try {
                  const recentRes = await prisma.reservation.findFirst({
                    where: { tenantId: tenant.id, propertyId: property.id },
                    orderBy: { createdAt: 'desc' },
                    select: { aiMode: true, aiEnabled: true },
                  });
                  if (recentRes) {
                    inheritedAiMode = recentRes.aiMode;
                    inheritedAiEnabled = recentRes.aiEnabled;
                    console.log(`[ReservationSync] Inherited aiMode=${inheritedAiMode} aiEnabled=${inheritedAiEnabled} from prior reservation for property ${property.id}`);
                  }
                } catch { /* fall back to defaults */ }

                const reservation = await prisma.reservation.create({
                  data: {
                    tenantId: tenant.id, propertyId: property.id, guestId: guest.id,
                    hostawayReservationId: hwResId,
                    checkIn: res.arrivalDate ? new Date(res.arrivalDate) : new Date(),
                    checkOut: res.departureDate ? new Date(res.departureDate) : new Date(),
                    guestCount: res.numberOfGuests || 1,
                    channel: mapChannel(res.channelName, res.channelId),
                    status,
                    aiEnabled: inheritedAiEnabled,
                    aiMode: inheritedAiMode,
                    totalPrice: res.totalPrice != null ? Number(res.totalPrice) : undefined,
                    hostPayout: res.hostPayout != null ? Number(res.hostPayout) : undefined,
                    cleaningFee: res.cleaningFee != null ? Number(res.cleaningFee) : undefined,
                    currency: res.currency || undefined,
                  },
                });

                // Create conversation
                try {
                  await prisma.conversation.create({
                    data: {
                      tenantId: tenant.id, reservationId: reservation.id,
                      guestId: guest.id, propertyId: property.id,
                      channel: mapChannel(res.channelName, res.channelId),
                      lastMessageAt: new Date(),
                    },
                  });
                } catch (err: any) {
                  if (err?.code !== 'P2002') throw err;
                }

                // NOTE: Do NOT sync messages or trigger AI here.
                // Messages will be picked up by the message sync job (every 2 min).
                // The message sync will schedule AI if it finds new guest messages.

                broadcastToTenant(tenant.id, 'reservation_created', { reservationId: reservation.id });
                newCount++;
              } catch (err: any) {
                if (err?.code === 'P2002') continue; // duplicate reservation, skip
                throw err;
              }

            } else {
              // EXISTING reservation — check if status/dates changed
              const existing = await prisma.reservation.findFirst({
                where: { tenantId: tenant.id, hostawayReservationId: hwResId },
                select: { id: true, status: true, checkIn: true, checkOut: true, guestCount: true },
              });
              if (!existing) continue;

              if (existing.status !== status) {
                const isCancelled = status === 'CANCELLED' || status === 'CHECKED_OUT';
                await prisma.reservation.update({
                  where: { id: existing.id },
                  data: {
                    status,
                    ...(res.arrivalDate && { checkIn: new Date(res.arrivalDate) }),
                    ...(res.departureDate && { checkOut: new Date(res.departureDate) }),
                    ...(res.numberOfGuests && { guestCount: res.numberOfGuests }),
                    ...(isCancelled && { aiEnabled: false }),
                    ...(res.totalPrice != null && { totalPrice: Number(res.totalPrice) }),
                    ...(res.hostPayout != null && { hostPayout: Number(res.hostPayout) }),
                    ...(res.cleaningFee != null && { cleaningFee: Number(res.cleaningFee) }),
                    ...(res.currency && { currency: res.currency }),
                  },
                });

                const conv = await prisma.conversation.findFirst({
                  where: { reservationId: existing.id },
                  select: { id: true },
                });
                if (conv) {
                  broadcastToTenant(tenant.id, 'reservation_updated', {
                    reservationId: existing.id,
                    conversationIds: [conv.id],
                    status,
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
