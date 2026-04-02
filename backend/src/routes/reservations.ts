import { Router } from 'express';
import { PrismaClient, ReservationStatus } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';

const ACTIVE_STATUSES: ReservationStatus[] = [
  ReservationStatus.INQUIRY,
  ReservationStatus.PENDING,
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
];

export function reservationsRouter(prisma: PrismaClient) {
  const router = Router();
  router.use(authMiddleware as any);

  /**
   * GET /api/reservations?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&propertyId=&status=
   * Returns reservations overlapping the date range with guest + conversation data.
   */
  router.get('/', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { startDate, endDate, propertyId, status } = req.query as Record<string, string | undefined>;

      if (!startDate || !endDate) {
        res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
        return;
      }

      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
        return;
      }
      if (start > end) {
        res.status(400).json({ error: 'startDate must be before endDate' });
        return;
      }

      // Parse status filter or use active statuses by default
      let statusFilter: ReservationStatus[];
      if (status) {
        statusFilter = status.split(',').map(s => s.trim()) as ReservationStatus[];
      } else {
        statusFilter = ACTIVE_STATUSES;
      }

      const where: any = {
        tenantId,
        status: { in: statusFilter },
        // Overlap query: reservation overlaps with [startDate, endDate]
        checkIn: { lte: end },
        checkOut: { gte: start },
      };
      if (propertyId) {
        where.propertyId = propertyId;
      }

      const reservations = await prisma.reservation.findMany({
        where,
        orderBy: { checkIn: 'asc' },
        include: {
          guest: { select: { id: true, name: true } },
          conversations: { select: { id: true }, take: 1 },
        },
      });

      res.json({
        reservations: reservations.map(r => ({
          id: r.id,
          propertyId: r.propertyId,
          hostawayReservationId: r.hostawayReservationId,
          checkIn: r.checkIn.toISOString(),
          checkOut: r.checkOut.toISOString(),
          guestCount: r.guestCount,
          channel: r.channel,
          status: r.status,
          totalPrice: r.totalPrice ? Number(r.totalPrice) : null,
          hostPayout: r.hostPayout ? Number(r.hostPayout) : null,
          cleaningFee: r.cleaningFee ? Number(r.cleaningFee) : null,
          currency: r.currency,
          guest: r.guest,
          conversationId: r.conversations[0]?.id || null,
        })),
      });
    } catch (err: any) {
      console.error('[Reservations] list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/reservations/cleanup-orphans
   * Finds all reservations for the tenant, checks each against Hostaway,
   * and deletes any that don't exist in Hostaway (test/fake data).
   */
  router.delete('/cleanup-orphans', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { hostawayAccountId: true, hostawayApiKey: true },
      });
      if (!tenant?.hostawayAccountId || !tenant?.hostawayApiKey) {
        res.status(400).json({ error: 'Hostaway not configured' });
        return;
      }

      // Fetch ALL Hostaway reservations to build valid ID set
      const { result: hwReservations } = await (await import('../services/hostaway.service')).listReservations(
        tenant.hostawayAccountId, tenant.hostawayApiKey
      );
      const validIds = new Set((hwReservations || []).map((r: any) => String(r.id)));

      // Find local reservations not in Hostaway
      const localReservations = await prisma.reservation.findMany({
        where: { tenantId },
        select: { id: true, hostawayReservationId: true },
      });

      const orphans = localReservations.filter(r => !validIds.has(r.hostawayReservationId));

      let deleted = 0;
      for (const orphan of orphans) {
        const conv = await prisma.conversation.findFirst({
          where: { reservationId: orphan.id },
          select: { id: true },
        });
        if (conv) {
          await prisma.task.deleteMany({ where: { conversationId: conv.id } });
          await prisma.pendingAiReply.deleteMany({ where: { conversationId: conv.id } });
          await prisma.message.deleteMany({ where: { conversationId: conv.id } });
        }
        await prisma.conversation.deleteMany({ where: { reservationId: orphan.id } });
        await prisma.reservation.delete({ where: { id: orphan.id } });
        deleted++;
      }

      console.log(`[Cleanup] Deleted ${deleted} orphan reservations for tenant ${tenantId}`);
      res.json({ ok: true, deleted, total: localReservations.length });
    } catch (err: any) {
      console.error('[Reservations] cleanup-orphans error:', err);
      res.status(500).json({ error: 'Cleanup failed' });
    }
  });

  return router;
}
