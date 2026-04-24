/**
 * get_edit_history — query BuildArtifactHistory for a specific artifact.
 *
 * Sprint 056-A F2 — "Ask-the-past" tool. Returns the edit timeline for a
 * named artifact so the manager (and the agent) can see why / when / by
 * whom the artifact was changed without relying on conversation scrollback.
 *
 * Tenant-scoped: the query always filters on the calling tenant's id so
 * cross-tenant leakage is impossible at the DB level. A tenant-B artifact
 * queried under tenant A silently returns { rows: [] } (not a 404 — tool-
 * level graceful degradation per spec).
 *
 * Results are ordered newest-first (DESC by createdAt) up to `limit`
 * rows (default 10, max 50).
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { asCallToolResult, type ToolContext } from './types';

const DESCRIPTION = `get_edit_history: Return the edit timeline for a specific artifact.
WHEN TO USE: When the manager asks about the *history* of a specific artifact — why it was changed, when, or by whom. Call this BEFORE responding to such questions. Do not rely on conversation scrollback; scrollback is incomplete. If the tool returns zero rows, say so honestly.
WHEN NOT TO USE: Cross-artifact "what changed this week" queries (different tool, later sprint). Free-text search over rationales.
PARAMETERS:
  artifactType (string) — one of: sop, faq, system_prompt, tool, property_override
  artifactId (string) — the artifact's stable cuid
  limit (number, optional) — max rows to return (default 10, max 50)
RETURNS: { rows: [{ appliedAt, operation, rationale, operatorRationale, rationalePrefix, appliedByUserId }] }`;

export function buildGetEditHistoryTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'get_edit_history',
    DESCRIPTION,
    {
      artifactType: z.enum(['sop', 'faq', 'system_prompt', 'tool', 'property_override']),
      artifactId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const c = ctx();
      const limit = Math.min(args.limit ?? 10, 50);

      try {
        const rows = await c.prisma.buildArtifactHistory.findMany({
          where: {
            tenantId: c.tenantId,
            artifactType: args.artifactType,
            artifactId: args.artifactId,
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            createdAt: true,
            operation: true,
            actorUserId: true,
            metadata: true,
          },
        });

        const result = {
          rows: rows.map((r) => {
            const meta =
              r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
                ? (r.metadata as Record<string, unknown>)
                : {};
            return {
              appliedAt: r.createdAt.toISOString(),
              operation: r.operation as 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT',
              rationale: (meta.rationale as string | null | undefined) ?? null,
              operatorRationale: (meta.operatorRationale as string | null | undefined) ?? null,
              rationalePrefix: (meta.rationalePrefix as string | null | undefined) ?? null,
              appliedByUserId: r.actorUserId ?? null,
            };
          }),
        };

        return asCallToolResult(result);
      } catch (err: any) {
        // Best-effort: return empty rows rather than propagating the error
        // so the agent can still respond gracefully.
        console.error('[get_edit_history] query failed (returning empty rows):', err?.message ?? err);
        return asCallToolResult({ rows: [] });
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
