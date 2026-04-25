/**
 * studio_get_correction — sprint 060-D phase 7d.
 *
 * Detail tool for the studio_search_corrections index pair. Decodes
 * the opaque pointer (HMAC-verified) and returns the full
 * TuningSuggestion row.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { decodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Resolve a detail_pointer returned by studio_search_corrections. Returns the full correction row: rationale, proposedText, beforeText excerpt, target chip, status timestamps. Pointers are HMAC-signed and rejected on tamper.`;

export function buildGetCorrectionTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_get_correction',
    DESCRIPTION,
    {
      pointer: z.string().min(8).max(2048),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_get_correction', {});
      try {
        const decoded = decodePointer(args.pointer, 'correction');
        if (!decoded.ok) {
          span.end({ error: `bad_pointer:${decoded.reason}` });
          return asError(`studio_get_correction: invalid pointer (${decoded.reason})`);
        }
        const row = await c.prisma.tuningSuggestion.findFirst({
          where: { id: decoded.payload.id, tenantId: c.tenantId },
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
            sopStatus: true,
            sopPropertyId: true,
            faqEntryId: true,
            faqCategory: true,
            applyMode: true,
            createdAt: true,
            appliedAt: true,
          },
        });
        if (!row) {
          span.end({ error: 'not_found' });
          return asError(`studio_get_correction: row ${decoded.payload.id} not found.`);
        }
        span.end({ id: row.id });
        return asCallToolResult({
          id: row.id,
          category: row.diagnosticCategory,
          subLabel: row.diagnosticSubLabel,
          confidence: row.confidence,
          status: row.status,
          actionType: row.actionType,
          rationale: row.rationale,
          proposedText: row.proposedText,
          beforeTextExcerpt: (row.beforeText ?? '').slice(0, 1000),
          target: {
            sopCategory: row.sopCategory,
            sopStatus: row.sopStatus,
            sopPropertyId: row.sopPropertyId,
            faqEntryId: row.faqEntryId,
            faqCategory: row.faqCategory,
            applyMode: row.applyMode,
          },
          timestamps: {
            createdAt: row.createdAt,
            appliedAt: row.appliedAt,
          },
        });
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_get_correction failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
