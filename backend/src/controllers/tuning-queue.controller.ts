/**
 * Tuning Edit Queue HTTP controller (2026-05-17).
 *
 * Surfaces every persisted edit (pending + analyzed) to the Studio right
 * column, with two manager-driven actions: run-analysis (PENDING → analyze
 * synchronously) and dismiss (PENDING → DISMISSED).
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import {
  analyzeQueueItem,
  dismissQueueItem,
  listQueueItems,
  type QueueBucket,
} from '../services/tuning/edit-queue.service';

export function makeTuningQueueController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const bucket = (typeof req.query.bucket === 'string' ? req.query.bucket : 'all') as QueueBucket;
        const limit = Math.min(
          Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
          200,
        );
        if (!['pending', 'analyzed', 'all'].includes(bucket)) {
          res.status(400).json({ error: 'INVALID_BUCKET', detail: 'bucket must be pending|analyzed|all' });
          return;
        }
        const rows = await listQueueItems(tenantId, bucket, limit, prisma);
        res.json({
          items: rows.map((r) => ({
            id: r.id,
            sourceMessageId: r.sourceMessageId,
            originalText: r.originalText,
            editedText: r.editedText,
            similarity: r.similarity,
            triggerType: r.triggerType,
            reservationStatus: r.reservationStatus,
            channel: r.channel,
            preClassifierCategory: r.preClassifierCategory,
            preClassifierConfidence: r.preClassifierConfidence,
            preClassifierRationale: r.preClassifierRationale,
            preClassifierModel: r.preClassifierModel,
            status: r.status,
            skipReason: r.skipReason,
            errorMessage: r.errorMessage,
            suggestion: r.suggestion ?? null,
            createdAt: r.createdAt.toISOString(),
            analyzedAt: r.analyzedAt?.toISOString() ?? null,
          })),
        });
      } catch (err) {
        console.error('[TuningQueue] list error:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async analyze(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        // `force=true` lets the manager override a SKIPPED_NO_FIX or
        // SKIPPED_COOLDOWN outcome and run the full diagnostic anyway.
        const force = req.body?.force === true || req.query.force === 'true';
        const outcome = await analyzeQueueItem(id, tenantId, prisma, { force });
        if (!outcome) {
          res.status(404).json({ error: 'QUEUE_ITEM_NOT_FOUND' });
          return;
        }
        res.json(outcome);
      } catch (err) {
        console.error('[TuningQueue] analyze error:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async dismiss(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const ok = await dismissQueueItem(id, tenantId, prisma);
        if (!ok) {
          res.status(409).json({ error: 'QUEUE_ITEM_NOT_PENDING' });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        console.error('[TuningQueue] dismiss error:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
