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
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  DATA_PART_TYPES,
  type FixTarget,
  type SuggestedFixData,
} from '../data-parts';
import { asCallToolResult, asError, type ToolContext } from './types';

/**
 * Derive a `FixTarget` from the legacy `targetHint` + category. Best-
 * effort — existing TUNE callsites preceded the Session B target contract,
 * and we want them to still render a useful target chip on the
 * suggested-fix card instead of rendering an untargeted card that a
 * future lint rule would reject.
 */
function deriveTargetFromHint(
  category: string,
  hint:
    | {
        sopCategory?: string;
        sopStatus?: string;
        sopPropertyId?: string;
        faqEntryId?: string;
        systemPromptVariant?: string;
        toolDefinitionId?: string;
      }
    | undefined
): FixTarget {
  if (!hint) {
    if (category === 'SYSTEM_PROMPT') return { artifact: 'system_prompt' };
    if (category === 'FAQ') return { artifact: 'faq' };
    if (category === 'SOP_CONTENT' || category === 'SOP_ROUTING') return { artifact: 'sop' };
    if (category === 'TOOL_CONFIG') return { artifact: 'tool_definition' };
    if (category === 'PROPERTY_OVERRIDE') return { artifact: 'property_override' };
    return {};
  }
  if (hint.systemPromptVariant) return { artifact: 'system_prompt', sectionId: hint.systemPromptVariant };
  if (hint.faqEntryId) return { artifact: 'faq', artifactId: hint.faqEntryId };
  if (hint.toolDefinitionId) return { artifact: 'tool_definition', artifactId: hint.toolDefinitionId };
  if (hint.sopPropertyId) return { artifact: 'property_override', artifactId: hint.sopPropertyId };
  if (hint.sopCategory || hint.sopStatus) return { artifact: 'sop' };
  return {};
}

export function buildProposeSuggestionTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'propose_suggestion',
    "Stage a proposed artifact change as a client-side preview the manager can inspect. Does not write to the database. Supports two edit formats: 'full_replacement' (default) supplies the COMPLETE revised artifact text via proposedText; 'search_replace' supplies oldText (exact, unique match from the current artifact) + newText for a literal string replacement at apply time. Use search_replace for artifacts larger than ~2,000 tokens.",
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
      editFormat: z.enum(['search_replace', 'full_replacement']).optional(),
      proposedText: z.string().optional(),
      oldText: z.string().optional(),
      newText: z.string().optional(),
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
      // Sprint 046 Session B — machine-readable target for the
      // data-suggested-fix card. Per Response Contract rule 5 an edit
      // without a concrete target is "never acceptable"; optional here
      // only for back-compat with TUNE-side callers that still rely on
      // the loose targetHint. New BUILD/TUNE paths should always supply.
      target: z
        .object({
          artifact: z
            .enum(['system_prompt', 'sop', 'faq', 'tool_definition', 'property_override'])
            .optional(),
          artifactId: z.string().optional(),
          sectionId: z.string().optional(),
          slotKey: z.string().optional(),
          lineRange: z.tuple([z.number(), z.number()]).optional(),
        })
        .optional(),
      impact: z.string().max(300).optional(),
    },
    async (args) => {
      const c = ctx();
      const editFormat = args.editFormat ?? 'full_replacement';
      const span = startAiSpan('tuning-agent.propose_suggestion', {
        category: args.category,
        confidence: args.confidence,
        editFormat,
      });
      try {
        const previewId = `preview:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        const createdAt = new Date().toISOString();

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
              editFormat,
              proposedText: args.proposedText ?? null,
              oldText: args.oldText ?? null,
              newText: args.newText ?? null,
              beforeText: args.beforeText ?? null,
              targetHint: args.targetHint ?? null,
              createdAt,
            },
          });

          // Sprint 046 Session B — also emit the canonical
          // data-suggested-fix shape consumed by the Studio
          // suggested-fix card. Derivation rules:
          //   before = beforeText (full_replacement) or oldText (search_replace)
          //   after  = proposedText (full_replacement) or newText (search_replace)
          // `target` is preferred when supplied; otherwise we derive a
          // best-effort FixTarget from the legacy `targetHint` so
          // existing TUNE callsites don't silently skip the card.
          const before =
            editFormat === 'search_replace'
              ? args.oldText ?? ''
              : args.beforeText ?? '';
          const after =
            editFormat === 'search_replace'
              ? args.newText ?? ''
              : args.proposedText ?? '';

          const derivedTarget: FixTarget = args.target ?? deriveTargetFromHint(args.category, args.targetHint);
          const fixData: SuggestedFixData = {
            id: previewId,
            target: derivedTarget,
            before,
            after,
            rationale: args.rationale,
            impact: args.impact,
            category: args.category,
            createdAt,
          };
          c.emitDataPart({
            type: DATA_PART_TYPES.suggested_fix,
            id: `suggested-fix:${previewId}`,
            data: fixData,
          });
        }

        const payload = {
          previewId,
          category: args.category,
          editFormat,
          status: 'PREVIEWED',
          hint: 'Wait for manager to sanction apply/queue/reject, then call suggestion_action with action and the same edit-format fields you passed here.',
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
