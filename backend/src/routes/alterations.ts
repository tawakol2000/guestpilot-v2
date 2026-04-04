import { Router } from 'express';
import { PrismaClient, AlterationStatus, AlterationActionType, AlterationActionStatus } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { decrypt } from '../lib/encryption';
import {
  fetchAlteration,
  acceptAlteration,
  rejectAlteration,
} from '../services/hostaway-alterations.service';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';

export function alterationsRouter(prisma: PrismaClient) {
  const router = Router();
  router.use(authMiddleware as any);

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

  // ── GET /api/reservations/:reservationId/alteration ───────────────────────

  router.get('/:reservationId/alteration', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;

      const alteration = await prisma.bookingAlteration.findUnique({
        where: { reservationId },
      });

      if (!alteration || alteration.tenantId !== tenantId) {
        res.json({ alteration: null });
        return;
      }

      res.json({
        alteration: {
          id: alteration.id,
          hostawayAlterationId: alteration.hostawayAlterationId,
          status: alteration.status,
          originalCheckIn: alteration.originalCheckIn?.toISOString() ?? null,
          originalCheckOut: alteration.originalCheckOut?.toISOString() ?? null,
          originalGuestCount: alteration.originalGuestCount,
          proposedCheckIn: alteration.proposedCheckIn?.toISOString() ?? null,
          proposedCheckOut: alteration.proposedCheckOut?.toISOString() ?? null,
          proposedGuestCount: alteration.proposedGuestCount,
          fetchError: alteration.fetchError,
          createdAt: alteration.createdAt.toISOString(),
        },
      });
    } catch (err: any) {
      console.error('[Alterations] get error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/reservations/:reservationId/alteration/accept ──────────────

  router.post('/:reservationId/alteration/accept', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;
      const userEmail = getUserEmail(req);

      const jwtResult = await getTenantDashboardJwt(tenantId, res);
      if (!jwtResult) return;

      const alteration = await prisma.bookingAlteration.findUnique({
        where: { reservationId },
      });

      if (!alteration || alteration.tenantId !== tenantId) {
        res.status(404).json({ success: false, error: 'No alteration found for this reservation' });
        return;
      }

      if (alteration.status !== AlterationStatus.PENDING) {
        res.status(400).json({ success: false, error: `Alteration status '${alteration.status}' cannot be accepted` });
        return;
      }

      const reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, tenantId },
        select: { hostawayReservationId: true },
      });
      if (!reservation) {
        res.status(404).json({ success: false, error: 'Reservation not found' });
        return;
      }

      const log = await prisma.alterationActionLog.create({
        data: {
          tenantId,
          reservationId,
          alterationId: alteration.id,
          actionType: AlterationActionType.ACCEPT,
          status: AlterationActionStatus.PENDING,
          initiatedBy: userEmail,
        },
      });

      const result = await acceptAlteration(
        jwtResult.decryptedJwt,
        reservation.hostawayReservationId,
        alteration.hostawayAlterationId,
      );

      if (result.success) {
        await Promise.all([
          prisma.alterationActionLog.update({
            where: { id: log.id },
            data: { status: AlterationActionStatus.SUCCESS, hostawayResponse: result.data as any },
          }),
          prisma.bookingAlteration.update({
            where: { id: alteration.id },
            data: { status: AlterationStatus.ACCEPTED },
          }),
        ]);
        res.json({ success: true, action: 'accept', reservationId: reservation.hostawayReservationId });
        return;
      }

      if (result.httpStatus === 401) {
        await clearDashboardJwt(tenantId);
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(403).json({ success: false, error: 'Hostaway dashboard token expired or revoked', action: 'reconnect' });
        return;
      }

      if (result.httpStatus === 409 || result.httpStatus === 400) {
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(409).json({ success: false, error: 'This alteration may have already been actioned. Please refresh to see the latest status.' });
        return;
      }

      await prisma.alterationActionLog.update({
        where: { id: log.id },
        data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
      });
      res.status(502).json({ success: false, error: result.error || 'Hostaway API error' });
    } catch (err: any) {
      console.error('[Alterations] accept error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/reservations/:reservationId/alteration/reject ──────────────

  router.post('/:reservationId/alteration/reject', async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const { reservationId } = req.params;
      const userEmail = getUserEmail(req);

      const jwtResult = await getTenantDashboardJwt(tenantId, res);
      if (!jwtResult) return;

      const alteration = await prisma.bookingAlteration.findUnique({
        where: { reservationId },
      });

      if (!alteration || alteration.tenantId !== tenantId) {
        res.status(404).json({ success: false, error: 'No alteration found for this reservation' });
        return;
      }

      if (alteration.status !== AlterationStatus.PENDING) {
        res.status(400).json({ success: false, error: `Alteration status '${alteration.status}' cannot be rejected` });
        return;
      }

      const reservation = await prisma.reservation.findFirst({
        where: { id: reservationId, tenantId },
        select: { hostawayReservationId: true },
      });
      if (!reservation) {
        res.status(404).json({ success: false, error: 'Reservation not found' });
        return;
      }

      const log = await prisma.alterationActionLog.create({
        data: {
          tenantId,
          reservationId,
          alterationId: alteration.id,
          actionType: AlterationActionType.REJECT,
          status: AlterationActionStatus.PENDING,
          initiatedBy: userEmail,
        },
      });

      const result = await rejectAlteration(
        jwtResult.decryptedJwt,
        reservation.hostawayReservationId,
        alteration.hostawayAlterationId,
      );

      if (result.success) {
        await Promise.all([
          prisma.alterationActionLog.update({
            where: { id: log.id },
            data: { status: AlterationActionStatus.SUCCESS, hostawayResponse: result.data as any },
          }),
          prisma.bookingAlteration.update({
            where: { id: alteration.id },
            data: { status: AlterationStatus.REJECTED },
          }),
        ]);
        res.json({ success: true, action: 'reject', reservationId: reservation.hostawayReservationId });
        return;
      }

      if (result.httpStatus === 401) {
        await clearDashboardJwt(tenantId);
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(403).json({ success: false, error: 'Hostaway dashboard token expired or revoked', action: 'reconnect' });
        return;
      }

      if (result.httpStatus === 422) {
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(422).json({ success: false, error: 'Rejection is not supported for this channel via the API. Please reject directly on Airbnb/Booking.com.' });
        return;
      }

      if (result.httpStatus === 409 || result.httpStatus === 400) {
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(409).json({ success: false, error: 'This alteration may have already been actioned. Please refresh to see the latest status.' });
        return;
      }

      await prisma.alterationActionLog.update({
        where: { id: log.id },
        data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
      });
      res.status(502).json({ success: false, error: result.error || 'Hostaway API error' });
    } catch (err: any) {
      console.error('[Alterations] reject error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}
