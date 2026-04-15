/**
 * Feature 041 sprint 02 routes for the complaint trigger and the
 * category-stats read endpoint (both under /api/tuning).
 *   POST /api/tuning/complaints
 *   GET  /api/tuning/category-stats
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningComplaintController } from '../controllers/tuning-complaint.controller';
import { makeTuningCategoryStatsController } from '../controllers/tuning-category-stats.controller';

export function tuningComplaintRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const complaintCtrl = makeTuningComplaintController(prisma);
  const statsCtrl = makeTuningCategoryStatsController(prisma);

  router.post('/complaints', (req: any, res) => complaintCtrl.create(req, res));
  router.get('/category-stats', (req: any, res) => statsCtrl.list(req, res));

  return router;
}
