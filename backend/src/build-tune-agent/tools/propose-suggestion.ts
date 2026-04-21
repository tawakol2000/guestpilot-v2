/**
 * propose_suggestion — stage a TuningSuggestion WITHOUT writing it.
 *
 * The row is not persisted. Instead, we:
 *   1. emit a `data-suggested-fix` part to the client with the diff
 *      and proposed change, so the manager sees the card inline
 *   2. return a summary to the agent with a client-generated preview id
 *
 * When the manager sanctions "apply"/"queue", the agent calls
 * suggestion_action with the previewId (or with a separately-persisted id
 * if a PENDING row was created via suggestion_action too).
 *
 * Sprint 046 Session D — session-scoped rejection memory guard. Before
 * emitting, the tool hashes (artifactId, sectionId||slotKey, category:subLabel)
 * and skips the emit when that hash already lives under
 * `session/{conversationId}/rejected/` in AgentMemory.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  DATA_PART_TYPES,
  type FixTarget,
  type SuggestedFixData,
} from '../data-parts';
import {
  computeRejectionFixHash,
  listRejectionHashes,
  lookupCrossSessionRejection,
  type RejectionIntent,
} from '../memory/service';
import { asCallToolResult, asError, type ToolContext } from './types';

/**
 * Derive the (artifactId, sectionOrSlotKey, semanticIntent) triple that
 * hashes into the rejection-memory key. `semanticIntent` is a short
 * category+subLabel fingerprint — stable across minor rephrasings of the
 * rationale but distinct across different intents on the same artifact.
 */
export function deriveRejectionIntent(args: {
  category: string;
  subLabel: string;
  target: FixTarget;
}): RejectionIntent {
  const artifactId = args.target.artifactId ?? '';
  const sectionOrSlot = args.target.sectionId ?? args.target.slotKey ?? '';
  const semanticIntent = `${args.category}:${args.subLabel}`;
  return {
    artifactId,
    sectionOrSlotKey: sectionOrSlot,
    semanticIntent,
  };
}

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
        sopStatus?: 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN';
        sopPropertyId?: string;
        faqEntryId?: string;
        systemPromptVariant?: 'coordinator' | 'screening';
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
  // Sprint 047 Session A — carry every hint field through to FixTarget so
  // the Studio accept-on-preview path has enough context to dispatch the
  // write without re-asking the agent. Still set the primary `artifact`
  // + `sectionId` / `artifactId` so the card chip stays legible.
  const base: FixTarget = {
    sopCategory: hint.sopCategory,
    sopStatus: hint.sopStatus,
    sopPropertyId: hint.sopPropertyId,
    faqEntryId: hint.faqEntryId,
    systemPromptVariant: hint.systemPromptVariant,
  };
  if (hint.systemPromptVariant) return { ...base, artifact: 'system_prompt', sectionId: hint.systemPromptVariant };
  if (hint.faqEntryId) return { ...base, artifact: 'faq', artifactId: hint.faqEntryId };
  if (hint.toolDefinitionId) return { ...base, artifact: 'tool_definition', artifactId: hint.toolDefinitionId };
  if (hint.sopPropertyId) return { ...base, artifact: 'property_override', artifactId: hint.sopPropertyId };
  if (hint.sopCategory || hint.sopStatus) return { ...base, artifact: 'sop' };
  return base;
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

        const derivedTarget: FixTarget = args.target ?? deriveTargetFromHint(args.category, args.targetHint);

        // Sprint 046 Session D — session-scoped rejection memory guard.
        // Before emitting the card, compute the fix hash and skip the
        // emit if the manager has already rejected a semantically-
        // equivalent fix in this conversation (per plan §4.4).
        //
        // Sprint 047 Session C — cross-session rejection memory. After
        // the session-scoped check, look up (tenantId, artifact,
        // fixHash) in RejectionMemory. A live hit means the manager
        // hated this fix in a past conversation; we skip the emit and
        // return the captured rationale so the agent can adjust its
        // next proposal. Missing memory ≠ no-suggestion (NEXT.md §3):
        // any lookup error falls through to the emit.
        const intent = deriveRejectionIntent({
          category: args.category,
          subLabel: args.subLabel,
          target: derivedTarget,
        });
        const fixHash = computeRejectionFixHash(intent);
        const artifactType = derivedTarget.artifact ?? '';

        if (c.conversationId) {
          try {
            const rejected = await listRejectionHashes(
              c.prisma,
              c.tenantId,
              c.conversationId
            );
            if (rejected.has(fixHash)) {
              const skipPayload = {
                previewId,
                category: args.category,
                editFormat,
                status: 'SKIPPED_REJECTED',
                hint: 'Fix was previously rejected in this session; rephrase or propose a different target.',
              };
              span.end({ ...skipPayload, skippedDueToRejection: true });
              return asCallToolResult(skipPayload);
            }
          } catch (err) {
            console.warn(
              '[propose_suggestion] rejection-memory lookup failed:',
              err
            );
          }
        }

        try {
          const prior = await lookupCrossSessionRejection(
            c.prisma,
            c.tenantId,
            artifactType,
            fixHash
          );
          if (prior) {
            const skipPayload = {
              previewId,
              category: args.category,
              editFormat,
              status: 'SKIPPED_PRIOR_REJECTION',
              priorRejection: {
                rejectedAt: prior.rejectedAt,
                expiresAt: prior.expiresAt,
                sourceConversationId: prior.sourceConversationId,
                rationale: prior.rationale,
                category: prior.category,
                subLabel: prior.subLabel,
              },
              hint: prior.rationale
                ? `Manager previously rejected this fix (${prior.rejectedAt}): "${prior.rationale}". Rephrase, retarget, or pick a different intent.`
                : `Manager previously rejected this fix (${prior.rejectedAt}). No rationale was captured — treat as a weak signal, but avoid re-proposing the exact same intent without new context.`,
            };
            span.end({ ...skipPayload, skippedDueToCrossSessionRejection: true });
            return asCallToolResult(skipPayload);
          }
        } catch (err) {
          console.warn(
            '[propose_suggestion] cross-session rejection lookup failed:',
            err
          );
        }

        if (c.emitDataPart) {
          // Sprint 046 Session D — retired legacy `data-suggestion-preview`
          // emission (was a dual-emit alongside data-suggested-fix during
          // sprint 046 sessions B and C). Studio is the only consumer now.

          // Sprint 046 Session B — canonical data-suggested-fix shape
          // consumed by the Studio suggested-fix card. Derivation rules:
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
