/**
 * Feature 041 sprint 03 — aggregated route mounts for the /tuning surface:
 *   GET    /api/tuning/coverage
 *   GET    /api/tuning/graduation-metrics
 *   GET    /api/tuning/history
 *   POST   /api/tuning/history/rollback
 *   GET    /api/evidence-bundles/:id
 *   GET    /api/capability-requests
 *   PATCH  /api/capability-requests/:id
 *   POST   /api/tuning-suggestions/:id/accept-tool-config  (mounted by tuning-suggestion route)
 *
 * Mounts are additive to the existing routers; nothing else is affected.
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningDashboardsController } from '../controllers/tuning-dashboards.controller';
import { makeTuningHistoryController } from '../controllers/tuning-history.controller';
import { makeEvidenceBundleController } from '../controllers/evidence-bundle.controller';
import { makeCapabilityRequestController } from '../controllers/capability-request.controller';

export function tuningDashboardsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);
  const ctrl = makeTuningDashboardsController(prisma);
  router.get('/coverage', (req: any, res) => ctrl.coverage(req, res));
  router.get('/graduation-metrics', (req: any, res) => ctrl.graduationMetrics(req, res));
  return router;
}

export function tuningHistoryRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);
  const ctrl = makeTuningHistoryController(prisma);
  router.get('/history', (req: any, res) => ctrl.list(req, res));
  router.post('/history/rollback', (req: any, res) => ctrl.rollback(req, res));
  return router;
}

export function evidenceBundleRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);
  const ctrl = makeEvidenceBundleController(prisma);
  router.get('/:id', (req: any, res) => ctrl.get(req, res));
  return router;
}

export function capabilityRequestsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);
  const ctrl = makeCapabilityRequestController(prisma);
  router.get('/', (req: any, res) => ctrl.list(req, res));
  router.patch('/:id', (req: any, res) => ctrl.update(req, res));
  return router;
}
