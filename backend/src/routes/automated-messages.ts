import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeAutomatedMessagesController } from '../controllers/automated-messages.controller';
import { AuthenticatedRequest } from '../types';

export function automatedMessagesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeAutomatedMessagesController(prisma);
  const auth = authMiddleware as unknown as RequestHandler;

  router.get('/', auth, ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/', auth, ((req, res) => ctrl.create(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/:id', auth, ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/toggle', auth, ((req, res) => ctrl.toggle(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.delete('/:id', auth, ((req, res) => ctrl.remove(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/sync', auth, ((req, res) => ctrl.sync(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
