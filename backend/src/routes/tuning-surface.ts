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
import { makePreferencePairController } from '../controllers/preference-pair.controller';

export function tuningDashboardsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);
  const ctrl = makeTuningDashboardsController(prisma);
  router.get('/coverage', (req: any, res) => ctrl.coverage(req, res));
  router.get('/graduation-metrics', (req: any, res) => ctrl.graduationMetrics(req, res));
  // Sprint 05 §4: % of last-14d accepts retained at 7d.
  router.get('/retention-summary', (req: any, res) => ctrl.retentionSummary(req, res));
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

// Sprint 08 §3: read-only viewer for the D2 preference-pair training signal.
// Mounted under /api/tuning so it shares the tuning-surface auth + namespace.
export function preferencePairsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);
  const ctrl = makePreferencePairController(prisma);
  // Order matters — /stats must win over /:id so that the literal route is
  // reached before the param route. Express resolves top-down.
  router.get('/preference-pairs', (req: any, res) => ctrl.list(req, res));
  router.get('/preference-pairs/stats', (req: any, res) => ctrl.stats(req, res));
  router.get('/preference-pairs/:id', (req: any, res) => ctrl.get(req, res));
  return router;
}
