import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getTopicCacheStats } from '../services/topic-state.service';
import { getTier2Stats } from '../services/intent-extractor.service';
import { getClassifierStatus } from '../services/classifier.service';

export function aiPipelineRouter(prisma: PrismaClient) {
  const router = Router();

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
          responseText: log.responseText?.substring(0, 500) || '',
          error: log.error,
          // Pipeline routing data from ragContext
          pipeline: {
            query: ragCtx?.query?.substring(0, 200) || '',
            tier: ragCtx?.tier || 'unknown',
            topSimilarity: ragCtx?.topSimilarity ?? null,
            // Tier 1 details
            classifierLabels: ragCtx?.classifierLabels || [],
            classifierTopSim: ragCtx?.classifierTopSim ?? null,
            classifierMethod: ragCtx?.classifierMethod || null,
            // Tier 3 details
            tier3Reinjected: ragCtx?.tier3Reinjected ?? false,
            tier3TopicSwitch: ragCtx?.tier3TopicSwitch ?? false,
            tier3ReinjectedLabels: ragCtx?.tier3ReinjectedLabels || [],
            // Tier 2 details
            tier2Output: ragCtx?.tier2Output || null,
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

  return router;
}
