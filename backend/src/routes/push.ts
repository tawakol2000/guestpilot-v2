import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { getVapidPublicKey, subscribe, unsubscribe } from '../services/push.service';

const iosRegisterSchema = z.object({
  deviceToken: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid APNs token format'),
  deviceId: z.string().optional(),
});

const iosDeleteSchema = z.object({
  deviceToken: z.string().min(1, 'deviceToken required'),
});

export function pushRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /api/push/vapid-public-key — no auth required
  router.get('/vapid-public-key', (_req, res) => {
    const publicKey = getVapidPublicKey();
    if (!publicKey) {
      res.status(503).json({ error: 'Push notifications not configured' });
      return;
    }
    res.json({ publicKey });
  });

  // Auth required for subscribe/unsubscribe
  router.use(authMiddleware as unknown as RequestHandler);

  // POST /api/push/subscribe
  router.post('/subscribe', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { subscription } = req.body;
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        res.status(400).json({ error: 'Invalid subscription object — needs endpoint, keys.p256dh, keys.auth' });
        return;
      }
      const userAgent = req.headers['user-agent'] || '';
      await subscribe(tenantId, subscription, userAgent, prisma);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Push] Subscribe failed:', err);
      res.status(500).json({ error: 'Failed to subscribe' });
    }
  });

  // DELETE /api/push/subscribe
  router.delete('/subscribe', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { endpoint } = req.body;
      if (!endpoint) {
        res.status(400).json({ error: 'Missing endpoint' });
        return;
      }
      await unsubscribe(tenantId, endpoint, prisma);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Push] Unsubscribe failed:', err);
      res.status(500).json({ error: 'Failed to unsubscribe' });
    }
  });

  // POST /api/push/ios-token — register/refresh an APNs device token
  router.post('/ios-token', async (req: any, res) => {
    const parse = iosRegisterSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }
    try {
      const tenantId = req.tenantId as string;
      const { deviceToken, deviceId } = parse.data;
      await prisma.iosPushToken.upsert({
        where: { tenantId_deviceToken: { tenantId, deviceToken } },
        create: { tenantId, deviceToken, deviceId: deviceId ?? null },
        update: { lastUsedAt: new Date(), deviceId: deviceId ?? null },
      });
      console.log(`[APNs] Registered iOS token for tenant ${tenantId}: ${deviceToken.slice(0, 12)}…`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[APNs] ios-token register failed:', err);
      res.status(500).json({ error: 'Failed to register iOS token' });
    }
  });

  // DELETE /api/push/ios-token — remove an APNs device token
  router.delete('/ios-token', async (req: any, res) => {
    const parse = iosDeleteSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0].message });
      return;
    }
    try {
      const tenantId = req.tenantId as string;
      const { deviceToken } = parse.data;
      await prisma.iosPushToken.deleteMany({ where: { tenantId, deviceToken } });
      console.log(`[APNs] Removed iOS token for tenant ${tenantId}: ${deviceToken.slice(0, 12)}…`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[APNs] ios-token delete failed:', err);
      res.status(500).json({ error: 'Failed to remove iOS token' });
    }
  });

  return router;
}
