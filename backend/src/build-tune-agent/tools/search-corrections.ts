/**
 * studio_search_corrections — sprint 060-D phase 7d.
 *
 * Replaces `search_corrections`. Returns metadata + opaque
 * detail_pointer per row; detail is fetched one row at a time via
 * studio_get_correction({pointer}).
 *
 * `limit` is REQUIRED (default 10, max 50). No truncation cap, no
 * pagination — index discipline + limit replaces them per spec § 4.7.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { encodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Search prior TuningSuggestion rows. Returns metadata + detail_pointer per row; the row's full body (rationale, proposed text, target chip) is fetched via studio_get_correction({pointer}). 'limit' is required and capped at 50.`;

export function buildSearchCorrectionsTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_search_corrections',
    DESCRIPTION,
    {
      category: z
        .enum([
          'SOP_CONTENT',
          'SOP_ROUTING',
          'FAQ',
          'SYSTEM_PROMPT',
          'TOOL_CONFIG',
          'PROPERTY_OVERRIDE',
          'MISSING_CAPABILITY',
          'NO_FIX',
        ])
        .optional(),
      subLabelQuery: z.string().max(64).optional(),
      propertyId: z.string().optional(),
      sinceDays: z.number().int().min(1).max(365).optional(),
      status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_SUPPRESSED']).optional(),
      includeSuppressed: z.boolean().optional(),
      limit: z.number().int().min(1).max(50),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_search_corrections', args);
      try {
        const where: any = { tenantId: c.tenantId };
        if (args.category) where.diagnosticCategory = args.category;
        if (args.status) {
          where.status = args.status;
        } else if (!args.includeSuppressed) {
          where.status = { notIn: ['AUTO_SUPPRESSED'] };
        }
        if (args.propertyId) where.sopPropertyId = args.propertyId;
        if (args.subLabelQuery) {
          where.diagnosticSubLabel = { contains: args.subLabelQuery, mode: 'insensitive' };
        }
        if (args.sinceDays) {
          where.createdAt = { gte: new Date(Date.now() - args.sinceDays * 86400_000) };
        }

        const rows = await c.prisma.tuningSuggestion.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: args.limit,
          select: {
            id: true,
            diagnosticCategory: true,
            diagnosticSubLabel: true,
            confidence: true,
            status: true,
            rationale: true,
            createdAt: true,
          },
        });

        const results = rows.map((r) => ({
          id: r.id,
          category: r.diagnosticCategory,
          subLabel: r.diagnosticSubLabel,
          confidence: r.confidence,
          status: r.status,
          summary_one_line: makeSummary(r),
          createdAt: r.createdAt,
          detail_pointer: encodePointer({
            type: 'correction',
            id: r.id,
          }),
        }));
        const payload = { count: results.length, results };
        span.end({ count: results.length });
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_search_corrections failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}

function makeSummary(r: {
  diagnosticCategory: string | null;
  diagnosticSubLabel: string | null;
  rationale: string | null;
}): string {
  const parts: string[] = [];
  if (r.diagnosticCategory) parts.push(r.diagnosticCategory);
  if (r.diagnosticSubLabel) parts.push(r.diagnosticSubLabel);
  const lead = parts.join(' · ');
  if (!r.rationale) return lead || '(no rationale)';
  const r1 = r.rationale.split('\n')[0].slice(0, 120);
  return lead ? `${lead} — ${r1}` : r1;
}
