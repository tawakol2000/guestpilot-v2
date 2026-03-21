import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';
import { seedTenantSops, ingestPropertyKnowledge } from '../services/rag.service';
import { getClassifierStatus, classifyMessage, isClassifierInitialized, initializeClassifier, reinitializeClassifier, setClassifierThresholds, setBoostThreshold, batchClassify, getDescriptionMatrix, classifyDetailed } from '../services/classifier.service';
import { addExample, getActiveExamples, getExampleByText } from '../services/classifier-store.service';
import { TRAINING_EXAMPLES } from '../services/classifier-data';
import { invalidateThresholdCache } from '../services/judge.service';
import { setEmbeddingProvider, getEmbeddingProvider, type EmbeddingProvider } from '../services/embeddings.service';
import { getTenantAiConfig, invalidateTenantConfigCache } from '../services/tenant-config.service';
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

  // GET /api/knowledge/classifier-status — classifier health check (LR primary, KNN diagnostic)
  router.get('/classifier-status', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const status = getClassifierStatus();
      const config = await getTenantAiConfig(tenantId, prisma);
      // ClassifierWeights table may not exist yet — handle gracefully
      let retrainCount = 0;
      let latestWeights: { createdAt: Date; accuracy: number | null; classes: number; examples: number } | null = null;
      try {
        retrainCount = await prisma.classifierWeights.count({ where: { tenantId } });
        latestWeights = await prisma.classifierWeights.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, accuracy: true, classes: true, examples: true },
        });
      } catch { /* table doesn't exist yet — that's fine */ }
      res.json({
        ...status,
        classifierType: 'lr',
        lrAccuracy: status.lrAccuracy || latestWeights?.accuracy || null,
        lastTrainedAt: status.lastTrainedAt || latestWeights?.createdAt?.toISOString() || null,
        retrainAvailable: true,
        retrainCount,
        weightsSource: status.lrAccuracy ? 'file' : (latestWeights ? 'database' : 'none'),
        confidenceTiers: {
          highThreshold: (config as any).highConfidenceThreshold || 0.85,
          lowThreshold: (config as any).lowConfidenceThreshold || 0.55,
        },
      });
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
      // propertyId=global → only tenant-level SOPs (propertyId IS NULL)
      const propertyFilter = propertyId === 'global' ? { propertyId: null } : propertyId ? { propertyId } : {};
      const chunks = await prisma.propertyKnowledgeChunk.findMany({
        where: { tenantId, ...propertyFilter },
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

      const [total, correct, incorrect, autoFixed, costAgg, recentSimRows, prevSimRows] = await Promise.all([
        prisma.classifierEvaluation.count({ where: { tenantId } }),
        prisma.classifierEvaluation.count({ where: { tenantId, retrievalCorrect: true } }),
        prisma.classifierEvaluation.count({ where: { tenantId, retrievalCorrect: false } }),
        prisma.classifierEvaluation.count({ where: { tenantId, autoFixed: true } }),
        prisma.classifierEvaluation.aggregate({
          where: { tenantId },
          _sum: { judgeCost: true, judgeInputTokens: true, judgeOutputTokens: true },
          _avg: { judgeCost: true },
        }),
        // Last 30 evaluations — for recent avg sim
        prisma.classifierEvaluation.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: 30,
          select: { classifierTopSim: true },
        }),
        // Previous 30 — for trend comparison
        prisma.classifierEvaluation.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          skip: 30,
          take: 30,
          select: { classifierTopSim: true },
        }),
      ]);

      const accuracy = total > 0 ? Math.round((correct / total) * 100) : 100;

      const avgSimRecent = recentSimRows.length > 0
        ? Math.round((recentSimRows.reduce((s, r) => s + r.classifierTopSim, 0) / recentSimRows.length) * 1000) / 1000
        : null;
      const avgSimPrev = prevSimRows.length > 0
        ? Math.round((prevSimRows.reduce((s, r) => s + r.classifierTopSim, 0) / prevSimRows.length) * 1000) / 1000
        : null;

      res.json({
        total,
        correct,
        incorrect,
        autoFixed,
        accuracyPercent: accuracy,
        totalJudgeCost:    Math.round((costAgg._sum.judgeCost    ?? 0) * 1_000_000) / 1_000_000,
        avgJudgeCost:      Math.round((costAgg._avg.judgeCost    ?? 0) * 1_000_000) / 1_000_000,
        totalInputTokens:  costAgg._sum.judgeInputTokens  ?? 0,
        totalOutputTokens: costAgg._sum.judgeOutputTokens ?? 0,
        avgSimRecent,
        avgSimPrev,
        recentSimCount: recentSimRows.length,
      });
    } catch (err) {
      console.error('[Knowledge] evaluation-stats failed:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // GET /api/knowledge/classifier-thresholds — current per-tenant thresholds
  router.get('/classifier-thresholds', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const cfg = await prisma.tenantAiConfig.findUnique({
        where: { tenantId },
        select: { judgeThreshold: true, autoFixThreshold: true, classifierVoteThreshold: true, classifierContextualGate: true, embeddingProvider: true, tier2Threshold: true, tier1Mode: true, tier2Mode: true, tier3Mode: true } as any,
      }) as any;
      res.json({
        judgeThreshold:  cfg?.judgeThreshold  ?? 0.75,
        autoFixThreshold: cfg?.autoFixThreshold ?? 0.70,
        classifierVoteThreshold: cfg?.classifierVoteThreshold ?? 0.30,
        classifierContextualGate: cfg?.classifierContextualGate ?? 0.85,
        embeddingProvider: cfg?.embeddingProvider ?? 'openai',
        tier2Threshold: cfg?.tier2Threshold ?? 0.80,
        tier1Mode: cfg?.tier1Mode ?? 'active',
        tier2Mode: cfg?.tier2Mode ?? 'active',
        tier3Mode: cfg?.tier3Mode ?? 'active',
      });
    } catch (err) {
      console.error('[Knowledge] classifier-thresholds GET failed:', err);
      res.status(500).json({ error: 'Failed to fetch thresholds' });
    }
  });

  // POST /api/knowledge/classifier-thresholds — update thresholds
  router.post('/classifier-thresholds', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { judgeThreshold, autoFixThreshold, classifierVoteThreshold, classifierContextualGate, embeddingProvider: newProvider, tier2Threshold, tier1Mode, tier2Mode, tier3Mode } = req.body as {
        judgeThreshold?: number; autoFixThreshold?: number;
        classifierVoteThreshold?: number; classifierContextualGate?: number;
        embeddingProvider?: string; tier2Threshold?: number;
        tier1Mode?: string; tier2Mode?: string; tier3Mode?: string;
      };

      // Validate tier modes if provided
      const VALID_TIER_MODES = ['active', 'ghost', 'off'];
      if (tier1Mode !== undefined && !VALID_TIER_MODES.includes(tier1Mode)) {
        res.status(400).json({ error: `tier1Mode must be one of: ${VALID_TIER_MODES.join(', ')}` });
        return;
      }
      if (tier2Mode !== undefined && !VALID_TIER_MODES.includes(tier2Mode)) {
        res.status(400).json({ error: `tier2Mode must be one of: ${VALID_TIER_MODES.join(', ')}` });
        return;
      }
      if (tier3Mode !== undefined && !VALID_TIER_MODES.includes(tier3Mode)) {
        res.status(400).json({ error: `tier3Mode must be one of: ${VALID_TIER_MODES.join(', ')}` });
        return;
      }

      if (typeof judgeThreshold !== 'number' || judgeThreshold < 0.3 || judgeThreshold > 1.0) {
        res.status(400).json({ error: 'judgeThreshold must be between 0.3 and 1.0' });
        return;
      }
      if (typeof autoFixThreshold !== 'number' || autoFixThreshold < 0.2 || autoFixThreshold > 0.95) {
        res.status(400).json({ error: 'autoFixThreshold must be between 0.2 and 0.95' });
        return;
      }
      if (autoFixThreshold >= judgeThreshold) {
        res.status(400).json({ error: 'autoFixThreshold must be less than judgeThreshold' });
        return;
      }
      const voteT = typeof classifierVoteThreshold === 'number' ? classifierVoteThreshold : 0.30;
      const ctxG = typeof classifierContextualGate === 'number' ? classifierContextualGate : 0.85;
      if (voteT < 0.1 || voteT > 0.8) {
        res.status(400).json({ error: 'classifierVoteThreshold must be between 0.1 and 0.8' });
        return;
      }
      if (ctxG < 0.5 || ctxG > 0.95) {
        res.status(400).json({ error: 'classifierContextualGate must be between 0.5 and 0.95' });
        return;
      }

      const provider = (newProvider === 'cohere' ? 'cohere' : 'openai') as EmbeddingProvider;
      const prevProvider = getEmbeddingProvider();

      const boostT = typeof tier2Threshold === 'number' ? Math.max(0.50, Math.min(1.00, tier2Threshold)) : undefined;

      // Build tier mode updates — only include if provided
      const tierModeUpdates: Record<string, string> = {};
      if (tier1Mode !== undefined) tierModeUpdates.tier1Mode = tier1Mode;
      if (tier2Mode !== undefined) tierModeUpdates.tier2Mode = tier2Mode;
      if (tier3Mode !== undefined) tierModeUpdates.tier3Mode = tier3Mode;

      await prisma.tenantAiConfig.upsert({
        where: { tenantId },
        update: { judgeThreshold, autoFixThreshold, classifierVoteThreshold: voteT, classifierContextualGate: ctxG, embeddingProvider: provider, ...(boostT != null ? { tier2Threshold: boostT } : {}), ...tierModeUpdates },
        create: { tenantId, judgeThreshold, autoFixThreshold, classifierVoteThreshold: voteT, classifierContextualGate: ctxG, embeddingProvider: provider, ...(boostT != null ? { tier2Threshold: boostT } : {}), ...tierModeUpdates },
      });

      invalidateThresholdCache(tenantId);
      invalidateTenantConfigCache(tenantId);
      setClassifierThresholds(voteT, ctxG);
      if (boostT != null) setBoostThreshold(boostT);

      // If embedding provider changed, re-embed everything in the background
      if (provider !== prevProvider) {
        setEmbeddingProvider(provider);
        console.log(`[Thresholds] Embedding provider changed: ${prevProvider} → ${provider}. Re-embedding all data...`);
        (async () => {
          try {
            await seedTenantSops(tenantId, prisma);
            const properties = await prisma.property.findMany({ where: { tenantId } });
            for (const prop of properties) {
              await ingestPropertyKnowledge(tenantId, prop.id, prop, prisma);
            }
            await initializeClassifier();
            console.log(`[Thresholds] Re-embedding complete for provider=${provider}`);
          } catch (err) {
            console.error('[Thresholds] Re-embedding failed:', err);
          }
        })();
      }

      res.json({ ok: true, judgeThreshold, autoFixThreshold, classifierVoteThreshold: voteT, classifierContextualGate: ctxG, embeddingProvider: provider, ...tierModeUpdates });
    } catch (err) {
      console.error('[Knowledge] classifier-thresholds POST failed:', err);
      res.status(500).json({ error: 'Failed to save thresholds' });
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

  // PATCH /api/knowledge/classifier-examples/:id — update labels for a DB example
  router.patch('/classifier-examples/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };
      const { labels } = req.body as { labels?: string[] };

      if (!Array.isArray(labels)) {
        res.status(400).json({ error: 'labels must be an array' });
        return;
      }

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
        data: { labels },
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] classifier-examples patch failed:', err);
      res.status(500).json({ error: 'Failed to update classifier example' });
    }
  });

  // GET /api/knowledge/all-examples — all training examples (hardcoded + DB) for visual editor
  router.get('/all-examples', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;

      // Hardcoded base examples from classifier-data.ts
      const baseExamples = TRAINING_EXAMPLES.map((ex, i) => ({
        id: `base-${i}`,
        text: ex.text,
        labels: ex.labels,
        source: 'base' as const,
        editable: false,
        createdAt: null as string | null,
      }));

      // DB examples (judge, manual, tier2-feedback, etc.)
      const dbExamples = await prisma.classifierExample.findMany({
        where: { tenantId, active: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, text: true, labels: true, source: true, createdAt: true },
      });

      const dbMapped = dbExamples.map(ex => ({
        id: ex.id,
        text: ex.text,
        labels: ex.labels as string[],
        source: (ex.source || 'manual') as string,
        editable: true,
        createdAt: ex.createdAt?.toISOString() || null,
      }));

      res.json({
        examples: [...baseExamples, ...dbMapped],
        baseCount: baseExamples.length,
        dbCount: dbMapped.length,
      });
    } catch (err) {
      console.error('[Knowledge] all-examples query failed:', err);
      res.status(500).json({ error: 'Failed to fetch all examples' });
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

  // POST /api/knowledge/gap-analysis — T012: classifier gap analysis
  router.post('/gap-analysis', ((req, res) => ctrl.gapAnalysis(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // POST /api/knowledge/classifier-examples/:id/approve — T014: approve a pending example
  router.post('/classifier-examples/:id/approve', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };

      const existing = await prisma.classifierExample.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Example not found' });
        return;
      }

      await prisma.classifierExample.update({
        where: { id },
        data: { active: true },
      });

      // Re-initialize classifier to pick up the newly approved example
      reinitializeClassifier(tenantId, prisma).catch(err =>
        console.error('[Knowledge] classifier reinit after approve failed:', err)
      );

      res.json({ id, active: true });
    } catch (err) {
      console.error('[Knowledge] classifier-examples approve failed:', err);
      res.status(500).json({ error: 'Failed to approve classifier example' });
    }
  });

  // POST /api/knowledge/classifier-examples/:id/reject — T015: reject and delete a pending example
  router.post('/classifier-examples/:id/reject', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };

      const existing = await prisma.classifierExample.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Example not found' });
        return;
      }

      await prisma.classifierExample.delete({ where: { id } });

      res.json({ deleted: true });
    } catch (err) {
      console.error('[Knowledge] classifier-examples reject failed:', err);
      res.status(500).json({ error: 'Failed to reject classifier example' });
    }
  });

  // POST /api/knowledge/retrain-classifier — T003: retrain LR classifier from all examples
  router.post('/retrain-classifier', ((req, res) => ctrl.retrainClassifier(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // GET /api/knowledge/training-distribution — T018: show training data distribution
  router.get('/training-distribution', ((req, res) => ctrl.trainingDistribution(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // POST /api/knowledge/generate-paraphrases — T019: generate paraphrases for under-represented categories
  router.post('/generate-paraphrases', ((req, res) => ctrl.generateParaphrases(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // GET /api/classifier/description-matrix — T027/T028: cross-class similarity diagnostic
  router.get('/description-matrix', ((_req, res) => {
    const result = getDescriptionMatrix();
    if (!result) {
      res.status(503).json({ error: 'Description embeddings not loaded — classifier not initialized or descriptions not available' });
      return;
    }
    res.json({ ...result, timestamp: new Date().toISOString() });
  }) as RequestHandler);

  // POST /api/knowledge/classify-test — live test: detailed KNN + LR breakdown
  router.post('/classify-test', (async (req: any, res: any) => {
    try {
      const { message } = req.body as { message?: string };
      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message is required' });
        return;
      }
      if (!isClassifierInitialized()) await initializeClassifier();
      const result = await classifyDetailed(message);
      if (!result) {
        res.status(503).json({ error: 'Classifier not ready' });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Classification failed' });
    }
  }) as RequestHandler);

  // POST /api/knowledge/batch-classify — T022-T023: batch classify messages
  router.post('/batch-classify', async (req: any, res) => {
    try {
      const { messages, voteThreshold } = req.body as { messages?: string[]; voteThreshold?: number };

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages must be a non-empty array of strings' });
        return;
      }

      if (!isClassifierInitialized()) {
        await initializeClassifier();
      }

      const result = await batchClassify(messages, voteThreshold);
      res.json(result);
    } catch (err) {
      console.error('[Knowledge] batch-classify failed:', err);
      res.status(500).json({ error: 'Batch classification failed' });
    }
  });

  // POST /api/knowledge/dedup-conversations
  // One-time cleanup: finds reservations with duplicate conversations and removes the empty ones.
  // Idempotent — safe to call multiple times. Required before adding @@unique constraint migration.
  router.post('/dedup-conversations', async (req: any, res) => {
    const tenantId = req.tenantId as string;
    try {
      // Find reservationIds that have more than one conversation for this tenant
      const groups = await prisma.$queryRaw<Array<{ reservationId: string; cnt: bigint }>>`
        SELECT "reservationId", COUNT(*) as cnt
        FROM "Conversation"
        WHERE "tenantId" = ${tenantId}
        GROUP BY "reservationId"
        HAVING COUNT(*) > 1
      `;

      const details: Array<{
        reservationId: string;
        winnerId: string;
        removedIds: string[];
        winnerMessageCount: number;
        removedMessageCounts: number[];
      }> = [];
      let totalRemoved = 0;

      for (const group of groups) {
        const convs = await prisma.conversation.findMany({
          where: { tenantId, reservationId: group.reservationId },
          include: { _count: { select: { messages: true } } },
          orderBy: [{ createdAt: 'desc' }],
        });

        // Sort: most messages first, then most recent
        convs.sort((a, b) =>
          b._count.messages - a._count.messages || b.createdAt.getTime() - a.createdAt.getTime()
        );

        const [winner, ...losers] = convs;
        const loserIds = losers.map(c => c.id);

        // Cancel pending AI replies on losers before deleting
        await prisma.pendingAiReply.deleteMany({ where: { conversationId: { in: loserIds } } });

        // Delete loser conversations
        await prisma.conversation.deleteMany({ where: { id: { in: loserIds } } });

        details.push({
          reservationId: group.reservationId,
          winnerId: winner.id,
          removedIds: loserIds,
          winnerMessageCount: winner._count.messages,
          removedMessageCounts: losers.map(c => c._count.messages),
        });
        totalRemoved += loserIds.length;
        console.log(`[Dedup] [${tenantId}] Reservation ${group.reservationId}: kept ${winner.id} (${winner._count.messages} msgs), removed ${loserIds.join(', ')}`);
      }

      res.json({ duplicatesFound: groups.length, conversationsRemoved: totalRemoved, details });
    } catch (err) {
      console.error('[Dedup] dedup-conversations failed:', err);
      res.status(500).json({ error: 'Dedup failed' });
    }
  });

  // GET /api/knowledge/tool-invocations — recent tool uses from AI pipeline
  router.get('/tool-invocations', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const logs = await prisma.aiApiLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      const toolLogs = logs
        .filter((entry) => (entry.ragContext as any)?.toolUsed === true)
        .map((entry) => {
          const ctx = entry.ragContext as any;
          return {
            id: entry.id,
            createdAt: entry.createdAt,
            conversationId: entry.conversationId,
            agentName: entry.agentName,
            toolName: ctx?.toolName ?? null,
            toolInput: ctx?.toolInput ?? null,
            toolResults: ctx?.toolResults ?? null,
            toolDurationMs: ctx?.toolDurationMs ?? null,
          };
        });

      res.json(toolLogs);
    } catch (err) {
      console.error('[Knowledge] tool-invocations failed:', err);
      res.status(500).json({ error: 'Failed to fetch tool invocations' });
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
