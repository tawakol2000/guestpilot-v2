import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';

export function messagesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = authMiddleware as unknown as RequestHandler;
  const knowledgeCtrl = makeKnowledgeController(prisma);

  // POST /api/messages/:id/rate — rate a message (was inlined in app.ts)
  router.post('/:id/rate', auth, (req: any, res: any) => {
    knowledgeCtrl.rateMessage(req, res);
  });

  return router;
}
