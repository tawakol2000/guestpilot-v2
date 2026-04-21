/**
 * Feature 040: Copilot Shadow Mode — Send endpoint for preview bubbles.
 *
 * POST /api/shadow-previews/:messageId/send
 *   Body: { editedText?: string }
 *
 * Delivers a preview Message (with optional admin-edited text) to the guest
 * via Hostaway and transitions the preview into a normal sent AI message.
 *
 * Atomic state transition pattern: conditional UPDATE from PREVIEW_PENDING →
 * PREVIEW_SENDING (or 409 if the preview is no longer pending), call Hostaway,
 * commit to null (normal message) on success or revert to PREVIEW_PENDING on
 * failure. Guarantees idempotency and no double-send.
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { broadcastCritical } from '../services/socket.service';
// Feature 041 sprint 02: new taxonomy-aware diagnostic pipeline replaces the
// two-step analyzer removed in sprint 01. Edited preview sends fire
// runDiagnostic + writeSuggestionFromDiagnostic as a fire-and-forget.
import { runDiagnostic } from '../services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../services/tuning/suggestion-writer.service';
import { semanticSimilarity } from '../services/tuning/diff.service';
import { shouldProcessTrigger } from '../services/tuning/trigger-dedup.service';
import { logTuningDiagnosticFailure } from '../services/tuning/diagnostic-failure-log';
import { compactMessageAsync } from '../services/message-compaction.service';
import { MessageRole } from '@prisma/client';

export function makeShadowPreviewController(prisma: PrismaClient) {
  return {
    async send(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const { messageId } = req.params;
      const editedText: string | undefined =
        typeof req.body?.editedText === 'string' && req.body.editedText.trim().length > 0
          ? req.body.editedText
          : undefined;

      try {
        // Load the preview Message scoped by tenant.
        const preview = await prisma.message.findFirst({
          where: { id: messageId, tenantId },
          include: {
            conversation: { include: { tenant: true } },
          },
        });

        if (!preview) {
          res.status(404).json({ error: 'PREVIEW_NOT_FOUND' });
          return;
        }

        if (preview.previewState !== 'PREVIEW_PENDING') {
          res.status(409).json({
            error: 'PREVIEW_NOT_PENDING',
            detail: 'This preview is no longer the latest unsent preview.',
          });
          return;
        }

        // Atomic state transition: PREVIEW_PENDING → PREVIEW_SENDING, optionally writing the edited text.
        // If updateMany returns count 0, another request already flipped the state.
        // When the manager edits, null out compactedContent so next AI turn's
        // history block doesn't inject a summary of the *original* AI draft.
        // Re-compaction for the new content fires after the Hostaway send commits.
        const transitionResult = await prisma.message.updateMany({
          where: { id: messageId, tenantId, previewState: 'PREVIEW_PENDING' },
          data: {
            previewState: 'PREVIEW_SENDING',
            ...(editedText !== undefined ? { content: editedText, editedByUserId: (req as any).userId ?? null, compactedContent: null } : {}),
          },
        });

        if (transitionResult.count === 0) {
          res.status(409).json({
            error: 'PREVIEW_NOT_PENDING',
            detail: 'This preview is no longer the latest unsent preview.',
          });
          return;
        }

        const finalContent = editedText ?? preview.content;
        const conversation = preview.conversation;
        if (!conversation.hostawayConversationId) {
          // No Hostaway conversation id — cannot deliver. Roll back state and error.
          await prisma.message
            .update({ where: { id: messageId }, data: { previewState: 'PREVIEW_PENDING' } })
            .catch(() => {});
          res.status(502).json({ error: 'HOSTAWAY_DELIVERY_FAILED', detail: 'Conversation has no Hostaway id' });
          return;
        }

        const communicationType = preview.communicationType || 'channel';

        try {
          const hwResult = await hostawayService.sendMessageToConversation(
            conversation.tenant.hostawayAccountId,
            conversation.tenant.hostawayApiKey,
            conversation.hostawayConversationId,
            finalContent,
            communicationType
          );
          const hostawayMsgId = String((hwResult as any)?.result?.id || '');
          const sentAt = new Date();

          // Commit: clear previewState, fill hostawayMessageId + sentAt
          const updated = await prisma.message.update({
            where: { id: messageId },
            data: {
              previewState: null,
              hostawayMessageId: hostawayMsgId,
              sentAt,
            },
          });

          // Re-fire compaction for the final sent text. Gated internally by
          // length threshold; safe to call for short messages. Fires only
          // when the manager edited — unedited sends still have the original
          // compactedContent (or none, if under the threshold).
          // Sprint-049 A7: compaction was previously `void`'d with no catch
          // at all; wrap so an AI-compaction crash is greppable in Railway
          // logs instead of landing on an unhandledRejection handler.
          if (editedText !== undefined) {
            void (async () => {
              try {
                await compactMessageAsync(updated.id, MessageRole.AI, finalContent, prisma);
              } catch (compactErr) {
                logTuningDiagnosticFailure({
                  phase: 'compaction',
                  path: 'shadow-preview',
                  tenantId,
                  messageId,
                  triggerType: null,
                  error: compactErr,
                });
              }
            })();
          }

          // Update conversation lastMessageAt so inbox list re-sorts
          await prisma.conversation
            .update({ where: { id: conversation.id }, data: { lastMessageAt: sentAt } })
            .catch(() => {});

          // Broadcast the final message state so all open inboxes refresh
          broadcastCritical(tenantId, 'message', {
            conversationId: conversation.id,
            message: {
              id: updated.id,
              role: 'AI',
              content: finalContent,
              sentAt: sentAt.toISOString(),
              channel: String(updated.channel),
              imageUrls: [],
              // previewState intentionally omitted — message is now a normal sent AI message
              editedByUserId: updated.editedByUserId ?? undefined,
              originalAiText: updated.originalAiText ?? undefined,
            },
            lastMessageRole: 'AI',
            lastMessageAt: sentAt.toISOString(),
          });

          // Feature 041 sprint 02: fire the new diagnostic pipeline when the
          // send was edited (original text differs from final text). EDIT vs
          // REJECT is decided by lexical similarity — wholesale replacements
          // (< 0.3) are stronger "the AI got this fundamentally wrong" signals
          // per sprint brief §5 trigger 2.
          const wasEdited = Boolean(updated.originalAiText && updated.originalAiText !== finalContent);
          let analyzerQueued = false;
          if (wasEdited) {
            const similarity = semanticSimilarity(updated.originalAiText ?? '', finalContent);
            const triggerType: 'EDIT_TRIGGERED' | 'REJECT_TRIGGERED' =
              similarity < 0.3 ? 'REJECT_TRIGGERED' : 'EDIT_TRIGGERED';

            if (shouldProcessTrigger(triggerType, messageId)) {
              analyzerQueued = true;
              // Fire-and-forget. Never blocks the HTTP response. All errors
              // swallowed — CLAUDE.md critical rule #2.
              void (async () => {
                try {
                  const result = await runDiagnostic(
                    {
                      triggerType,
                      tenantId,
                      messageId,
                      note: triggerType === 'REJECT_TRIGGERED'
                        ? 'Manager replaced the AI draft wholesale (similarity < 0.3).'
                        : 'Manager edited the AI draft before sending.',
                    },
                    prisma
                  );
                  if (result) {
                    await writeSuggestionFromDiagnostic(result, {}, prisma);
                  }
                } catch (diagErr) {
                  logTuningDiagnosticFailure({
                    phase: 'diagnostic',
                    path: 'shadow-preview',
                    tenantId,
                    messageId,
                    triggerType,
                    error: diagErr,
                  });
                }
              })();
            } else {
              console.log(`[ShadowPreview] [${messageId}] diagnostic deduped (60s window).`);
            }
          }

          res.json({
            ok: true,
            message: {
              id: updated.id,
              content: updated.content,
              previewState: null,
              originalAiText: updated.originalAiText,
              editedByUserId: updated.editedByUserId,
              hostawayMessageId: updated.hostawayMessageId,
              sentAt: sentAt.toISOString(),
            },
            analyzerQueued,
          });
        } catch (sendErr) {
          console.error(`[ShadowPreview] [${messageId}] Hostaway send failed:`, sendErr);
          // Roll back to PREVIEW_PENDING so the admin can retry
          await prisma.message
            .update({ where: { id: messageId }, data: { previewState: 'PREVIEW_PENDING' } })
            .catch(() => {});
          res.status(502).json({
            error: 'HOSTAWAY_DELIVERY_FAILED',
            detail: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        }
      } catch (err) {
        console.error(`[ShadowPreview] [${messageId}] send handler error:`, err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
