/**
 * Feature 040: Tuning suggestion routes.
 *   GET    /api/tuning-suggestions
 *   POST   /api/tuning-suggestions/:id/accept
 *   POST   /api/tuning-suggestions/:id/reject
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningSuggestionController } from '../controllers/tuning-suggestion.controller';

export function tuningSuggestionRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const ctrl = makeTuningSuggestionController(prisma);

  router.get('/', (req: any, res) => ctrl.list(req, res));
  router.post('/:id/accept', (req: any, res) => ctrl.accept(req, res));
  router.post('/:id/reject', (req: any, res) => ctrl.reject(req, res));

  return router;
}
