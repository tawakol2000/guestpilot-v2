import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { messageSendLimiter } from '../middleware/rate-limit';
import { taskController } from '../controllers/task.controller';
import { makeTaskActionsController } from '../controllers/task-actions.controller';
import { AuthenticatedRequest } from '../types';

export function tasksRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = taskController(prisma);
  const actionsCtrl = makeTaskActionsController(prisma);
  const auth = authMiddleware as unknown as RequestHandler;

  // Global tasks list + create
  router.get('/tasks', auth, ctrl.listAll);
  router.post('/tasks', auth, ctrl.createGlobal);

  // Conversation-scoped
  router.get('/conversations/:conversationId/tasks', auth, ctrl.listByConversation);
  router.post('/conversations/:conversationId/tasks', auth, ctrl.create);

  // Task-scoped
  router.patch('/tasks/:id', auth, ctrl.update);
  router.delete('/tasks/:id', auth, ctrl.remove);

  // ─── Feature 043: action-card accept/reject/preview ───
  router.get(
    '/tasks/:taskId/preview',
    auth,
    ((req, res) => actionsCtrl.preview(req as unknown as AuthenticatedRequest, res)) as RequestHandler
  );
  router.post(
    '/tasks/:taskId/accept',
    auth,
    messageSendLimiter as any,
    ((req, res) => actionsCtrl.accept(req as unknown as AuthenticatedRequest, res)) as RequestHandler
  );
  router.post(
    '/tasks/:taskId/reject',
    auth,
    messageSendLimiter as any,
    ((req, res) => actionsCtrl.reject(req as unknown as AuthenticatedRequest, res)) as RequestHandler
  );

  return router;
}
