/**
 * Feature 041 sprint 02 §5 trigger 3 — manager-initiated complaint.
 *
 * POST /api/tuning/complaints
 *   Body: { messageId: string, description: string }
 *
 * Records the complaint and fires the diagnostic pipeline with triggerType
 * COMPLAINT_TRIGGERED. The diagnostic runs async; the HTTP response returns
 * immediately with a triggerId (the messageId echoed back for now — there's
 * no persistent "complaint" row in V1; sprint 04 will hang the conversation
 * off the message directly).
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { runDiagnostic } from '../services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../services/tuning/suggestion-writer.service';
import { shouldProcessTrigger } from '../services/tuning/trigger-dedup.service';

export function makeTuningComplaintController(prisma: PrismaClient) {
  return {
    async create(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const messageId: string =
          typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : '';
        const description: string =
          typeof req.body?.description === 'string' ? req.body.description : '';

        if (!messageId) {
          res.status(400).json({ error: 'MESSAGE_ID_REQUIRED' });
          return;
        }

        // Validate that the message exists and belongs to this tenant.
        const msg = await prisma.message.findFirst({
          where: { id: messageId, tenantId },
          select: { id: true },
        });
        if (!msg) {
          res.status(404).json({ error: 'MESSAGE_NOT_FOUND' });
          return;
        }

        if (!shouldProcessTrigger('COMPLAINT_TRIGGERED', messageId)) {
          // Second fire within 60s — respond OK but do not re-queue.
          res.json({ ok: true, triggerId: messageId, deduped: true });
          return;
        }

        // Fire-and-forget. Respond immediately.
        void (async () => {
          try {
            const result = await runDiagnostic(
              {
                triggerType: 'COMPLAINT_TRIGGERED',
                tenantId,
                messageId,
                note: description || 'Manager complaint (no description provided).',
              },
              prisma
            );
            if (result) {
              await writeSuggestionFromDiagnostic(result, {}, prisma);
            }
          } catch (err) {
            console.error(`[TuningComplaint] [${messageId}] diagnostic fire-and-forget failed:`, err);
          }
        })();

        res.json({ ok: true, triggerId: messageId, deduped: false });
      } catch (err) {
        console.error('[TuningComplaint] create failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
