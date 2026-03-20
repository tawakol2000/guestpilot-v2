import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getTopicCacheStats } from '../services/topic-state.service';
import { getTier2Stats } from '../services/intent-extractor.service';
import { getClassifierStatus } from '../services/classifier.service';
import { generatePipelineSnapshot } from '../services/snapshot.service';

// In-memory cache for /accuracy endpoint (60s TTL)
const accuracyCache = new Map<string, { data: any; expiresAt: number }>();

export function aiPipelineRouter(prisma: PrismaClient) {
  const router = Router();

  // Accuracy: classifier & judge accuracy metrics
  router.get('/accuracy', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId;
      const period = req.query.period === '7d' ? '7d' : '30d';
      const periodMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
      const periodStart = new Date(Date.now() - periodMs);

      // Check cache
      const cacheKey = `${tenantId}:${period}`;
      const cached = accuracyCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.data);
      }

      // 1. Overall accuracy (only evaluated, not skipped)
      const [overallCorrect, overallTotal] = await Promise.all([
        prisma.classifierEvaluation.count({
          where: { tenantId, createdAt: { gte: periodStart }, skipReason: null, retrievalCorrect: true },
        }),
        prisma.classifierEvaluation.count({
          where: { tenantId, createdAt: { gte: periodStart }, skipReason: null },
        }),
      ]);

      // 2. Empty-label rate
      const [emptyLabelCount, totalEvalsInPeriod] = await Promise.all([
        prisma.classifierEvaluation.count({
          where: { tenantId, createdAt: { gte: periodStart }, classifierLabels: { isEmpty: true } },
        }),
        prisma.classifierEvaluation.count({
          where: { tenantId, createdAt: { gte: periodStart } },
        }),
      ]);

      // 3. Per-category accuracy — fetch evaluated records and aggregate in code
      const evaluatedRecords = await prisma.classifierEvaluation.findMany({
        where: { tenantId, createdAt: { gte: periodStart }, skipReason: null },
        select: { judgeCorrectLabels: true, classifierLabels: true, retrievalCorrect: true },
      });

      const categoryStats = new Map<string, { correct: number; total: number }>();
      for (const rec of evaluatedRecords) {
        const correctSet = new Set(rec.judgeCorrectLabels || []);
        const classifierSet = new Set(rec.classifierLabels || []);
        // Count each label that appears in judgeCorrectLabels
        for (const label of correctSet) {
          if (!categoryStats.has(label)) categoryStats.set(label, { correct: 0, total: 0 });
          const stat = categoryStats.get(label)!;
          stat.total++;
          if (classifierSet.has(label)) stat.correct++;
        }
        // Also count classifier labels not in judgeCorrectLabels as incorrect
        for (const label of classifierSet) {
          if (!correctSet.has(label)) {
            if (!categoryStats.has(label)) categoryStats.set(label, { correct: 0, total: 0 });
            categoryStats.get(label)!.total++;
          }
        }
      }

      const perCategory = Array.from(categoryStats.entries())
        .map(([category, { correct, total }]) => ({
          category,
          correct,
          total,
          accuracy: total > 0 ? Math.round((correct / total) * 1000) / 1000 : 0,
        }))
        .sort((a, b) => b.total - a.total);

      // 4. Self-improvement stats
      const activeExamples = await prisma.classifierExample.findMany({
        where: { tenantId, active: true },
        select: { source: true, createdAt: true },
      });

      const totalActive = activeExamples.length;
      const bySource: Record<string, number> = {};
      let addedThisPeriod = 0;
      for (const ex of activeExamples) {
        bySource[ex.source] = (bySource[ex.source] || 0) + 1;
        if (ex.createdAt >= periodStart) addedThisPeriod++;
      }

      // 5. Judge mode from TenantAiConfig
      const config = await prisma.tenantAiConfig.findUnique({
        where: { tenantId },
        select: { judgeMode: true },
      });

      const result = {
        overall: {
          correct: overallCorrect,
          total: overallTotal,
          accuracy: overallTotal > 0 ? Math.round((overallCorrect / overallTotal) * 1000) / 1000 : 0,
        },
        emptyLabelRate: totalEvalsInPeriod > 0
          ? Math.round((emptyLabelCount / totalEvalsInPeriod) * 1000) / 1000
          : 0,
        perCategory,
        selfImprovement: {
          totalActive,
          bySource,
          addedThisPeriod,
        },
        judgeMode: config?.judgeMode || 'evaluate_all',
        period,
      };

      // Cache for 60 seconds
      accuracyCache.set(cacheKey, { data: result, expiresAt: Date.now() + 60_000 });

      res.json(result);
    } catch (err) {
      console.error('[Pipeline] Accuracy query failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Feed: recent messages with full pipeline data
  router.get('/feed', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId;
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const offset = parseInt(req.query.offset || '0', 10);

      const [logs, total] = await Promise.all([
        prisma.aiApiLog.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.aiApiLog.count({ where: { tenantId } }),
      ]);

      // Get all conversation IDs to batch-fetch evaluations
      const conversationIds = [...new Set(logs.map(l => l.conversationId).filter(Boolean))] as string[];

      const evaluations = conversationIds.length > 0
        ? await prisma.classifierEvaluation.findMany({
            where: { tenantId, conversationId: { in: conversationIds } },
            orderBy: { createdAt: 'desc' },
          })
        : [];

      // Index evaluations by conversationId for quick lookup
      const evalByConvId = new Map<string, typeof evaluations>();
      for (const ev of evaluations) {
        if (!ev.conversationId) continue;
        if (!evalByConvId.has(ev.conversationId)) evalByConvId.set(ev.conversationId, []);
        evalByConvId.get(ev.conversationId)!.push(ev);
      }

      const feed = logs.map(log => {
        const ragCtx = log.ragContext as any;
        const convEvals = log.conversationId ? (evalByConvId.get(log.conversationId) || []) : [];
        // Find the closest evaluation by time
        const matchingEval = convEvals.find(ev =>
          Math.abs(ev.createdAt.getTime() - log.createdAt.getTime()) < 30000 // within 30s
        );

        return {
          id: log.id,
          timestamp: log.createdAt.toISOString(),
          conversationId: log.conversationId,
          agentName: log.agentName,
          model: log.model,
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
          costUsd: log.costUsd,
          durationMs: log.durationMs,
          responseText: log.responseText || '',
          error: log.error,
          // Pipeline routing data from ragContext
          pipeline: {
            query: ragCtx?.query || '',
            tier: ragCtx?.tier || 'unknown',
            topSimilarity: ragCtx?.topSimilarity ?? null,
            // Tier 1 details
            classifierLabels: ragCtx?.classifierLabels || [],
            classifierTopSim: ragCtx?.classifierTopSim ?? null,
            classifierConfidence: ragCtx?.classifierConfidence ?? null,
            confidenceTier: ragCtx?.confidenceTier || null,
            classifierMethod: ragCtx?.classifierMethod || null,
            // Tier 3 details
            tier3Reinjected: ragCtx?.tier3Reinjected ?? false,
            tier3TopicSwitch: ragCtx?.tier3TopicSwitch ?? false,
            tier3ReinjectedLabels: ragCtx?.tier3ReinjectedLabels || [],
            centroidSimilarity: ragCtx?.centroidSimilarity ?? null,
            centroidThreshold: ragCtx?.centroidThreshold ?? null,
            switchMethod: ragCtx?.switchMethod ?? null,
            // Tier 2 details
            tier2Output: ragCtx?.tier2Output || null,
            // LLM override (medium confidence)
            llmOverride: ragCtx?.llmOverride ?? null,
            // Escalation
            escalationSignals: ragCtx?.escalationSignals || [],
            chunksRetrieved: ragCtx?.totalRetrieved ?? 0,
            chunks: (ragCtx?.chunks || []).map((c: any) => ({
              category: c.category,
              similarity: c.similarity,
              sourceKey: c.sourceKey,
              isGlobal: c.isGlobal,
            })),
            ragDurationMs: ragCtx?.durationMs ?? 0,
          },
          // Judge evaluation data (if available)
          evaluation: matchingEval ? {
            retrievalCorrect: matchingEval.retrievalCorrect,
            classifierLabels: matchingEval.classifierLabels,
            classifierTopSim: matchingEval.classifierTopSim,
            classifierMethod: matchingEval.classifierMethod,
            judgeCorrectLabels: matchingEval.judgeCorrectLabels,
            judgeConfidence: matchingEval.judgeConfidence,
            judgeReasoning: matchingEval.judgeReasoning,
            autoFixed: matchingEval.autoFixed,
            judgeCost: matchingEval.judgeCost,
            skipReason: matchingEval.skipReason || null,
          } : null,
        };
      });

      res.json({ feed, total, limit, offset });
    } catch (err) {
      console.error('[Pipeline] Feed query failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Stats: aggregate pipeline statistics
  router.get('/stats', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h

      // Get recent logs with ragContext
      const recentLogs = await prisma.aiApiLog.findMany({
        where: { tenantId, createdAt: { gte: since } },
        select: { ragContext: true, costUsd: true, durationMs: true },
      });

      // Count tiers from ragContext
      let tier1Count = 0, tier2Count = 0, tier3Count = 0, unknownCount = 0;
      let totalCost = 0, totalDuration = 0;
      let escalationSignalCount = 0;

      for (const log of recentLogs) {
        const rc = log.ragContext as any;
        const tier = rc?.tier || 'unknown';
        if (tier === 'tier1') tier1Count++;
        else if (tier === 'tier2_needed') tier2Count++;
        else if (tier === 'tier3_cache') tier3Count++;
        else unknownCount++;
        totalCost += log.costUsd || 0;
        totalDuration += log.durationMs || 0;
        if (rc?.escalationSignals?.length > 0) escalationSignalCount++;
      }

      // Get evaluation stats
      const [evalTotal, evalCorrect, evalAutoFixed] = await Promise.all([
        prisma.classifierEvaluation.count({ where: { tenantId, createdAt: { gte: since } } }),
        prisma.classifierEvaluation.count({ where: { tenantId, createdAt: { gte: since }, retrievalCorrect: true } }),
        prisma.classifierEvaluation.count({ where: { tenantId, createdAt: { gte: since }, autoFixed: true } }),
      ]);

      // Get Tier 2 and topic cache stats from in-memory services
      const tier2Stats = getTier2Stats();
      const cacheStats = getTopicCacheStats();
      const classifierStatus = getClassifierStatus();

      const total = recentLogs.length;

      res.json({
        period: '24h',
        totalMessages: total,
        tiers: {
          tier1: { count: tier1Count, pct: total > 0 ? Math.round(tier1Count / total * 100) : 0 },
          tier2: { count: tier2Count, pct: total > 0 ? Math.round(tier2Count / total * 100) : 0 },
          tier3: { count: tier3Count, pct: total > 0 ? Math.round(tier3Count / total * 100) : 0 },
          unknown: { count: unknownCount, pct: total > 0 ? Math.round(unknownCount / total * 100) : 0 },
        },
        cost: {
          total: totalCost,
          avgPerMessage: total > 0 ? totalCost / total : 0,
        },
        latency: {
          avgMs: total > 0 ? Math.round(totalDuration / total) : 0,
        },
        selfImprovement: {
          evaluationsRun: evalTotal,
          correctPct: evalTotal > 0 ? Math.round(evalCorrect / evalTotal * 100) : 0,
          autoFixed: evalAutoFixed,
        },
        escalationSignals: escalationSignalCount,
        tier2Service: tier2Stats,
        topicCache: cacheStats,
        classifier: classifierStatus,
      });
    } catch (err) {
      console.error('[Pipeline] Stats query failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Snapshot: generate pipeline health snapshot (FR-007)
  router.post('/snapshot', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const markdown = await generatePipelineSnapshot(tenantId, prisma);
      res.setHeader('Content-Type', 'text/markdown');
      res.send(markdown);
    } catch (err) {
      console.error('[Pipeline] Snapshot generation failed:', err);
      res.status(500).json({ error: 'Snapshot generation failed' });
    }
  });

  return router;
}
