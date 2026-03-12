import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeWebhooksController } from '../controllers/webhooks.controller';

export function webhooksRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeWebhooksController(prisma);

  // POST /webhooks/hostaway/:tenantId
  router.post('/hostaway/:tenantId', (req, res) => ctrl.handleHostaway(req, res));

  return router;
}
