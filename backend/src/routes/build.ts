/**
 * /api/build/* routes (sprint 045, Gate 5).
 *
 * Hard switch: the entire router is gated behind `ENABLE_BUILD_MODE`. If
 * the env var is unset / falsy, every path under `/api/build/*` returns
 * 404 — the BUILD surface is unreachable in production until the flag
 * is flipped on (after Gate 7 passes per spec §"Out of scope").
 *
 * The 404 (rather than 403/501) is deliberate: production crawlers and
 * security scans should see no evidence the route family exists. This
 * matches the spec's "feature flag default off in all environments"
 * constraint.
 *
 * All routes are JWT-gated (reuse existing `authMiddleware`) and tenant-
 * scoped via `req.tenantId` populated by that middleware.
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeBuildController } from '../controllers/build-controller';
import { isBuildModeEnabled } from '../build-tune-agent/config';

export function buildRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Hard 404 gate — must run BEFORE auth, so an unauthenticated probe
  // still gets a generic 404 and can't infer the route exists from the
  // 401 it would otherwise see.
  router.use((_req, res, next) => {
    if (!isBuildModeEnabled()) {
      res.status(404).json({ error: `No route: ${_req.method} ${_req.path}` });
      return;
    }
    next();
  });

  router.use(authMiddleware as unknown as RequestHandler);

  const ctl = makeBuildController(prisma);

  router.get('/tenant-state', (req: any, res) => ctl.tenantState(req, res));
  router.get('/capabilities', (req: any, res) => ctl.capabilities(req, res));
  router.get('/traces', (req: any, res) => ctl.listTraces(req, res));
  // Sprint 047 Session C — admin-only raw-prompt editor read-through.
  router.get('/system-prompt', (req: any, res) =>
    ctl.getSystemPrompt(req, res)
  );
  router.post('/turn', (req: any, res) => ctl.turn(req, res));
  // Sprint 056-A F1 — compose-at-cursor span edit endpoint.
  router.post('/compose-span', (req: any, res) => ctl.composeSpan(req, res));
  router.post('/plan/:id/approve', (req: any, res) => ctl.approvePlan(req, res));
  router.post('/plan/:id/rollback', (req: any, res) => ctl.rollbackPlan(req, res));
  // Sprint 046 Session C — thin accept/reject proxies for Studio cards.
  router.post('/suggested-fix/:fixId/accept', (req: any, res) =>
    ctl.acceptSuggestedFix(req, res)
  );
  router.post('/suggested-fix/:fixId/reject', (req: any, res) =>
    ctl.rejectSuggestedFix(req, res)
  );
  // Sprint 051 A B1 — artifact drawer read-seam.
  router.get('/artifact/:type/:id', (req: any, res) =>
    ctl.getArtifact(req, res)
  );
  // Sprint 053-A D3 — admin-only Preview/Apply endpoint for the drawer.
  router.post('/artifacts/:type/:id/apply', (req: any, res) =>
    ctl.applyArtifact(req, res)
  );
  // Sprint 053-A D4 — write-ledger list + revert endpoints.
  // Note: `/artifacts/history` must be declared BEFORE `/artifacts/:type/:id/apply`
  //        to avoid the latter matching `history` as a type. Express matches in
  //        order, so keeping list path above apply is sufficient.
  router.get('/artifacts/history', (req: any, res) =>
    ctl.listArtifactHistory(req, res)
  );
  router.post('/artifacts/history/:historyId/revert', (req: any, res) =>
    ctl.revertArtifactFromHistory(req, res)
  );

  // Sprint 058-A F8 — Nano-backed composer draft rewrite.
  router.post('/enhance-prompt', (req: any, res) =>
    ctl.enhancePrompt(req, res)
  );

  return router;
}
