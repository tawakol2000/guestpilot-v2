import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { taskController } from '../controllers/task.controller';

export function tasksRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = taskController(prisma);
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

  return router;
}
