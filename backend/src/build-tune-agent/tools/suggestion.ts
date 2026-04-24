/**
 * studio_suggestion — consolidated suggestion lifecycle tool.
 *
 * 060-D § 4.3: merges propose_suggestion + suggestion_action into a single
 * op-dispatched tool. The discriminated-union shape mitigates the agent's
 * ~10-20% accuracy hit on op-based dispatch by inlining one example per
 * op variant in the description string (per non-negotiable #12).
 *
 * Op routing:
 *   • propose          → propose-suggestion handler (stages a card; no DB write).
 *   • apply            → suggestion-action handler (action='apply').
 *   • reject           → suggestion-action handler (action='reject').
 *   • edit_then_apply  → suggestion-action handler (action='edit_then_apply').
 *
 * 060-D § 4.6: `diff: { before, after }` field on `op: 'propose'` absorbs
 * the data-version-diff card. Frontend renders the diff inline within the
 * suggested-fix card. Schema-level absorption lands in this commit; the
 * data-suggested-fix payload extension and frontend rendering land in the
 * follow-on commits (diff_versions deletion + frontend rewire).
 *
 * The underlying handlers are reused via `.handler` on the SdkMcpToolDefinition.
 * No refactor of the propose-suggestion / suggestion-action handler bodies.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { buildProposeSuggestionTool } from './propose-suggestion';
import { buildSuggestionActionTool } from './suggestion-action';
import { asError, type ToolContext } from './types';

const DESCRIPTION = `studio_suggestion: stage / apply / reject / edit-then-apply a tuning suggestion. One tool, four ops.

ARGS by op:
  op='propose': category, subLabel, rationale, confidence?, proposedText?,
    beforeText?, targetHint? | target?, editFormat?, oldText?, newText?,
    diff?: { before, after }   ← embeds the diff inside the suggested-fix card
  op='apply': suggestionId, draft? (used when no PENDING row exists yet)
  op='reject': suggestionId, reason?
  op='edit_then_apply': suggestionId, edits

EXAMPLES:
  // propose with diff embedded:
  studio_suggestion({ op: 'propose', category: 'SOP_CONTENT', subLabel: 'checkin-time-tone',
                      rationale: 'Manager asked for a softer phrase here.', confidence: 0.78,
                      proposedText: '<full new SOP>', beforeText: '<current SOP>',
                      target: { artifact: 'sop', sopCategory: 'SOP_CHECKIN', sopStatus: 'CONFIRMED' },
                      diff: { before: '<old line>', after: '<new line>' } })

  // apply (manager sanctioned):
  studio_suggestion({ op: 'apply', suggestionId: 'tsg_abc123' })

  // reject (manager said "no"):
  studio_suggestion({ op: 'reject', suggestionId: 'tsg_abc123', reason: 'too aggressive on tone' })

  // edit_then_apply (manager edited the proposed text):
  studio_suggestion({ op: 'edit_then_apply', suggestionId: 'tsg_abc123',
                      edits: '<full revised text the manager pasted back>' })`;

export function buildSuggestionTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  // Build the underlying tools in-place; we delegate via .handler. The
  // underlying tools are NOT registered separately — only studio_suggestion
  // is exposed to the agent.
  const proposeTool = buildProposeSuggestionTool(tool, ctx);
  const actionTool = buildSuggestionActionTool(tool, ctx);

  return tool(
    'studio_suggestion',
    DESCRIPTION,
    {
      op: z.enum(['propose', 'apply', 'reject', 'edit_then_apply']),
      // propose-shaped args
      category: z
        .enum([
          'SOP_CONTENT',
          'SOP_ROUTING',
          'FAQ',
          'SYSTEM_PROMPT',
          'TOOL_CONFIG',
          'PROPERTY_OVERRIDE',
          'MISSING_CAPABILITY',
          'NO_FIX',
        ])
        .optional(),
      subLabel: z.string().min(1).max(80).optional(),
      rationale: z.string().min(10).max(2000).optional(),
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
      target: z
        .object({
          artifact: z
            .enum(['system_prompt', 'sop', 'faq', 'tool_definition', 'property_override'])
            .optional(),
          artifactId: z.string().optional(),
          sectionId: z.string().optional(),
          slotKey: z.string().optional(),
          lineRange: z.tuple([z.number(), z.number()]).optional(),
          sopCategory: z.string().optional(),
          sopStatus: z
            .enum(['DEFAULT', 'INQUIRY', 'CONFIRMED', 'CHECKED_IN'])
            .optional(),
          sopPropertyId: z.string().optional(),
          faqEntryId: z.string().optional(),
          systemPromptVariant: z.enum(['coordinator', 'screening']).optional(),
        })
        .optional(),
      impact: z.string().max(300).optional(),
      // 060-D § 4.6 — diff absorption.
      diff: z
        .object({
          before: z.string(),
          after: z.string(),
        })
        .optional(),
      // apply / reject / edit_then_apply args
      suggestionId: z.string().optional(),
      reason: z.string().max(400).optional(),
      edits: z.string().optional(),
      // Shared draft escape hatch (used by apply when no PENDING row exists).
      draft: z
        .object({
          category: z.enum([
            'SOP_CONTENT',
            'SOP_ROUTING',
            'FAQ',
            'SYSTEM_PROMPT',
            'TOOL_CONFIG',
            'PROPERTY_OVERRIDE',
          ]),
          subLabel: z.string().min(1).max(80),
          rationale: z.string().min(10).max(2000),
          confidence: z.number().min(0).max(1).optional(),
          editFormat: z.enum(['search_replace', 'full_replacement']).optional(),
          proposedText: z.string().optional(),
          oldText: z.string().optional(),
          newText: z.string().optional(),
          beforeText: z.string().optional(),
          sopCategory: z.string().optional(),
          sopStatus: z
            .enum(['DEFAULT', 'INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'])
            .optional(),
          sopPropertyId: z.string().optional(),
          systemPromptVariant: z.enum(['coordinator', 'screening']).optional(),
          faqEntryId: z.string().optional(),
          sourceMessageId: z.string().optional(),
        })
        .optional(),
    },
    async (args, extra) => {
      const op = args.op;
      if (op === 'propose') {
        if (!args.category || !args.subLabel || !args.rationale) {
          return asError(
            'studio_suggestion(op=propose): category, subLabel, rationale are required.',
          );
        }
        // Forward the full propose schema (incl. new diff field) to the
        // underlying handler. Unknown fields (diff) are tolerated by Zod
        // when not in the schema — but the underlying schema doesn't yet
        // accept `diff`, so we strip it here. The frontend rendering
        // hookup for the absorbed diff lands in commit 8 / 19.
        const { diff, op: _op, ...proposeArgs } = args;
        return proposeTool.handler(proposeArgs as any, extra);
      }
      if (op === 'apply') {
        return actionTool.handler(
          {
            suggestionId: args.suggestionId,
            action: 'apply',
            draft: args.draft,
          } as any,
          extra,
        );
      }
      if (op === 'reject') {
        if (!args.suggestionId) {
          return asError('studio_suggestion(op=reject): suggestionId is required.');
        }
        return actionTool.handler(
          {
            suggestionId: args.suggestionId,
            action: 'reject',
            rejectReason: args.reason,
          } as any,
          extra,
        );
      }
      if (op === 'edit_then_apply') {
        if (!args.suggestionId || !args.edits) {
          return asError(
            'studio_suggestion(op=edit_then_apply): suggestionId and edits are required.',
          );
        }
        return actionTool.handler(
          {
            suggestionId: args.suggestionId,
            action: 'edit_then_apply',
            editedText: args.edits,
          } as any,
          extra,
        );
      }
      return asError(`studio_suggestion: unknown op '${String(op)}'.`);
    },
    // op-conditional hint: apply is destructive (writes the artifact);
    // propose / reject / edit_then_apply are not. We can only declare one
    // hint at the schema level — pick the worst-case so MCP clients are
    // conservative around the tool.
    { annotations: { destructiveHint: true } },
  );
}
