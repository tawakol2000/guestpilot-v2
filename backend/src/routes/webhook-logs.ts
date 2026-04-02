import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';

export function webhookLogsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  // GET /api/webhook-logs — list webhook logs
  router.get('/', (async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const event = req.query.event as string | undefined;
      const status = req.query.status as string | undefined;

      const where: any = { tenantId };
      if (event) where.event = event;
      if (status) where.status = status;

      const logs = await prisma.webhookLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      res.json({ logs, total: logs.length });
    } catch (err) {
      console.error('[WebhookLogs] Failed:', err);
      res.status(500).json({ error: 'Failed to fetch webhook logs' });
    }
  }) as RequestHandler);

  return router;
}
