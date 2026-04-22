/**
 * Hostaway Dashboard Connection routes.
 * GET  /api/hostaway-connect/callback  — bookmarklet redirect target
 * POST /api/hostaway-connect/manual    — paste token directly
 * GET  /api/hostaway-connect/status    — connection status
 * DELETE /api/hostaway-connect         — disconnect
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { encrypt } from '../lib/encryption';
import { validateDashboardJwt } from '../services/hostaway-dashboard.service';

function getFrontendUrl(): string {
  const origins = process.env.CORS_ORIGINS;
  if (origins) {
    const first = origins.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'http://localhost:3001';
}

export function hostawayConnectRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = authMiddleware as unknown as RequestHandler;

  // ── GET /callback?token=<jwt> — bookmarklet redirect ────────────────────
  //
  // Bugfix (2026-04-23): the bookmarklet redirect target REQUIRES the
  // operator's GuestPilot session — they're the one clicking the
  // bookmarklet from a browser that's logged into both Hostaway AND
  // GuestPilot. Without this auth requirement, any unauthenticated
  // attacker who knows (or guesses) a tenant's Hostaway accountId can
  // craft a payload `{accountId, exp, userEmail}`, base64-encode it
  // into a fake JWT, hit /callback?token=<fake>, and overwrite the
  // victim tenant's stored dashboardJwt. The forged token would be
  // rejected by Hostaway when used → DoS on inquiry accept/reject
  // until the real admin re-pastes their real token. Also, the
  // attacker-controlled `userEmail` becomes `dashboardConnectedBy`
  // displayed in Settings.
  //
  // Auth-gating /callback is the right fix because:
  //  (a) The bookmarklet is run from a browser where the operator is
  //      logged into both products. The cookie / Bearer is naturally
  //      present.
  //  (b) Tenant resolution should come from req.tenantId (the JWT
  //      claim) NOT from the untrusted payload.accountId.
  //  (c) /manual already requires auth — /callback now matches.
  router.get('/callback', auth, async (req: any, res) => {
    const frontendUrl = getFrontendUrl();
    try {
      const token = req.query.token as string | undefined;
      if (!token) {
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=missing_token`);
        return;
      }

      const result = validateDashboardJwt(token);
      if (!result.valid) {
        const reason = result.error === 'Token expired' ? 'token_expired' : 'invalid_token';
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=${reason}`);
        return;
      }

      const payload = result.payload;
      // Use the AUTHENTICATED tenant id, not the untrusted payload claim.
      // We still fetch the tenant row so we can verify the JWT's accountId
      // matches what we have on file (defence in depth — catches an
      // operator who connected a bookmarklet from the wrong Hostaway
      // login).
      const tenantId = req.tenantId as string;
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, hostawayAccountId: true },
      });

      if (!tenant) {
        console.error(`[HostawayConnect] No tenant row for authenticated tenantId ${tenantId}`);
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=no_account`);
        return;
      }

      const claimedAccountId = String(payload.accountId);
      if (tenant.hostawayAccountId && tenant.hostawayAccountId !== claimedAccountId) {
        console.error(
          `[HostawayConnect] Account mismatch — tenant has ${tenant.hostawayAccountId}, token claims ${claimedAccountId}`,
        );
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=account_mismatch`);
        return;
      }

      const encryptedJwt = encrypt(token);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          dashboardJwt: encryptedJwt,
          dashboardJwtIssuedAt: payload.iat ? new Date(payload.iat * 1000) : new Date(),
          dashboardJwtExpiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
          dashboardConnectedBy: payload.userEmail || null,
        },
      });

      console.log(`[HostawayConnect] Connected for tenant ${tenant.id} by ${payload.userEmail || 'unknown'}`);
      res.redirect(`${frontendUrl}/settings?hostaway=connected`);
    } catch (err) {
      console.error('[HostawayConnect] Callback failed:', err);
      res.redirect(`${frontendUrl}/settings?hostaway=error&reason=server_error`);
    }
  });

  // ── POST /manual — paste token directly (auth required) ────────────────
  router.post('/manual', auth, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { token } = req.body;

      if (!token) {
        res.status(400).json({ success: false, error: 'Token is required' });
        return;
      }

      const validation = validateDashboardJwt(token);
      if (!validation.valid) {
        res.status(400).json({ success: false, error: validation.error || 'Invalid token' });
        return;
      }

      const payload = validation.payload;
      const encryptedJwt = encrypt(token);

      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          dashboardJwt: encryptedJwt,
          dashboardJwtIssuedAt: payload.iat ? new Date(payload.iat * 1000) : new Date(),
          dashboardJwtExpiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
          dashboardConnectedBy: payload.userEmail || 'manual',
        },
      });

      console.log(`[HostawayConnect] Connected manually for tenant ${tenantId}`);
      res.json({ success: true, connected: true });
    } catch (err) {
      console.error('[HostawayConnect] Manual connect failed:', err);
      res.status(500).json({ success: false, error: 'Failed to connect' });
    }
  });

  // ── GET /status — connection status (auth required) ─────────────────────
  router.get('/status', auth, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          dashboardJwt: true,
          dashboardJwtIssuedAt: true,
          dashboardJwtExpiresAt: true,
          dashboardConnectedBy: true,
        },
      });

      if (!tenant || !tenant.dashboardJwt) {
        res.json({ connected: false, connectedBy: null, issuedAt: null, expiresAt: null, daysRemaining: 0, warning: false });
        return;
      }

      let daysRemaining = 0;
      if (tenant.dashboardJwtExpiresAt) {
        const msRemaining = new Date(tenant.dashboardJwtExpiresAt).getTime() - Date.now();
        daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
      }

      res.json({
        connected: daysRemaining > 0,
        connectedBy: tenant.dashboardConnectedBy,
        issuedAt: tenant.dashboardJwtIssuedAt,
        expiresAt: tenant.dashboardJwtExpiresAt,
        daysRemaining,
        warning: daysRemaining > 0 && daysRemaining <= 7,
      });
    } catch (err) {
      console.error('[HostawayConnect] Status check failed:', err);
      res.status(500).json({ error: 'Failed to check connection status' });
    }
  });

  // ── DELETE / — disconnect (auth required) ───────────────────────────────
  router.delete('/', auth, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { dashboardJwt: null, dashboardJwtIssuedAt: null, dashboardJwtExpiresAt: null, dashboardConnectedBy: null },
      });
      console.log(`[HostawayConnect] Disconnected for tenant ${tenantId}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[HostawayConnect] Disconnect failed:', err);
      res.status(500).json({ error: 'Failed to disconnect' });
    }
  });

  return router;
}
