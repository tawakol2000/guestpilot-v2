/**
 * get_version_history + rollback — lightweight agent-facing wrappers over
 * sprint-03's tuning-history controller logic. Scope:
 *
 *   - get_version_history(artifactType?, artifactId?, limit?) — returns the
 *     agent a compact list of recent edits.
 *   - rollback(artifactType, versionId) — SYSTEM_PROMPT and TOOL_DEFINITION
 *     supported; SOP/FAQ return NOT_SUPPORTED to match sprint-03's 501 path.
 *
 * No controller coupling: reuses Prisma directly so the agent can call these
 * from its tool layer without needing an Express context.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { Prisma } from '@prisma/client';
import { startAiSpan } from '../../services/observability.service';
import { invalidateTenantConfigCache } from '../../services/tenant-config.service';
import {
  snapshotFaqEntry,
  snapshotSopVariant,
} from '../../services/tuning/artifact-history.service';
import { asCallToolResult, asError, type ToolContext } from './types';

type ArtifactType = 'SYSTEM_PROMPT' | 'SOP_VARIANT' | 'FAQ_ENTRY' | 'TOOL_DEFINITION';

export function buildGetVersionHistoryTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'get_version_history',
    'Recent artifact edits. Optionally filter by artifactType (SYSTEM_PROMPT / SOP_VARIANT / FAQ_ENTRY / TOOL_DEFINITION) or by artifactId. Returns the most recent `limit` entries across the tenant. Use to decide whether a rollback is the right move, and to spot oscillation.',
    {
      artifactType: z.enum(['SYSTEM_PROMPT', 'SOP_VARIANT', 'FAQ_ENTRY', 'TOOL_DEFINITION']).optional(),
      artifactId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.get_version_history', args);
      try {
        const take = args.limit ?? 20;
        const entries: any[] = [];

        // SYSTEM_PROMPT — read TenantAiConfig.systemPromptHistory.
        if (!args.artifactType || args.artifactType === 'SYSTEM_PROMPT') {
          const cfg = await c.prisma.tenantAiConfig.findUnique({
            where: { tenantId: c.tenantId },
            select: { systemPromptHistory: true },
          });
          const history: any[] = Array.isArray(cfg?.systemPromptHistory)
            ? (cfg!.systemPromptHistory as any[])
            : [];
          for (const h of history) {
            if (!h || typeof h !== 'object') continue;
            const which = h.coordinator ? 'coordinator' : h.screening ? 'screening' : 'unknown';
            if (args.artifactId && which !== args.artifactId) continue;
            entries.push({
              artifactType: 'SYSTEM_PROMPT',
              artifactId: which,
              version: typeof h.version === 'number' ? h.version : null,
              versionId: `sp:${h.version ?? 'x'}:${h.timestamp ?? ''}`,
              timestamp: typeof h.timestamp === 'string' ? h.timestamp : null,
              note: typeof h.note === 'string' ? h.note : null,
              rollbackSupported: true,
            });
          }
        }

        // TOOL_DEFINITION — one synthetic version-row per tool (reset to default).
        if (!args.artifactType || args.artifactType === 'TOOL_DEFINITION') {
          const tools = await c.prisma.toolDefinition.findMany({
            where: {
              tenantId: c.tenantId,
              ...(args.artifactId ? { id: args.artifactId } : {}),
            },
            orderBy: { updatedAt: 'desc' },
            take,
          });
          for (const t of tools) {
            const hasDiff = t.description !== t.defaultDescription;
            entries.push({
              artifactType: 'TOOL_DEFINITION',
              artifactId: t.id,
              artifactLabel: t.name,
              versionId: `tool:${t.id}:${t.updatedAt.toISOString()}`,
              timestamp: t.updatedAt.toISOString(),
              note: hasDiff ? 'description differs from default' : 'matches default',
              rollbackSupported: hasDiff,
            });
          }
        }

        // SOP_VARIANT — snapshot rows from sprint 05 §2 are rollback targets.
        if (!args.artifactType || args.artifactType === 'SOP_VARIANT') {
          const sopHistory = await c.prisma.sopVariantHistory.findMany({
            where: {
              tenantId: c.tenantId,
              ...(args.artifactId ? { targetId: args.artifactId } : {}),
            },
            orderBy: { editedAt: 'desc' },
            take,
          });
          const sopDefIds = Array.from(
            new Set(
              sopHistory
                .map(h => (h.previousContent as any)?.sopDefinitionId as string | undefined)
                .filter((x): x is string => !!x)
            )
          );
          const defs = sopDefIds.length
            ? await c.prisma.sopDefinition.findMany({
                where: { tenantId: c.tenantId, id: { in: sopDefIds } },
                select: { id: true, category: true },
              })
            : [];
          const defById = new Map(defs.map(d => [d.id, d.category]));
          for (const h of sopHistory) {
            const pc = h.previousContent as any;
            const category = defById.get(pc?.sopDefinitionId) ?? 'unknown';
            entries.push({
              artifactType: 'SOP_VARIANT',
              artifactId: h.targetId,
              artifactLabel: `${category} (${pc?.status ?? '?'})${pc?.kind === 'override' ? ' override' : ''}`,
              versionId: `svh:${h.id}`,
              timestamp: h.editedAt.toISOString(),
              note: pc?.kind === 'override' ? 'property override snapshot' : 'variant snapshot',
              rollbackSupported: true,
            });
          }
        }
        if (!args.artifactType || args.artifactType === 'FAQ_ENTRY') {
          const faqHistory = await c.prisma.faqEntryHistory.findMany({
            where: {
              tenantId: c.tenantId,
              ...(args.artifactId ? { targetId: args.artifactId } : {}),
            },
            orderBy: { editedAt: 'desc' },
            take,
          });
          for (const h of faqHistory) {
            const pc = h.previousContent as any;
            const q = typeof pc?.question === 'string' ? pc.question : '(unknown)';
            entries.push({
              artifactType: 'FAQ_ENTRY',
              artifactId: h.targetId,
              artifactLabel: q.slice(0, 80),
              versionId: `feh:${h.id}`,
              timestamp: h.editedAt.toISOString(),
              rollbackSupported: true,
            });
          }
        }

        entries.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
        const payload = { count: Math.min(entries.length, take), entries: entries.slice(0, take) };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`get_version_history failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}

export function buildRollbackTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'rollback',
    "Revert an artifact to a previous version. Supported: SYSTEM_PROMPT (creates a new history entry pointing at the prior content), TOOL_DEFINITION (resets to defaultDescription), SOP_VARIANT (restores from SopVariantHistory snapshot — sprint 05 §2), FAQ_ENTRY (restores from FaqEntryHistory snapshot — sprint 05 §2). Always explain what you're rolling back and why before calling.",
    {
      artifactType: z.enum(['SYSTEM_PROMPT', 'SOP_VARIANT', 'FAQ_ENTRY', 'TOOL_DEFINITION']),
      versionId: z.string().min(1),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.rollback', args);
      try {
        if (args.artifactType === 'SOP_VARIANT') {
          const historyId = args.versionId.startsWith('svh:') ? args.versionId.slice(4) : args.versionId;
          const snap = await c.prisma.sopVariantHistory.findFirst({
            where: { id: historyId, tenantId: c.tenantId },
          });
          if (!snap) {
            span.end({ error: 'VERSION_NOT_FOUND' });
            return asError(`rollback: SOP variant snapshot ${historyId} not found.`);
          }
          const pc = snap.previousContent as any;
          const sopDefinitionId = pc?.sopDefinitionId as string | undefined;
          const status = pc?.status as string | undefined;
          const content = pc?.content as string | undefined;
          const propertyId = pc?.propertyId as string | undefined;
          const kind: 'variant' | 'override' = pc?.kind === 'override' ? 'override' : 'variant';
          if (!sopDefinitionId || !status || typeof content !== 'string') {
            span.end({ error: 'SNAPSHOT_INCOMPLETE' });
            return asError('rollback: SOP snapshot is missing required fields.');
          }
          if (kind === 'override') {
            if (!propertyId) {
              span.end({ error: 'SNAPSHOT_INCOMPLETE' });
              return asError('rollback: override snapshot missing propertyId.');
            }
            const current = await c.prisma.sopPropertyOverride.findUnique({
              where: { sopDefinitionId_propertyId_status: { sopDefinitionId, propertyId, status } },
              select: { id: true, content: true },
            });
            if (current) {
              await snapshotSopVariant(c.prisma, {
                tenantId: c.tenantId,
                targetId: current.id,
                kind: 'override',
                sopDefinitionId,
                status,
                content: current.content,
                propertyId,
                editedByUserId: c.userId ?? null,
                triggeringSuggestionId: snap.triggeringSuggestionId ?? null,
                metadata: { rolledBackFrom: snap.id },
              });
            }
            const restored = await c.prisma.sopPropertyOverride.upsert({
              where: { sopDefinitionId_propertyId_status: { sopDefinitionId, propertyId, status } },
              update: { content },
              create: { sopDefinitionId, propertyId, status, content },
              select: { id: true },
            });
            const payload = { ok: true, artifactType: 'SOP_VARIANT', kind, targetId: restored.id };
            span.end(payload);
            return asCallToolResult(payload);
          }
          const current = await c.prisma.sopVariant.findUnique({
            where: { sopDefinitionId_status: { sopDefinitionId, status } },
            select: { id: true, content: true },
          });
          if (current) {
            await snapshotSopVariant(c.prisma, {
              tenantId: c.tenantId,
              targetId: current.id,
              kind: 'variant',
              sopDefinitionId,
              status,
              content: current.content,
              editedByUserId: c.userId ?? null,
              triggeringSuggestionId: snap.triggeringSuggestionId ?? null,
              metadata: { rolledBackFrom: snap.id },
            });
          }
          const restored = await c.prisma.sopVariant.upsert({
            where: { sopDefinitionId_status: { sopDefinitionId, status } },
            update: { content },
            create: { sopDefinitionId, status, content },
            select: { id: true },
          });
          const payload = { ok: true, artifactType: 'SOP_VARIANT', kind, targetId: restored.id };
          span.end(payload);
          return asCallToolResult(payload);
        }

        if (args.artifactType === 'FAQ_ENTRY') {
          const historyId = args.versionId.startsWith('feh:') ? args.versionId.slice(4) : args.versionId;
          const snap = await c.prisma.faqEntryHistory.findFirst({
            where: { id: historyId, tenantId: c.tenantId },
          });
          if (!snap) {
            span.end({ error: 'VERSION_NOT_FOUND' });
            return asError(`rollback: FAQ snapshot ${historyId} not found.`);
          }
          const pc = snap.previousContent as any;
          if (typeof pc?.question !== 'string' || typeof pc?.answer !== 'string' || typeof pc?.category !== 'string') {
            span.end({ error: 'SNAPSHOT_INCOMPLETE' });
            return asError('rollback: FAQ snapshot is missing required fields.');
          }
          const current = await c.prisma.faqEntry.findFirst({
            where: { id: snap.targetId, tenantId: c.tenantId },
          });
          if (current) {
            await snapshotFaqEntry(c.prisma, {
              tenantId: c.tenantId,
              targetId: current.id,
              question: current.question,
              answer: current.answer,
              category: current.category,
              scope: String(current.scope),
              propertyId: current.propertyId ?? null,
              status: String(current.status),
              editedByUserId: c.userId ?? null,
              triggeringSuggestionId: snap.triggeringSuggestionId ?? null,
              metadata: { rolledBackFrom: snap.id },
            });
            await c.prisma.faqEntry.update({
              where: { id: current.id },
              data: {
                question: pc.question,
                answer: pc.answer,
                category: pc.category,
                ...(pc.scope ? { scope: pc.scope as any } : {}),
                ...(pc.status ? { status: pc.status as any } : {}),
                propertyId: pc.propertyId ?? null,
              },
            });
            const payload = { ok: true, artifactType: 'FAQ_ENTRY', targetId: current.id };
            span.end(payload);
            return asCallToolResult(payload);
          }
          // Row was deleted — recreate from snapshot.
          const recreated = await c.prisma.faqEntry.create({
            data: {
              tenantId: c.tenantId,
              question: pc.question,
              answer: pc.answer,
              category: pc.category,
              scope: pc.scope ?? 'PROPERTY',
              status: pc.status ?? 'ACTIVE',
              propertyId: pc.propertyId ?? null,
              source: 'MANUAL',
            },
            select: { id: true },
          });
          const payload = { ok: true, artifactType: 'FAQ_ENTRY', targetId: recreated.id, recreated: true };
          span.end(payload);
          return asCallToolResult(payload);
        }

        if (args.artifactType === 'SYSTEM_PROMPT') {
          const parts = args.versionId.split(':');
          const version = parseInt(parts[1], 10);
          if (!Number.isFinite(version)) {
            span.end({ error: 'INVALID_VERSION_ID' });
            return asError('rollback: invalid versionId format (expected sp:<version>:<ts>).');
          }
          const cfg = await c.prisma.tenantAiConfig.findUnique({ where: { tenantId: c.tenantId } });
          const history = Array.isArray(cfg?.systemPromptHistory)
            ? ((cfg!.systemPromptHistory as any[]) ?? [])
            : [];
          const target = history.find((h: any) => h && h.version === version);
          if (!target) {
            span.end({ error: 'VERSION_NOT_FOUND' });
            return asError(`rollback: version v${version} not found in systemPromptHistory.`);
          }
          const variant: 'coordinator' | 'screening' = target.coordinator ? 'coordinator' : 'screening';
          const prev: string = target[variant] || '';
          if (!prev) {
            span.end({ error: 'ROLLBACK_CONTENT_EMPTY' });
            return asError('rollback: stored history entry has empty content.');
          }
          const field = variant === 'coordinator' ? 'systemPromptCoordinator' : 'systemPromptScreening';
          const newHistory = [...history];
          newHistory.push({
            version: cfg?.systemPromptVersion ?? 1,
            timestamp: new Date().toISOString(),
            [variant]: (cfg as any)?.[field] || '',
            note: `Rolled back to v${version} by tuning agent`,
          });
          while (newHistory.length > 10) newHistory.shift();
          await c.prisma.tenantAiConfig.update({
            where: { tenantId: c.tenantId },
            data: {
              [field]: prev,
              systemPromptVersion: { increment: 1 },
              systemPromptHistory: newHistory as Prisma.InputJsonValue,
            },
          });
          invalidateTenantConfigCache(c.tenantId);
          const payload = { ok: true, artifactType: 'SYSTEM_PROMPT', variant, rolledBackTo: version };
          span.end(payload);
          return asCallToolResult(payload);
        }

        // TOOL_DEFINITION
        const parts = args.versionId.split(':');
        const toolId = parts[1];
        if (!toolId) return asError('rollback: invalid versionId format (expected tool:<id>:<ts>).');
        const t = await c.prisma.toolDefinition.findFirst({
          where: { id: toolId, tenantId: c.tenantId },
        });
        if (!t) {
          span.end({ error: 'TOOL_NOT_FOUND' });
          return asError(`rollback: ToolDefinition ${toolId} not found.`);
        }
        await c.prisma.toolDefinition.update({
          where: { id: t.id },
          data: { description: t.defaultDescription },
        });
        const payload = { ok: true, artifactType: 'TOOL_DEFINITION', artifactId: t.id, resetToDefault: true };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`rollback failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
