import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';
import { seedTenantSops } from '../services/rag.service';
import { getClassifierStatus, classifyMessage, isClassifierInitialized, initializeClassifier, reinitializeClassifier } from '../services/classifier.service';
import { addExample, getActiveExamples, getExampleByText } from '../services/classifier-store.service';
import { AuthenticatedRequest } from '../types';

export function knowledgeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeKnowledgeController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);

  // POST /api/knowledge/seed-sops — seed tenant-level SOP chunks for RAG
  router.post('/seed-sops', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const inserted = await seedTenantSops(tenantId, prisma);
      res.json({ ok: true, inserted });
    } catch (err) {
      console.error('[Knowledge] seed-sops failed:', err);
      res.status(500).json({ error: 'Failed to seed SOPs' });
    }
  });

  // GET /api/knowledge/classifier-status — KNN classifier health check
  router.get('/classifier-status', async (req: any, res) => {
    try {
      const status = getClassifierStatus();
      res.json(status);
    } catch (err) {
      console.error('[Knowledge] classifier-status failed:', err);
      res.status(500).json({ error: 'Failed to get classifier status' });
    }
  });

  // POST /api/knowledge/test-classify — test the classifier with a message
  router.post('/test-classify', async (req: any, res) => {
    try {
      const { message } = req.body as { message?: string };
      if (!message || !message.trim()) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      if (!isClassifierInitialized()) {
        // Try to initialize on demand
        await initializeClassifier();
      }

      const result = await classifyMessage(message.trim());
      res.json(result);
    } catch (err) {
      console.error('[Knowledge] test-classify failed:', err);
      res.status(500).json({ error: 'Classification failed' });
    }
  });

  // GET /api/knowledge/chunk-stats — aggregate retrieval stats per sourceKey from AiApiLog.ragContext
  router.get('/chunk-stats', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const logs = await prisma.aiApiLog.findMany({
        where: { tenantId, NOT: { ragContext: undefined } },
        select: { ragContext: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });

      const stats: Record<string, { hitCount: number; totalSimilarity: number; lastSeenAt: string }> = {};
      for (const log of logs) {
        const ctx = log.ragContext as any;
        if (!ctx?.chunks) continue;
        for (const chunk of ctx.chunks) {
          const key = chunk.sourceKey || chunk.category || 'unknown';
          if (!stats[key]) stats[key] = { hitCount: 0, totalSimilarity: 0, lastSeenAt: '' };
          stats[key].hitCount++;
          stats[key].totalSimilarity += chunk.similarity ?? 0;
          const ts = log.createdAt.toISOString();
          if (!stats[key].lastSeenAt || ts > stats[key].lastSeenAt) stats[key].lastSeenAt = ts;
        }
      }

      const result = Object.entries(stats).map(([sourceKey, s]) => ({
        sourceKey,
        hitCount: s.hitCount,
        avgSimilarity: Math.round((s.totalSimilarity / s.hitCount) * 100) / 100,
        lastSeenAt: s.lastSeenAt,
      }));

      res.json({ stats: result, logsAnalyzed: logs.length });
    } catch (err) {
      console.error('[Knowledge] chunk-stats failed:', err);
      res.status(500).json({ error: 'Failed to fetch chunk stats' });
    }
  });

  // GET /api/knowledge/chunks?propertyId=xxx — view ingested RAG vector chunks (no embedding)
  router.get('/chunks', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { propertyId } = req.query as { propertyId?: string };
      const chunks = await prisma.propertyKnowledgeChunk.findMany({
        where: { tenantId, ...(propertyId ? { propertyId } : {}) },
        select: { id: true, propertyId: true, content: true, category: true, sourceKey: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      res.json(chunks);
    } catch (err) {
      console.error('[Knowledge] chunks query failed:', err);
      res.status(500).json({ error: 'Failed to fetch chunks' });
    }
  });

  // PATCH /api/knowledge/chunks/:id — update content and/or category of a chunk
  router.patch('/chunks/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };
      const { content, category } = req.body as { content?: string; category?: string };

      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PropertyKnowledgeChunk"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      if (rows.length === 0) {
        res.status(404).json({ error: 'Chunk not found' });
        return;
      }

      await prisma.$executeRaw`
        UPDATE "PropertyKnowledgeChunk"
        SET content = ${content ?? null}, category = ${category ?? null}, "updatedAt" = now()
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] chunk update failed:', err);
      res.status(500).json({ error: 'Failed to update chunk' });
    }
  });

  // DELETE /api/knowledge/chunks/:id — delete a chunk
  router.delete('/chunks/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };

      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PropertyKnowledgeChunk"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      if (rows.length === 0) {
        res.status(404).json({ error: 'Chunk not found' });
        return;
      }

      await prisma.$executeRaw`
        DELETE FROM "PropertyKnowledgeChunk"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] chunk delete failed:', err);
      res.status(500).json({ error: 'Failed to delete chunk' });
    }
  });

  // GET /api/knowledge/evaluations — paginated evaluation log
  router.get('/evaluations', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { limit: limitStr, offset: offsetStr, correct } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || '50', 10), 200);
      const offset = parseInt(offsetStr || '0', 10);

      const where: Record<string, unknown> = { tenantId };
      if (correct === 'true') where.retrievalCorrect = true;
      if (correct === 'false') where.retrievalCorrect = false;

      const [evals, total] = await Promise.all([
        prisma.classifierEvaluation.findMany({
          where: where as any,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.classifierEvaluation.count({ where: where as any }),
      ]);

      res.json({ evaluations: evals, total, limit, offset });
    } catch (err) {
      console.error('[Knowledge] evaluations query failed:', err);
      res.status(500).json({ error: 'Failed to fetch evaluations' });
    }
  });

  // GET /api/knowledge/evaluation-stats — aggregate metrics
  router.get('/evaluation-stats', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;

      const [total, correct, incorrect, autoFixed] = await Promise.all([
        prisma.classifierEvaluation.count({ where: { tenantId } }),
        prisma.classifierEvaluation.count({ where: { tenantId, retrievalCorrect: true } }),
        prisma.classifierEvaluation.count({ where: { tenantId, retrievalCorrect: false } }),
        prisma.classifierEvaluation.count({ where: { tenantId, autoFixed: true } }),
      ]);

      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 100;

      res.json({
        total,
        correct,
        incorrect,
        autoFixed,
        accuracyPercent: accuracy,
      });
    } catch (err) {
      console.error('[Knowledge] evaluation-stats failed:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // GET /api/knowledge/classifier-examples — paginated list of DB examples
  router.get('/classifier-examples', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { limit: limitStr, offset: offsetStr, source } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || '100', 10), 500);
      const offset = parseInt(offsetStr || '0', 10);

      const where: Record<string, unknown> = { tenantId, active: true };
      if (source) where.source = source;

      const [examples, total] = await Promise.all([
        prisma.classifierExample.findMany({
          where: where as any,
          orderBy: { createdAt: 'asc' },
          take: limit,
          skip: offset,
          select: { id: true, text: true, labels: true, source: true, active: true, createdAt: true },
        }),
        prisma.classifierExample.count({ where: where as any }),
      ]);

      res.json({ examples, total });
    } catch (err) {
      console.error('[Knowledge] classifier-examples query failed:', err);
      res.status(500).json({ error: 'Failed to fetch classifier examples' });
    }
  });

  // POST /api/knowledge/classifier-examples — add a manual training example
  router.post('/classifier-examples', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { text, labels } = req.body as { text?: string; labels?: string[] };

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      if (!Array.isArray(labels)) {
        res.status(400).json({ error: 'labels must be an array' });
        return;
      }

      const existing = await getExampleByText(tenantId, text.trim(), prisma);
      if (existing) {
        res.status(409).json({ error: 'Example with this text already exists' });
        return;
      }

      const created = await addExample(tenantId, text.trim(), labels, 'manual', prisma);
      res.json({ ok: true, id: created.id });
    } catch (err) {
      console.error('[Knowledge] classifier-examples create failed:', err);
      res.status(500).json({ error: 'Failed to create classifier example' });
    }
  });

  // DELETE /api/knowledge/classifier-examples/:id — soft-delete (set active=false)
  router.delete('/classifier-examples/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };

      const existing = await prisma.classifierExample.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!existing) {
        res.status(404).json({ error: 'Example not found' });
        return;
      }

      await prisma.classifierExample.update({
        where: { id },
        data: { active: false },
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] classifier-examples delete failed:', err);
      res.status(500).json({ error: 'Failed to delete classifier example' });
    }
  });

  // POST /api/knowledge/classifier-reinitialize — force re-embed all examples
  router.post('/classifier-reinitialize', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      await reinitializeClassifier(tenantId, prisma);
      const status = getClassifierStatus();
      res.json({ ok: true, exampleCount: status.exampleCount });
    } catch (err) {
      console.error('[Knowledge] classifier-reinitialize failed:', err);
      res.status(500).json({ error: 'Failed to reinitialize classifier' });
    }
  });

  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/', ((req, res) => ctrl.create(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/detect-gaps', ((req, res) => ctrl.detectGaps(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/bulk-import', ((req, res) => ctrl.bulkImport(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id', ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.delete('/:id', ((req, res) => ctrl.remove(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
