/**
 * Hostaway Dashboard Connection routes.
 * POST /api/hostaway-connect/login      — start login via headless browser (auth required)
 * POST /api/hostaway-connect/verify-2fa — complete 2FA verification (auth required)
 * GET  /api/hostaway-connect/status     — connection status (auth required)
 * DELETE /api/hostaway-connect          — disconnect (auth required)
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { encrypt } from '../lib/encryption';
import { validateDashboardJwt } from '../services/hostaway-dashboard.service';
import { loginToHostaway, verify2fa } from '../services/hostaway-login.service';

export function hostawayConnectRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = authMiddleware as unknown as RequestHandler;

  // ── POST /login — start headless browser login ──────────────────────────
  router.post('/login', auth, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({ success: false, error: 'Email and password are required' });
        return;
      }

      const result = await loginToHostaway(email, password);

      if (!result.success) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      // 2FA required — return session for user to verify
      if (result.pending2fa) {
        res.json({ success: true, pending2fa: true, sessionId: result.sessionId });
        return;
      }

      // Login succeeded — validate and store JWT
      if (!result.jwt) {
        res.status(500).json({ success: false, error: 'No token received' });
        return;
      }

      const validation = validateDashboardJwt(result.jwt);
      if (!validation.valid) {
        res.status(500).json({ success: false, error: 'Received invalid token' });
        return;
      }

      const payload = validation.payload;
      const encryptedJwt = encrypt(result.jwt);

      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          dashboardJwt: encryptedJwt,
          dashboardJwtIssuedAt: payload.iat ? new Date(payload.iat * 1000) : new Date(),
          dashboardJwtExpiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
          dashboardConnectedBy: result.userEmail || email,
        },
      });

      console.log(`[HostawayConnect] Dashboard connected for tenant ${tenantId} by ${result.userEmail || email}`);
      res.json({ success: true, connected: true });
    } catch (err) {
      console.error('[HostawayConnect] Login failed:', err);
      res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
    }
  });

  // ── POST /verify-2fa — complete 2FA after user clicks email link ────────
  router.post('/verify-2fa', auth, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({ success: false, error: 'Session ID is required' });
        return;
      }

      const result = await verify2fa(sessionId);

      if (!result.success) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      if (!result.jwt) {
        res.status(500).json({ success: false, error: 'No token received' });
        return;
      }

      const validation = validateDashboardJwt(result.jwt);
      if (!validation.valid) {
        res.status(500).json({ success: false, error: 'Received invalid token' });
        return;
      }

      const payload = validation.payload;
      const encryptedJwt = encrypt(result.jwt);

      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          dashboardJwt: encryptedJwt,
          dashboardJwtIssuedAt: payload.iat ? new Date(payload.iat * 1000) : new Date(),
          dashboardJwtExpiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
          dashboardConnectedBy: result.userEmail || null,
        },
      });

      console.log(`[HostawayConnect] 2FA verified, dashboard connected for tenant ${tenantId}`);
      res.json({ success: true, connected: true });
    } catch (err) {
      console.error('[HostawayConnect] 2FA verification failed:', err);
      res.status(500).json({ success: false, error: 'Verification failed. Please try again.' });
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

  // ── POST /manual — connect with a manually-pasted JWT token ─────────────
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

      console.log(`[HostawayConnect] Dashboard connected manually for tenant ${tenantId}`);
      res.json({ success: true, connected: true });
    } catch (err) {
      console.error('[HostawayConnect] Manual connect failed:', err);
      res.status(500).json({ success: false, error: 'Failed to connect' });
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
      console.log(`[HostawayConnect] Dashboard disconnected for tenant ${tenantId}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[HostawayConnect] Disconnect failed:', err);
      res.status(500).json({ error: 'Failed to disconnect' });
    }
  });

  return router;
}
