/**
 * Feature 041 sprint 04 — tuning agent SSE chat + conversation CRUD routes.
 *
 *   POST /api/tuning/conversations
 *   GET  /api/tuning/conversations
 *   GET  /api/tuning/conversations/:id
 *   PATCH /api/tuning/conversations/:id
 *   POST /api/tuning/chat
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeTuningConversationController } from '../controllers/tuning-conversation.controller';
import { makeTuningChatController } from '../controllers/tuning-chat.controller';

export function tuningChatRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const conv = makeTuningConversationController(prisma);
  const chat = makeTuningChatController(prisma);

  router.post('/conversations', (req: any, res) => conv.create(req, res));
  router.get('/conversations', (req: any, res) => conv.list(req, res));
  router.get('/conversations/:id', (req: any, res) => conv.get(req, res));
  router.patch('/conversations/:id', (req: any, res) => conv.patch(req, res));

  router.post('/chat', (req: any, res) => chat.chat(req, res));

  return router;
}
