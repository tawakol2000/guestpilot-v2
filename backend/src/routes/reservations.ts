import { Router } from 'express';
import { PrismaClient, ReservationStatus } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest, JwtPayload } from '../types';
import { decrypt } from '../lib/encryption';
import {
  approveReservation,
  rejectReservation,
  cancelReservation,
} from '../services/hostaway-dashboard.service';
import jwt from 'jsonwebtoken';

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

  // ── Inquiry action helpers ─────────────────────────────────────────

  /** Extract the logged-in user's email from the Authorization header JWT. */
  function getUserEmail(req: any): string {
    const token = (req.headers.authorization || '').slice(7);
    const payload = jwt.decode(token) as JwtPayload | null;
    return payload?.email || 'unknown';
  }

  /** Load tenant and validate dashboardJwt is present + not expired. */
  async function getTenantDashboardJwt(tenantId: string, res: any): Promise<{ decryptedJwt: string } | null> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { dashboardJwt: true, dashboardJwtExpiresAt: true },
    });

    if (!tenant?.dashboardJwt) {
      res.status(403).json({ success: false, error: 'Hostaway dashboard not connected', action: 'reconnect' });
      return null;
    }

    if (tenant.dashboardJwtExpiresAt && tenant.dashboardJwtExpiresAt < new Date()) {
      res.status(403).json({ success: false, error: 'Hostaway dashboard connection expired', action: 'reconnect' });
      return null;
    }

    const decryptedJwt = decrypt(tenant.dashboardJwt);
    return { decryptedJwt };
  }

  /** Clear dashboard JWT fields when Hostaway returns 401 (token invalidated). */
  async function clearDashboardJwt(tenantId: string): Promise<void> {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { dashboardJwt: null, dashboardJwtIssuedAt: null, dashboardJwtExpiresAt: null },
    });
  }

  // ── POST /api/reservations/:reservationId/approve ─────────────────

  router.post('/:reservationId/approve', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;
      const userEmail = getUserEmail(req);

      // Validate dashboard connection
      const jwtResult = await getTenantDashboardJwt(tenantId, res);
      if (!jwtResult) return;

      // Load & validate reservation
      const reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, tenantId },
      });
      if (!reservation) {
        res.status(404).json({ success: false, error: 'Reservation not found' });
        return;
      }
      if (reservation.status !== ReservationStatus.INQUIRY && reservation.status !== ReservationStatus.PENDING) {
        res.status(400).json({ success: false, error: `Reservation status '${reservation.status}' cannot be approved` });
        return;
      }

      // Create audit log
      const log = await prisma.inquiryActionLog.create({
        data: {
          tenantId,
          reservationId,
          actionType: 'APPROVE',
          status: 'PENDING',
          initiatedBy: userEmail,
        },
      });

      // Call Hostaway dashboard API
      const result = await approveReservation(jwtResult.decryptedJwt, reservation.hostawayReservationId);

      if (result.success) {
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'SUCCESS', hostawayResponse: result.data as any },
        });
        res.json({ success: true, action: 'approve', reservationId: reservation.hostawayReservationId, previousStatus: reservation.status });
        return;
      }

      // Token invalidated by Hostaway
      if (result.httpStatus === 401) {
        await clearDashboardJwt(tenantId);
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', errorMessage: result.error },
        });
        res.status(403).json({ success: false, error: 'Hostaway dashboard token expired or revoked', action: 'reconnect' });
        return;
      }

      // Already performed externally or other conflict
      if (result.httpStatus === 409 || result.httpStatus === 400) {
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', errorMessage: result.error },
        });
        res.status(409).json({ success: false, error: 'This inquiry may have already been actioned. Please refresh to see the latest status.' });
        return;
      }

      // Other failure
      await prisma.inquiryActionLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', errorMessage: result.error },
      });
      res.status(502).json({ success: false, error: result.error || 'Hostaway API error' });
    } catch (err: any) {
      console.error('[Reservations] approve error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/reservations/:reservationId/reject ──────────────────

  router.post('/:reservationId/reject', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;
      const userEmail = getUserEmail(req);

      const jwtResult = await getTenantDashboardJwt(tenantId, res);
      if (!jwtResult) return;

      const reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, tenantId },
      });
      if (!reservation) {
        res.status(404).json({ success: false, error: 'Reservation not found' });
        return;
      }
      if (reservation.status !== ReservationStatus.INQUIRY && reservation.status !== ReservationStatus.PENDING) {
        res.status(400).json({ success: false, error: `Reservation status '${reservation.status}' cannot be rejected` });
        return;
      }

      const log = await prisma.inquiryActionLog.create({
        data: {
          tenantId,
          reservationId,
          actionType: 'REJECT',
          status: 'PENDING',
          initiatedBy: userEmail,
        },
      });

      const result = await rejectReservation(jwtResult.decryptedJwt, reservation.hostawayReservationId);

      if (result.success) {
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'SUCCESS', hostawayResponse: result.data as any },
        });
        res.json({ success: true, data: result.data });
        return;
      }

      if (result.httpStatus === 401) {
        await clearDashboardJwt(tenantId);
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', errorMessage: result.error },
        });
        res.status(403).json({ success: false, error: 'Hostaway dashboard token expired or revoked', action: 'reconnect' });
        return;
      }

      // Channel limitation (e.g. Booking.com doesn't allow reject via API)
      if (result.httpStatus === 422) {
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', errorMessage: result.error },
        });
        res.status(422).json({ success: false, error: result.error || 'Rejection not supported for this channel' });
        return;
      }

      await prisma.inquiryActionLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', errorMessage: result.error },
      });
      res.status(502).json({ success: false, error: result.error || 'Hostaway API error' });
    } catch (err: any) {
      console.error('[Reservations] reject error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/reservations/:reservationId/cancel ──────────────────

  router.post('/:reservationId/cancel', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;
      const userEmail = getUserEmail(req);

      const jwtResult = await getTenantDashboardJwt(tenantId, res);
      if (!jwtResult) return;

      const reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, tenantId },
      });
      if (!reservation) {
        res.status(404).json({ success: false, error: 'Reservation not found' });
        return;
      }
      if (reservation.status === ReservationStatus.CANCELLED) {
        res.status(400).json({ success: false, error: 'Reservation is already cancelled' });
        return;
      }

      const log = await prisma.inquiryActionLog.create({
        data: {
          tenantId,
          reservationId,
          actionType: 'CANCEL',
          status: 'PENDING',
          initiatedBy: userEmail,
        },
      });

      const result = await cancelReservation(jwtResult.decryptedJwt, reservation.hostawayReservationId);

      if (result.success) {
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'SUCCESS', hostawayResponse: result.data as any },
        });
        res.json({ success: true, data: result.data });
        return;
      }

      if (result.httpStatus === 401) {
        await clearDashboardJwt(tenantId);
        await prisma.inquiryActionLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', errorMessage: result.error },
        });
        res.status(403).json({ success: false, error: 'Hostaway dashboard token expired or revoked', action: 'reconnect' });
        return;
      }

      await prisma.inquiryActionLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', errorMessage: result.error },
      });
      res.status(502).json({ success: false, error: result.error || 'Hostaway API error' });
    } catch (err: any) {
      console.error('[Reservations] cancel error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/reservations/:reservationId/last-action ──────────────

  router.get('/:reservationId/last-action', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;

      const log = await prisma.inquiryActionLog.findFirst({
        where: { tenantId, reservationId },
        orderBy: { createdAt: 'desc' },
      });

      if (!log) {
        res.json({ lastAction: null });
        return;
      }

      res.json({
        lastAction: {
          action: log.actionType,
          initiatedBy: log.initiatedBy,
          createdAt: log.createdAt,
          status: log.status,
        },
      });
    } catch (err: any) {
      console.error('[Reservations] last-action error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}
