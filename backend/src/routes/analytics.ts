import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeAnalyticsController } from '../controllers/analytics.controller';
import { AuthenticatedRequest } from '../types';

export function analyticsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeAnalyticsController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);
  router.get('/', ((req, res) => ctrl.get(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  return router;
}
