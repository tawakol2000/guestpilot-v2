import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient, MessageRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { cancelPendingAiReply } from '../services/debounce.service';
import { getAiConfig } from '../services/ai-config.service';
import { createMessage, stripCodeFences } from '../services/ai.service';
import { processFaqSuggestion } from '../services/faq-suggest.service';
import { compactMessageAsync } from '../services/message-compaction.service';
import { translationService } from '../services/translation.service';
// Feature 041 — legacy copilot tuning trigger. The shadow-mode preview send
// path (shadow-preview.controller.ts) already fires the diagnostic when the
// manager edits a preview before sending. Without these imports the legacy
// copilot path (PendingAiReply.suggestion → operator approves/edits → send via
// this endpoint) would silently drop every edit, so /tuning never received a
// suggestion for tenants without shadowModeEnabled.
import { runDiagnostic } from '../services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../services/tuning/suggestion-writer.service';
import { semanticSimilarity } from '../services/tuning/diff.service';
import { shouldProcessTrigger } from '../services/tuning/trigger-dedup.service';
import { logTuningDiagnosticFailure } from '../services/tuning/diagnostic-failure-log';

const sendMessageSchema = z.object({
  content: z.string().min(1).max(4000, 'Message too long (max 4000 characters)'),
  channel: z.string().optional(),
  // Sprint-10 follow-up: explicit opt-in signal from the UI that the
  // manager was editing an AI-drafted reply when they sent this message.
  // Without this the legacy copilot path fired EDIT/REJECT_TRIGGERED
  // diagnostics on every send that happened while ANY PendingAiReply
  // existed — including freshly-typed replies unrelated to the draft —
  // which poisoned the diagnostic corpus and fed criticalFailure
  // detection. Callers that DO want diagnostic fire must pass true; the
  // default stays false for back-compat with existing API consumers.
  fromDraft: z.boolean().optional(),
});

export function makeMessagesController(prisma: PrismaClient) {
  return {
    async send(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const parsed = sendMessageSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: { tenant: true },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        const { content, channel, fromDraft } = parsed.data;

        // Read optional client source header for audit trail
        const rawSource = req.headers['x-client-source'] as string | undefined;
        const clientSource = rawSource && ['web', 'ios'].includes(rawSource) ? rawSource : null;

        let hostawayMsgId = '';
        let deliveryStatus: string = 'pending';
        let deliveryError: string | null = null;
        let deliveredAt: Date | null = null;

        if (conversation.hostawayConversationId) {
          // Map frontend channel keys to Hostaway communicationType
          const communicationType = channel === 'whatsapp' ? 'whatsapp'
            : channel === 'email' ? 'email'
            : 'channel';
          try {
            const hwResult = await hostawayService.sendMessageToConversation(
              conversation.tenant.hostawayAccountId,
              conversation.tenant.hostawayApiKey,
              conversation.hostawayConversationId,
              content,
              communicationType
            );
            // Capture Hostaway message ID to prevent duplicates when webhook echoes back
            hostawayMsgId = String((hwResult as any)?.result?.id || '');
            deliveryStatus = 'sent';
            deliveredAt = new Date();
          } catch (err: any) {
            console.warn(`[Messages] Hostaway send failed (message still saved locally): ${err.message}`);
            deliveryStatus = 'failed';
            deliveryError = err.message || 'Hostaway send failed';
          }
        } else {
          // No Hostaway conversation ID — message saved locally only
          deliveryStatus = 'pending';
        }

        // Feature 041 — capture any pending AI suggestion BEFORE we cancel it.
        // In legacy copilot, the AI's draft lives on PendingAiReply.suggestion
        // (set by ai.service.ts when shadowModeEnabled is false). The worker
        // marks fired:true after generating, so we look up by conversationId
        // alone — not fired:false, which would miss the typical case.
        //
        // Sprint-10 follow-up: only consider the pending draft as an "edit
        // signal" if the client explicitly opted in via fromDraft: true.
        // Merely having a debounced draft in flight when the manager types
        // an unrelated reply used to trigger false REJECT_TRIGGERED runs
        // (similarity < 0.3 because texts are unrelated), which poisoned
        // the critical-failure signal feeding Autopilot graduation.
        const pendingDraft = fromDraft
          ? await prisma.pendingAiReply
              .findFirst({
                where: { conversationId: id, suggestion: { not: null } },
                orderBy: { scheduledAt: 'desc' },
                select: { suggestion: true },
              })
              .catch(() => null)
          : null;
        const pendingSuggestion = pendingDraft?.suggestion?.trim() ? pendingDraft.suggestion : null;

        // If there was an AI draft, also link the most recent AiApiLog so the
        // diagnostic's evidence bundle can pull RAG context (mirrors the
        // shadow-preview path which stamps aiApiLogId on the preview Message).
        const recentAiApiLog = pendingSuggestion
          ? await prisma.aiApiLog
              .findFirst({
                where: { tenantId, conversationId: id },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              })
              .catch(() => null)
          : null;

        const editorUserId = (req as any).userId ?? null;

        const hostCommType = channel === 'whatsapp' ? 'whatsapp'
          : channel === 'email' ? 'email'
          : 'channel';
        const message = await prisma.message.create({
          data: {
            conversationId: id,
            tenantId,
            role: MessageRole.HOST,
            content,
            channel: conversation.channel,
            communicationType: hostCommType,
            sentAt: new Date(),
            hostawayMessageId: hostawayMsgId,
            deliveryStatus,
            deliveryError,
            deliveredAt,
            source: clientSource,
            // Audit fields populated only when the manager was acting on an AI
            // draft (legacy copilot). For a freshly typed reply with no draft,
            // these stay null and no diagnostic fires below.
            originalAiText: pendingSuggestion,
            editedByUserId: pendingSuggestion ? editorUserId : null,
            aiApiLogId: recentAiApiLog?.id ?? null,
          },
        });
        compactMessageAsync(message.id, MessageRole.HOST, content, prisma);

        await prisma.conversation.updateMany({
          where: { id, tenantId },
          data: { lastMessageAt: new Date() },
        });

        await cancelPendingAiReply(id, prisma);

        // Feature 041 — fire the tuning diagnostic when the manager actually
        // edited the AI draft. Same EDIT vs REJECT split as
        // shadow-preview.controller.ts:140-174: similarity < 0.3 = wholesale
        // replacement (stronger "AI got it wrong" signal). Fire-and-forget,
        // deduped per-message for 60s by shouldProcessTrigger. Never blocks
        // the response, never throws into the caller.
        if (pendingSuggestion && pendingSuggestion !== content) {
          const similarity = semanticSimilarity(pendingSuggestion, content);
          const triggerType: 'EDIT_TRIGGERED' | 'REJECT_TRIGGERED' =
            similarity < 0.3 ? 'REJECT_TRIGGERED' : 'EDIT_TRIGGERED';

          if (shouldProcessTrigger(triggerType, message.id)) {
            void (async () => {
              try {
                const result = await runDiagnostic(
                  {
                    triggerType,
                    tenantId,
                    messageId: message.id,
                    note: triggerType === 'REJECT_TRIGGERED'
                      ? 'Manager replaced the AI copilot draft wholesale (similarity < 0.3).'
                      : 'Manager edited the AI copilot draft before sending.',
                  },
                  prisma
                );
                if (result) {
                  await writeSuggestionFromDiagnostic(result, {}, prisma);
                }
              } catch (diagErr) {
                logTuningDiagnosticFailure({
                  phase: 'diagnostic',
                  path: 'messages',
                  tenantId,
                  messageId: message.id,
                  triggerType,
                  error: diagErr,
                });
              }
            })();
          } else {
            console.log(`[Messages] [${message.id}] copilot diagnostic deduped (60s window).`);
          }
        }

        // Broadcast delivery status if failed so other devices/tabs see the failure
        if (deliveryStatus === 'failed') {
          const { broadcastToTenant } = await import('../services/socket.service');
          broadcastToTenant(tenantId, 'message_delivery_status', {
            messageId: message.id,
            conversationId: id,
            status: 'failed',
            error: deliveryError,
          });
        }

        // Auto-suggest FAQ: if conversation has an open info_request task, classify the reply
        try {
          const infoRequestTask = await prisma.task.findFirst({
            where: { conversationId: id, status: 'open', urgency: 'info_request' },
            orderBy: { createdAt: 'desc' },
          });
          if (infoRequestTask?.note) {
            // Use the task's note (escalation context) — not the last guest message,
            // which might be "just escalate this" instead of the actual question.
            processFaqSuggestion(prisma, tenantId, id, conversation.propertyId, infoRequestTask.note, content)
              .catch(err => console.warn('[FAQ] Auto-suggest failed (non-fatal):', err.message));
          }
        } catch (err: any) {
          console.warn('[FAQ] Auto-suggest trigger failed (non-fatal):', err.message);
        }

        // Background: pre-fill pending knowledge suggestion if exists
        prisma.knowledgeSuggestion.findFirst({
          where: { conversationId: id, status: 'pending', source: 'ai_identified', answer: '' },
          orderBy: { createdAt: 'desc' },
        }).then(async (pendingSuggestion) => {
          if (pendingSuggestion) {
            await prisma.knowledgeSuggestion.update({
              where: { id: pendingSuggestion.id },
              data: { answer: content, source: 'manager_approved' },
            });
            const { broadcastToTenant } = await import('../services/socket.service');
            broadcastToTenant(tenantId, 'knowledge_suggestion_updated', { id: pendingSuggestion.id });
          }
        }).catch(err => console.warn('[Messages] Could not pre-fill knowledge suggestion:', err));

        res.status(201).json({
          id: message.id,
          role: message.role,
          content: message.content,
          sentAt: message.sentAt,
          deliveryStatus: message.deliveryStatus,
          deliveryError: message.deliveryError,
          source: message.source,
        });
      } catch (err) {
        console.error('[Messages] send error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async translateAndSend(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const parsed = sendMessageSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: {
            tenant: true,
            messages: { orderBy: { sentAt: 'desc' }, take: 10 },
          },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        const { content, channel } = parsed.data;
        const cfg = getAiConfig().managerTranslator;

        // Build conversation history for context
        const history = [...conversation.messages].reverse()
          .map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`)
          .join('\n');

        const userContent: Array<{ type: 'text'; text: string }> = [
          { type: 'text', text: `### CONVERSATION HISTORY ###\n${history}` },
          { type: 'text', text: `### MANAGER INSTRUCTION ###\n${content}` },
        ];

        const rawResponse = await createMessage(cfg.systemPrompt, userContent, {
          model: cfg.model,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          agentName: 'managerTranslator',
        });

        const translatedContent = stripCodeFences(rawResponse).trim();

        if (!translatedContent) {
          res.status(422).json({ error: 'AI returned empty response' });
          return;
        }

        const rawSource = req.headers['x-client-source'] as string | undefined;
        const clientSource = rawSource && ['web', 'ios'].includes(rawSource) ? rawSource : null;

        let deliveryStatus: string = 'pending';
        let deliveryError: string | null = null;
        let deliveredAt: Date | null = null;

        // Send translated message to Hostaway — respect the chosen channel
        if (conversation.hostawayConversationId) {
          const communicationType = channel === 'whatsapp' ? 'whatsapp'
            : channel === 'email' ? 'email'
            : 'channel';
          try {
            await hostawayService.sendMessageToConversation(
              conversation.tenant.hostawayAccountId,
              conversation.tenant.hostawayApiKey,
              conversation.hostawayConversationId,
              translatedContent,
              communicationType
            );
            deliveryStatus = 'sent';
            deliveredAt = new Date();
          } catch (err: any) {
            console.warn(`[Messages] Hostaway translate+send failed: ${err.message}`);
            deliveryStatus = 'failed';
            deliveryError = err.message || 'Hostaway send failed';
          }
        }

        const translateCommType = channel === 'whatsapp' ? 'whatsapp'
          : channel === 'email' ? 'email'
          : 'channel';
        const message = await prisma.message.create({
          data: {
            conversationId: id,
            tenantId,
            role: MessageRole.HOST,
            content: translatedContent,
            channel: conversation.channel,
            communicationType: translateCommType,
            sentAt: new Date(),
            deliveryStatus,
            deliveryError,
            deliveredAt,
            source: clientSource,
          },
        });
        compactMessageAsync(message.id, MessageRole.HOST, translatedContent, prisma);

        await prisma.conversation.updateMany({
          where: { id, tenantId },
          data: { lastMessageAt: new Date() },
        });

        await cancelPendingAiReply(id, prisma);

        if (deliveryStatus === 'failed') {
          const { broadcastToTenant } = await import('../services/socket.service');
          broadcastToTenant(tenantId, 'message_delivery_status', {
            messageId: message.id,
            conversationId: id,
            status: 'failed',
            error: deliveryError,
          });
        }

        res.status(201).json({
          id: message.id,
          role: message.role,
          content: message.content,
          sentAt: message.sentAt,
          deliveryStatus: message.deliveryStatus,
          deliveryError: message.deliveryError,
          source: message.source,
        });
      } catch (err) {
        console.error('[Messages] translateAndSend error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async sendNote(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const parsed = sendMessageSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        const { content } = parsed.data;

        const rawSource = req.headers['x-client-source'] as string | undefined;
        const clientSource = rawSource && ['web', 'ios'].includes(rawSource) ? rawSource : null;

        const message = await prisma.message.create({
          data: {
            conversationId: id,
            tenantId,
            role: MessageRole.MANAGER_PRIVATE,
            content,
            channel: conversation.channel,
            communicationType: 'internal',
            sentAt: new Date(),
            source: clientSource,
          },
        });

        res.status(201).json({
          id: message.id,
          role: message.role,
          content: message.content,
          sentAt: message.sentAt,
        });
      } catch (err) {
        console.error('[Messages] sendNote error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // Feature 042 — message-scoped translation with server-side persistence.
    // Translates ONE inbound guest message to English, caches the result on
    // Message.contentTranslationEn so subsequent calls (from any manager, any
    // device, incl. the iOS app) serve from cache without re-hitting the
    // provider.
    async translateMessageById(req: AuthenticatedRequest, res: Response): Promise<void> {
      const t0 = Date.now();
      const { tenantId } = req;
      const { messageId } = req.params;
      let cached = false;
      let ok = false;
      try {
        const message = await prisma.message.findFirst({
          where: { id: messageId, tenantId },
          select: { id: true, role: true, content: true, contentTranslationEn: true },
        });

        if (!message) {
          res.status(404).json({ error: 'Message not found' });
          return;
        }
        if (message.role !== MessageRole.GUEST) {
          res.status(400).json({ error: 'Only inbound guest messages can be translated' });
          return;
        }
        if (!message.content?.trim()) {
          res.status(400).json({ error: 'Message has no content to translate' });
          return;
        }

        if (message.contentTranslationEn) {
          cached = true;
          ok = true;
          res.json({
            messageId: message.id,
            translated: message.contentTranslationEn,
            cached: true,
          });
          return;
        }

        let translated: string;
        let detectedSourceLang: string | undefined;
        try {
          const result = await translationService.translate(message.content, { targetLang: 'en' });
          translated = result.translated;
          detectedSourceLang = result.detectedSourceLang;
        } catch (providerErr: any) {
          console.warn(`[Messages] translate provider failed for ${messageId}: ${providerErr?.message}`);
          res.status(502).json({ error: 'Translation provider unavailable' });
          return;
        }

        // Best-effort persist — if the DB write fails we still return the
        // translation so the manager isn't blocked on a transient DB issue.
        try {
          await prisma.message.update({
            where: { id: messageId },
            data: { contentTranslationEn: translated },
          });
        } catch (dbErr: any) {
          console.warn(`[Messages] translate persist failed for ${messageId} (non-fatal): ${dbErr?.message}`);
        }

        ok = true;
        res.json({
          messageId: message.id,
          translated,
          cached: false,
          sourceLanguage: detectedSourceLang,
        });
      } catch (err) {
        console.error('[Messages] translateMessageById error:', err);
        res.status(500).json({ error: 'Internal server error' });
      } finally {
        console.log(
          `[Messages] translate messageId=${messageId} tenantId=${tenantId} ms=${Date.now() - t0} cached=${cached} ok=${ok}`
        );
      }
    },
  };
}
