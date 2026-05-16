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
        const decoded = decodePointer(args.pointer, 'evidence', c.tenantId);
        if (!decoded.ok) {
          span.end({ error: `bad_pointer:${decoded.reason}` });
          return asError(`studio_get_evidence_section: invalid pointer (${decoded.reason})`);
        }
        const meta = (decoded.payload.metadata ?? {}) as Record<string, unknown>;
        const section = String(meta.section ?? '');
        const bundleId = decoded.payload.id;

        // 2026-05-16: per-turn dedup. Live test surfaced the agent
        // calling the same `classifier_detail` pointer 3x in a row,
        // burning the read budget and triggering a budget advisory
        // for no informational gain. Track each (bundleId, section,
        // toolIndex?) key in turnFlags so a duplicate call returns
        // the same payload but with a `duplicate_read` flag the
        // agent can see — train it to stop without breaking the
        // happy path.
        const toolIndexKey =
          typeof meta.toolIndex === 'number' ? `:${meta.toolIndex}` : '';
        const dedupKey = `ev_read:${bundleId}:${section}${toolIndexKey}`;
        const alreadyRead = c.turnFlags?.[dedupKey] === true;
        if (c.turnFlags) c.turnFlags[dedupKey] = true;

        const row = await c.prisma.evidenceBundle.findFirst({
          where: { id: bundleId, tenantId: c.tenantId },
        });
        if (!row) {
          span.end({ error: 'bundle_not_found' });
          return asError(`studio_get_evidence_section: bundle ${bundleId} not found.`);
        }
        const bundle = row.payload as any;

        const annotate = <T extends Record<string, unknown>>(payload: T) =>
          alreadyRead
            ? {
                ...payload,
                duplicate_read: true,
                note: 'This pointer was already read on this turn. Re-use the prior tool_result instead of calling again — duplicate reads burn the read budget without new information.',
              }
            : payload;

        if (section === 'reply') {
          span.end({ section, duplicate: alreadyRead });
          return asCallToolResult(annotate({ section, reply: bundle?.disputedMessage ?? null }));
        }
        if (section === 'sop_used') {
          span.end({ section, duplicate: alreadyRead });
          return asCallToolResult(annotate({ section, sopsInEffect: bundle?.sopsInEffect ?? [] }));
        }
        if (section === 'reasoning_trace') {
          span.end({ section, duplicate: alreadyRead });
          return asCallToolResult(annotate({
            section,
            mainAiTrace: bundle?.mainAiTrace ?? null,
            langfuseTrace: bundle?.langfuseTrace ?? null,
            langfuseTraceRef: bundle?.langfuseTraceRef ?? null,
          }));
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
          span.end({ section, toolIndex: idx, duplicate: alreadyRead });
          return asCallToolResult(annotate({ section, toolIndex: idx, call: calls[idx] }));
        }
        if (section === 'classifier_detail') {
          const ragContext = bundle?.mainAiTrace?.ragContext ?? null;
          span.end({ section, duplicate: alreadyRead });
          return asCallToolResult(annotate({
            section,
            classifier: ragContext
              ? {
                  decision: ragContext.classifier ?? null,
                  sopCategories: ragContext.sopCategories ?? [],
                  faqHitIds: ragContext.faqHitIds ?? null,
                  rationale: ragContext.classifierRationale ?? null,
                }
              : null,
          }));
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
