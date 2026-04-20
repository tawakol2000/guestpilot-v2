/**
 * ask_manager — sprint 046 Session B, plan §5.4.
 *
 * Thin wrapper around `emitDataPart` so the agent is forced to commit to
 * a card-shaped payload (`data-question-choices`) whenever it needs to
 * ask the manager a question. Per Response Contract rule 4: no
 * open-ended prose questions — every question is a choice card.
 *
 * Mode: both. No DB write. No side effects beyond the SSE emit.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { DATA_PART_TYPES, type QuestionChoiceOption, type QuestionChoicesData } from '../data-parts';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Ask the manager a question with a set of choice buttons. Emits a data-question-choices card. Use whenever you would otherwise ask an open-ended prose question; per the Response Contract (rule 4) prose questions are banned. Provide 2-5 options with one flagged \`recommended: true\`. Set allowCustomInput=true only when a free-text escape hatch genuinely helps (e.g. brand voice, custom hours). Does NOT write to the database. Callable in both BUILD and TUNE modes.`;

const optionSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  recommended: z.boolean().optional(),
});

export function buildAskManagerTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'ask_manager',
    DESCRIPTION,
    {
      question: z.string().min(3).max(500),
      options: z.array(optionSchema).min(2).max(5),
      recommendedDefault: z.string().optional(),
      allowCustomInput: z.boolean().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.ask_manager', {
        optionCount: args.options.length,
        allowCustomInput: !!args.allowCustomInput,
      });
      try {
        // Normalise recommended flag: honour explicit option.recommended first,
        // fall back to recommendedDefault id match.
        const normalised: QuestionChoiceOption[] = args.options.map((o) => ({
          id: o.id,
          label: o.label,
          recommended:
            o.recommended === true || (!!args.recommendedDefault && args.recommendedDefault === o.id),
        }));
        const recommendedCount = normalised.filter((o) => o.recommended).length;
        if (recommendedCount > 1) {
          return asError(
            `ask_manager: at most one option may be flagged recommended (got ${recommendedCount}).`
          );
        }

        const data: QuestionChoicesData = {
          question: args.question,
          options: normalised,
          allowCustomInput: !!args.allowCustomInput,
        };
        const id = `question:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        if (c.emitDataPart) {
          c.emitDataPart({
            type: DATA_PART_TYPES.question_choices,
            id,
            data,
          });
        }
        const payload = {
          ok: true,
          questionId: id,
          optionsEmitted: normalised.length,
          hint: 'Wait for the manager to choose (or type a custom answer if enabled) before proposing an edit.',
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`ask_manager failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
