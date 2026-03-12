import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';
import { AuthenticatedRequest } from '../types';

export function knowledgeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeKnowledgeController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);

  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/', ((req, res) => ctrl.create(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/detect-gaps', ((req, res) => ctrl.detectGaps(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/bulk-import', ((req, res) => ctrl.bulkImport(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id', ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.delete('/:id', ((req, res) => ctrl.remove(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
