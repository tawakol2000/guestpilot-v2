/**
 * studio_get_artifact — sprint 060-D phase 7, extended in feature 047 PR 2/3.
 *
 * Detail tool for the index-then-fetch pair started by
 * studio_get_tenant_index. Decodes the opaque pointer (HMAC-verified)
 * and returns the addressed artifact's body. Reject any pointer
 * the index didn't sign — the agent cannot fabricate one.
 *
 * Three modes:
 *   - mode:'full' (default), verbosity:'concise' (default) → head excerpt
 *     + structural metadata. Most triage decisions don't need the full
 *     body; this caps per-call token return at ≤1500 tokens regardless
 *     of underlying body size.
 *   - mode:'full', verbosity:'detailed' → full body byte-for-byte.
 *   - mode:'index' → section list with names/summaries/tokens/hashId.
 *     No body text. Only meaningful for system_prompt and sop kinds.
 *   - section:'<name>' → return only that section's body. Validates the
 *     name against the freshly-extracted section list.
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
import {
  extractSections,
  type Section,
  type SectionSignContext,
} from './lib/section-extractor';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Resolve a body_pointer returned by studio_get_tenant_index. Returns one artifact (system-prompt variant, SOP, FAQ, or custom tool). Pointers are HMAC-signed and rejected on tamper.

DRILL-DOWN PATTERN (for system_prompt + sop kinds):
  1. studio_get_tenant_index            → see catalog (titles + descriptions)
  2. studio_get_artifact(ptr, mode:'index')   → see section list (names + summaries + tokens), no body
  3. studio_get_artifact(ptr, section:'<name>')  → fetch one section's body
  4. studio_get_artifact(ptr, verbosity:'detailed')  → full body (only when modifying)

PARAMETERS:
  verbosity (default 'concise'):
    'concise' — head excerpt + structural metadata (≤1500 tokens). Use for triage / routing.
    'detailed' — full body, byte-for-byte (10-30K tokens for system prompts). Use ONLY when modifying verbatim.
  mode (default 'full'):
    'full' — return body content per verbosity setting.
    'index' — return sectionList with names/summaries/token-counts. NO body text. system_prompt + sop only.
  section (optional, system_prompt + sop only):
    Name from the sectionList of a prior mode:'index' call. Returns just that section's body + neighbors.

Defaulting to concise saves 5-25K tokens per call. Section drill-down on a 25K system prompt fetches 300-1500 tokens instead of the whole body.`;

const HEAD_EXCERPT_CHARS = 1200;

function getSectionSecret(): string {
  return (
    process.env.STUDIO_POINTER_HMAC_KEY ??
    process.env.JWT_SECRET ??
    'fallback-test-secret'
  );
}

function conciseText(full: string | null | undefined): string {
  if (!full) return '';
  const trimmed = full.trim();
  if (trimmed.length <= HEAD_EXCERPT_CHARS) return trimmed;
  return `${trimmed.slice(0, HEAD_EXCERPT_CHARS)}\n\n…[truncated — call studio_get_artifact again with verbosity:'detailed' to read the full body]`;
}

function conciseSopVariant(v: CurrentSopPayload['variants'][number]) {
  if (v.content.length <= HEAD_EXCERPT_CHARS) return v;
  return { ...v, content: conciseText(v.content), fullCharLength: v.content.length };
}

function conciseSopOverride(o: CurrentSopPayload['propertyOverrides'][number]) {
  if (o.content.length <= HEAD_EXCERPT_CHARS) return o;
  return { ...o, content: conciseText(o.content), fullCharLength: o.content.length };
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
  return { ...faq, answer: conciseText(faq.answer), fullCharLength: faq.answer.length };
}

function conciseTool(t: CurrentToolPayload) {
  if (t.description.length <= HEAD_EXCERPT_CHARS) return t;
  return { ...t, description: conciseText(t.description), fullCharLength: t.description.length };
}

function pickDefaultSopVariant(sop: CurrentSopPayload): { content: string; status: string } {
  // Prefer DEFAULT, fall back to first enabled variant.
  const def = sop.variants.find((v) => v.status === 'DEFAULT');
  if (def) return { content: def.content, status: def.status };
  const first = sop.variants.find((v) => v.enabled) ?? sop.variants[0];
  return first ? { content: first.content, status: first.status } : { content: '', status: 'DEFAULT' };
}

interface IndexEntry {
  name: string;
  summary: string;
  tokens: number;
  hashId: string;
}

function indexEntriesFromSections(sections: Section[]): IndexEntry[] {
  return sections.map(({ name, summary, tokens, hashId }) => ({
    name,
    summary,
    tokens,
    hashId,
  }));
}

function buildSectionsForArtifact(
  body: string,
  fallbackTitle: string,
  signCtx: SectionSignContext,
): Section[] {
  return extractSections(body, fallbackTitle, signCtx);
}

function findSection(sections: Section[], name: string): Section | undefined {
  return sections.find((s) => s.name === name);
}

function neighborNames(
  sections: Section[],
  index: number,
): { prev: string | null; next: string | null } {
  return {
    prev: index > 0 ? sections[index - 1].name : null,
    next: index < sections.length - 1 ? sections[index + 1].name : null,
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
      mode: z.enum(['full', 'index']).optional(),
      section: z.string().min(1).max(120).optional(),
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
        const mode = args.mode ?? 'full';
        const requestedSection = args.section ?? null;
        const signCtx: SectionSignContext = {
          tenantId: c.tenantId,
          artifactId: decoded.payload.id,
          secret: getSectionSecret(),
        };

        // Reject mode:'index' / section drill-down on atomic kinds early.
        if (
          (mode === 'index' || requestedSection) &&
          (kind === 'faq' || kind === 'tool')
        ) {
          span.end({ error: `unsupported_mode_for_kind:${kind}` });
          if (mode === 'index') {
            return asError(
              `studio_get_artifact: kind '${kind}' does not support mode:'index'. Use mode:'full' with verbosity:'concise' instead.`,
            );
          }
          return asError(
            `studio_get_artifact: kind '${kind}' does not support section drill-down. ${kind === 'faq' ? 'FAQ entries are atomic (single Q+A pair).' : 'Tool definitions are atomic.'}`,
          );
        }

        if (kind === 'system_prompt') {
          const variant = String(meta.variant ?? 'coordinator') as
            | 'coordinator'
            | 'screening';
          const sp = await fetchSystemPromptPayload(c.prisma, c.tenantId);
          const v = sp.variants[variant];
          const sections = buildSectionsForArtifact(v.text, `${variant} system prompt`, signCtx);

          // section:'<name>' — return one section's body
          if (requestedSection) {
            const idx = sections.findIndex((s) => s.name === requestedSection);
            if (idx < 0) {
              const validNames = sections.map((s) => s.name).join(', ');
              span.end({ error: 'section_not_found' });
              return asError(
                `studio_get_artifact: section '${requestedSection}' not found in ${variant} system prompt. Valid sections: [${validNames}]`,
              );
            }
            const section = sections[idx];
            const { prev, next } = neighborNames(sections, idx);
            span.end({
              kind,
              variant,
              mode: 'section',
              sectionName: section.name,
              fullCharLength: v.text.length,
              returnCharLength: section.body.length,
            });
            return asCallToolResult({
              kind: 'system_prompt',
              variant,
              version: sp.version,
              sectionName: section.name,
              text: section.body,
              tokens: section.tokens,
              neighborSections: [prev, next].filter((x): x is string => x !== null),
            });
          }

          // mode:'index' — section list, no body text
          if (mode === 'index') {
            span.end({
              kind,
              variant,
              mode: 'index',
              fullCharLength: v.text.length,
              sectionCount: sections.length,
            });
            return asCallToolResult({
              kind: 'system_prompt',
              variant,
              version: sp.version,
              sectionList: indexEntriesFromSections(sections),
              fullCharLength: v.text.length,
              mode: 'index',
            });
          }

          // mode:'full' — verbosity-respecting body
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

          // For SOPs, "the body" we extract sections from is the DEFAULT
          // variant content. Property overrides and per-status variants
          // are surfaced via mode:'full' + verbosity:'detailed'.
          const defaultVariant = pickDefaultSopVariant(sop);
          const fallbackTitle = sop.toolDescription || sop.category || 'sop';
          const sections = buildSectionsForArtifact(
            defaultVariant.content,
            fallbackTitle,
            signCtx,
          );

          if (requestedSection) {
            const idx = sections.findIndex((s) => s.name === requestedSection);
            if (idx < 0) {
              const validNames = sections.map((s) => s.name).join(', ');
              span.end({ error: 'section_not_found' });
              return asError(
                `studio_get_artifact: section '${requestedSection}' not found in SOP '${sop.category}'. Valid sections: [${validNames}]`,
              );
            }
            const section = sections[idx];
            const { prev, next } = neighborNames(sections, idx);
            span.end({
              kind,
              id: sop.id,
              mode: 'section',
              sectionName: section.name,
              fullCharLength: defaultVariant.content.length,
              returnCharLength: section.body.length,
            });
            return asCallToolResult({
              kind: 'sop',
              sopId: sop.id,
              category: sop.category,
              defaultVariantStatus: defaultVariant.status,
              sectionName: section.name,
              text: section.body,
              tokens: section.tokens,
              neighborSections: [prev, next].filter((x): x is string => x !== null),
            });
          }

          if (mode === 'index') {
            const fellBackToSingle = sections.length === 1 && sections[0].name === fallbackTitle;
            span.end({
              kind,
              id: sop.id,
              mode: 'index',
              fullCharLength: defaultVariant.content.length,
              sectionCount: sections.length,
              fallback: fellBackToSingle,
            });
            return asCallToolResult({
              kind: 'sop',
              sopId: sop.id,
              category: sop.category,
              sectionList: indexEntriesFromSections(sections),
              fullCharLength: defaultVariant.content.length,
              mode: 'index',
              ...(fellBackToSingle
                ? { fallback: 'single-section (no markdown headings detected)' }
                : {}),
            });
          }

          // mode:'full' — verbosity-respecting full SOP shape
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

// Exported for unit tests.
export const __test = {
  HEAD_EXCERPT_CHARS,
  conciseText,
  conciseSop,
  conciseFaq,
  conciseTool,
};
