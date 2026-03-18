import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeWebhooksController } from '../controllers/webhooks.controller';
import { makeWebhookAuthMiddleware } from '../middleware/webhook-auth';
import { webhookLimiter } from '../middleware/rate-limit';

export function webhooksRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeWebhooksController(prisma);
  const webhookAuth = makeWebhookAuthMiddleware(prisma);

  // POST /webhooks/hostaway/:tenantId — rate limited + Basic Auth (FR-001, FR-014)
  router.post('/hostaway/:tenantId', webhookLimiter, webhookAuth, (req, res) => ctrl.handleHostaway(req, res));

  return router;
}
