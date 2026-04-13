import { Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { PrismaClient, MessageRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { cancelPendingAiReply } from '../services/debounce.service';
import { getAiConfig } from '../services/ai-config.service';
import { createMessage, stripCodeFences } from '../services/ai.service';
import { processFaqSuggestion } from '../services/faq-suggest.service';

const sendMessageSchema = z.object({
  content: z.string().min(1).max(4000, 'Message too long (max 4000 characters)'),
  channel: z.string().nullable().optional().transform(v => v ?? undefined),
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

        const { content, channel } = parsed.data;

        // Read optional client source header for audit trail
        const rawSource = req.headers['x-client-source'] as string | undefined;
        const clientSource = rawSource && ['web', 'ios'].includes(rawSource) ? rawSource : null;

        console.log(`[DEBUG-SEND] conversationId=${id}, content="${content?.substring(0, 50)}", channel="${channel}", source="${clientSource}", rawBody.channel=${JSON.stringify(req.body?.channel)}`);

        let hostawayMsgId = '';
        let deliveryStatus: string = 'pending';
        let deliveryError: string | null = null;
        let deliveredAt: Date | null = null;

        if (conversation.hostawayConversationId) {
          // Map frontend channel keys to Hostaway communicationType
          const communicationType = channel === 'whatsapp' ? 'whatsapp'
            : channel === 'email' ? 'email'
            : 'channel';
          console.log(`[DEBUG-SEND] About to call Hostaway: hwConvId=${conversation.hostawayConversationId}, communicationType=${communicationType}`);
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
          console.log(`[DEBUG-SEND] No hostawayConversationId for conv ${id} — skipping Hostaway send`);
          deliveryStatus = 'pending';
        }

        console.log(`[DEBUG-SEND] Result: deliveryStatus=${deliveryStatus}, error=${deliveryError}, hwMsgId=${hostawayMsgId}`);

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
          },
        });

        await prisma.conversation.updateMany({
          where: { id, tenantId },
          data: { lastMessageAt: new Date() },
        });

        await cancelPendingAiReply(id, prisma);

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

    async translateMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { content } = req.body as { content?: string };
        if (!content?.trim()) {
          res.status(400).json({ error: 'content required' });
          return;
        }

        // Free Google Translate — no API key needed
        const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'en', dt: 't', q: content });
        const gtRes = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`);
        const translated = (gtRes.data[0] as Array<[string]>).map(part => part[0]).join('').trim();

        res.json({ translated });
      } catch (err) {
        console.error('[Messages] translate error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
