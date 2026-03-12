import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makePropertiesController } from '../controllers/properties.controller';
import { AuthenticatedRequest } from '../types';

export function propertiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makePropertiesController(prisma);

  router.use(authMiddleware as unknown as RequestHandler);

  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/ai-status', ((req, res) => ctrl.listWithAiStatus(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/:id', ((req, res) => ctrl.get(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/:id/knowledge-base', ((req, res) => ctrl.updateKnowledgeBase(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
