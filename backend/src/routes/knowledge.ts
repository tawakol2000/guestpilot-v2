import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';
import { seedTenantSops, ingestPropertyKnowledge } from '../services/rag.service';
import { invalidateThresholdCache } from '../services/judge.service';
import { setEmbeddingProvider, getEmbeddingProvider, type EmbeddingProvider } from '../services/embeddings.service';
import { invalidateTenantConfigCache } from '../services/tenant-config.service';
import { AuthenticatedRequest } from '../types';
import { SOP_CATEGORIES, buildToolDefinition, getSopContent, invalidateSopCache } from '../services/sop.service';

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

  // GET /api/knowledge/classifier-status — classifier health check

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

      // If embedding provider changed, re-embed RAG chunks in the background
      if (provider !== prevProvider) {
        setEmbeddingProvider(provider);
        console.log(`[Thresholds] Embedding provider changed: ${prevProvider} → ${provider}. Re-embedding RAG data...`);
        (async () => {
          try {
            await seedTenantSops(tenantId, prisma);
            const properties = await prisma.property.findMany({ where: { tenantId } });
            for (const prop of properties) {
              await ingestPropertyKnowledge(tenantId, prop.id, prop, prisma);
            }
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

  // POST /api/knowledge/gap-analysis — T012: classifier gap analysis
  router.post('/gap-analysis', ((req, res) => ctrl.gapAnalysis(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

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

  // GET /api/knowledge/sop-data — returns all SOP categories with descriptions and content
  router.get('/sop-data', async (req: any, res) => {
    try {
      const tenantId = req.tenantId;

      // Build tool definition from DB (cached 5min) to extract descriptions
      const toolDef = await buildToolDefinition(tenantId, prisma);
      const descriptionText = toolDef.parameters.properties.categories.description as string;
      const descriptionMap: Record<string, string> = {};
      for (const line of descriptionText.split('\n')) {
        const match = line.match(/^- '([^']+)':\s*(.+)$/);
        if (match) descriptionMap[match[1]] = match[2];
      }

      // Get property list for the dropdown
      const properties = await prisma.property.findMany({
        where: { tenantId },
        select: { id: true, name: true, address: true },
        orderBy: { name: 'asc' },
      });

      // Get property-specific chunks (RAG knowledge per property)
      const propertyChunks = await prisma.propertyKnowledgeChunk.findMany({
        where: { tenantId },
        select: { id: true, propertyId: true, content: true, category: true, sourceKey: true },
      });

      // Build SOP data array — use DEFAULT status for the overview listing
      const sops = await Promise.all(
        SOP_CATEGORIES.map(async category => ({
          category,
          toolDescription: descriptionMap[category] || '',
          content: await getSopContent(tenantId, category, 'DEFAULT', undefined, undefined, prisma) || '',
          isGlobal: true,
        }))
      );

      res.json({ sops, properties, propertyChunks });
    } catch (err) {
      console.error('[Knowledge] sop-data failed:', err);
      res.status(500).json({ error: 'Failed to fetch SOP data' });
    }
  });

  // ── SOP Definition & Variant CRUD ──

  // GET /api/knowledge/sop-definitions — all definitions + variants for tenant (auto-seeds if empty)
  router.get('/sop-definitions', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;

      // Auto-seed if no definitions found
      const count = await prisma.sopDefinition.count({ where: { tenantId } });
      if (count === 0) {
        const { seedSopDefinitions } = await import('../services/sop.service');
        await seedSopDefinitions(tenantId, prisma);
      }

      const definitions = await prisma.sopDefinition.findMany({
        where: { tenantId },
        include: { variants: true },
        orderBy: { category: 'asc' },
      });

      const properties = await prisma.property.findMany({
        where: { tenantId },
        select: { id: true, name: true, address: true },
        orderBy: { name: 'asc' },
      });

      res.json({ definitions, properties });
    } catch (err) {
      console.error('[Knowledge] sop-definitions GET failed:', err);
      res.status(500).json({ error: 'Failed to fetch SOP definitions' });
    }
  });

  // PUT /api/knowledge/sop-definitions/:id — update toolDescription and/or enabled
  router.put('/sop-definitions/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;
      const { toolDescription, enabled } = req.body as { toolDescription?: string; enabled?: boolean };

      const def = await prisma.sopDefinition.findFirst({
        where: { id, tenantId },
      });
      if (!def) return res.status(404).json({ error: 'Not found' });

      const updated = await prisma.sopDefinition.update({
        where: { id },
        data: {
          ...(toolDescription !== undefined ? { toolDescription } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        },
        include: { variants: true },
      });

      invalidateSopCache(tenantId);
      res.json(updated);
    } catch (err) {
      console.error('[Knowledge] sop-definitions PUT failed:', err);
      res.status(500).json({ error: 'Failed to update SOP definition' });
    }
  });

  // PUT /api/knowledge/sop-variants/:id — update content and/or enabled
  router.put('/sop-variants/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;
      const { content, enabled } = req.body as { content?: string; enabled?: boolean };

      // Verify the variant belongs to this tenant
      const variant = await prisma.sopVariant.findFirst({
        where: { id },
        include: { sopDefinition: { select: { tenantId: true } } },
      });
      if (!variant || variant.sopDefinition.tenantId !== tenantId) {
        return res.status(404).json({ error: 'Not found' });
      }

      const updated = await prisma.sopVariant.update({
        where: { id },
        data: {
          ...(content !== undefined ? { content } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        },
      });

      invalidateSopCache(tenantId);
      res.json(updated);
    } catch (err) {
      console.error('[Knowledge] sop-variants PUT failed:', err);
      res.status(500).json({ error: 'Failed to update SOP variant' });
    }
  });

  // POST /api/knowledge/sop-variants — create new variant
  router.post('/sop-variants', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { sopDefinitionId, status, content } = req.body as {
        sopDefinitionId: string; status: string; content: string;
      };

      if (!sopDefinitionId || !status || !content) {
        return res.status(400).json({ error: 'sopDefinitionId, status, and content are required' });
      }

      // Verify the definition belongs to this tenant
      const def = await prisma.sopDefinition.findFirst({
        where: { id: sopDefinitionId, tenantId },
      });
      if (!def) return res.status(404).json({ error: 'SOP definition not found' });

      const variant = await prisma.sopVariant.create({
        data: { sopDefinitionId, status, content, enabled: true },
      });

      invalidateSopCache(tenantId);
      res.json(variant);
    } catch (err) {
      console.error('[Knowledge] sop-variants POST failed:', err);
      res.status(500).json({ error: 'Failed to create SOP variant' });
    }
  });

  // DELETE /api/knowledge/sop-variants/:id — delete a variant
  router.delete('/sop-variants/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;

      const variant = await prisma.sopVariant.findFirst({
        where: { id },
        include: { sopDefinition: { select: { tenantId: true } } },
      });
      if (!variant || variant.sopDefinition.tenantId !== tenantId) {
        return res.status(404).json({ error: 'Not found' });
      }

      await prisma.sopVariant.delete({ where: { id } });

      invalidateSopCache(tenantId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] sop-variants DELETE failed:', err);
      res.status(500).json({ error: 'Failed to delete SOP variant' });
    }
  });

  // GET /api/knowledge/sop-property-overrides?propertyId=xxx — list overrides for a property
  router.get('/sop-property-overrides', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { propertyId } = req.query as { propertyId?: string };

      if (!propertyId) {
        return res.status(400).json({ error: 'propertyId query parameter is required' });
      }

      const overrides = await prisma.sopPropertyOverride.findMany({
        where: {
          propertyId,
          sopDefinition: { tenantId },
        },
        include: { sopDefinition: { select: { category: true } } },
        orderBy: { createdAt: 'desc' },
      });

      res.json(overrides);
    } catch (err) {
      console.error('[Knowledge] sop-property-overrides GET failed:', err);
      res.status(500).json({ error: 'Failed to fetch property overrides' });
    }
  });

  // POST /api/knowledge/sop-property-overrides — create property override
  router.post('/sop-property-overrides', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { sopDefinitionId, propertyId, status, content } = req.body as {
        sopDefinitionId: string; propertyId: string; status: string; content: string;
      };

      if (!sopDefinitionId || !propertyId || !status || !content) {
        return res.status(400).json({ error: 'sopDefinitionId, propertyId, status, and content are required' });
      }

      // Verify the definition belongs to this tenant
      const def = await prisma.sopDefinition.findFirst({
        where: { id: sopDefinitionId, tenantId },
      });
      if (!def) return res.status(404).json({ error: 'SOP definition not found' });

      // Verify property belongs to this tenant
      const prop = await prisma.property.findFirst({
        where: { id: propertyId, tenantId },
      });
      if (!prop) return res.status(404).json({ error: 'Property not found' });

      const override = await prisma.sopPropertyOverride.create({
        data: { sopDefinitionId, propertyId, status, content, enabled: true },
      });

      invalidateSopCache(tenantId);
      res.json(override);
    } catch (err) {
      console.error('[Knowledge] sop-property-overrides POST failed:', err);
      res.status(500).json({ error: 'Failed to create property override' });
    }
  });

  // PUT /api/knowledge/sop-property-overrides/:id — update property override
  router.put('/sop-property-overrides/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;
      const { content, enabled } = req.body as { content?: string; enabled?: boolean };

      const override = await prisma.sopPropertyOverride.findFirst({
        where: { id },
        include: { sopDefinition: { select: { tenantId: true } } },
      });
      if (!override || override.sopDefinition.tenantId !== tenantId) {
        return res.status(404).json({ error: 'Not found' });
      }

      const updated = await prisma.sopPropertyOverride.update({
        where: { id },
        data: {
          ...(content !== undefined ? { content } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        },
      });

      invalidateSopCache(tenantId);
      res.json(updated);
    } catch (err) {
      console.error('[Knowledge] sop-property-overrides PUT failed:', err);
      res.status(500).json({ error: 'Failed to update property override' });
    }
  });

  // DELETE /api/knowledge/sop-property-overrides/:id — delete property override
  router.delete('/sop-property-overrides/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;

      const override = await prisma.sopPropertyOverride.findFirst({
        where: { id },
        include: { sopDefinition: { select: { tenantId: true } } },
      });
      if (!override || override.sopDefinition.tenantId !== tenantId) {
        return res.status(404).json({ error: 'Not found' });
      }

      await prisma.sopPropertyOverride.delete({ where: { id } });

      invalidateSopCache(tenantId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] sop-property-overrides DELETE failed:', err);
      res.status(500).json({ error: 'Failed to delete property override' });
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
