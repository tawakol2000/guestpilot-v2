/**
 * Tuning Edit Queue routes (2026-05-17).
 *   GET    /api/tuning-queue?bucket=pending|analyzed|all&limit=N
 *   POST   /api/tuning-queue/:id/analyze
 *   POST   /api/tuning-queue/:id/dismiss
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningQueueController } from '../controllers/tuning-queue.controller';

export function tuningQueueRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const ctrl = makeTuningQueueController(prisma);

  router.get('/', (req: any, res) => ctrl.list(req, res));
  router.post('/:id/analyze', (req: any, res) => ctrl.analyze(req, res));
  router.post('/:id/dismiss', (req: any, res) => ctrl.dismiss(req, res));

  return router;
}
