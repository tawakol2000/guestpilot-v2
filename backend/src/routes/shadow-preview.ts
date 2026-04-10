/**
 * Feature 040: Copilot Shadow Mode routes.
 * POST /api/shadow-previews/:messageId/send — deliver a preview to the guest (with optional edit).
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeShadowPreviewController } from '../controllers/shadow-preview.controller';

export function shadowPreviewRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  const ctrl = makeShadowPreviewController(prisma);

  router.post('/:messageId/send', (req: any, res) => ctrl.send(req, res));

  return router;
}
