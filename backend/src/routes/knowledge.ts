import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { SOP_CATEGORIES, buildToolDefinition, getSopContent, invalidateSopCache } from '../services/sop.service';

/**
 * Bugfix (2026-04-23): canonical SOP-status set the readers
 * (sop.service.ts#getSopContent) match against. The admin SOP-variant
 * + property-override POST handlers used to accept arbitrary `status`
 * strings, so a typo like `"CONFIRMED "` (trailing space) or
 * `"checked_in"` (lowercase) would create a row that never matched
 * any reader query — invisible to the AI but counted in admin UI
 * totals (orphan write). The sister write paths in create-sop.ts +
 * suggestion-action.ts both validate; this admin surface was the odd
 * one out.
 */
const SOP_STATUSES_SET = new Set([
  'DEFAULT',
  'INQUIRY',
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
]);

export function knowledgeRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

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

      // Build SOP data array — use DEFAULT status for the overview listing
      const sops = await Promise.all(
        SOP_CATEGORIES.map(async category => ({
          category,
          toolDescription: descriptionMap[category] || '',
          content: await getSopContent(tenantId, category, 'DEFAULT', undefined, undefined, prisma) || '',
          isGlobal: true,
        }))
      );

      res.json({ sops, properties });
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
      // 2026-04-23: validate status against the canonical set so an
      // admin typo can't create an orphan variant invisible to the AI.
      if (!SOP_STATUSES_SET.has(status)) {
        return res.status(400).json({
          error: `status must be one of: ${[...SOP_STATUSES_SET].join(', ')}`,
        });
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

  // POST /api/knowledge/sop-definitions/reset — delete all SOPs and re-seed from defaults
  router.post('/sop-definitions/reset', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;

      // Delete in order (respecting foreign keys)
      await prisma.sopPropertyOverride.deleteMany({ where: { sopDefinition: { tenantId } } });
      await prisma.sopVariant.deleteMany({ where: { sopDefinition: { tenantId } } });
      await prisma.sopDefinition.deleteMany({ where: { tenantId } });

      // Re-seed from defaults
      const { seedSopDefinitions } = await import('../services/sop.service');
      await seedSopDefinitions(tenantId, prisma);

      invalidateSopCache(tenantId);
      console.log(`[Knowledge] SOPs reset to defaults for tenant ${tenantId}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] sop-definitions reset failed:', err);
      res.status(500).json({ error: 'Failed to reset SOPs' });
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
      // 2026-04-23: validate status — same orphan-write protection as
      // the sop-variants POST handler above.
      if (!SOP_STATUSES_SET.has(status)) {
        return res.status(400).json({
          error: `status must be one of: ${[...SOP_STATUSES_SET].join(', ')}`,
        });
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

  return router;
}
