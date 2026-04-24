/**
 * search_corrections — agentic search over prior TuningSuggestion records.
 * Replaces the old get_suggestion_stats + corrections-browser.
 *
 * Filters: category, propertyId (inferred via sopPropertyId or anchor
 * message's property), sub-label substring, time range in days. Returns
 * recent first, capped.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';

export function buildSearchCorrectionsTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'search_corrections',
    'Search prior TuningSuggestion rows. Use to answer "have we seen this pattern before?" or to decide whether a specific fix has been tried already. Concise returns id/category/subLabel/confidence/status; detailed adds rationale, proposedText excerpt, and timestamps.',
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
      // Sprint 08 §5 — include AUTO_SUPPRESSED rows (hidden from the default
      // queue) when the agent needs to explain why a suggestion didn't
      // surface. Defaults to false to keep existing behavior stable.
      includeSuppressed: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.search_corrections', args);
      try {
        const take = args.limit ?? 20;
        const detailed = args.verbosity === 'detailed';
        const where: any = { tenantId: c.tenantId };
        if (args.category) where.diagnosticCategory = args.category;
        if (args.status) {
          // An explicit status filter wins — lets the agent ask specifically
          // for AUTO_SUPPRESSED when explaining why a suggestion didn't surface.
          where.status = args.status;
        } else if (!args.includeSuppressed) {
          // Hide AUTO_SUPPRESSED by default so the "recent history" view
          // matches what the manager sees in the queue.
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
          take,
          select: {
            id: true,
            diagnosticCategory: true,
            diagnosticSubLabel: true,
            confidence: true,
            status: true,
            actionType: true,
            rationale: true,
            proposedText: true,
            beforeText: true,
            sopCategory: true,
            sopPropertyId: true,
            faqEntryId: true,
            createdAt: true,
            appliedAt: true,
          },
        });

        const results = rows.map((r) => ({
          id: r.id,
          category: r.diagnosticCategory,
          subLabel: r.diagnosticSubLabel,
          confidence: r.confidence,
          status: r.status,
          // Sprint 08 §5 — hint flag so the agent can surface "[suppressed]"
          // in its rationale when explaining why a suggestion didn't appear.
          suppressed: r.status === 'AUTO_SUPPRESSED',
          actionType: r.actionType,
          createdAt: r.createdAt,
          ...(detailed
            ? {
                rationale: r.rationale,
                proposedTextExcerpt: (r.proposedText ?? '').slice(0, 400),
                beforeTextExcerpt: (r.beforeText ?? '').slice(0, 200),
                target: {
                  sopCategory: r.sopCategory,
                  sopPropertyId: r.sopPropertyId,
                  faqEntryId: r.faqEntryId,
                },
                appliedAt: r.appliedAt,
              }
            : {}),
        }));

        const payload = { count: results.length, results };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`search_corrections failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
