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

  // ── GET /callback?token=<jwt> — bookmarklet redirect (no auth) ──────────
  router.get('/callback', async (req: any, res) => {
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
      const accountId = String(payload.accountId);

      const tenant = await prisma.tenant.findFirst({
        where: { hostawayAccountId: accountId },
        select: { id: true },
      });

      if (!tenant) {
        console.error(`[HostawayConnect] No tenant for accountId ${accountId}`);
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=no_account`);
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
