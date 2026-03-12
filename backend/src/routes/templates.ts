import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTemplateController } from '../controllers/template.controller';
import { AuthenticatedRequest } from '../types';

export function templatesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeTemplateController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);

  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id', ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/enhance', ((req, res) => ctrl.enhance(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
