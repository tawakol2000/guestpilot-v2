/**
 * Feature 040 + 041 sprint 03: Tuning suggestion routes.
 *   GET    /api/tuning-suggestions
 *   POST   /api/tuning-suggestions/:id/accept
 *   POST   /api/tuning-suggestions/:id/reject
 *   POST   /api/tuning-suggestions/:id/accept-tool-config   (sprint 03)
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningSuggestionController } from '../controllers/tuning-suggestion.controller';
import { makeTuningToolConfigController } from '../controllers/tuning-tool-config.controller';

export function tuningSuggestionRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const ctrl = makeTuningSuggestionController(prisma);
  const toolConfigCtrl = makeTuningToolConfigController(prisma);

  router.get('/', (req: any, res) => ctrl.list(req, res));
  router.post('/:id/accept', (req: any, res) => ctrl.accept(req, res));
  router.post('/:id/reject', (req: any, res) => ctrl.reject(req, res));
  router.post('/:id/accept-tool-config', (req: any, res) =>
    toolConfigCtrl.accept(req, res),
  );

  return router;
}
