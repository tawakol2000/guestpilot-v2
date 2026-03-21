import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeAiConfigController } from '../controllers/ai-config.controller';
import { AuthenticatedRequest } from '../types';

export function aiConfigRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeAiConfigController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);
  router.get('/', ((req, res) => ctrl.get(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/', ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/test', ((req, res) => ctrl.test(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/versions', ((req, res) => ctrl.listVersions(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/versions/:id/revert', ((req, res) => ctrl.revertVersion(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/sandbox-chat', ((req, res) => ctrl.sandboxChat(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/intent-prompt', ((req, res) => ctrl.getIntentPrompt(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/intent-prompt', ((req, res) => ctrl.updateIntentPrompt(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  return router;
}
