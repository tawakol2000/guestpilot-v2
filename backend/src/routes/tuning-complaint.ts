/**
 * Feature 041 sprint 02 §5 trigger 3 routes.
 *   POST /api/tuning/complaints
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningComplaintController } from '../controllers/tuning-complaint.controller';

export function tuningComplaintRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const ctrl = makeTuningComplaintController(prisma);

  router.post('/complaints', (req: any, res) => ctrl.create(req, res));

  return router;
}
