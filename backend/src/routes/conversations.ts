import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeConversationsController } from '../controllers/conversations.controller';
import { makeMessagesController } from '../controllers/messages.controller';
import { AuthenticatedRequest } from '../types';

export function conversationsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const convCtrl = makeConversationsController(prisma);
  const msgCtrl = makeMessagesController(prisma);

  router.use(authMiddleware as unknown as RequestHandler);

  router.get('/', ((req, res) => convCtrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/ai-toggle-all', ((req, res) => convCtrl.aiToggleAll(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/ai-toggle-property', ((req, res) => convCtrl.aiToggleProperty(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/:id', ((req, res) => convCtrl.get(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/:id/reservation', ((req, res) => convCtrl.getReservation(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/:id/suggestion', ((req, res) => convCtrl.getSuggestion(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id/star', ((req, res) => convCtrl.toggleStar(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id/resolve', ((req, res) => convCtrl.resolve(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id/ai-toggle', ((req, res) => convCtrl.aiToggle(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/messages', ((req, res) => msgCtrl.send(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/notes', ((req, res) => msgCtrl.sendNote(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/messages/translate', ((req, res) => msgCtrl.translateAndSend(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/translate-message', ((req, res) => msgCtrl.translateMessage(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/inquiry-action', ((req, res) => convCtrl.inquiryAction(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/cancel-ai', ((req, res) => convCtrl.cancelPendingAi(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/send-ai-now', ((req, res) => convCtrl.sendAiNow(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id/ai-mode', ((req, res) => convCtrl.setAiMode(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/:id/approve-suggestion', ((req, res) => convCtrl.approveSuggestion(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
