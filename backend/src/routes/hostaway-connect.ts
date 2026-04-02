/**
 * Hostaway Dashboard Connection routes.
 * GET  /api/hostaway-connect/callback  — bookmarklet redirect (no auth)
 * GET  /api/hostaway-connect/status    — connection status (auth required)
 * DELETE /api/hostaway-connect         — disconnect (auth required)
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

  // ── GET /callback?token=<jwt> — bookmarklet redirect (no auth) ──────────
  router.get('/callback', async (req: any, res) => {
    const frontendUrl = getFrontendUrl();
    try {
      const token = req.query.token as string | undefined;
      if (!token) {
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=invalid_token`);
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

      // Look up tenant by hostawayAccountId
      const tenant = await prisma.tenant.findFirst({
        where: { hostawayAccountId: accountId },
        select: { id: true },
      });

      if (!tenant) {
        console.error(`[HostawayConnect] No tenant found for accountId ${accountId}`);
        res.redirect(`${frontendUrl}/settings?hostaway=error&reason=invalid_token`);
        return;
      }

      // Encrypt token and store on tenant
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

      console.log(`[HostawayConnect] Dashboard connected for tenant ${tenant.id} by ${payload.userEmail || 'unknown'}`);
      res.redirect(`${frontendUrl}/settings?hostaway=connected`);
    } catch (err) {
      console.error('[HostawayConnect] Callback failed:', err);
      res.redirect(`${frontendUrl}/settings?hostaway=error&reason=invalid_token`);
    }
  });

  // ── GET /status — connection status (auth required) ─────────────────────
  router.get('/status', authMiddleware as unknown as RequestHandler, async (req: any, res) => {
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
        res.json({
          connected: false,
          connectedBy: null,
          issuedAt: null,
          expiresAt: null,
          daysRemaining: 0,
          warning: false,
        });
        return;
      }

      let daysRemaining = 0;
      if (tenant.dashboardJwtExpiresAt) {
        const msRemaining = new Date(tenant.dashboardJwtExpiresAt).getTime() - Date.now();
        daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
      }

      res.json({
        connected: true,
        connectedBy: tenant.dashboardConnectedBy,
        issuedAt: tenant.dashboardJwtIssuedAt,
        expiresAt: tenant.dashboardJwtExpiresAt,
        daysRemaining,
        warning: daysRemaining <= 7,
      });
    } catch (err) {
      console.error('[HostawayConnect] Status check failed:', err);
      res.status(500).json({ error: 'Failed to check connection status' });
    }
  });

  // ── DELETE / — disconnect (auth required) ───────────────────────────────
  router.delete('/', authMiddleware as unknown as RequestHandler, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          dashboardJwt: null,
          dashboardJwtIssuedAt: null,
          dashboardJwtExpiresAt: null,
          dashboardConnectedBy: null,
        },
      });

      console.log(`[HostawayConnect] Dashboard disconnected for tenant ${tenantId}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[HostawayConnect] Disconnect failed:', err);
      res.status(500).json({ error: 'Failed to disconnect' });
    }
  });

  return router;
}
