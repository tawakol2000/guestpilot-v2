/**
 * FAQ Knowledge System — REST API
 *
 * GET    /api/faq              — list FAQ entries (with optional filters)
 * POST   /api/faq              — create FAQ entry
 * GET    /api/faq/categories   — category stats (ACTIVE counts per category)
 * PATCH  /api/faq/:id          — update FAQ entry
 * DELETE /api/faq/:id          — delete FAQ entry
 *
 * All endpoints are tenant-scoped via authMiddleware.
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeFaqController } from '../controllers/faq.controller';
import { AuthenticatedRequest } from '../types';

export function faqRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeFaqController(prisma);

  router.use(authMiddleware as unknown as RequestHandler);

  // GET /api/faq — list entries
  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // POST /api/faq — create entry
  router.post('/', ((req, res) => ctrl.create(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // GET /api/faq/categories — category stats (MUST be before /:id to avoid conflict)
  router.get('/categories', ((req, res) => ctrl.categories(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // PATCH /api/faq/:id — update entry
  router.patch('/:id', ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // DELETE /api/faq/:id — delete entry
  router.delete('/:id', ((req, res) => ctrl.remove(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
