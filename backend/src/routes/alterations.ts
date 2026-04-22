import { Router } from 'express';
import { PrismaClient, AlterationStatus, AlterationActionType, AlterationActionStatus, MessageRole, Channel } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { broadcastToTenant } from '../services/socket.service';
import { AuthenticatedRequest } from '../types';
import { decrypt } from '../lib/encryption';
import {
  fetchAlteration,
  acceptAlteration,
  rejectAlteration,
  getAlterationStatusById,
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

  /** Map a Hostaway-side alteration status string to our enum. Returns null
   * when the value is still pending (or unrecognized — in which case we leave
   * the DB row as-is). */
  function mapHostawayAlterationStatus(raw: string): AlterationStatus | null {
    const s = raw.toLowerCase();
    if (s === 'accepted') return AlterationStatus.ACCEPTED;
    if (s === 'declined' || s === 'rejected') return AlterationStatus.REJECTED;
    if (s === 'expired' || s === 'cancelled' || s === 'canceled') return AlterationStatus.EXPIRED;
    return null;
  }

  /** Reconcile a local PENDING alteration against Hostaway. If Hostaway no
   * longer shows it as pending (accepted from their dashboard, expired, etc.)
   * update our DB status so the UI stops asking the host to action something
   * that is already resolved. Best-effort; swallows errors. */
  async function reconcileAlterationStatus(
    tenantId: string,
    alteration: { id: string; hostawayAlterationId: string; status: AlterationStatus },
    hostawayReservationId: string,
    decryptedJwt: string,
  ): Promise<AlterationStatus> {
    if (alteration.status !== AlterationStatus.PENDING) return alteration.status;
    try {
      const lookup = await getAlterationStatusById(
        decryptedJwt,
        hostawayReservationId,
        alteration.hostawayAlterationId,
      );
      let nextStatus: AlterationStatus | null = null;
      if ('notFound' in lookup) {
        // Hostaway dropped the row — treat as accepted, the most common outcome.
        nextStatus = AlterationStatus.ACCEPTED;
      } else if ('status' in lookup) {
        nextStatus = mapHostawayAlterationStatus(lookup.status);
      }
      if (nextStatus && nextStatus !== AlterationStatus.PENDING) {
        await prisma.bookingAlteration.update({
          where: { id: alteration.id },
          data: { status: nextStatus },
        });
        console.log(`[Alterations] Reconciled ${alteration.hostawayAlterationId}: PENDING → ${nextStatus}`);
        return nextStatus;
      }
    } catch (err: any) {
      console.warn(`[Alterations] Reconcile failed for ${alteration.hostawayAlterationId} (non-fatal): ${err.message}`);
    }
    return alteration.status;
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

      // Reconcile stale PENDING rows against Hostaway: when the host accepts
      // an alteration inside Hostaway directly, we never get a webhook, so the
      // DB keeps showing PENDING until a fetch hits. Best-effort — missing
      // dashboard JWT just skips the reconciliation rather than failing the GET.
      let currentStatus = alteration.status;
      if (alteration.status === AlterationStatus.PENDING) {
        const reservation = await prisma.reservation.findFirst({
          where: { id: reservationId, tenantId },
          select: { hostawayReservationId: true },
        });
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { dashboardJwt: true, dashboardJwtExpiresAt: true },
        });
        const jwtUsable = tenant?.dashboardJwt
          && (!tenant.dashboardJwtExpiresAt || tenant.dashboardJwtExpiresAt > new Date());
        if (reservation && jwtUsable && tenant?.dashboardJwt) {
          currentStatus = await reconcileAlterationStatus(
            tenantId,
            alteration,
            reservation.hostawayReservationId,
            decrypt(tenant.dashboardJwt),
          );
        }
      }

      res.json({
        alteration: {
          id: alteration.id,
          hostawayAlterationId: alteration.hostawayAlterationId,
          status: currentStatus,
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

      // Bugfix (2026-04-23): atomic claim before creating the action-log
      // row + calling Hostaway. Without this, two concurrent accept/reject
      // requests (double-tap, two tabs, accept-vs-reject race) both
      // passed the PENDING status check above and both proceeded to call
      // Hostaway + insert action-log rows. The 409 from Hostaway's
      // second call was handled gracefully but the audit log ended up
      // with two rows for what should be a single atomic action. Same
      // pattern as inquiryAction's atomic-claim fix from round 2.
      //
      // We use `updatedAt` as the optimistic-lock sentinel (Prisma's
      // @updatedAt auto-touches on every update). Only the worker
      // whose observed updatedAt matches wins the claim; others hit
      // count=0 and exit with 409.
      const claim = await prisma.bookingAlteration.updateMany({
        where: {
          id: alteration.id,
          status: AlterationStatus.PENDING,
          updatedAt: alteration.updatedAt,
        },
        // No-op self-set on hostawayAlterationId to trigger @updatedAt
        // bump without changing observable state.
        data: { hostawayAlterationId: alteration.hostawayAlterationId },
      });
      if (claim.count === 0) {
        res.status(409).json({
          success: false,
          error:
            'Alteration is being processed by another request. Refresh and try again.',
        });
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

        // Insert synthetic message so AI has context about the outcome (no AI trigger)
        insertAlterationOutcomeMessage(prisma, tenantId, reservationId, alteration, 'accepted', userEmail).catch(err =>
          console.warn('[Alterations] Failed to insert accept context message:', err),
        );

        // Broadcast for multi-device sync
        const convAccept = await prisma.conversation.findFirst({ where: { reservationId, tenantId }, select: { id: true } });
        broadcastToTenant(tenantId, 'reservation_updated', {
          reservationId,
          conversationIds: convAccept ? [convAccept.id] : [],
        });

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
        // Hostaway says this alteration is no longer pending — almost always
        // because the host accepted/declined it from Hostaway's own dashboard
        // since we rendered the card. Reconcile our DB so the next fetch
        // returns the correct status and the UI stops showing a pending card.
        const reconciled = await reconcileAlterationStatus(
          tenantId,
          alteration,
          reservation.hostawayReservationId,
          jwtResult.decryptedJwt,
        );
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(409).json({
          success: false,
          error: 'This alteration may have already been actioned. Please refresh to see the latest status.',
          reconciledStatus: reconciled,
        });
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

      // Bugfix (2026-04-23): atomic claim — same fix as the accept
      // handler above. See that comment for the rationale.
      const claim = await prisma.bookingAlteration.updateMany({
        where: {
          id: alteration.id,
          status: AlterationStatus.PENDING,
          updatedAt: alteration.updatedAt,
        },
        data: { hostawayAlterationId: alteration.hostawayAlterationId },
      });
      if (claim.count === 0) {
        res.status(409).json({
          success: false,
          error:
            'Alteration is being processed by another request. Refresh and try again.',
        });
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

        // Insert synthetic message so AI has context about the outcome (no AI trigger)
        insertAlterationOutcomeMessage(prisma, tenantId, reservationId, alteration, 'rejected', userEmail).catch(err =>
          console.warn('[Alterations] Failed to insert reject context message:', err),
        );

        // Broadcast for multi-device sync
        const convReject = await prisma.conversation.findFirst({ where: { reservationId, tenantId }, select: { id: true } });
        broadcastToTenant(tenantId, 'reservation_updated', {
          reservationId,
          conversationIds: convReject ? [convReject.id] : [],
        });

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
        // See accept branch for rationale — reconcile DB before returning.
        const reconciled = await reconcileAlterationStatus(
          tenantId,
          alteration,
          reservation.hostawayReservationId,
          jwtResult.decryptedJwt,
        );
        await prisma.alterationActionLog.update({
          where: { id: log.id },
          data: { status: AlterationActionStatus.FAILED, errorMessage: result.error },
        });
        res.status(409).json({
          success: false,
          error: 'This alteration may have already been actioned. Please refresh to see the latest status.',
          reconciledStatus: reconciled,
        });
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

/**
 * Insert a silent context message into the conversation so the AI (and summaries)
 * know the alteration outcome. Does NOT trigger the AI pipeline.
 */
async function insertAlterationOutcomeMessage(
  prisma: PrismaClient,
  tenantId: string,
  reservationId: string,
  alteration: {
    originalCheckIn: Date | null;
    originalCheckOut: Date | null;
    originalGuestCount: number | null;
    proposedCheckIn: Date | null;
    proposedCheckOut: Date | null;
    proposedGuestCount: number | null;
  },
  outcome: 'accepted' | 'rejected',
  userEmail: string,
): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { reservationId, tenantId },
    select: { id: true, channel: true },
  });
  if (!conversation) return;

  const fmtD = (d: Date | null) => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const who = userEmail.split('@')[0];

  let content: string;
  if (outcome === 'accepted') {
    const lines = [`[System: Booking alteration ACCEPTED by ${who}.`];
    if (alteration.proposedCheckIn || alteration.proposedCheckOut) {
      lines.push(`Updated dates: ${fmtD(alteration.proposedCheckIn)} – ${fmtD(alteration.proposedCheckOut)}.`);
    }
    if (alteration.proposedGuestCount !== null) {
      lines.push(`Guests: ${alteration.proposedGuestCount}.`);
    }
    lines[lines.length - 1] += ']';
    content = lines.join(' ');
  } else {
    content = `[System: Booking alteration REJECTED by ${who}. Original dates kept: ${fmtD(alteration.originalCheckIn)} – ${fmtD(alteration.originalCheckOut)}.]`;
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      tenantId,
      role: MessageRole.HOST,
      content,
      channel: conversation.channel,
      communicationType: 'system',
      sentAt: new Date(),
      hostawayMessageId: `alteration-${outcome}-${Date.now()}`,
    },
  });
  console.log(`[Alterations] Inserted ${outcome} context message in conv ${conversation.id}`);
}
