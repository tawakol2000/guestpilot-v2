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
import { invalidateSopCache } from '../../services/sop.service';
import { invalidateToolCache } from '../../services/tool-definition.service';
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
    "Revert artifact state. Two modes: (1) PER-ARTIFACT — pass artifactType + versionId to roll a single artifact back to a prior version. Supported types: SYSTEM_PROMPT, TOOL_DEFINITION, SOP_VARIANT, FAQ_ENTRY. (2) TRANSACTION — pass transactionId to revert ALL artifacts written under a BUILD-mode plan, in reverse dependency order (tool_definitions → system_prompt → faq → sop). Exactly one mode per call — passing both is an error. Always explain what you're rolling back and why before calling.",
    {
      artifactType: z.enum(['SYSTEM_PROMPT', 'SOP_VARIANT', 'FAQ_ENTRY', 'TOOL_DEFINITION']).optional(),
      versionId: z.string().min(1).optional(),
      transactionId: z.string().min(1).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.rollback', args);
      try {
        // Mode validation — exactly one of the two rollback modes.
        const hasArtifactMode = Boolean(args.artifactType && args.versionId);
        const hasPartialArtifact = Boolean(args.artifactType) !== Boolean(args.versionId);
        const hasTxMode = Boolean(args.transactionId);
        if (hasPartialArtifact) {
          span.end({ error: 'INVALID_ARGS' });
          return asError(
            'rollback: artifactType and versionId must be passed together. Pass both for per-artifact rollback, or pass transactionId alone for transaction rollback.'
          );
        }
        if (hasArtifactMode && hasTxMode) {
          span.end({ error: 'INVALID_ARGS' });
          return asError(
            'rollback: cannot combine per-artifact and transaction modes in one call. Pick one — either (artifactType + versionId) OR transactionId.'
          );
        }
        if (!hasArtifactMode && !hasTxMode) {
          span.end({ error: 'INVALID_ARGS' });
          return asError(
            'rollback: nothing to roll back. Pass either (artifactType + versionId) for a single artifact or transactionId for a whole BUILD plan.'
          );
        }

        // ─── Transaction mode (sprint 045) ─────────────────────────────
        if (hasTxMode) {
          const txId = args.transactionId!;
          const tx = await c.prisma.buildTransaction.findFirst({
            where: { id: txId, tenantId: c.tenantId },
          });
          if (!tx) {
            span.end({ error: 'TX_NOT_FOUND' });
            return asError(`rollback: BuildTransaction ${txId} not found for this tenant.`);
          }
          if (tx.status === 'ROLLED_BACK') {
            span.end({ error: 'ALREADY_ROLLED_BACK' });
            return asError(`rollback: BuildTransaction ${txId} is already rolled back.`);
          }
          const reverted = {
            toolDefinitions: 0,
            systemPromptVersions: 0,
            faqEntries: 0,
            sopVariants: 0,
            sopPropertyOverrides: 0,
          };
          // Reverse dependency order: tools → system_prompt → faq → sop.
          // Each branch is a soft delete: BUILD-created artifacts didn't
          // exist before the transaction, so the revert is a DELETE (or
          // for AiConfigVersion, a restore of TenantAiConfig to the
          // previous version's content).
          await c.prisma.$transaction(async (db) => {
            // 1. Tool definitions
            const toolDels = await db.toolDefinition.deleteMany({
              where: { buildTransactionId: txId, tenantId: c.tenantId },
            });
            reverted.toolDefinitions = toolDels.count;
            if (toolDels.count > 0) {
              invalidateToolCache(c.tenantId);
              invalidateTenantConfigCache(c.tenantId);
            }

            // 2. System prompt (AiConfigVersion) — restore TenantAiConfig
            //    to the prior version's config values.
            const txVersions = await db.aiConfigVersion.findMany({
              where: { buildTransactionId: txId, tenantId: c.tenantId },
              orderBy: { version: 'asc' },
            });
            if (txVersions.length > 0) {
              const firstTxVersion = txVersions[0].version;
              const prior = await db.aiConfigVersion.findFirst({
                where: {
                  tenantId: c.tenantId,
                  version: { lt: firstTxVersion },
                },
                orderBy: { version: 'desc' },
              });
              if (prior) {
                const priorCfg = (prior.config ?? {}) as {
                  systemPromptCoordinator?: string;
                  systemPromptScreening?: string;
                };
                const updateData: Record<string, string> = {};
                if (typeof priorCfg.systemPromptCoordinator === 'string') {
                  updateData.systemPromptCoordinator = priorCfg.systemPromptCoordinator;
                }
                if (typeof priorCfg.systemPromptScreening === 'string') {
                  updateData.systemPromptScreening = priorCfg.systemPromptScreening;
                }
                if (Object.keys(updateData).length > 0) {
                  await db.tenantAiConfig.update({
                    where: { tenantId: c.tenantId },
                    data: updateData,
                  });
                }
              }
              // Keep AiConfigVersion rows for audit — don't delete them.
              // Future inspection of "what did this transaction do" depends
              // on the history trail. The rollback-to-prior above is
              // sufficient to restore runtime behaviour.
              reverted.systemPromptVersions = txVersions.length;
              invalidateTenantConfigCache(c.tenantId);
            }

            // 3. FAQ entries
            const faqDels = await db.faqEntry.deleteMany({
              where: { buildTransactionId: txId, tenantId: c.tenantId },
            });
            reverted.faqEntries = faqDels.count;

            // 4. SOP variants + property overrides
            const sopVarDels = await db.sopVariant.deleteMany({
              where: { buildTransactionId: txId },
            });
            reverted.sopVariants = sopVarDels.count;
            const sopOverrideDels = await db.sopPropertyOverride.deleteMany({
              where: { buildTransactionId: txId },
            });
            reverted.sopPropertyOverrides = sopOverrideDels.count;
            if (sopVarDels.count > 0 || sopOverrideDels.count > 0) {
              invalidateSopCache(c.tenantId);
            }

            await db.buildTransaction.update({
              where: { id: txId },
              data: { status: 'ROLLED_BACK', completedAt: new Date() },
            });
          });

          const payload = {
            ok: true,
            mode: 'transaction',
            transactionId: txId,
            reverted,
            plannedItems: tx.plannedItems,
          };
          span.end(payload);
          return asCallToolResult(payload);
        }

        // ─── Per-artifact mode (pre-045 behaviour, unchanged below) ────
        // After the guards above, both fields are set — narrow for TS.
        const artifactType = args.artifactType!;
        const versionId = args.versionId!;
        if (artifactType === 'SOP_VARIANT') {
          const historyId = versionId.startsWith('svh:') ? versionId.slice(4) : versionId;
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
            // Parity with the HTTP rollback (tuning-history.controller.ts):
            // main AI reads SOPs through a 5-min cache and would otherwise
            // serve the rolled-back-FROM content until the TTL expired.
            invalidateSopCache(c.tenantId);
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
          invalidateSopCache(c.tenantId);
          const payload = { ok: true, artifactType: 'SOP_VARIANT', kind, targetId: restored.id };
          span.end(payload);
          return asCallToolResult(payload);
        }

        if (artifactType === 'FAQ_ENTRY') {
          const historyId = versionId.startsWith('feh:') ? versionId.slice(4) : versionId;
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

        if (artifactType === 'SYSTEM_PROMPT') {
          const parts = versionId.split(':');
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
          // Sprint 09 follow-up: guard against ambiguous history rows. The
          // OLD code did `target.coordinator ? 'coordinator' : 'screening'`,
          // which silently defaulted to `screening` whenever the coordinator
          // field was missing — including when the row snapshot ONLY stored
          // the screening prompt. Worse, if neither key was present (bad
          // legacy row) the rollback would blank the screening prompt even
          // when the user was trying to roll back the coordinator.
          // Detect explicitly: require exactly one of the two variant keys
          // to be a non-empty string, else refuse.
          const hasCoord = typeof target.coordinator === 'string' && target.coordinator.length > 0;
          const hasScreen = typeof target.screening === 'string' && target.screening.length > 0;
          if (!hasCoord && !hasScreen) {
            span.end({ error: 'ROLLBACK_CONTENT_EMPTY' });
            return asError('rollback: stored history entry has no coordinator or screening snapshot.');
          }
          if (hasCoord && hasScreen) {
            span.end({ error: 'ROLLBACK_AMBIGUOUS' });
            return asError(
              'rollback: stored history entry contains both coordinator and screening snapshots; cannot pick a single variant. This row likely predates the per-variant snapshot convention.'
            );
          }
          const variant: 'coordinator' | 'screening' = hasCoord ? 'coordinator' : 'screening';
          const prev: string = target[variant] as string;
          // Mirror tenant-config.service's 100-char floor / 50k ceiling so
          // a legacy snapshot can't roll forward into an unusable prompt.
          if (prev.length < 100 || prev.length > 50000) {
            span.end({ error: 'ROLLBACK_INVALID_LENGTH' });
            return asError(
              `rollback: snapshot length ${prev.length} is outside the 100–50,000 char range. Refusing to restore an invalid prompt.`
            );
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
        const parts = versionId.split(':');
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
        // Parity with the HTTP rollback: tool schema is cached 5min,
        // tenant config 60s. Without this the rolled-back description
        // won't reach the next main-AI call until the TTL expires.
        invalidateToolCache(c.tenantId);
        invalidateTenantConfigCache(c.tenantId);
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
