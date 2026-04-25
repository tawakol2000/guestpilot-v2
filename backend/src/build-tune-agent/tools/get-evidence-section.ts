/**
 * studio_get_evidence_section — sprint 060-D phase 7c.
 *
 * Detail tool for the index-then-fetch pair started by
 * studio_get_evidence_index. Decodes the section pointer (HMAC-verified),
 * looks up the bundle by id, and returns the addressed slice.
 *
 * Section enum is a frozen API seam — see studio_get_evidence_index
 * docstring.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { decodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Resolve a section_pointer returned by studio_get_evidence_index. Returns one section of the evidence bundle: reply, sop_used, reasoning_trace, tool_call (specific index), or classifier_detail. Pointers are HMAC-signed and rejected on tamper.`;

export function buildGetEvidenceSectionTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_get_evidence_section',
    DESCRIPTION,
    {
      pointer: z.string().min(8).max(2048),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_get_evidence_section', {});
      try {
        const decoded = decodePointer(args.pointer, 'evidence');
        if (!decoded.ok) {
          span.end({ error: `bad_pointer:${decoded.reason}` });
          return asError(`studio_get_evidence_section: invalid pointer (${decoded.reason})`);
        }
        const meta = (decoded.payload.metadata ?? {}) as Record<string, unknown>;
        const section = String(meta.section ?? '');
        const bundleId = decoded.payload.id;

        const row = await c.prisma.evidenceBundle.findFirst({
          where: { id: bundleId, tenantId: c.tenantId },
        });
        if (!row) {
          span.end({ error: 'bundle_not_found' });
          return asError(`studio_get_evidence_section: bundle ${bundleId} not found.`);
        }
        const bundle = row.payload as any;

        if (section === 'reply') {
          span.end({ section });
          return asCallToolResult({ section, reply: bundle?.disputedMessage ?? null });
        }
        if (section === 'sop_used') {
          span.end({ section });
          return asCallToolResult({ section, sopsInEffect: bundle?.sopsInEffect ?? [] });
        }
        if (section === 'reasoning_trace') {
          span.end({ section });
          return asCallToolResult({
            section,
            mainAiTrace: bundle?.mainAiTrace ?? null,
            langfuseTrace: bundle?.langfuseTrace ?? null,
            langfuseTraceRef: bundle?.langfuseTraceRef ?? null,
          });
        }
        if (section === 'tool_call') {
          const idx = typeof meta.toolIndex === 'number' ? (meta.toolIndex as number) : -1;
          const rag = bundle?.mainAiTrace?.ragContext;
          // Match the field-name fallback used by extractToolCallSummaries
          // in get-evidence-index.ts — ai.service.ts uses `tools`; legacy
          // traces may use `toolCalls`.
          const calls = Array.isArray(rag?.tools)
            ? rag.tools
            : Array.isArray(rag?.toolCalls)
              ? rag.toolCalls
              : [];
          if (idx < 0 || idx >= calls.length) {
            span.end({ error: 'tool_index_out_of_range' });
            return asError(`studio_get_evidence_section: tool_call index ${idx} out of range.`);
          }
          span.end({ section, toolIndex: idx });
          return asCallToolResult({ section, toolIndex: idx, call: calls[idx] });
        }
        if (section === 'classifier_detail') {
          const ragContext = bundle?.mainAiTrace?.ragContext ?? null;
          span.end({ section });
          return asCallToolResult({
            section,
            classifier: ragContext
              ? {
                  decision: ragContext.classifier ?? null,
                  sopCategories: ragContext.sopCategories ?? [],
                  faqHitIds: ragContext.faqHitIds ?? null,
                  rationale: ragContext.classifierRationale ?? null,
                }
              : null,
          });
        }
        span.end({ error: `unknown_section:${section}` });
        return asError(`studio_get_evidence_section: unknown section '${section}'`);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_get_evidence_section failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
