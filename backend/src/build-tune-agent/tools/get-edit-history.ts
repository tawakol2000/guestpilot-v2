/**
 * studio_get_edit_history — consolidated edit timeline for tenant artifacts.
 *
 * 060-D consolidation: merges the prior `get_version_history` (broad,
 * snapshot-tables) and `get_edit_history` (single-artifact, BuildArtifactHistory)
 * into one tool. Dispatch hinges on whether `artifactId` is supplied:
 *
 *   • artifactId present  → single-artifact mode. Query BuildArtifactHistory
 *     for the named artifact's operation log. Returns `{ rows }` with
 *     appliedAt/operation/rationale/etc. ordered newest-first.
 *
 *   • artifactId absent   → broad mode. Walk the per-type snapshot history
 *     tables (TenantAiConfig.systemPromptHistory, ToolDefinition,
 *     SopVariantHistory, FaqEntryHistory) and return a flat
 *     `{ count, entries }` list of recent edits across the tenant.
 *
 * Both paths take optional `artifactType` + `limit`. `detail: 'summary' |
 * 'full'` (default 'summary') controls verbosity:
 *   • single-artifact: 'full' includes prevBody/newBody snapshots from
 *     BuildArtifactHistory. 'summary' excludes them.
 *   • broad: 'full' includes the per-entry note/rollbackSupported flags;
 *     'summary' is just artifactType + id + timestamp.
 *
 * Tenant-scoped — the where-clause always pins on the calling tenant.
 * Errors degrade to empty result rather than propagating.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, type ToolContext } from './types';

// Lowercase enum matches BuildArtifactHistory.artifactType column values
// AND the version-history.ts internal types after a tiny normalisation.
const ARTIFACT_TYPE = z
  .enum(['sop', 'faq', 'system_prompt', 'tool_definition', 'property_override'])
  .optional();

const DESCRIPTION = `studio_get_edit_history: Edit timeline for tenant artifacts.
WHEN TO USE: When the manager asks why / when / by whom an artifact was
changed, OR when assessing rollback / oscillation risk before a write.
DISPATCH:
  • Pass artifactId  → single-artifact log from BuildArtifactHistory.
  • Omit artifactId  → broad recent-edits list across artifact types
    (filter by artifactType to scope; omit both for everything).
PARAMETERS:
  artifactType (optional) — sop | faq | system_prompt | tool_definition | property_override
  artifactId   (optional) — the artifact's stable cuid
  limit        (optional) — max rows (default 10, max 100)
  detail       (optional) — 'summary' | 'full' (default 'summary')
RETURNS:
  • Single-artifact: { rows: [{ appliedAt, operation, rationale, ... }] }
  • Broad: { count, entries: [{ artifactType, artifactId, versionId, timestamp, note?, rollbackSupported? }] }`;

type SingleArtifactType = 'sop' | 'faq' | 'system_prompt' | 'tool_definition' | 'property_override';

async function querySingleArtifact(
  c: ToolContext,
  artifactType: SingleArtifactType,
  artifactId: string,
  limit: number,
  detail: 'summary' | 'full',
) {
  const rows = await c.prisma.buildArtifactHistory.findMany({
    where: {
      tenantId: c.tenantId,
      artifactType,
      artifactId,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      operation: true,
      actorUserId: true,
      metadata: true,
      ...(detail === 'full' ? { prevBody: true, newBody: true } : {}),
    },
  });

  return {
    rows: rows.map((r: any) => {
      const meta =
        r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
          ? (r.metadata as Record<string, unknown>)
          : {};
      const base: Record<string, unknown> = {
        appliedAt: r.createdAt.toISOString(),
        operation: r.operation as 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT',
        rationale: (meta.rationale as string | null | undefined) ?? null,
        operatorRationale: (meta.operatorRationale as string | null | undefined) ?? null,
        rationalePrefix: (meta.rationalePrefix as string | null | undefined) ?? null,
        appliedByUserId: r.actorUserId ?? null,
        versionId: r.id,
      };
      if (detail === 'full') {
        base.prevBody = r.prevBody ?? null;
        base.newBody = r.newBody ?? null;
      }
      return base;
    }),
  };
}

// Map lowercase artifactType to the broad-mode uppercase types used by
// the legacy snapshot-tables logic.
const BROAD_TYPE_MAP: Record<SingleArtifactType, string | null> = {
  system_prompt: 'SYSTEM_PROMPT',
  tool_definition: 'TOOL_DEFINITION',
  sop: 'SOP_VARIANT',
  faq: 'FAQ_ENTRY',
  property_override: null, // not surfaced in broad mode (no snapshot table)
};

async function queryBroad(
  c: ToolContext,
  artifactType: SingleArtifactType | undefined,
  limit: number,
  detail: 'summary' | 'full',
) {
  const broadFilter = artifactType ? BROAD_TYPE_MAP[artifactType] ?? null : null;
  const entries: any[] = [];

  if (!broadFilter || broadFilter === 'SYSTEM_PROMPT') {
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
      const entry: Record<string, unknown> = {
        artifactType: 'SYSTEM_PROMPT',
        artifactId: which,
        version: typeof h.version === 'number' ? h.version : null,
        versionId: `sp:${h.version ?? 'x'}:${h.timestamp ?? ''}`,
        timestamp: typeof h.timestamp === 'string' ? h.timestamp : null,
      };
      if (detail === 'full') {
        entry.note = typeof h.note === 'string' ? h.note : null;
        entry.rollbackSupported = true;
      }
      entries.push(entry);
    }
  }

  if (!broadFilter || broadFilter === 'TOOL_DEFINITION') {
    const tools = await c.prisma.toolDefinition.findMany({
      where: { tenantId: c.tenantId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    for (const t of tools) {
      const hasDiff = t.description !== t.defaultDescription;
      const entry: Record<string, unknown> = {
        artifactType: 'TOOL_DEFINITION',
        artifactId: t.id,
        artifactLabel: t.name,
        versionId: `tool:${t.id}:${t.updatedAt.toISOString()}`,
        timestamp: t.updatedAt.toISOString(),
      };
      if (detail === 'full') {
        entry.note = hasDiff ? 'description differs from default' : 'matches default';
        entry.rollbackSupported = hasDiff;
      }
      entries.push(entry);
    }
  }

  if (!broadFilter || broadFilter === 'SOP_VARIANT') {
    const sopHistory = await c.prisma.sopVariantHistory.findMany({
      where: { tenantId: c.tenantId },
      orderBy: { editedAt: 'desc' },
      take: limit,
    });
    const sopDefIds = Array.from(
      new Set(
        sopHistory
          .map((h: any) => (h.previousContent as any)?.sopDefinitionId as string | undefined)
          .filter((x: any): x is string => !!x),
      ),
    );
    const defs = sopDefIds.length
      ? await c.prisma.sopDefinition.findMany({
          where: { tenantId: c.tenantId, id: { in: sopDefIds } },
          select: { id: true, category: true },
        })
      : [];
    const defById = new Map(defs.map((d: any) => [d.id, d.category]));
    for (const h of sopHistory) {
      const pc = h.previousContent as any;
      const category = defById.get(pc?.sopDefinitionId) ?? 'unknown';
      const entry: Record<string, unknown> = {
        artifactType: 'SOP_VARIANT',
        artifactId: h.targetId,
        artifactLabel: `${category} (${pc?.status ?? '?'})${pc?.kind === 'override' ? ' override' : ''}`,
        versionId: `svh:${h.id}`,
        timestamp: h.editedAt.toISOString(),
      };
      if (detail === 'full') {
        entry.note = pc?.kind === 'override' ? 'property override snapshot' : 'variant snapshot';
        entry.rollbackSupported = true;
      }
      entries.push(entry);
    }
  }

  if (!broadFilter || broadFilter === 'FAQ_ENTRY') {
    const faqHistory = await c.prisma.faqEntryHistory.findMany({
      where: { tenantId: c.tenantId },
      orderBy: { editedAt: 'desc' },
      take: limit,
    });
    for (const h of faqHistory) {
      const pc = h.previousContent as any;
      const q = typeof pc?.question === 'string' ? pc.question : '(unknown)';
      const entry: Record<string, unknown> = {
        artifactType: 'FAQ_ENTRY',
        artifactId: h.targetId,
        artifactLabel: q.slice(0, 80),
        versionId: `feh:${h.id}`,
        timestamp: h.editedAt.toISOString(),
      };
      if (detail === 'full') {
        entry.rollbackSupported = true;
      }
      entries.push(entry);
    }
  }

  entries.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  return { count: Math.min(entries.length, limit), entries: entries.slice(0, limit) };
}

export function buildGetEditHistoryTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'studio_get_edit_history',
    DESCRIPTION,
    {
      artifactType: ARTIFACT_TYPE,
      artifactId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      detail: z.enum(['summary', 'full']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.studio_get_edit_history', args);
      const limit = Math.min(args.limit ?? 10, 100);
      const detail = args.detail ?? 'summary';

      try {
        if (args.artifactId) {
          if (!args.artifactType) {
            return asCallToolResult({ rows: [], error: 'artifactType is required when artifactId is supplied' });
          }
          const result = await querySingleArtifact(c, args.artifactType, args.artifactId, limit, detail);
          span.end({ mode: 'single', count: result.rows.length });
          return asCallToolResult(result);
        }
        const result = await queryBroad(c, args.artifactType, limit, detail);
        span.end({ mode: 'broad', count: result.count });
        return asCallToolResult(result);
      } catch (err: any) {
        span.end({ error: String(err) });
        // Best-effort: degrade gracefully so the agent can still respond.
        console.error('[studio_get_edit_history] query failed:', err?.message ?? err);
        return asCallToolResult(args.artifactId ? { rows: [] } : { count: 0, entries: [] });
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
