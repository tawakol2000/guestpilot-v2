import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getVapidPublicKey, subscribe, unsubscribe } from '../services/push.service';

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

  return router;
}
