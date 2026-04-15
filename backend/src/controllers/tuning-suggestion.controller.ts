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
import { AuthenticatedRequest } from '../types';
import { broadcastCritical } from '../services/socket.service';
import { invalidateTenantConfigCache } from '../services/tenant-config.service';
import {
  updateCategoryStatsOnAccept,
  updateCategoryStatsOnReject,
} from '../services/tuning/category-stats.service';
import { recordPreferencePair } from '../services/tuning/preference-pair.service';

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
          const validStatuses: TuningSuggestionStatus[] = ['PENDING', 'ACCEPTED', 'REJECTED'];
          if (validStatuses.includes(statusParam as TuningSuggestionStatus)) {
            where.status = statusParam;
          }
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

      try {
        const suggestion = await prisma.tuningSuggestion.findFirst({ where: { id, tenantId } });
        if (!suggestion) {
          res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
          return;
        }
        if (suggestion.status !== 'PENDING') {
          res.status(409).json({ error: 'SUGGESTION_NOT_PENDING' });
          return;
        }

        const body = req.body || {};
        let appliedPayload: Record<string, unknown> = {};
        let targetUpdated: { kind: string; id: string } = { kind: 'unknown', id: '' };

        switch (suggestion.actionType) {
          case TuningActionType.EDIT_SYSTEM_PROMPT: {
            const finalText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.proposedText;
            if (!finalText || !suggestion.systemPromptVariant) {
              res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
              return;
            }
            const variantField =
              suggestion.systemPromptVariant === 'coordinator'
                ? 'systemPromptCoordinator'
                : 'systemPromptScreening';
            const current = await prisma.tenantAiConfig.findUnique({ where: { tenantId } });
            const history = Array.isArray(current?.systemPromptHistory)
              ? [...((current!.systemPromptHistory as any[]) || [])]
              : [];
            history.push({
              version: current?.systemPromptVersion ?? 1,
              timestamp: new Date().toISOString(),
              [suggestion.systemPromptVariant]: (current as any)?.[variantField] || '',
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
            appliedPayload = { text: finalText };
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
              res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
              return;
            }
            // Resolve the SopDefinition first — both variants and property overrides hang off it.
            const sopDef = await prisma.sopDefinition.findFirst({
              where: { tenantId, category: suggestion.sopCategory },
              select: { id: true },
            });
            if (!sopDef) {
              res.status(404).json({ error: 'SOP_DEFINITION_NOT_FOUND' });
              return;
            }
            if (effectiveSopPropertyId) {
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
                select: { id: true },
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
            break;
          }

          case TuningActionType.EDIT_SOP_ROUTING: {
            const finalText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.sopToolDescription;
            if (!finalText || !suggestion.sopCategory) {
              res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
              return;
            }
            const sopDef = await prisma.sopDefinition.findFirst({
              where: { tenantId, category: suggestion.sopCategory },
              select: { id: true },
            });
            if (!sopDef) {
              res.status(404).json({ error: 'SOP_DEFINITION_NOT_FOUND' });
              return;
            }
            await prisma.sopDefinition.update({
              where: { id: sopDef.id },
              data: { toolDescription: finalText },
            });
            appliedPayload = { text: finalText };
            targetUpdated = { kind: 'sop_routing', id: sopDef.id };
            break;
          }

          case TuningActionType.EDIT_FAQ: {
            const finalText: string | null =
              (typeof body.editedText === 'string' ? body.editedText : null) ?? suggestion.proposedText;
            if (!finalText || !suggestion.faqEntryId) {
              res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
              return;
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
              res.status(404).json({
                error: 'FAQ_NOT_FOUND',
                detail: `FAQ entry ${suggestion.faqEntryId} no longer exists for this tenant.`,
              });
              return;
            }
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
              res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
              return;
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
            targetUpdated = { kind: 'sop_definition_new', id: sopDef.id };
            break;
          }

          case TuningActionType.CREATE_FAQ: {
            const finalQuestion: string | null =
              (typeof body.editedQuestion === 'string' ? body.editedQuestion : null) ?? suggestion.faqQuestion;
            const finalAnswer: string | null =
              (typeof body.editedAnswer === 'string' ? body.editedAnswer : null) ?? suggestion.faqAnswer;
            if (!finalQuestion || !finalAnswer || !suggestion.faqCategory || !suggestion.faqScope) {
              res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
              return;
            }
            // Constitution §VIII: source=MANUAL, not AUTO_SUGGESTED — admin explicitly approved.
            const entry = await prisma.faqEntry.create({
              data: {
                tenantId,
                category: suggestion.faqCategory,
                scope: suggestion.faqScope as any,
                propertyId: suggestion.faqScope === 'PROPERTY' ? suggestion.faqPropertyId : null,
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

        const updated = await prisma.tuningSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: 'ACCEPTED',
            appliedAt: new Date(),
            appliedPayload: appliedPayload as any,
            appliedByUserId: userId,
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
        const suggestion = await prisma.tuningSuggestion.findFirst({ where: { id, tenantId } });
        if (!suggestion) {
          res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
          return;
        }
        if (suggestion.status !== 'PENDING') {
          res.status(409).json({ error: 'SUGGESTION_NOT_PENDING' });
          return;
        }
        // Feature 041 sprint 03: optional one-line reason. Stored in
        // appliedPayload for reject (free-form JSON) so no schema change is needed.
        const body = req.body || {};
        const reason: string | null =
          typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

        const updated = await prisma.tuningSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: 'REJECTED',
            appliedByUserId: userId,
            ...(reason ? { appliedPayload: { rejectReason: reason } as any } : {}),
          },
        });

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
