import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';
import { runDiagnostic } from '../services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../services/tuning/suggestion-writer.service';
import { shouldProcessTrigger } from '../services/tuning/trigger-dedup.service';

export function messagesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = authMiddleware as unknown as RequestHandler;
  const knowledgeCtrl = makeKnowledgeController(prisma);

  // POST /api/messages/:id/rate — rate a message (was inlined in app.ts)
  router.post('/:id/rate', auth, (req: any, res: any) => {
    knowledgeCtrl.rateMessage(req, res);
  });

  // ─── Feature 041 sprint 02 §5 trigger 4 — thumbs-down on unedited send ───
  // POST /api/messages/:id/thumbs-down {note?}
  // Records a negative MessageRating (reusing the existing table) and fires
  // the diagnostic pipeline as fire-and-forget.
  router.post('/:id/thumbs-down', auth, async (req: any, res: any) => {
    try {
      const tenantId: string = req.tenantId;
      const messageId: string = req.params.id;
      const note: string = typeof req.body?.note === 'string' ? req.body.note : '';

      const msg = await prisma.message.findFirst({
        where: { id: messageId, tenantId },
        select: { id: true },
      });
      if (!msg) {
        res.status(404).json({ error: 'MESSAGE_NOT_FOUND' });
        return;
      }

      // Persist the thumbs-down using the existing MessageRating table.
      await prisma.messageRating
        .upsert({
          where: { messageId },
          create: { messageId, rating: 'negative' },
          update: { rating: 'negative' },
        })
        .catch((err) => {
          console.warn(`[ThumbsDown] [${messageId}] rating upsert failed (non-fatal):`, err);
        });

      if (!shouldProcessTrigger('THUMBS_DOWN_TRIGGERED', messageId)) {
        res.json({ ok: true, triggerId: messageId, deduped: true });
        return;
      }

      void (async () => {
        try {
          const result = await runDiagnostic(
            {
              triggerType: 'THUMBS_DOWN_TRIGGERED',
              tenantId,
              messageId,
              note: note || 'Manager thumbs-downed an unedited AI send.',
            },
            prisma
          );
          if (result) {
            await writeSuggestionFromDiagnostic(result, {}, prisma);
          }
        } catch (err) {
          console.error(`[ThumbsDown] [${messageId}] diagnostic fire-and-forget failed:`, err);
        }
      })();

      res.json({ ok: true, triggerId: messageId, deduped: false });
    } catch (err) {
      console.error('[ThumbsDown] handler failed:', err);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
