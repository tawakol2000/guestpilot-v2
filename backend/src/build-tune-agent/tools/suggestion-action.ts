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
  PrismaClient,
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
import { invalidateSopCache } from '../../services/sop.service';
import { invalidateToolCache } from '../../services/tool-definition.service';
import { broadcastCritical } from '../../services/socket.service';
import { performSearchReplace } from './search-replace';
import {
  findDuplicateFaqEntry,
  resolveFaqAutoCreateFields,
} from '../../services/tuning/faq-auto-create';
import { detectElisionMarker } from '../validators/elision-patterns';
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
          // Sprint 10: edit-format support. 'full_replacement' (default) uses
          // proposedText as the complete new artifact body. 'search_replace'
          // resolves oldText→newText against the current artifact text at
          // apply time; fails fast if oldText is not found.
          editFormat: z.enum(['search_replace', 'full_replacement']).optional(),
          proposedText: z.string().optional(),
          oldText: z.string().optional(),
          newText: z.string().optional(),
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
      // Sprint 09 follow-up: track whether the CAS flipped this row to
      // ACCEPTED so the catch handler can revert if anything throws after
      // the claim. Previously an unexpected throw between CAS and outcome
      // left the row permanently ACCEPTED with no artifact written.
      let acceptedClaimForId: string | null = null;
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
          // Sprint 10 workstream A: resolve search_replace → full proposedText
          // before persisting. The apply path downstream writes proposedText
          // directly to the artifact, so we normalise edit-format here. If
          // oldText isn't found (or appears multiple times) in the current
          // artifact, fail fast — the agent can retry with corrected oldText.
          let draftProposedText = args.draft.proposedText ?? null;
          let draftBeforeText = args.draft.beforeText ?? null;
          let draftEditFormat: 'search_replace' | 'full_replacement' =
            (args.draft.editFormat as any) ?? 'full_replacement';
          if (draftEditFormat === 'search_replace') {
            // TOOL_CONFIG has no "current artifact text" the resolver can
            // hand back — the tool description IS the artifact but it's
            // matched by exact-equality at apply time, not by substring
            // splice. Fail early with a clean error instead of letting
            // resolveCurrentArtifactText return null and surfacing the
            // generic target-not-found message.
            if (args.draft.category === 'TOOL_CONFIG') {
              span.end({ error: 'SEARCH_REPLACE_UNSUPPORTED_TOOL_CONFIG' });
              return asError(
                'TOOL_CONFIG edits do not support editFormat=search_replace. Use editFormat=full_replacement with the complete new tool description in proposedText, and set beforeText to the current description so the apply path can identify the target.'
              );
            }
            const oldText = args.draft.oldText ?? '';
            const newText = args.draft.newText ?? '';
            if (!oldText || !newText) {
              span.end({ error: 'SEARCH_REPLACE_MISSING_FIELDS' });
              return asError(
                'search_replace edit format requires both oldText and newText in the draft.'
              );
            }
            if (oldText === newText) {
              span.end({ error: 'SEARCH_REPLACE_NOOP' });
              return asError('search_replace edit format requires oldText !== newText.');
            }
            const currentText = await resolveCurrentArtifactText(c, args.draft);
            if (currentText == null) {
              span.end({ error: 'SEARCH_REPLACE_TARGET_NOT_FOUND' });
              return asError(
                'Could not resolve current artifact text for search_replace. Check the draft target fields (e.g. sopCategory+sopStatus, systemPromptVariant, faqEntryId, or beforeText for TOOL_CONFIG).'
              );
            }
            const resolved = performSearchReplace(currentText, oldText, newText);
            if (resolved.kind === 'not_found') {
              span.end({ error: 'SEARCH_REPLACE_OLDTEXT_NOT_FOUND' });
              return asError(
                'search_replace failed: oldText was not found in the current artifact. Re-read the artifact via fetch_evidence_bundle and supply an exact, verbatim passage (including whitespace and punctuation). Newlines must match exactly (LF vs CRLF).'
              );
            }
            if (resolved.kind === 'ambiguous') {
              span.end({ error: 'SEARCH_REPLACE_OLDTEXT_AMBIGUOUS' });
              return asError(
                `search_replace failed: oldText matched ${resolved.count} occurrences in the current artifact. Extend oldText with surrounding context so the match is unique, then retry.`
              );
            }
            draftProposedText = resolved.result;
            draftBeforeText = draftBeforeText ?? currentText;
          }
          // Sprint 10 workstream A.2 follow-up: run the same validator the
          // PostToolUse hook runs on propose_suggestion so the agent can't
          // bypass validation by going straight to suggestion_action({draft}).
          const draftValidationError = validateDraftForApply({
            category: args.draft.category,
            editFormat: draftEditFormat,
            proposedText: draftProposedText,
            oldText: args.draft.oldText ?? null,
            newText: args.draft.newText ?? null,
            beforeText: draftBeforeText,
          });
          if (draftValidationError) {
            span.end({ error: 'DRAFT_VALIDATION_FAILED' });
            return asError(`suggestion_action draft validation failed: ${draftValidationError}`);
          }
          const actionType = CATEGORY_TO_ACTION_TYPE[args.draft.category] ?? 'EDIT_SYSTEM_PROMPT';
          const created = await c.prisma.tuningSuggestion.create({
            data: {
              tenantId: c.tenantId,
              sourceMessageId: args.draft.sourceMessageId,
              actionType,
              status: 'PENDING',
              rationale: args.draft.rationale,
              beforeText: draftBeforeText,
              proposedText: draftProposedText,
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
          // Sprint 09 follow-up: atomic CAS mirrors the HTTP endpoint so a
          // parallel accept + reject (or two concurrent rejects) cannot both
          // pass the status gate. Allow AUTO_SUPPRESSED → REJECTED too,
          // matching the HTTP endpoint.
          const appliedPayload: Record<string, unknown> = {
            rejectReason: args.rejectReason ?? null,
            rejectedByAgent: true,
          };
          const claim = await c.prisma.tuningSuggestion.updateMany({
            where: {
              id: suggestion.id,
              tenantId: c.tenantId,
              status: { in: ['PENDING', 'AUTO_SUPPRESSED'] },
            },
            data: {
              status: 'REJECTED' as TuningSuggestionStatus,
              appliedAt: new Date(),
              appliedPayload: appliedPayload as Prisma.InputJsonValue,
              conversationId: c.conversationId ?? suggestion.conversationId,
            },
          });
          if (claim.count === 0) {
            span.end({ error: 'NOT_PENDING' });
            return asError(`Suggestion ${suggestionId} is not in a rejectable state.`);
          }
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
          // Broadcast so the frontend tuning dashboard refetches and any
          // other open tab drops this row from the pending queue. The
          // HTTP reject path broadcasts the same event; parity here lets
          // agent-driven rejects update the UI without manual refresh.
          broadcastCritical(c.tenantId, 'tuning_suggestion_updated', {
            suggestionId: suggestion.id,
            status: 'REJECTED',
            appliedByUserId: c.userId,
          });
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

        // apply | edit_then_apply — atomic status claim, then artifact write.
        // Sprint 09 follow-up: mirror the HTTP endpoint's CAS pattern so two
        // concurrent agent-path accepts (or an agent accept + HTTP accept
        // racing on the same row) cannot both pass the status gate.
        const wasEdited = args.action === 'edit_then_apply';
        if (wasEdited && (args.editedText == null || args.editedText.length === 0)) {
          span.end({ error: 'EDIT_THEN_APPLY_REQUIRES_EDITED_TEXT' });
          return asError(
            `edit_then_apply requires a non-empty editedText argument. If you meant to apply the original proposed text verbatim, use action:'apply' instead.`
          );
        }
        const finalText = args.editedText ?? suggestion.proposedText;
        const claim = await c.prisma.tuningSuggestion.updateMany({
          where: {
            id: suggestion.id,
            tenantId: c.tenantId,
            status: { in: ['PENDING', 'AUTO_SUPPRESSED'] },
          },
          data: {
            status: 'ACCEPTED' as TuningSuggestionStatus,
            appliedAt: new Date(),
            appliedByUserId: c.userId,
          },
        });
        if (claim.count === 0) {
          span.end({ error: 'NOT_PENDING' });
          return asError(`Suggestion ${suggestionId} is not in an applicable state.`);
        }
        acceptedClaimForId = suggestion.id;
        const outcome = await applyArtifactWrite(c, suggestion, finalText);
        if (!outcome.ok) {
          // Revert the claim so the manager can retry.
          await c.prisma.tuningSuggestion
            .update({
              where: { id: suggestion.id },
              data: { status: 'PENDING', appliedAt: null, appliedByUserId: null },
            })
            .catch((err) =>
              console.warn('[suggestion_action] CAS revert failed:', err)
            );
          acceptedClaimForId = null;
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
        acceptedClaimForId = null; // payload stamp + artifact write both succeeded
        // Broadcast so the frontend tuning dashboard + any other open tab
        // drops the row from PENDING and shows the new ACCEPTED state.
        broadcastCritical(c.tenantId, 'tuning_suggestion_updated', {
          suggestionId: suggestion.id,
          status: 'ACCEPTED',
          appliedByUserId: c.userId,
          applyMode: 'IMMEDIATE',
        });
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        // Sprint 09 follow-up: revert the CAS flip if we claimed a row but
        // never completed the full apply. Without this, an unexpected throw
        // (network, DB unavailable, unhandled runtime error) would leave the
        // row ACCEPTED with no artifact written and no path to retry.
        if (acceptedClaimForId) {
          await c.prisma.tuningSuggestion
            .update({
              where: { id: acceptedClaimForId },
              data: { status: 'PENDING', appliedAt: null, appliedByUserId: null },
            })
            .catch((revertErr) =>
              console.warn('[suggestion_action] CAS revert-on-throw failed:', revertErr)
            );
        }
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
export { applyArtifactWrite, CATEGORY_TO_ACTION_TYPE };

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
    faqQuestion?: string | null;
    faqCategory?: string | null;
    faqScope?: string | null;
    faqPropertyId?: string | null;
    beforeText: string | null;
    proposedText: string | null;
    sourceMessageId?: string | null;
  },
  finalText: string | null
): Promise<ApplyOutcome> {
  if (!finalText) return { ok: false, error: 'MISSING_FINAL_TEXT' };

  // TOOL_CONFIG dispatch — use the ToolDefinition update pattern.
  if (suggestion.diagnosticCategory === 'TOOL_CONFIG') {
    // finalText is the new description. Resolve the target tool by exact
    // beforeText match against ToolDefinition.description. We used to fall
    // back to allTools[0] when the match failed — that silently corrupted a
    // random tool's description. Sprint 09 fix 2: return an error so the
    // agent asks the manager to clarify which tool to update.
    const allTools = await c.prisma.toolDefinition.findMany({
      where: { tenantId: c.tenantId },
      select: { id: true, description: true, name: true },
    });
    if (allTools.length === 0) return { ok: false, error: 'NO_TOOL_DEFINITIONS_FOUND' };
    // Sprint 09 follow-up: normalise whitespace/line-endings on both sides so
    // CRLF vs LF drift or trailing newlines don't cause a correct-in-spirit
    // match to miss. Previously a copy-paste through a Windows client would
    // always fail the match and trigger the "Could not identify" error path.
    const normalize = (s: string | null): string =>
      (s ?? '').replace(/\r\n/g, '\n').trim();
    const wanted = normalize(suggestion.beforeText);
    const target = wanted
      ? allTools.find((t) => normalize(t.description) === wanted)
      : undefined;
    if (!target) {
      return {
        ok: false,
        error:
          'Could not identify which tool to update. The beforeText did not match any existing tool description. Ask the manager to clarify which tool they mean.',
      };
    }
    // Mirror the 10-char floor from tool-definition.service#updateToolDefinition.
    // Without this guard the agent can write an unusably short description
    // into the main AI's tool schema.
    if (finalText.trim().length < 10) {
      return {
        ok: false,
        error: 'TOOL_DESCRIPTION_TOO_SHORT: tool descriptions must be at least 10 characters.',
      };
    }
    await c.prisma.toolDefinition.update({
      where: { id: target.id },
      data: { description: finalText },
    });
    // Tool definitions feed the main AI's tool schema via tool-definition.service
    // (5-minute cache). Bust it so the updated description reaches the next
    // main-AI turn immediately. Also bust tenant config cache for symmetry
    // with other apply paths.
    invalidateToolCache(c.tenantId);
    invalidateTenantConfigCache(c.tenantId);
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
      // 'auto' lets the merge service decide replace vs append by length
      // ratio — see system-prompt-merge.service.ts. Aligned with the controller
      // path for consistency.
      const mergedFinalText = mergeSystemPromptClause(
        currentPromptText,
        finalText,
        suggestion.id,
        { mode: 'auto' }
      );
      // Match tenant-config.service.ts validation — tuning writes must
      // respect the same 100-char floor / 50k ceiling as direct edits.
      if (mergedFinalText.length < 100 || mergedFinalText.length > 50000) {
        return {
          ok: false,
          error: `SYSTEM_PROMPT_INVALID_LENGTH:${mergedFinalText.length}`,
        };
      }
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
        // Main AI reads SOP content through a 5-minute cache. Without this
        // the override takes up to 5 minutes to reach the main-AI pipeline,
        // so guests keep seeing pre-edit replies. The non-override branch
        // below already invalidates.
        invalidateSopCache(c.tenantId);
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
      // Bust the SOP cache so the main AI picks up the new content on the
      // next turn, not after the 5-minute TTL expires.
      invalidateSopCache(c.tenantId);
      return {
        ok: true,
        target: { kind: 'sop_variant', id: targetId },
        appliedPayload: { text: finalText, sopStatus: suggestion.sopStatus },
      };
    }

    case 'EDIT_SOP_ROUTING': {
      if (!suggestion.sopCategory) return { ok: false, error: 'MISSING_SOP_CATEGORY' };
      const trimmedRoute = finalText.trim();
      if (trimmedRoute.length < 10 || trimmedRoute.length > 2000) {
        return {
          ok: false,
          error: `SOP_TOOL_DESCRIPTION_INVALID_LENGTH:${trimmedRoute.length}`,
        };
      }
      const sopDef = await c.prisma.sopDefinition.findFirst({
        where: { tenantId: c.tenantId, category: suggestion.sopCategory },
        select: { id: true },
      });
      if (!sopDef) return { ok: false, error: 'SOP_DEFINITION_NOT_FOUND' };
      await c.prisma.sopDefinition.update({
        where: { id: sopDef.id },
        data: { toolDescription: finalText },
      });
      invalidateSopCache(c.tenantId);
      return {
        ok: true,
        target: { kind: 'sop_routing', id: sopDef.id },
        appliedPayload: { text: finalText },
      };
    }

    case 'EDIT_FAQ': {
      // Hotfix (shares resolver with tuning-suggestion.controller.ts): the
      // diagnostic pipeline writes FAQ suggestions with actionType=EDIT_FAQ
      // and a null faqEntryId when the fix is "there should be an FAQ
      // entry for this topic" (new-entry case). Promote to create rather
      // than failing. Same precedence order as the HTTP endpoint so a
      // single suggestion dedups to the same FAQ row regardless of which
      // apply surface the manager used.
      if (!suggestion.faqEntryId) {
        const resolved = await resolveFaqAutoCreateFields(c.prisma, c.tenantId, {
          overrides: {},
          // Thread all persisted FAQ fields through so the agent path
          // resolves the same `finalQuestion` / category / scope as the
          // HTTP endpoint. Previously these were passed as null, which
          // meant the two surfaces could produce different dedup keys
          // and create duplicate FAQ entries from a single suggestion.
          suggestion: {
            sourceMessageId: suggestion.sourceMessageId ?? null,
            beforeText: suggestion.beforeText,
            faqQuestion: suggestion.faqQuestion ?? null,
            faqCategory: suggestion.faqCategory ?? null,
            faqScope: suggestion.faqScope ?? null,
            faqPropertyId: suggestion.faqPropertyId ?? null,
          },
        });
        let createdId: string;
        let wasCreated: boolean;
        const duplicate = await findDuplicateFaqEntry(c.prisma, {
          tenantId: c.tenantId,
          question: resolved.finalQuestion,
          propertyId: resolved.finalPropertyId,
        });
        if (duplicate) {
          await c.prisma.faqEntry.update({
            where: { id: duplicate.id },
            data: { answer: finalText, status: 'ACTIVE' as any },
          });
          createdId = duplicate.id;
          wasCreated = false;
        } else {
          try {
            const entry = await c.prisma.faqEntry.create({
              data: {
                tenantId: c.tenantId,
                question: resolved.finalQuestion,
                answer: finalText,
                category: resolved.finalCategory,
                scope: resolved.finalScope as any,
                propertyId: resolved.finalPropertyId,
                status: 'ACTIVE' as any,
                source: 'MANUAL',
              },
            });
            createdId = entry.id;
            wasCreated = true;
          } catch (err: any) {
            if (err?.code === 'P2002') {
              const now = await findDuplicateFaqEntry(c.prisma, {
                tenantId: c.tenantId,
                question: resolved.finalQuestion,
                propertyId: resolved.finalPropertyId,
              });
              if (!now) throw err;
              await c.prisma.faqEntry.update({
                where: { id: now.id },
                data: { answer: finalText, status: 'ACTIVE' as any },
              });
              createdId = now.id;
              wasCreated = false;
            } else {
              throw err;
            }
          }
        }
        return {
          ok: true,
          target: { kind: 'faq_entry_new', id: createdId },
          appliedPayload: {
            question: resolved.finalQuestion,
            answer: finalText,
            category: resolved.finalCategory,
            scope: resolved.finalScope,
            propertyId: resolved.finalPropertyId,
            created: wasCreated,
            questionSource: resolved.sourceHint,
            scopeSource: resolved.scopeSource,
          },
        };
      }
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

/**
 * Sprint 10 workstream A.2 follow-up: the same validator the PostToolUse
 * hook runs on propose_suggestion, reused here so `suggestion_action({draft})`
 * cannot bypass validation by skipping propose_suggestion entirely. Keep
 * the rules in sync with hooks/post-tool-use.ts#validateProposeSuggestion.
 */
function validateDraftForApply(args: {
  category: string;
  editFormat: 'search_replace' | 'full_replacement';
  proposedText: string | null;
  oldText: string | null;
  newText: string | null;
  beforeText: string | null;
}): string | null {
  if (args.category === 'NO_FIX' || args.category === 'MISSING_CAPABILITY') {
    if (args.proposedText || args.oldText || args.newText) {
      return `${args.category} must have proposedText/oldText/newText all null`;
    }
    return null;
  }
  if (args.editFormat === 'search_replace') {
    if (!args.oldText || !args.newText) {
      return 'editFormat=search_replace requires both oldText and newText (non-empty)';
    }
    if (args.oldText === args.newText) {
      return 'editFormat=search_replace requires oldText !== newText';
    }
  } else {
    if (!args.proposedText || args.proposedText.length === 0) {
      return 'editFormat=full_replacement requires a non-empty proposedText';
    }
  }
  const textToCheck =
    args.editFormat === 'search_replace' ? args.newText ?? '' : args.proposedText ?? '';
  const elision = detectElisionMarker(textToCheck);
  if (elision) {
    return `proposed text contains an elision marker (${elision}). Include the complete text, not a placeholder.`;
  }
  return null;
}

/**
 * Sprint 10 workstream A: resolve the current artifact text for a draft so we
 * can apply a search_replace edit format. Returns null when the draft's target
 * fields are insufficient or the target row doesn't exist. Intentionally
 * narrow — only the fields covered by applyArtifactWrite above are supported.
 */
async function resolveCurrentArtifactText(
  c: ToolContext,
  draft: {
    category: string;
    sopCategory?: string;
    sopStatus?: string;
    sopPropertyId?: string;
    systemPromptVariant?: string;
    faqEntryId?: string;
    beforeText?: string;
  }
): Promise<string | null> {
  if (draft.category === 'SYSTEM_PROMPT') {
    if (!draft.systemPromptVariant) return null;
    const variantField = draft.systemPromptVariant.toLowerCase().includes('coord')
      ? 'systemPromptCoordinator'
      : 'systemPromptScreening';
    const current = await c.prisma.tenantAiConfig.findUnique({ where: { tenantId: c.tenantId } });
    const text = ((current as any)?.[variantField] as string | null) ?? '';
    return text || null;
  }
  if (draft.category === 'SOP_CONTENT' || draft.category === 'PROPERTY_OVERRIDE') {
    if (!draft.sopCategory || !draft.sopStatus) return null;
    const sopDef = await c.prisma.sopDefinition.findFirst({
      where: { tenantId: c.tenantId, category: draft.sopCategory },
      select: { id: true },
    });
    if (!sopDef) return null;
    if (draft.sopPropertyId) {
      const override = await c.prisma.sopPropertyOverride.findUnique({
        where: {
          sopDefinitionId_propertyId_status: {
            sopDefinitionId: sopDef.id,
            propertyId: draft.sopPropertyId,
            status: draft.sopStatus,
          },
        },
        select: { content: true },
      });
      if (override) return override.content;
    }
    const variant = await c.prisma.sopVariant.findFirst({
      where: { sopDefinitionId: sopDef.id, status: draft.sopStatus },
      select: { content: true },
    });
    return variant?.content ?? null;
  }
  if (draft.category === 'SOP_ROUTING') {
    if (!draft.sopCategory) return null;
    const sopDef = await c.prisma.sopDefinition.findFirst({
      where: { tenantId: c.tenantId, category: draft.sopCategory },
      select: { toolDescription: true },
    });
    return sopDef?.toolDescription ?? null;
  }
  if (draft.category === 'FAQ') {
    if (!draft.faqEntryId) return null;
    const faq = await c.prisma.faqEntry.findFirst({
      where: { id: draft.faqEntryId, tenantId: c.tenantId },
      select: { question: true, answer: true },
    });
    if (!faq) return null;
    // The apply path decides question-vs-answer by matching beforeText against
    // the current question. Mirror that here so search_replace operates on the
    // same field the apply path will write.
    if (draft.beforeText && draft.beforeText.trim() === faq.question.trim()) {
      return faq.question;
    }
    return faq.answer;
  }
  if (draft.category === 'TOOL_CONFIG') {
    if (!draft.beforeText) return null;
    const normalize = (s: string | null): string => (s ?? '').replace(/\r\n/g, '\n').trim();
    const wanted = normalize(draft.beforeText);
    const tools = await c.prisma.toolDefinition.findMany({
      where: { tenantId: c.tenantId },
      select: { description: true },
    });
    const match = tools.find((t) => normalize(t.description) === wanted);
    return match?.description ?? null;
  }
  return null;
}

// ─── Sprint 047 Session A — controller-facing helper ──────────────────────
//
// The Studio `/api/build/suggested-fix/:fixId/accept` endpoint needs to
// apply an artifact change directly when the click targets an ephemeral
// `preview:*` id (no TuningSuggestion row exists yet). The manager's
// button press IS the compliance signal — we bypass the PreToolUse
// compliance hook by calling the write path directly, but we still
// persist a TuningSuggestion row with `status: 'ACCEPTED'` so the
// recent-edit / oscillation hooks have a history entry to detect
// against, and so admin-only trace views can reconstruct the accept.

type UiFixCategory =
  | 'SOP_CONTENT'
  | 'SOP_ROUTING'
  | 'FAQ'
  | 'SYSTEM_PROMPT'
  | 'TOOL_CONFIG'
  | 'PROPERTY_OVERRIDE';

export interface ApplyFromUiInput {
  prisma: PrismaClient;
  tenantId: string;
  userId: string | null;
  conversationId: string;
  /** The `preview:*` id the agent emitted alongside the data-suggested-fix card. */
  previewId: string;
  /** Manager's last turn text — unused today, captured for audit trails. */
  sanctionedBy: 'ui';
  category: UiFixCategory;
  subLabel?: string;
  rationale: string;
  before: string;
  after: string;
  target: {
    sopCategory?: string;
    sopStatus?: 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN';
    sopPropertyId?: string;
    faqEntryId?: string;
    systemPromptVariant?: 'coordinator' | 'screening';
  };
}

export interface ApplyFromUiResult {
  suggestionId: string;
  appliedAt: Date;
  alreadyApplied: boolean;
  target?: { kind: string; id: string };
}

/**
 * Applies a Studio suggested-fix (ephemeral `preview:*` id) and records
 * an ACCEPTED TuningSuggestion row so history hooks can see it. Returns
 * early if a prior accept for the same `previewId` already landed
 * (idempotency per sprint-047 Session A non-negotiable §6).
 */
/**
 * Bugfix (2026-04-22): TOCTOU race protection for double-click /
 * flaky-network re-clicks of the same preview-id.
 *
 * Layer 1 — process-level single-flight Map.
 *   Two concurrent calls to applyArtifactChangeFromUi with the same
 *   `${tenantId}:${previewId}` key collapse onto the SAME promise.
 *   Single-instance dedupe; not cross-instance. The DB-level idempotency
 *   check below covers cross-instance for already-completed work.
 *
 * Layer 2 — `appliedPayload.previewId` stamped at create-time (was
 *   stamped after the artifact write completed). The findFirst
 *   idempotency check now sees the stamp as soon as the create row
 *   commits, narrowing the race window from "duration of the artifact
 *   write" to "duration of the create round-trip."
 *
 * Layer 3 — proper fix (deferred): partial unique index on
 *   `(tenantId, (appliedPayload->>'previewId'))` as a
 *   `prisma db push`-safe schema change. Tracked in
 *   DEFERRED_BUGS_2026_04_22.md.
 */
const _applyInFlight = new Map<string, Promise<ApplyFromUiResult>>();

export async function applyArtifactChangeFromUi(
  input: ApplyFromUiInput
): Promise<ApplyFromUiResult> {
  const dedupeKey = `${input.tenantId}:${input.previewId}`;
  const existing = _applyInFlight.get(dedupeKey);
  if (existing) return existing;
  const p = _applyArtifactChangeFromUiCore(input).finally(() => {
    _applyInFlight.delete(dedupeKey);
  });
  _applyInFlight.set(dedupeKey, p);
  return p;
}

async function _applyArtifactChangeFromUiCore(
  input: ApplyFromUiInput
): Promise<ApplyFromUiResult> {
  const { prisma, tenantId, userId, conversationId, previewId } = input;

  // Idempotency — re-click after flaky network must not double-apply. We
  // look up any TuningSuggestion row whose appliedPayload carries this
  // previewId. Postgres JSONB supports this via Prisma's `path` filter.
  const prior = await prisma.tuningSuggestion.findFirst({
    where: {
      tenantId,
      status: 'ACCEPTED',
      appliedPayload: { path: ['previewId'], equals: previewId } as any,
    },
    select: { id: true, appliedAt: true, appliedPayload: true },
  });
  if (prior && prior.appliedAt) {
    const pp = (prior.appliedPayload ?? {}) as any;
    const target = pp?.target as { kind: string; id: string } | undefined;
    return {
      suggestionId: prior.id,
      appliedAt: prior.appliedAt,
      alreadyApplied: true,
      target,
    };
  }

  const actionType = CATEGORY_TO_ACTION_TYPE[input.category] ?? 'EDIT_SYSTEM_PROMPT';
  const created = await prisma.tuningSuggestion.create({
    data: {
      tenantId,
      // sourceMessageId is nullable from sprint-047 Session A onwards —
      // Studio accepts have no inbox-message anchor.
      sourceMessageId: null,
      actionType,
      status: 'ACCEPTED',
      rationale: input.rationale,
      beforeText: input.before || null,
      proposedText: input.after || null,
      sopCategory: input.target.sopCategory ?? null,
      sopStatus: input.target.sopStatus ?? null,
      sopPropertyId: input.target.sopPropertyId ?? null,
      systemPromptVariant: input.target.systemPromptVariant ?? null,
      faqEntryId: input.target.faqEntryId ?? null,
      diagnosticCategory: input.category as TuningDiagnosticCategory,
      diagnosticSubLabel: input.subLabel ?? null,
      conversationId,
      appliedAt: new Date(),
      appliedByUserId: userId,
      applyMode: 'IMMEDIATE',
      // 2026-04-22 bugfix: stamp previewId at create-time (Layer 2 of
      // the TOCTOU defence). Was stamped only AFTER the artifact write
      // completed via a follow-up update — that left a wide race
      // window where two concurrent finders both saw `prior === null`.
      // Stamping here means the second click's `findFirst` above will
      // see the first click's row as soon as the create commits, even
      // before the artifact write returns.
      appliedPayload: { previewId, sanctionedBy: input.sanctionedBy } as Prisma.InputJsonValue,
    },
    select: { id: true, appliedAt: true },
  });

  const outcome = await applyArtifactWrite(
    {
      prisma,
      tenantId,
      userId,
      conversationId,
      lastUserSanctionedApply: true,
    },
    {
      id: created.id,
      actionType,
      diagnosticCategory: input.category as TuningDiagnosticCategory,
      systemPromptVariant: input.target.systemPromptVariant ?? null,
      sopCategory: input.target.sopCategory ?? null,
      sopStatus: input.target.sopStatus ?? null,
      sopPropertyId: input.target.sopPropertyId ?? null,
      sopToolDescription: null,
      faqEntryId: input.target.faqEntryId ?? null,
      faqQuestion: null,
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
      beforeText: input.before || null,
      proposedText: input.after || null,
      sourceMessageId: null,
    },
    input.after
  );

  if (!outcome.ok) {
    // Revert the ACCEPTED row so the manager can retry without a stale
    // history entry blocking the recent-edit advisory.
    await prisma.tuningSuggestion
      .delete({ where: { id: created.id } })
      .catch((err) =>
        console.warn('[applyArtifactChangeFromUi] cleanup failed:', err)
      );
    throw new Error(outcome.error ?? 'ARTIFACT_WRITE_FAILED');
  }

  const appliedPayload: Record<string, unknown> = {
    ...(outcome.appliedPayload ?? {}),
    previewId,
    sanctionedBy: input.sanctionedBy,
    target: outcome.target,
  };
  await prisma.tuningSuggestion.update({
    where: { id: created.id },
    data: { appliedPayload: appliedPayload as Prisma.InputJsonValue },
  });

  return {
    suggestionId: created.id,
    appliedAt: created.appliedAt!,
    alreadyApplied: false,
    target: outcome.target,
  };
}
