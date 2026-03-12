import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeImportController } from '../controllers/import.controller';
import { AuthenticatedRequest } from '../types';

export function importRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeImportController(prisma);

  router.use(authMiddleware as unknown as RequestHandler);

  router.post('/', ((req, res) => ctrl.run(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/progress', ((req, res) => ctrl.progress(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.delete('/', ((req, res) => ctrl.deleteAll(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
