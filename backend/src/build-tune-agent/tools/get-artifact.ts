/**
 * studio_get_artifact — sprint 060-D phase 7, extended in feature 047 PR 2.
 *
 * Detail tool for the index-then-fetch pair started by
 * studio_get_tenant_index. Decodes the opaque pointer (HMAC-verified)
 * and returns the addressed artifact's body. Reject any pointer
 * the index didn't sign — the agent cannot fabricate one.
 *
 * Feature 047 PR 2 — verbosity honored:
 *   - verbosity:'concise' (default) → head excerpt + structural metadata.
 *     Most triage decisions don't need the full body; this caps per-call
 *     token return at ≤1500 tokens regardless of underlying body size.
 *   - verbosity:'detailed' → full body byte-for-byte (existing v1 shape).
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
  type CurrentSopPayload,
  type CurrentFaqPayload,
  type CurrentToolPayload,
} from './get-current-state';
import { decodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Resolve a body_pointer returned by studio_get_tenant_index. Returns one artifact (system-prompt variant, SOP, FAQ, or custom tool). Pointers are HMAC-signed and rejected on tamper.

verbosity (default 'concise'):
  'concise' — head excerpt + structural metadata (sections list for system_prompt; variant/override list for SOP). Typically 1-3K tokens. Use for triage and routing decisions where you only need to confirm the artifact exists and see its shape.
  'detailed' — full body, byte-for-byte. 10-30K tokens for system prompts, 5-15K for SOPs. Use ONLY when you must read or modify the artifact verbatim.

Default-concise saves 5-25K tokens per call vs detailed; only escalate to detailed when triage has determined the artifact needs editing.`;

// Concise-mode head excerpt cap. Full bodies are 10-30K tokens for system
// prompts and ~5-15K for SOPs; replaying that across every internal
// messages.create round inside a tuning-agent.query is the single biggest
// driver of per-request token count. Concise returns a head excerpt + the
// structural metadata so the agent can route to the right section without
// reading the body verbatim.
const HEAD_EXCERPT_CHARS = 1200;

function conciseText(full: string | null | undefined): string {
  if (!full) return '';
  const trimmed = full.trim();
  if (trimmed.length <= HEAD_EXCERPT_CHARS) return trimmed;
  return `${trimmed.slice(0, HEAD_EXCERPT_CHARS)}\n\n…[truncated — call studio_get_artifact again with verbosity:'detailed' to read the full body]`;
}

function conciseSopVariant(v: CurrentSopPayload['variants'][number]) {
  if (v.content.length <= HEAD_EXCERPT_CHARS) return v;
  return {
    ...v,
    content: conciseText(v.content),
    fullCharLength: v.content.length,
  };
}

function conciseSopOverride(o: CurrentSopPayload['propertyOverrides'][number]) {
  if (o.content.length <= HEAD_EXCERPT_CHARS) return o;
  return {
    ...o,
    content: conciseText(o.content),
    fullCharLength: o.content.length,
  };
}

function conciseSop(sop: CurrentSopPayload) {
  return {
    ...sop,
    variants: sop.variants.map(conciseSopVariant),
    propertyOverrides: sop.propertyOverrides.map(conciseSopOverride),
  };
}

function conciseFaq(faq: CurrentFaqPayload) {
  if (faq.answer.length <= HEAD_EXCERPT_CHARS) return faq;
  return {
    ...faq,
    answer: conciseText(faq.answer),
    fullCharLength: faq.answer.length,
  };
}

function conciseTool(t: CurrentToolPayload) {
  if (t.description.length <= HEAD_EXCERPT_CHARS) return t;
  return {
    ...t,
    description: conciseText(t.description),
    fullCharLength: t.description.length,
  };
}

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
        const detailed = args.verbosity === 'detailed';

        if (kind === 'system_prompt') {
          const variant = String(meta.variant ?? 'coordinator') as
            | 'coordinator'
            | 'screening';
          const sp = await fetchSystemPromptPayload(c.prisma, c.tenantId);
          const v = sp.variants[variant];
          span.end({
            kind,
            variant,
            detailed,
            fullCharLength: v.text.length,
            returnCharLength: detailed ? v.text.length : conciseText(v.text).length,
          });
          if (detailed) {
            return asCallToolResult({
              kind: 'system_prompt',
              variant,
              version: sp.version,
              text: v.text,
              sections: v.sections,
            });
          }
          return asCallToolResult({
            kind: 'system_prompt',
            variant,
            version: sp.version,
            text: conciseText(v.text),
            sections: v.sections,
            fullCharLength: v.text.length,
            verbosity: 'concise',
          });
        }

        if (kind === 'sop') {
          const sops = await fetchSopsPayload(c.prisma, c.tenantId);
          const sop = sops.find((s) => s.id === decoded.payload.id);
          if (!sop) {
            span.end({ error: 'sop_not_found' });
            return asError(`studio_get_artifact: SOP ${decoded.payload.id} not found`);
          }
          const totalCharLength =
            sop.variants.reduce((s, v) => s + v.content.length, 0) +
            sop.propertyOverrides.reduce((s, o) => s + o.content.length, 0);
          span.end({ kind, id: sop.id, detailed, fullCharLength: totalCharLength });
          if (detailed) {
            return asCallToolResult({ kind: 'sop', sop });
          }
          return asCallToolResult({
            kind: 'sop',
            sop: conciseSop(sop),
            verbosity: 'concise',
          });
        }

        if (kind === 'faq') {
          const faqs = await fetchFaqsPayload(c.prisma, c.tenantId);
          const faq = faqs.find((f) => f.id === decoded.payload.id);
          if (!faq) {
            span.end({ error: 'faq_not_found' });
            return asError(`studio_get_artifact: FAQ ${decoded.payload.id} not found`);
          }
          span.end({ kind, id: faq.id, detailed, fullCharLength: faq.answer.length });
          if (detailed) {
            return asCallToolResult({ kind: 'faq', faq });
          }
          return asCallToolResult({
            kind: 'faq',
            faq: conciseFaq(faq),
            verbosity: 'concise',
          });
        }

        if (kind === 'tool') {
          const tools = await fetchToolsPayload(c.prisma, c.tenantId);
          const t = tools.find((tt) => tt.id === decoded.payload.id);
          if (!t) {
            span.end({ error: 'tool_not_found' });
            return asError(`studio_get_artifact: tool ${decoded.payload.id} not found`);
          }
          span.end({ kind, id: t.id, detailed, fullCharLength: t.description.length });
          if (detailed) {
            return asCallToolResult({ kind: 'tool', tool: t });
          }
          return asCallToolResult({
            kind: 'tool',
            tool: conciseTool(t),
            verbosity: 'concise',
          });
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

// Exported for unit tests — pure helpers. The handler itself depends on
// Prisma + the SDK tool registration plumbing, which is awkward to mock.
// Testing the helpers + a handful of fixture payloads is enough.
export const __test = {
  HEAD_EXCERPT_CHARS,
  conciseText,
  conciseSop,
  conciseFaq,
  conciseTool,
};
