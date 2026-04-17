/**
 * Feature 040: Copilot Shadow Mode — Tuning Suggestion CRUD.
 *
 *   GET    /api/tuning-suggestions           — list pending/accepted/rejected/all
 *   POST   /api/tuning-suggestions/:id/accept — apply the change to the target artifact
 *   POST   /api/tuning-suggestions/:id/reject — mark rejected, no artifact changes
 *
 * Per-action-type Accept dispatch writes directly to system prompts, SOP
 * content/variants/overrides, SOP classifier routing, or FAQ entries — reusing
 * existing Prisma tables (no extra service layer needed for a short-lived
 * diagnostic feature).
 *
 * The CREATE_FAQ accept path writes `source: 'MANUAL'` per constitution §VIII
 * — tuning-accepted entries are not "auto-suggested" in the Principle VIII
 * sense because the admin explicitly approved via the Tuning tab.
 */
import { Response } from 'express';
import { PrismaClient, TuningActionType, TuningSuggestionStatus } from '@prisma/client';

// Sprint 09 fix 8: raised inside the accept dispatch when a required field is
// missing. The outer handler catches, reverts the status claim back to
// PENDING, and responds 400. Using an error class avoids forcing every
// dispatch branch to thread a revert-and-return helper through.
class RequiredFieldsError extends Error {
  code = 'MISSING_REQUIRED_FIELDS';
  constructor() {
    super('MISSING_REQUIRED_FIELDS');
  }
}
class NotFoundError extends Error {
  readonly httpCode: string;
  readonly detail?: string;
  constructor(code: string, detail?: string) {
    super(code);
    this.httpCode = code;
    this.detail = detail;
  }
}
import { AuthenticatedRequest } from '../types';
import { broadcastCritical } from '../services/socket.service';
import { invalidateTenantConfigCache } from '../services/tenant-config.service';
import { invalidateSopCache } from '../services/sop.service';
import {
  findDuplicateFaqEntry,
  resolveFaqAutoCreateFields,
} from '../services/tuning/faq-auto-create';
import {
  updateCategoryStatsOnAccept,
  updateCategoryStatsOnReject,
} from '../services/tuning/category-stats.service';
import { recordPreferencePair } from '../services/tuning/preference-pair.service';
import { mergeSystemPromptClause } from '../services/tuning/system-prompt-merge.service';
import {
  snapshotFaqEntry,
  snapshotSopVariant,
} from '../services/tuning/artifact-history.service';

export function makeTuningSuggestionController(prisma: PrismaClient) {
  return {
    // ─── GET /api/tuning-suggestions ──────────────────────────────────────
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
        const limitParam = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
        const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

        const where: any = { tenantId };
        if (statusParam !== 'ALL') {
          // Sprint 08 §5: AUTO_SUPPRESSED is a valid filter value (for the
          // "Show suppressed" toggle), not just PENDING/ACCEPTED/REJECTED.
          const validStatuses: TuningSuggestionStatus[] = [
            'PENDING',
            'ACCEPTED',
            'REJECTED',
            'AUTO_SUPPRESSED',
          ];
          if (validStatuses.includes(statusParam as TuningSuggestionStatus)) {
            where.status = statusParam;
          }
        } else {
          // `status=ALL` previously returned every row. Sprint 08 §5: hide
          // AUTO_SUPPRESSED from the default "all" view — the dedicated
          // toggle/filter is the only way they surface in the UI.
          where.status = { notIn: ['AUTO_SUPPRESSED'] };
        }

        const rows = await prisma.tuningSuggestion.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limitParam + 1,
          ...(cursorParam ? { cursor: { id: cursorParam }, skip: 1 } : {}),
          include: {
            sourceMessage: { select: { conversationId: true } },
          },
        });

        const hasMore = rows.length > limitParam;
        const page = hasMore ? rows.slice(0, limitParam) : rows;

        res.json({
          suggestions: page.map(s => ({
            id: s.id,
            status: s.status,
            actionType: s.actionType,
            rationale: s.rationale,
            beforeText: s.beforeText,
            proposedText: s.proposedText,
            systemPromptVariant: s.systemPromptVariant,
            sopCategory: s.sopCategory,
            sopStatus: s.sopStatus,
            sopPropertyId: s.sopPropertyId,
            sopToolDescription: s.sopToolDescription,
            faqEntryId: s.faqEntryId,
            faqCategory: s.faqCategory,
            faqScope: s.faqScope,
            faqPropertyId: s.faqPropertyId,
            faqQuestion: s.faqQuestion,
            faqAnswer: s.faqAnswer,
            sourceMessageId: s.sourceMessageId,
            sourceConversationId: s.sourceMessage?.conversationId ?? null,
            appliedPayload: s.appliedPayload,
            appliedAt: s.appliedAt,
            createdAt: s.createdAt,
            // ─── Feature 041 sprint 02/03 extensions (nullable on legacy rows) ───
            diagnosticCategory: s.diagnosticCategory,
            diagnosticSubLabel: s.diagnosticSubLabel,
            confidence: s.confidence,
            triggerType: s.triggerType,
            evidenceBundleId: s.evidenceBundleId,
            applyMode: s.applyMode,
          })),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        });
      } catch (err) {
        console.error('[tuning-suggestion] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    // ─── POST /api/tuning-suggestions/:id/accept ──────────────────────────
    async accept(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const { id } = req.params;
      const userId = (req as any).userId ?? null;

      // Sprint 09 fix 8 + fix 9: atomic status claim.
      //
      // fix 8 (race): Two concurrent accepts both read PENDING, both apply
      //   the artifact, both flip to ACCEPTED. Double-applied artifacts
      //   can concatenate system prompts (mergeSystemPromptClause appends)
      //   or double-bump version counters. The `updateMany` below uses
      //   Postgres's row-level lock on UPDATE — equivalent to
      //   SELECT FOR UPDATE in this context — to serialise the two
      //   concurrent calls. Whichever request reaches the UPDATE first
      //   commits the status flip; the second re-evaluates the WHERE
      //   clause on the committed state and matches 0 rows → 409.
      // fix 9 (AUTO_SUPPRESSED stuck): Sprint 08 §5 wrote AUTO_SUPPRESSED
      //   rows for gated categories; the old gate only accepted PENDING,
      //   leaving these rows unresolvable. Including AUTO_SUPPRESSED in
      //   the claim lets the manager accept them explicitly.
      //
      // If the artifact write fails after the claim, we revert the status
      // in the catch block so a retry can still succeed.
      let claimed = false;
      try {
        const claim = await prisma.tuningSuggestion.updateMany({
          where: { id, tenantId, status: { in: ['PENDING', 'AUTO_SUPPRESSED'] } },
          data: { status: 'ACCEPTED', appliedAt: new Date(), appliedByUserId: userId },
        });
        if (claim.count === 0) {
          const exists = await prisma.tuningSuggestion.findFirst({
            where: { id, tenantId },
            select: { id: true },
          });
          if (!exists) {
            res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
            return;
          }
          res.status(409).json({ error: 'SUGGESTION_NOT_PENDING' });
          return;
        }
        claimed = true;
        const suggestion = await prisma.tuningSuggestion.findFirst({ where: { id, tenantId } });
        if (!suggestion) {
          // Race: deleted between claim and read. Unlikely but handle it.
          res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
          return;
        }

        const body = req.body || {};
        let appliedPayload: Record<string, unknown> = {};
        let targetUpdated: { kind: string; id: string } = { kind: 'unknown', id: '' };

        switch (suggestion.actionType) {
          case TuningActionType.EDIT_SYSTEM_PROMPT: {
            const proposedText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.proposedText;
            if (!proposedText || !suggestion.systemPromptVariant) {
              throw new RequiredFieldsError();
            }
            // Hotfix — until the recent fix this branch wrote `proposedText`
            // directly into the variant field, OVERWRITING the entire system
            // prompt with the new clause and wiping ~5,000 chars of existing
            // rules. The diagnostic produces a clause to add, not a complete
            // prompt. `mergeSystemPromptClause` appends the clause inside
            // marker comments tagged with the suggestion id so re-apply is
            // idempotent and the inserted block is locatable for later edits.
            // Callers can opt into the legacy replace semantics via
            // body.applyMode === 'replace' for the rare case where the
            // manager hand-edited the proposed text into a complete prompt.
            // `coordinator` / `screening` are the canonical variant names;
            // the diagnostic occasionally returns capitalized variants
            // (e.g. 'SystemPromptScreening'), so we sniff defensively.
            const variantLower = suggestion.systemPromptVariant.toLowerCase();
            const variantField =
              variantLower.includes('coord')
                ? 'systemPromptCoordinator'
                : 'systemPromptScreening';
            const current = await prisma.tenantAiConfig.findUnique({ where: { tenantId } });
            const currentPromptText = ((current as any)?.[variantField] as string | null) ?? '';
            // 'auto' picks replace vs append by length ratio. Diagnostic
            // post-hotfix produces a complete revised prompt → replace; old
            // fragment-style suggestions still in the queue → append, so they
            // don't wipe the prompt. Manager can force either via body.applyMode.
            const mergeMode: 'append' | 'replace' | 'auto' =
              body && body.applyMode === 'replace'
                ? 'replace'
                : body && body.applyMode === 'append'
                  ? 'append'
                  : 'auto';
            const finalText = mergeSystemPromptClause(
              currentPromptText,
              proposedText,
              suggestion.id,
              { mode: mergeMode }
            );
            const history = Array.isArray(current?.systemPromptHistory)
              ? [...((current!.systemPromptHistory as any[]) || [])]
              : [];
            // Snapshot under canonical key (coordinator/screening) so the
            // rollback path can locate the prior content reliably.
            const snapshotVariantKey =
              variantField === 'systemPromptCoordinator' ? 'coordinator' : 'screening';
            history.push({
              version: current?.systemPromptVersion ?? 1,
              timestamp: new Date().toISOString(),
              [snapshotVariantKey]: currentPromptText,
              note: `Tuning suggestion ${suggestion.id} accepted`,
            });
            while (history.length > 10) history.shift();

            await prisma.tenantAiConfig.update({
              where: { tenantId },
              data: {
                [variantField]: finalText,
                systemPromptVersion: { increment: 1 },
                systemPromptHistory: history,
              },
            });
            invalidateTenantConfigCache(tenantId);
            appliedPayload = { text: finalText, mode: mergeMode };
            targetUpdated = { kind: 'system_prompt', id: suggestion.systemPromptVariant };
            break;
          }

          case TuningActionType.EDIT_SOP_CONTENT: {
            const finalText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.proposedText;
            // Feature 041 sprint 03: sprint-02 diagnostic leaves sopStatus /
            // sopPropertyId null for new-pipeline rows. Accept body can supply
            // them from the manager's dispatch dialog; fall back to persisted.
            const effectiveSopStatus: string | null =
              (typeof body.sopStatus === 'string' && body.sopStatus) ? body.sopStatus : suggestion.sopStatus;
            const effectiveSopPropertyId: string | null =
              typeof body.sopPropertyId === 'string' && body.sopPropertyId
                ? body.sopPropertyId
                : suggestion.sopPropertyId;
            if (!finalText || !suggestion.sopCategory || !effectiveSopStatus) {
              throw new RequiredFieldsError();
            }
            // Resolve the SopDefinition first — both variants and property overrides hang off it.
            const sopDef = await prisma.sopDefinition.findFirst({
              where: { tenantId, category: suggestion.sopCategory },
              select: { id: true },
            });
            if (!sopDef) {
              throw new NotFoundError('SOP_DEFINITION_NOT_FOUND');
            }
            if (effectiveSopPropertyId) {
              // Snapshot the prior content so a rollback can restore it (sprint 05 §2 / C17).
              const prior = await prisma.sopPropertyOverride.findUnique({
                where: {
                  sopDefinitionId_propertyId_status: {
                    sopDefinitionId: sopDef.id,
                    propertyId: effectiveSopPropertyId,
                    status: effectiveSopStatus,
                  },
                },
                select: { id: true, content: true },
              });
              if (prior) {
                await snapshotSopVariant(prisma, {
                  tenantId,
                  targetId: prior.id,
                  kind: 'override',
                  sopDefinitionId: sopDef.id,
                  status: effectiveSopStatus,
                  content: prior.content,
                  propertyId: effectiveSopPropertyId,
                  editedByUserId: userId,
                  triggeringSuggestionId: suggestion.id,
                });
              }
              // Update or create the property override at (sopDefinitionId, propertyId, status).
              const override = await prisma.sopPropertyOverride.upsert({
                where: {
                  sopDefinitionId_propertyId_status: {
                    sopDefinitionId: sopDef.id,
                    propertyId: effectiveSopPropertyId,
                    status: effectiveSopStatus,
                  },
                },
                update: { content: finalText },
                create: {
                  sopDefinitionId: sopDef.id,
                  propertyId: effectiveSopPropertyId,
                  status: effectiveSopStatus,
                  content: finalText,
                },
              });
              targetUpdated = { kind: 'sop_property_override', id: override.id };
            } else {
              const variant = await prisma.sopVariant.findFirst({
                where: { sopDefinitionId: sopDef.id, status: effectiveSopStatus },
                select: { id: true, content: true },
              });
              if (!variant) {
                // Create on demand — preserves the create-SOP-variant affordance
                // when the manager picks a status that doesn't have a variant yet.
                const created = await prisma.sopVariant.create({
                  data: {
                    sopDefinitionId: sopDef.id,
                    status: effectiveSopStatus,
                    content: finalText,
                  },
                });
                targetUpdated = { kind: 'sop_variant', id: created.id };
              } else {
                await snapshotSopVariant(prisma, {
                  tenantId,
                  targetId: variant.id,
                  kind: 'variant',
                  sopDefinitionId: sopDef.id,
                  status: effectiveSopStatus,
                  content: variant.content,
                  editedByUserId: userId,
                  triggeringSuggestionId: suggestion.id,
                });
                await prisma.sopVariant.update({
                  where: { id: variant.id },
                  data: { content: finalText },
                });
                targetUpdated = { kind: 'sop_variant', id: variant.id };
              }
            }
            appliedPayload = {
              text: finalText,
              sopStatus: effectiveSopStatus,
              sopPropertyId: effectiveSopPropertyId ?? null,
            };
            invalidateSopCache(tenantId);
            break;
          }

          case TuningActionType.EDIT_SOP_ROUTING: {
            const finalText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.sopToolDescription;
            if (!finalText || !suggestion.sopCategory) {
              throw new RequiredFieldsError();
            }
            const sopDef = await prisma.sopDefinition.findFirst({
              where: { tenantId, category: suggestion.sopCategory },
              select: { id: true },
            });
            if (!sopDef) {
              throw new NotFoundError('SOP_DEFINITION_NOT_FOUND');
            }
            await prisma.sopDefinition.update({
              where: { id: sopDef.id },
              data: { toolDescription: finalText },
            });
            invalidateSopCache(tenantId);
            appliedPayload = { text: finalText };
            targetUpdated = { kind: 'sop_routing', id: sopDef.id };
            break;
          }

          case TuningActionType.EDIT_FAQ: {
            const finalText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.proposedText;
            if (!finalText) {
              throw new RequiredFieldsError();
            }
            // Hotfix — the diagnostic pipeline writes FAQ suggestions with
            // actionType=EDIT_FAQ and a null faqEntryId when the fix is
            // "there should be an FAQ entry for this topic" (new-entry
            // case). Prior code rejected these with MISSING_REQUIRED_FIELDS
            // even though the UI displays "Apply will create it." Auto-
            // promote to a create path, sharing precedence resolution with
            // the agent's suggestion_action tool so the same suggestion
            // dedups to the same FAQ row regardless of which apply surface
            // the manager used.
            if (!suggestion.faqEntryId) {
              const resolved = await resolveFaqAutoCreateFields(prisma, tenantId, {
                overrides: {
                  editedQuestion:
                    typeof body.editedQuestion === 'string' ? body.editedQuestion : null,
                  faqCategory:
                    typeof body.faqCategory === 'string' ? body.faqCategory : null,
                  faqScope: body.faqScope === 'PROPERTY' || body.faqScope === 'GLOBAL'
                    ? body.faqScope
                    : null,
                  faqPropertyId:
                    typeof body.faqPropertyId === 'string' ? body.faqPropertyId : null,
                },
                suggestion: {
                  sourceMessageId: suggestion.sourceMessageId ?? null,
                  beforeText: suggestion.beforeText,
                  faqQuestion: suggestion.faqQuestion,
                  faqCategory: suggestion.faqCategory,
                  faqScope: suggestion.faqScope,
                  faqPropertyId: suggestion.faqPropertyId,
                },
              });
              const finalAnswer: string = finalText;
              // Dedup + create, with a retry-on-P2002 for the case where a
              // concurrent apply landed the same question between our
              // findFirst and create (the @@unique([tenantId, propertyId,
              // question]) index will reject the second insert).
              let createdId: string;
              let wasCreated: boolean;
              const duplicate = await findDuplicateFaqEntry(prisma, {
                tenantId,
                question: resolved.finalQuestion,
                propertyId: resolved.finalPropertyId,
              });
              if (duplicate) {
                await prisma.faqEntry.update({
                  where: { id: duplicate.id },
                  data: { answer: finalAnswer, status: 'ACTIVE' as any },
                });
                createdId = duplicate.id;
                wasCreated = false;
              } else {
                try {
                  const entry = await prisma.faqEntry.create({
                    data: {
                      tenantId,
                      question: resolved.finalQuestion,
                      answer: finalAnswer,
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
                    // Concurrent accept beat us. Re-resolve and update.
                    const now = await findDuplicateFaqEntry(prisma, {
                      tenantId,
                      question: resolved.finalQuestion,
                      propertyId: resolved.finalPropertyId,
                    });
                    if (!now) throw err;
                    await prisma.faqEntry.update({
                      where: { id: now.id },
                      data: { answer: finalAnswer, status: 'ACTIVE' as any },
                    });
                    createdId = now.id;
                    wasCreated = false;
                  } else {
                    throw err;
                  }
                }
              }
              appliedPayload = {
                question: resolved.finalQuestion,
                answer: finalAnswer,
                category: resolved.finalCategory,
                scope: resolved.finalScope,
                created: wasCreated,
                questionSource: resolved.sourceHint,
              };
              targetUpdated = { kind: 'faq_entry_new', id: createdId };
              break;
            }
            let faq = await prisma.faqEntry.findFirst({
              where: { id: suggestion.faqEntryId, tenantId },
            });
            // Fallback: analyzer may have persisted a hallucinated/stale cuid.
            // Recover by matching on question text from beforeText or faqQuestion.
            if (!faq) {
              const probeQuestion = (suggestion.beforeText || '')
                .replace(/^Q:\s*/i, '')
                .split('\n')[0]
                .trim() || (suggestion.faqQuestion || '').trim();
              if (probeQuestion) {
                faq = await prisma.faqEntry.findFirst({
                  where: { tenantId, question: probeQuestion },
                });
              }
            }
            if (!faq) {
              throw new NotFoundError(
                'FAQ_NOT_FOUND',
                `FAQ entry ${suggestion.faqEntryId} no longer exists for this tenant.`
              );
            }
            // Snapshot the prior FAQ row so a rollback can restore it (sprint 05 §2 / C17).
            await snapshotFaqEntry(prisma, {
              tenantId,
              targetId: faq.id,
              question: faq.question,
              answer: faq.answer,
              category: faq.category,
              scope: String(faq.scope),
              propertyId: faq.propertyId ?? null,
              status: String(faq.status),
              editedByUserId: userId,
              triggeringSuggestionId: suggestion.id,
            });
            // Default to replacing the answer; if beforeText matched the question, replace the question.
            const editQuestion =
              suggestion.beforeText && suggestion.beforeText.trim() === faq.question.trim();
            if (editQuestion) {
              await prisma.faqEntry.update({
                where: { id: faq.id },
                data: { question: finalText },
              });
              appliedPayload = { text: finalText, field: 'question' };
            } else {
              await prisma.faqEntry.update({
                where: { id: faq.id },
                data: { answer: finalText },
              });
              appliedPayload = { text: finalText, field: 'answer' };
            }
            targetUpdated = { kind: 'faq_entry', id: faq.id };
            break;
          }

          case TuningActionType.CREATE_SOP: {
            const finalContent: string | null =
              (typeof body.editedContent === 'string' ? body.editedContent : null) ?? suggestion.proposedText;
            const finalToolDesc: string | null =
              (typeof body.editedToolDescription === 'string' ? body.editedToolDescription : null) ??
              suggestion.sopToolDescription;
            if (!finalContent || !finalToolDesc || !suggestion.sopCategory || !suggestion.sopStatus) {
              throw new RequiredFieldsError();
            }
            // Upsert SopDefinition by (tenantId, category).
            const sopDef = await prisma.sopDefinition.upsert({
              where: {
                tenantId_category: { tenantId, category: suggestion.sopCategory },
              },
              update: { toolDescription: finalToolDesc },
              create: {
                tenantId,
                category: suggestion.sopCategory,
                toolDescription: finalToolDesc,
              },
            });
            // Snapshot the existing variant if any before upsert (sprint 05 §2 / C17).
            const priorVariant = await prisma.sopVariant.findUnique({
              where: {
                sopDefinitionId_status: {
                  sopDefinitionId: sopDef.id,
                  status: suggestion.sopStatus,
                },
              },
              select: { id: true, content: true },
            });
            if (priorVariant) {
              await snapshotSopVariant(prisma, {
                tenantId,
                targetId: priorVariant.id,
                kind: 'variant',
                sopDefinitionId: sopDef.id,
                status: suggestion.sopStatus,
                content: priorVariant.content,
                editedByUserId: userId,
                triggeringSuggestionId: suggestion.id,
              });
            }
            // Upsert SopVariant by (sopDefinitionId, status).
            const variant = await prisma.sopVariant.upsert({
              where: {
                sopDefinitionId_status: {
                  sopDefinitionId: sopDef.id,
                  status: suggestion.sopStatus,
                },
              },
              update: { content: finalContent },
              create: {
                sopDefinitionId: sopDef.id,
                status: suggestion.sopStatus,
                content: finalContent,
              },
            });
            if (suggestion.sopPropertyId) {
              const priorOverride = await prisma.sopPropertyOverride.findUnique({
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
                await snapshotSopVariant(prisma, {
                  tenantId,
                  targetId: priorOverride.id,
                  kind: 'override',
                  sopDefinitionId: sopDef.id,
                  status: suggestion.sopStatus,
                  content: priorOverride.content,
                  propertyId: suggestion.sopPropertyId,
                  editedByUserId: userId,
                  triggeringSuggestionId: suggestion.id,
                });
              }
              await prisma.sopPropertyOverride.upsert({
                where: {
                  sopDefinitionId_propertyId_status: {
                    sopDefinitionId: sopDef.id,
                    propertyId: suggestion.sopPropertyId,
                    status: suggestion.sopStatus,
                  },
                },
                update: { content: finalContent },
                create: {
                  sopDefinitionId: sopDef.id,
                  propertyId: suggestion.sopPropertyId,
                  status: suggestion.sopStatus,
                  content: finalContent,
                },
              });
            }
            appliedPayload = { content: finalContent, toolDescription: finalToolDesc };
            invalidateSopCache(tenantId);
            targetUpdated = { kind: 'sop_definition_new', id: sopDef.id };
            break;
          }

          case TuningActionType.CREATE_FAQ: {
            const finalQuestion: string | null =
              (typeof body.editedQuestion === 'string' ? body.editedQuestion : null) ?? suggestion.faqQuestion;
            const finalAnswer: string | null =
              (typeof body.editedAnswer === 'string' ? body.editedAnswer : null) ?? suggestion.faqAnswer;
            if (!finalQuestion || !finalAnswer || !suggestion.faqCategory || !suggestion.faqScope) {
              throw new RequiredFieldsError();
            }
            // Defense-in-depth: if the suggestion claims PROPERTY scope,
            // verify the persisted faqPropertyId actually belongs to this
            // tenant before writing. Coerces to GLOBAL if the check fails
            // rather than persisting a cross-tenant propertyId on the FAQ.
            let finalScope: string = suggestion.faqScope;
            let finalPropertyId: string | null = null;
            if (suggestion.faqScope === 'PROPERTY' && suggestion.faqPropertyId) {
              const owns = await prisma.property.findFirst({
                where: { id: suggestion.faqPropertyId, tenantId },
                select: { id: true },
              });
              if (owns) {
                finalPropertyId = owns.id;
              } else {
                finalScope = 'GLOBAL';
              }
            } else if (suggestion.faqScope === 'PROPERTY') {
              // PROPERTY scope requested but no propertyId — would orphan.
              finalScope = 'GLOBAL';
            }
            // Constitution §VIII: source=MANUAL, not AUTO_SUGGESTED — admin explicitly approved.
            const entry = await prisma.faqEntry.create({
              data: {
                tenantId,
                category: suggestion.faqCategory,
                scope: finalScope as any,
                propertyId: finalPropertyId,
                question: finalQuestion,
                answer: finalAnswer,
                status: 'ACTIVE',
                source: 'MANUAL',
              },
            });
            appliedPayload = { question: finalQuestion, answer: finalAnswer };
            targetUpdated = { kind: 'faq_entry_new', id: entry.id };
            break;
          }
        }

        // Feature 041 sprint 03: honor applyMode from the UI. IMMEDIATE (default)
        // means the accept happened now; QUEUED means the manager marked it for
        // later batching (we still apply, but the flag informs future workflow).
        const applyMode: 'IMMEDIATE' | 'QUEUED' =
          body.applyMode === 'QUEUED' ? 'QUEUED' : 'IMMEDIATE';

        // Sprint 09 fix 8: status + appliedAt + appliedByUserId were already
        // set by the atomic claim above. This update just stamps the payload
        // and apply mode now that the artifact write has succeeded.
        const updated = await prisma.tuningSuggestion.update({
          where: { id: suggestion.id },
          data: {
            appliedPayload: appliedPayload as any,
            applyMode,
          },
        });

        // Feature 041 sprint 02 §6: per-category EMA acceptance-rate tracking.
        // Old-branch suggestions (no diagnosticCategory) are skipped silently.
        await updateCategoryStatsOnAccept(prisma, tenantId, updated.diagnosticCategory);

        // Feature 041 sprint 03 — D2 pre-wire: when the manager edits then
        // accepts, persist the (context, rejected, preferred) triple to the
        // PreferencePair table. First caller of this table; additive.
        if (body.editedFromOriginal === true && suggestion.proposedText) {
          const finalWritten =
            typeof body.editedText === 'string' && body.editedText.length > 0
              ? body.editedText
              : (appliedPayload as any)?.text;
          if (finalWritten && finalWritten !== suggestion.proposedText) {
            await recordPreferencePair(prisma, {
              tenantId,
              suggestionId: suggestion.id,
              category: updated.diagnosticCategory,
              before: suggestion.beforeText ?? null,
              rejectedProposal: suggestion.proposedText,
              preferredFinal: finalWritten,
            }).catch((err) => console.error('[preference-pair] write failed:', err));
          }
        }

        broadcastCritical(tenantId, 'tuning_suggestion_updated', {
          suggestionId: updated.id,
          status: 'ACCEPTED',
          appliedByUserId: userId,
          applyMode,
        });

        res.json({ ok: true, suggestion: updated, targetUpdated });
      } catch (err) {
        // Sprint 09 fix 8: if we claimed the row but the dispatch failed,
        // revert the status back to PENDING so the manager can retry instead
        // of having a suggestion permanently stuck in ACCEPTED without the
        // corresponding artifact write.
        if (claimed) {
          await prisma.tuningSuggestion
            .update({
              where: { id },
              data: {
                status: 'PENDING',
                appliedAt: null,
                appliedByUserId: null,
              },
            })
            .catch((revertErr) =>
              console.error(`[tuning-suggestion] [${id}] accept revert failed:`, revertErr)
            );
        }
        if (err instanceof RequiredFieldsError) {
          res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
          return;
        }
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: err.httpCode, ...(err.detail ? { detail: err.detail } : {}) });
          return;
        }
        console.error(`[tuning-suggestion] [${id}] accept failed:`, err);
        res.status(500).json({ error: 'INTERNAL_ERROR', detail: err instanceof Error ? err.message : String(err) });
      }
    },

    // ─── POST /api/tuning-suggestions/:id/reject ──────────────────────────
    async reject(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const { id } = req.params;
      const userId = (req as any).userId ?? null;

      try {
        // Feature 041 sprint 03: optional one-line reason. Stored in
        // appliedPayload for reject (free-form JSON) so no schema change is needed.
        const body = req.body || {};
        const reason: string | null =
          typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

        // Sprint 09 fix 8 + fix 9: atomic CAS on status, same approach as
        // accept. Serialises concurrent rejects, and allows rejecting
        // AUTO_SUPPRESSED suggestions (sprint 08 §5) which were otherwise
        // stuck unresolvable.
        const claim = await prisma.tuningSuggestion.updateMany({
          where: { id, tenantId, status: { in: ['PENDING', 'AUTO_SUPPRESSED'] } },
          data: {
            status: 'REJECTED',
            appliedByUserId: userId,
            ...(reason ? { appliedPayload: { rejectReason: reason } as any } : {}),
          },
        });
        if (claim.count === 0) {
          const exists = await prisma.tuningSuggestion.findFirst({
            where: { id, tenantId },
            select: { id: true },
          });
          if (!exists) {
            res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
            return;
          }
          res.status(409).json({ error: 'SUGGESTION_NOT_PENDING' });
          return;
        }
        const updated = await prisma.tuningSuggestion.findFirst({ where: { id, tenantId } });
        if (!updated) {
          // Race: deleted between flip and read. Treat as 404.
          res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
          return;
        }

        // Feature 041 sprint 02 §6: EMA update on reject too.
        await updateCategoryStatsOnReject(prisma, tenantId, updated.diagnosticCategory);

        broadcastCritical(tenantId, 'tuning_suggestion_updated', {
          suggestionId: updated.id,
          status: 'REJECTED',
          appliedByUserId: userId,
        });
        res.json({ ok: true, suggestion: updated });
      } catch (err) {
        console.error(`[tuning-suggestion] [${id}] reject failed:`, err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
