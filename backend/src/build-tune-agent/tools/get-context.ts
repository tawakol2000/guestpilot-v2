/**
 * get_context — the agent's first-touch context call. Returns the selected
 * suggestion (if any), anchor message (if any), pending-queue summary, and
 * a compact recent-activity view.
 *
 * Bugfix (2026-04-22): when `verbosity === 'detailed'` the `recentMessages`
 * query previously selected only `{ id, role, createdAt }` and so the agent
 * got ten metadata stubs with no message text — effectively a "chat history
 * truncated to zero content" bug. We now pull `parts` (the Vercel AI SDK
 * JSON column that holds the actual turn content) and flatten its text /
 * reasoning parts into a `content` string on each row. The anchor-message
 * char cap is also relaxed on `detailed` (8,000 chars vs. 800) so the
 * operator can have the agent reason about a long guest message without
 * it being silently clipped. Concise mode is unchanged.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';

/**
 * Flatten a TuningMessage `parts` JSON value into a plain-text preview the
 * BUILD/TUNE agent can read as "what was said on this turn".
 *
 * Input shape (Vercel AI SDK v5 parts): an array where each entry is one of
 *   { type: 'text',      text: string }
 *   { type: 'reasoning', text: string }
 *   { type: 'tool-<name>' | 'tool-call', toolName, input, output?, state? }
 *   { type: 'tool-result', toolCallId, output }
 *   { type: 'step-start' | 'step-end' | 'data-*' | 'source-*' | 'file' }  (cosmetic; skipped)
 *
 * We concatenate text + reasoning verbatim and stringify tool-call inputs /
 * results as a compact one-line tag. Anything unrecognised is skipped. Each
 * row is capped at `maxChars` to keep a single pathological message from
 * dominating the tool response; the cap is generous (8k by default) so real
 * chat content survives intact.
 */
function flattenPartsToText(parts: unknown, maxChars = 8_000): string {
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const p of parts as Array<Record<string, unknown>>) {
    if (!p || typeof p !== 'object') continue;
    const type = String(p.type ?? '');
    if (type === 'text' || type === 'reasoning') {
      if (typeof p.text === 'string') chunks.push(p.text);
    } else if (type === 'tool-call' || type.startsWith('tool-')) {
      const toolName = p.toolName ?? type.replace(/^tool-/, '');
      const input = p.input != null ? JSON.stringify(p.input) : '';
      const inputSnip = input.length > 200 ? input.slice(0, 200) + '…' : input;
      chunks.push(`[tool:${toolName}${inputSnip ? ` ${inputSnip}` : ''}]`);
    }
    // step-*, data-*, source-*, file → intentionally dropped (cosmetic).
  }
  const joined = chunks.join('\n').trim();
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + '\n…[truncated at ' + maxChars + ' chars]';
}

export function buildGetContextTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'get_context',
    'Current tuning conversation context: anchor message (if any), selected suggestion (if any), pending queue summary, last accepted suggestion. Call this first when a conversation opens. Verbosity "detailed" expands the recent-activity timeline.',
    {
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.get_context', args);
      try {
        const detailed = args.verbosity === 'detailed';
        // Sprint 09 fix 1: the returned `total` used `pending.length` after a
        // take:8 query, silently under-reporting a queue of any non-trivial
        // size. Separate count() keeps detail limits while reporting truth.
        const [conversation, pending, pendingTotal, lastAccepted, recentMessages] = await Promise.all([
          c.conversationId
            ? c.prisma.tuningConversation.findFirst({
                where: { id: c.conversationId, tenantId: c.tenantId },
                include: {
                  anchorMessage: {
                    select: {
                      id: true,
                      content: true,
                      role: true,
                      sentAt: true,
                      conversationId: true,
                    },
                  },
                },
              })
            : Promise.resolve(null),
          c.prisma.tuningSuggestion.findMany({
            where: { tenantId: c.tenantId, status: 'PENDING' },
            orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
            take: 8,
            select: {
              id: true,
              diagnosticCategory: true,
              diagnosticSubLabel: true,
              confidence: true,
              rationale: true,
              triggerType: true,
              createdAt: true,
            },
          }),
          c.prisma.tuningSuggestion.count({
            where: { tenantId: c.tenantId, status: 'PENDING' },
          }),
          c.prisma.tuningSuggestion.findFirst({
            where: { tenantId: c.tenantId, status: 'ACCEPTED' },
            orderBy: { appliedAt: 'desc' },
            select: {
              id: true,
              diagnosticCategory: true,
              diagnosticSubLabel: true,
              actionType: true,
              appliedAt: true,
              rationale: true,
            },
          }),
          detailed && c.conversationId
            ? c.prisma.tuningMessage.findMany({
                where: { conversationId: c.conversationId },
                orderBy: { createdAt: 'desc' },
                // Bumped from 10 → 30 when detailed so the agent can scroll
                // further back when an operator asks about something earlier
                // in the Studio conversation. Per-row content is capped to
                // 8,000 chars by `flattenPartsToText` so total payload stays
                // bounded even at 30 rows.
                take: 30,
                // `parts` is the Vercel AI SDK JSON column that stores the
                // actual turn content (text + reasoning + tool-calls).
                // Previously omitted; agents got metadata-only rows and
                // could not recall what was said.
                select: { id: true, role: true, createdAt: true, parts: true },
              })
            : Promise.resolve(null),
        ]);

        const countsByCategory = pending.reduce<Record<string, number>>((acc, s) => {
          const k = s.diagnosticCategory ?? 'LEGACY';
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {});

        const payload = {
          conversation: conversation
            ? {
                id: conversation.id,
                title: conversation.title,
                triggerType: conversation.triggerType,
                anchorMessageId: conversation.anchorMessageId,
                anchorMessage: (conversation as any).anchorMessage
                  ? {
                      id: (conversation as any).anchorMessage.id,
                      // Concise: 800-char preview (token-cheap first touch).
                      // Detailed: 8,000 chars so the agent can reason about
                      // a long guest message without silent clipping.
                      content: (conversation as any).anchorMessage.content.slice(
                        0,
                        detailed ? 8_000 : 800,
                      ),
                      role: (conversation as any).anchorMessage.role,
                      conversationId: (conversation as any).anchorMessage.conversationId,
                      sentAt: (conversation as any).anchorMessage.sentAt,
                    }
                  : null,
              }
            : null,
          pendingQueue: {
            total: pendingTotal,
            countsByCategory,
            topSuggestions: pending.slice(0, detailed ? 8 : 3).map((s) => ({
              id: s.id,
              category: s.diagnosticCategory,
              subLabel: s.diagnosticSubLabel,
              confidence: s.confidence,
              rationale: s.rationale.slice(0, detailed ? 400 : 180),
              triggerType: s.triggerType,
            })),
          },
          lastAccepted,
          recentMessages: recentMessages
            ? recentMessages.map((m) => ({
                id: m.id,
                role: m.role,
                createdAt: m.createdAt,
                // Bugfix 2026-04-22: flatten the Vercel AI SDK `parts` JSON
                // into a plain-text `content` string so the agent can
                // actually read what was said on each recent turn. Without
                // this, the agent was seeing 10 id/role/timestamp stubs
                // and no text — i.e. no chat-history recall at all.
                content: flattenPartsToText((m as any).parts),
              }))
            : undefined,
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`get_context failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
