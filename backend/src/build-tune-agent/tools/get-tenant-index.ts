/**
 * studio_get_tenant_index — sprint 060-D phase 7.
 *
 * Replaces the broad-scope path of `get_current_state`. Returns a
 * metadata-only tour of the tenant's configured artifacts: id, label,
 * status, byte size, plus an opaque `body_pointer` per artifact. The
 * agent CANNOT reason about content from this response alone — it
 * must follow up with `studio_get_artifact({pointer})` to read any
 * body.
 *
 * Verbosity: 'concise' returns id + label + status + body_tokens;
 * 'detailed' (TBD by phase 9 polish) adds first-paragraph preview.
 *
 * Annotation: readOnlyHint: true.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { getTenantStateSummary } from '../../services/tenant-state.service';
import {
  fetchSystemPromptPayload,
  fetchSopsPayload,
  fetchFaqsPayload,
  fetchToolsPayload,
} from './get-current-state';
import { encodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Return a metadata-only index of every configured artifact for this tenant — system-prompt variants, SOPs, FAQs, custom tools, plus a tenant summary. Each entry carries a body_pointer (opaque, HMAC-signed). To read an artifact's full body, follow up with studio_get_artifact({pointer}). The index alone is bounded; bodies are fetched one at a time.`;

interface IndexEntry {
  id: string;
  label: string;
  status?: string;
  body_tokens: number;
  body_pointer: string;
  preview?: string;
}

function approxTokens(s: string): number {
  // ~4 chars/token for English prose. Coarse on purpose; the agent
  // uses this to budget further calls, not for billing.
  return Math.ceil((s ?? '').length / 4);
}

export function buildGetTenantIndexTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_get_tenant_index',
    DESCRIPTION,
    {
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_get_tenant_index', {
        verbosity: args.verbosity ?? 'concise',
      });
      try {
        const detailed = args.verbosity === 'detailed';
        const [summary, sp, sops, faqs, tools] = await Promise.all([
          getTenantStateSummary(c.prisma, c.tenantId),
          fetchSystemPromptPayload(c.prisma, c.tenantId),
          fetchSopsPayload(c.prisma, c.tenantId),
          fetchFaqsPayload(c.prisma, c.tenantId),
          fetchToolsPayload(c.prisma, c.tenantId),
        ]);

        const system_prompts: IndexEntry[] = (
          ['coordinator', 'screening'] as const
        ).map((variant) => {
          const text = sp.variants[variant].text;
          const entry: IndexEntry = {
            id: variant,
            label: `System prompt (${variant})`,
            status: `v${sp.version}`,
            body_tokens: approxTokens(text),
            body_pointer: encodePointer({
              type: 'artifact',
              id: `system_prompt:${variant}`,
              metadata: { kind: 'system_prompt', variant },
            }),
          };
          if (detailed) entry.preview = firstParagraph(text);
          return entry;
        });

        const sopEntries: IndexEntry[] = sops.map((s) => {
          const bodySize = s.variants.reduce(
            (acc, v) => acc + (v.content?.length ?? 0),
            0,
          );
          const entry: IndexEntry = {
            id: s.id,
            label: s.category,
            status: s.enabled ? 'enabled' : 'disabled',
            body_tokens: approxTokens(String(bodySize)),
            body_pointer: encodePointer({
              type: 'artifact',
              id: s.id,
              metadata: {
                kind: 'sop',
                variantCount: s.variants.length,
                overrideCount: s.propertyOverrides.length,
              },
            }),
          };
          if (detailed) {
            const longest = s.variants.reduce(
              (acc, v) => ((v.content?.length ?? 0) > (acc?.length ?? 0) ? v.content : acc),
              '' as string,
            );
            entry.preview = firstParagraph(longest);
          }
          return entry;
        });

        const faqEntries: IndexEntry[] = faqs.map((f) => {
          const entry: IndexEntry = {
            id: f.id,
            label: f.question.length > 80 ? `${f.question.slice(0, 77)}…` : f.question,
            status: f.status,
            body_tokens: approxTokens(f.answer),
            body_pointer: encodePointer({
              type: 'artifact',
              id: f.id,
              metadata: {
                kind: 'faq',
                scope: f.scope,
                propertyId: f.propertyId,
                category: f.category,
              },
            }),
          };
          if (detailed) entry.preview = firstParagraph(f.answer);
          return entry;
        });

        const toolEntries: IndexEntry[] = tools.map((t) => {
          const entry: IndexEntry = {
            id: t.id,
            label: t.displayName ?? t.name,
            status: t.enabled ? 'enabled' : 'disabled',
            body_tokens: approxTokens(t.description),
            body_pointer: encodePointer({
              type: 'artifact',
              id: t.id,
              metadata: {
                kind: 'tool',
                customOrSystem: t.isCustom ? 'custom' : 'system',
              },
            }),
          };
          if (detailed) entry.preview = firstParagraph(t.description);
          return entry;
        });

        const payload = {
          summary,
          system_prompts,
          sops: sopEntries,
          faqs: faqEntries,
          tools: toolEntries,
        };
        span.end({
          systemPrompts: system_prompts.length,
          sops: sopEntries.length,
          faqs: faqEntries.length,
          tools: toolEntries.length,
        });
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_get_tenant_index failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}

function firstParagraph(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  const idx = trimmed.indexOf('\n\n');
  const slice = idx > 0 ? trimmed.slice(0, idx) : trimmed;
  return slice.length > 200 ? `${slice.slice(0, 197)}…` : slice;
}
