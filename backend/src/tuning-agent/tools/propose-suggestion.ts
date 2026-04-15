/**
 * propose_suggestion — stage a TuningSuggestion WITHOUT writing it.
 *
 * The row is not persisted. Instead, we:
 *   1. emit a `data-suggestion-preview` part to the client with the diff
 *      and proposed change, so the manager sees the suggestion inline
 *   2. return a summary to the agent with a client-generated preview id
 *
 * When the manager sanctions "apply"/"queue", the agent calls
 * suggestion_action with the previewId (or with a separately-persisted id
 * if a PENDING row was created via suggestion_action too).
 *
 * This preserves sprint-02's writer as the single write path for persisted
 * suggestions — this tool is a *preview generator* plus a seat at the
 * manager's review table.
 */
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';

export function buildProposeSuggestionTool(ctx: () => ToolContext) {
  return tool(
    'propose_suggestion',
    'Stage a proposed artifact change as a client-side preview the manager can inspect. Does not write to the database. The manager confirms with a chat turn; you then call suggestion_action to persist + apply (or reject). Emits a data-suggestion-preview part.',
    {
      category: z.enum([
        'SOP_CONTENT',
        'SOP_ROUTING',
        'FAQ',
        'SYSTEM_PROMPT',
        'TOOL_CONFIG',
        'PROPERTY_OVERRIDE',
        'MISSING_CAPABILITY',
        'NO_FIX',
      ]),
      subLabel: z.string().min(1).max(80),
      rationale: z.string().min(10).max(2000),
      confidence: z.number().min(0).max(1).optional(),
      proposedText: z.string().optional(),
      beforeText: z.string().optional(),
      targetHint: z
        .object({
          sopCategory: z.string().optional(),
          sopStatus: z
            .enum(['DEFAULT', 'INQUIRY', 'CONFIRMED', 'CHECKED_IN'])
            .optional(),
          sopPropertyId: z.string().optional(),
          faqEntryId: z.string().optional(),
          systemPromptVariant: z.enum(['coordinator', 'screening']).optional(),
          toolDefinitionId: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.propose_suggestion', {
        category: args.category,
        confidence: args.confidence,
      });
      try {
        const previewId = `preview:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-suggestion-preview',
            id: previewId,
            data: {
              previewId,
              category: args.category,
              subLabel: args.subLabel,
              rationale: args.rationale,
              confidence: args.confidence ?? null,
              proposedText: args.proposedText ?? null,
              beforeText: args.beforeText ?? null,
              targetHint: args.targetHint ?? null,
              createdAt: new Date().toISOString(),
            },
          });
        }

        const payload = {
          previewId,
          category: args.category,
          status: 'PREVIEWED',
          hint: 'Wait for manager to sanction apply/queue/reject, then call suggestion_action with action and the payload fields you need persisted.',
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`propose_suggestion failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
