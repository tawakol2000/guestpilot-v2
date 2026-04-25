/**
 * studio_get_artifact — sprint 060-D phase 7.
 *
 * Detail tool for the index-then-fetch pair started by
 * studio_get_tenant_index. Decodes the opaque pointer (HMAC-verified)
 * and returns the addressed artifact's full body. Reject any pointer
 * the index didn't sign — the agent cannot fabricate one.
 *
 * Annotation: readOnlyHint: true.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  fetchSystemPromptPayload,
  fetchSopsPayload,
  fetchFaqsPayload,
  fetchToolsPayload,
} from './get-current-state';
import { decodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Resolve a body_pointer returned by studio_get_tenant_index. Returns the full body of one artifact (system-prompt variant, SOP, FAQ, or custom tool). Pointers are HMAC-signed and rejected on tamper. Pass exactly the pointer string the index returned — do not modify it.`;

export function buildGetArtifactTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_get_artifact',
    DESCRIPTION,
    {
      pointer: z.string().min(8).max(2048),
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_get_artifact', {});
      try {
        const decoded = decodePointer(args.pointer, 'artifact');
        if (!decoded.ok) {
          span.end({ error: `bad_pointer:${decoded.reason}` });
          return asError(`studio_get_artifact: invalid pointer (${decoded.reason})`);
        }
        const meta = (decoded.payload.metadata ?? {}) as Record<string, unknown>;
        const kind = String(meta.kind ?? '');

        if (kind === 'system_prompt') {
          const variant = String(meta.variant ?? 'coordinator') as
            | 'coordinator'
            | 'screening';
          const sp = await fetchSystemPromptPayload(c.prisma, c.tenantId);
          const v = sp.variants[variant];
          span.end({ kind, variant });
          return asCallToolResult({
            kind: 'system_prompt',
            variant,
            version: sp.version,
            text: v.text,
            sections: v.sections,
          });
        }

        if (kind === 'sop') {
          const sops = await fetchSopsPayload(c.prisma, c.tenantId);
          const sop = sops.find((s) => s.id === decoded.payload.id);
          if (!sop) {
            span.end({ error: 'sop_not_found' });
            return asError(`studio_get_artifact: SOP ${decoded.payload.id} not found`);
          }
          span.end({ kind, id: sop.id });
          return asCallToolResult({ kind: 'sop', sop });
        }

        if (kind === 'faq') {
          const faqs = await fetchFaqsPayload(c.prisma, c.tenantId);
          const faq = faqs.find((f) => f.id === decoded.payload.id);
          if (!faq) {
            span.end({ error: 'faq_not_found' });
            return asError(`studio_get_artifact: FAQ ${decoded.payload.id} not found`);
          }
          span.end({ kind, id: faq.id });
          return asCallToolResult({ kind: 'faq', faq });
        }

        if (kind === 'tool') {
          const tools = await fetchToolsPayload(c.prisma, c.tenantId);
          const t = tools.find((tt) => tt.id === decoded.payload.id);
          if (!t) {
            span.end({ error: 'tool_not_found' });
            return asError(`studio_get_artifact: tool ${decoded.payload.id} not found`);
          }
          span.end({ kind, id: t.id });
          return asCallToolResult({ kind: 'tool', tool: t });
        }

        span.end({ error: `unknown_kind:${kind}` });
        return asError(`studio_get_artifact: unknown artifact kind '${kind}'`);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_get_artifact failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
