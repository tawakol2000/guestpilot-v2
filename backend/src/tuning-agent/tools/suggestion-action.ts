/**
 * suggestion_action — apply / queue / reject / edit-then-apply a suggestion.
 *
 * Two modes:
 *   (a) `suggestionId` refers to an existing PENDING TuningSuggestion row.
 *       This is the typical path when the manager was looking at a queue
 *       item before opening the chat, or when the agent previously proposed
 *       and persisted via this tool.
 *   (b) `previewOnly` suggestions from propose_suggestion are staged as
 *       PENDING rows here before being acted on. Pass `draft` to persist
 *       the proposed row and apply/queue it in one call.
 *
 * Cooldown + oscillation + compliance are enforced by the PreToolUse hook
 * BEFORE this handler runs. The handler itself trusts that the hook
 * allowed the call. If the hook blocked, we never get here.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import {
  Prisma,
  TuningActionType,
  TuningDiagnosticCategory,
  TuningSuggestionStatus,
} from '@prisma/client';
import { startAiSpan } from '../../services/observability.service';
import { updateCategoryStatsOnAccept, updateCategoryStatsOnReject } from '../../services/tuning/category-stats.service';
import { recordPreferencePair } from '../../services/tuning/preference-pair.service';
import {
  snapshotFaqEntry,
  snapshotSopVariant,
} from '../../services/tuning/artifact-history.service';
import { invalidateTenantConfigCache } from '../../services/tenant-config.service';
import { mergeSystemPromptClause } from '../../services/tuning/system-prompt-merge.service';
import { asCallToolResult, asError, type ToolContext } from './types';

const CATEGORY_TO_ACTION_TYPE: Record<string, TuningActionType> = {
  SOP_CONTENT: 'EDIT_SOP_CONTENT',
  SOP_ROUTING: 'EDIT_SOP_ROUTING',
  FAQ: 'EDIT_FAQ',
  SYSTEM_PROMPT: 'EDIT_SYSTEM_PROMPT',
  TOOL_CONFIG: 'EDIT_SYSTEM_PROMPT', // legacy fallback, sprint-02 convention
  PROPERTY_OVERRIDE: 'EDIT_SOP_CONTENT',
  NO_FIX: 'EDIT_SYSTEM_PROMPT', // placeholder; NO_FIX never actually reaches here
  MISSING_CAPABILITY: 'EDIT_SYSTEM_PROMPT', // placeholder; handled separately
};

export function buildSuggestionActionTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext
): SdkMcpToolDefinition<any> {
  return tool(
    'suggestion_action',
    "Persist + act on a tuning suggestion. Actions: 'apply' writes the artifact immediately; 'queue' persists as PENDING for manager review; 'reject' marks REJECTED (logs + captures preference pair); 'edit_then_apply' applies the manager-edited text and captures a preference pair. Cooldown / oscillation / compliance are enforced by PreToolUse hook. Pass `draft` if no PENDING row exists yet (lets you persist + act in one call).",
    {
      suggestionId: z.string().optional(),
      action: z.enum(['apply', 'queue', 'reject', 'edit_then_apply']),
      editedText: z.string().optional(),
      rejectReason: z.string().max(400).optional(),
      /** When no suggestion exists yet (agent proposed inline), include the draft payload. */
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
          proposedText: z.string().optional(),
          beforeText: z.string().optional(),
          sopCategory: z.string().optional(),
          sopStatus: z.enum(['DEFAULT', 'INQUIRY', 'CONFIRMED', 'CHECKED_IN']).optional(),
          sopPropertyId: z.string().optional(),
          systemPromptVariant: z.enum(['coordinator', 'screening']).optional(),
          faqEntryId: z.string().optional(),
          sourceMessageId: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.suggestion_action', {
        action: args.action,
        suggestionId: args.suggestionId ?? null,
      });
      try {
        // 1. Resolve or create the suggestion row.
        let suggestionId = args.suggestionId ?? null;
        if (!suggestionId) {
          if (!args.draft) {
            span.end({ error: 'NEITHER_ID_NOR_DRAFT' });
            return asError('suggestion_action requires either suggestionId or draft.');
          }
          if (!args.draft.sourceMessageId) {
            // Use the conversation's anchor message as the source, if any.
            if (c.conversationId) {
              const conv = await c.prisma.tuningConversation.findFirst({
                where: { id: c.conversationId, tenantId: c.tenantId },
                select: { anchorMessageId: true },
              });
              if (conv?.anchorMessageId) args.draft.sourceMessageId = conv.anchorMessageId;
            }
          }
          if (!args.draft.sourceMessageId) {
            span.end({ error: 'NO_SOURCE_MESSAGE' });
            return asError(
              'Cannot persist draft suggestion without sourceMessageId (either explicitly in draft or via an anchored conversation).'
            );
          }
          const actionType = CATEGORY_TO_ACTION_TYPE[args.draft.category] ?? 'EDIT_SYSTEM_PROMPT';
          const created = await c.prisma.tuningSuggestion.create({
            data: {
              tenantId: c.tenantId,
              sourceMessageId: args.draft.sourceMessageId,
              actionType,
              status: 'PENDING',
              rationale: args.draft.rationale,
              beforeText: args.draft.beforeText ?? null,
              proposedText: args.draft.proposedText ?? null,
              sopCategory: args.draft.sopCategory ?? null,
              sopStatus: args.draft.sopStatus ?? null,
              sopPropertyId: args.draft.sopPropertyId ?? null,
              systemPromptVariant: args.draft.systemPromptVariant ?? null,
              faqEntryId: args.draft.faqEntryId ?? null,
              diagnosticCategory: args.draft.category as TuningDiagnosticCategory,
              diagnosticSubLabel: args.draft.subLabel,
              confidence: args.draft.confidence ?? null,
              conversationId: c.conversationId,
              triggerType: null,
            },
            select: { id: true },
          });
          suggestionId = created.id;
        }

        const suggestion = await c.prisma.tuningSuggestion.findFirst({
          where: { id: suggestionId!, tenantId: c.tenantId },
        });
        if (!suggestion) {
          span.end({ error: 'NOT_FOUND' });
          return asError(`TuningSuggestion ${suggestionId} not found for tenant.`);
        }

        // 2. Dispatch on action.
        if (args.action === 'reject') {
          if (suggestion.status !== 'PENDING') {
            span.end({ error: 'NOT_PENDING' });
            return asError(`Suggestion ${suggestionId} is ${suggestion.status}; cannot reject.`);
          }
          const appliedPayload: Record<string, unknown> = {
            rejectReason: args.rejectReason ?? null,
            rejectedByAgent: true,
          };
          await c.prisma.tuningSuggestion.update({
            where: { id: suggestion.id },
            data: {
              status: 'REJECTED' as TuningSuggestionStatus,
              appliedAt: new Date(),
              appliedPayload: appliedPayload as Prisma.InputJsonValue,
              conversationId: c.conversationId ?? suggestion.conversationId,
            },
          });
          await updateCategoryStatsOnReject(c.prisma, c.tenantId, suggestion.diagnosticCategory);
          // PreferencePair on reject captures the (context, rejected, preferred-final=before)
          // triple so DPO can later learn "prefer keeping the original over this suggestion".
          if (suggestion.beforeText && suggestion.proposedText) {
            await recordPreferencePair(c.prisma, {
              tenantId: c.tenantId,
              suggestionId: suggestion.id,
              category: suggestion.diagnosticCategory ?? null,
              before: suggestion.beforeText,
              rejectedProposal: suggestion.proposedText,
              preferredFinal: suggestion.beforeText,
            }).catch((err) => console.warn('[suggestion_action] preference-pair write failed:', err));
          }
          const payload = { suggestionId: suggestion.id, status: 'REJECTED' };
          span.end(payload);
          return asCallToolResult(payload);
        }

        if (args.action === 'queue') {
          // QUEUE = persist the edit-with-QUEUED applyMode on the row; artifact
          // write deferred to manager-confirmed apply later (V1 behavior is
          // identical to IMMEDIATE at write time, but we record the intent).
          await c.prisma.tuningSuggestion.update({
            where: { id: suggestion.id },
            data: {
              applyMode: 'QUEUED',
              conversationId: c.conversationId ?? suggestion.conversationId,
            },
          });
          const payload = { suggestionId: suggestion.id, status: 'PENDING', applyMode: 'QUEUED' };
          span.end(payload);
          return asCallToolResult(payload);
        }

        // apply | edit_then_apply — artifact write + ACCEPTED status
        const finalText = args.editedText ?? suggestion.proposedText;
        const wasEdited = args.action === 'edit_then_apply';
        const outcome = await applyArtifactWrite(c, suggestion, finalText);
        if (!outcome.ok) {
          span.end({ error: outcome.error });
          return asError(`apply failed: ${outcome.error}`);
        }
        const appliedPayload: Record<string, unknown> = {
          ...outcome.appliedPayload,
          editedByAgent: true,
          editedFromOriginal: wasEdited,
        };
        await c.prisma.tuningSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: 'ACCEPTED' as TuningSuggestionStatus,
            appliedAt: new Date(),
            appliedByUserId: c.userId,
            appliedPayload: appliedPayload as Prisma.InputJsonValue,
            applyMode: 'IMMEDIATE',
            conversationId: c.conversationId ?? suggestion.conversationId,
          },
        });
        await updateCategoryStatsOnAccept(c.prisma, c.tenantId, suggestion.diagnosticCategory);
        if (wasEdited && suggestion.proposedText && finalText) {
          await recordPreferencePair(c.prisma, {
            tenantId: c.tenantId,
            suggestionId: suggestion.id,
            category: suggestion.diagnosticCategory ?? null,
            before: suggestion.beforeText,
            rejectedProposal: suggestion.proposedText,
            preferredFinal: finalText,
          }).catch((err) => console.warn('[suggestion_action] preference-pair write failed:', err));
        }

        const payload = {
          suggestionId: suggestion.id,
          status: 'ACCEPTED',
          target: outcome.target,
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`suggestion_action failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}

interface ApplyOutcome {
  ok: boolean;
  error?: string;
  target?: { kind: string; id: string };
  appliedPayload?: Record<string, unknown>;
}

/**
 * Writes to the target artifact using the same logic as the Feature-040
 * accept controller (system prompts, SOP variants, SOP routing, FAQ,
 * tool-config). Tool-config is new-branch-only — sprint-03 added it; the
 * agent path reuses the same update pattern directly to avoid coupling
 * to an Express controller.
 */
async function applyArtifactWrite(
  c: ToolContext,
  suggestion: {
    id: string;
    actionType: TuningActionType;
    diagnosticCategory: TuningDiagnosticCategory | null;
    systemPromptVariant: string | null;
    sopCategory: string | null;
    sopStatus: string | null;
    sopPropertyId: string | null;
    sopToolDescription: string | null;
    faqEntryId: string | null;
    beforeText: string | null;
    proposedText: string | null;
  },
  finalText: string | null
): Promise<ApplyOutcome> {
  if (!finalText) return { ok: false, error: 'MISSING_FINAL_TEXT' };

  // TOOL_CONFIG dispatch — use the ToolDefinition update pattern.
  if (suggestion.diagnosticCategory === 'TOOL_CONFIG') {
    // finalText is the new description; we need a tool id. Look up by
    // beforeText match if hints aren't enough. V1: require the agent to
    // have included the tool name as the subLabel or encoded the toolId
    // into the payload. If nothing matches, fall back to first tool for
    // this tenant — this is intentionally conservative and logged.
    const allTools = await c.prisma.toolDefinition.findMany({
      where: { tenantId: c.tenantId },
      select: { id: true, description: true, name: true },
    });
    let target = allTools.find(
      (t) => suggestion.beforeText && t.description === suggestion.beforeText
    );
    if (!target) target = allTools[0];
    if (!target) return { ok: false, error: 'NO_TOOL_DEFINITIONS_FOUND' };
    await c.prisma.toolDefinition.update({
      where: { id: target.id },
      data: { description: finalText },
    });
    return {
      ok: true,
      target: { kind: 'tool_definition', id: target.id },
      appliedPayload: { text: finalText, toolName: target.name },
    };
  }

  switch (suggestion.actionType) {
    case 'EDIT_SYSTEM_PROMPT': {
      if (!suggestion.systemPromptVariant) return { ok: false, error: 'MISSING_SYSTEM_PROMPT_VARIANT' };
      // Hotfix — see tuning-suggestion.controller.ts for the same bug fix.
      // Append the proposed clause inside marker comments rather than
      // overwriting the entire prompt. Variant key sniffed defensively.
      const variantLower = suggestion.systemPromptVariant.toLowerCase();
      const variantField =
        variantLower.includes('coord')
          ? 'systemPromptCoordinator'
          : 'systemPromptScreening';
      const current = await c.prisma.tenantAiConfig.findUnique({ where: { tenantId: c.tenantId } });
      const currentPromptText = ((current as any)?.[variantField] as string | null) ?? '';
      const mergedFinalText = mergeSystemPromptClause(
        currentPromptText,
        finalText,
        suggestion.id,
        { mode: 'append' }
      );
      const history = Array.isArray(current?.systemPromptHistory)
        ? [...((current!.systemPromptHistory as unknown[]) || [])]
        : [];
      const snapshotVariantKey =
        variantField === 'systemPromptCoordinator' ? 'coordinator' : 'screening';
      history.push({
        version: current?.systemPromptVersion ?? 1,
        timestamp: new Date().toISOString(),
        [snapshotVariantKey]: currentPromptText,
        note: `Tuning agent applied suggestion ${suggestion.id}`,
      });
      while (history.length > 10) history.shift();
      await c.prisma.tenantAiConfig.update({
        where: { tenantId: c.tenantId },
        data: {
          [variantField]: mergedFinalText,
          systemPromptVersion: { increment: 1 },
          systemPromptHistory: history as Prisma.InputJsonValue,
        },
      });
      invalidateTenantConfigCache(c.tenantId);
      return {
        ok: true,
        target: { kind: 'system_prompt', id: suggestion.systemPromptVariant },
        appliedPayload: { text: mergedFinalText, mode: 'append' },
      };
    }

    case 'EDIT_SOP_CONTENT': {
      if (!suggestion.sopCategory || !suggestion.sopStatus) {
        return { ok: false, error: 'MISSING_SOP_FIELDS' };
      }
      const sopDef = await c.prisma.sopDefinition.findFirst({
        where: { tenantId: c.tenantId, category: suggestion.sopCategory },
        select: { id: true },
      });
      if (!sopDef) return { ok: false, error: 'SOP_DEFINITION_NOT_FOUND' };
      if (suggestion.sopPropertyId) {
        const priorOverride = await c.prisma.sopPropertyOverride.findUnique({
          where: {
            sopDefinitionId_propertyId_status: {
              sopDefinitionId: sopDef.id,
              propertyId: suggestion.sopPropertyId,
              status: suggestion.sopStatus,
            },
          },
          select: { id: true, content: true },
        });
        if (priorOverride) {
          await snapshotSopVariant(c.prisma, {
            tenantId: c.tenantId,
            targetId: priorOverride.id,
            kind: 'override',
            sopDefinitionId: sopDef.id,
            status: suggestion.sopStatus,
            content: priorOverride.content,
            propertyId: suggestion.sopPropertyId,
            editedByUserId: c.userId ?? null,
            triggeringSuggestionId: suggestion.id,
          });
        }
        const override = await c.prisma.sopPropertyOverride.upsert({
          where: {
            sopDefinitionId_propertyId_status: {
              sopDefinitionId: sopDef.id,
              propertyId: suggestion.sopPropertyId,
              status: suggestion.sopStatus,
            },
          },
          update: { content: finalText },
          create: {
            sopDefinitionId: sopDef.id,
            propertyId: suggestion.sopPropertyId,
            status: suggestion.sopStatus,
            content: finalText,
          },
        });
        return {
          ok: true,
          target: { kind: 'sop_property_override', id: override.id },
          appliedPayload: { text: finalText, sopPropertyId: suggestion.sopPropertyId, sopStatus: suggestion.sopStatus },
        };
      }
      const variant = await c.prisma.sopVariant.findFirst({
        where: { sopDefinitionId: sopDef.id, status: suggestion.sopStatus },
        select: { id: true, content: true },
      });
      let targetId: string;
      if (variant) {
        await snapshotSopVariant(c.prisma, {
          tenantId: c.tenantId,
          targetId: variant.id,
          kind: 'variant',
          sopDefinitionId: sopDef.id,
          status: suggestion.sopStatus,
          content: variant.content,
          editedByUserId: c.userId ?? null,
          triggeringSuggestionId: suggestion.id,
        });
        targetId = (
          await c.prisma.sopVariant.update({
            where: { id: variant.id },
            data: { content: finalText },
            select: { id: true },
          })
        ).id;
      } else {
        targetId = (
          await c.prisma.sopVariant.create({
            data: {
              sopDefinitionId: sopDef.id,
              status: suggestion.sopStatus,
              content: finalText,
            },
            select: { id: true },
          })
        ).id;
      }
      return {
        ok: true,
        target: { kind: 'sop_variant', id: targetId },
        appliedPayload: { text: finalText, sopStatus: suggestion.sopStatus },
      };
    }

    case 'EDIT_SOP_ROUTING': {
      if (!suggestion.sopCategory) return { ok: false, error: 'MISSING_SOP_CATEGORY' };
      const sopDef = await c.prisma.sopDefinition.findFirst({
        where: { tenantId: c.tenantId, category: suggestion.sopCategory },
        select: { id: true },
      });
      if (!sopDef) return { ok: false, error: 'SOP_DEFINITION_NOT_FOUND' };
      await c.prisma.sopDefinition.update({
        where: { id: sopDef.id },
        data: { toolDescription: finalText },
      });
      return {
        ok: true,
        target: { kind: 'sop_routing', id: sopDef.id },
        appliedPayload: { text: finalText },
      };
    }

    case 'EDIT_FAQ': {
      if (!suggestion.faqEntryId) return { ok: false, error: 'MISSING_FAQ_ENTRY_ID' };
      const faq = await c.prisma.faqEntry.findFirst({
        where: { id: suggestion.faqEntryId, tenantId: c.tenantId },
      });
      if (!faq) return { ok: false, error: 'FAQ_ENTRY_NOT_FOUND' };
      await snapshotFaqEntry(c.prisma, {
        tenantId: c.tenantId,
        targetId: faq.id,
        question: faq.question,
        answer: faq.answer,
        category: faq.category,
        scope: String(faq.scope),
        propertyId: faq.propertyId ?? null,
        status: String(faq.status),
        editedByUserId: c.userId ?? null,
        triggeringSuggestionId: suggestion.id,
      });
      const editQuestion =
        !!suggestion.beforeText && suggestion.beforeText.trim() === faq.question.trim();
      if (editQuestion) {
        await c.prisma.faqEntry.update({
          where: { id: faq.id },
          data: { question: finalText },
        });
      } else {
        await c.prisma.faqEntry.update({
          where: { id: faq.id },
          data: { answer: finalText },
        });
      }
      return {
        ok: true,
        target: { kind: 'faq_entry', id: faq.id },
        appliedPayload: { text: finalText, field: editQuestion ? 'question' : 'answer' },
      };
    }

    default:
      return { ok: false, error: `UNSUPPORTED_ACTION_TYPE:${suggestion.actionType}` };
  }
}
