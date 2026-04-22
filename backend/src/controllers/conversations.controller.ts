import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient, ReservationStatus } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { cancelPendingAiReply, getPendingReplyForConversation, markFired } from '../services/debounce.service';
import { generateAndSendAiReply } from '../services/ai.service';
import { broadcastToTenant, broadcastCritical } from '../services/socket.service';
import { syncConversationMessages } from '../services/message-sync.service';
// Sprint-049 A2: Path B tuning diagnostic fire. Before this session the
// legacy-copilot approve-as-edit path accepted editedText but never ran
// the diagnostic, so tenants on copilot mode (shadowModeEnabled=false)
// lost every EDIT/REJECT signal. Sprint-048 Session A wired Path A via
// messages.controller#send; this closes the Path B half.
import { runDiagnostic } from '../services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../services/tuning/suggestion-writer.service';
import { semanticSimilarity } from '../services/tuning/diff.service';
import { shouldProcessTrigger } from '../services/tuning/trigger-dedup.service';
import { logTuningDiagnosticFailure } from '../services/tuning/diagnostic-failure-log';

const aiToggleSchema = z.object({
  aiEnabled: z.boolean(),
});

/**
 * Delete an orphan reservation and all its related data (conversation, messages, tasks).
 * Used when a reservation doesn't exist in Hostaway (test/fake data).
 */
async function deleteOrphanReservation(prisma: PrismaClient, reservationId: string, conversationId: string) {
  // Delete in dependency order: Tasks → PendingAiReply → Messages → Conversation → Reservation
  await prisma.task.deleteMany({ where: { conversationId } });
  await prisma.pendingAiReply.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { reservationId } });
  await prisma.reservation.delete({ where: { id: reservationId } });
  console.log(`[Cleanup] Deleted orphan reservation=${reservationId} conversation=${conversationId}`);
}

export function makeConversationsController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const conversations = await prisma.conversation.findMany({
          where: {
            tenantId,
          },
          orderBy: { lastMessageAt: 'desc' },
          include: {
            guest: true,
            property: true,
            reservation: true,
            messages: { orderBy: { sentAt: 'desc' }, take: 1 },
          },
        });

        res.json(conversations.map(conv => ({
          id: conv.id,
          guestName: conv.guest.name,
          propertyName: conv.property.name,
          channel: conv.channel,
          aiEnabled: conv.reservation.aiEnabled,
          aiMode: conv.reservation.aiMode,
          unreadCount: conv.unreadCount,
          starred: conv.starred,
          status: conv.status,
          lastMessage: conv.messages[0]?.content || '',
          lastMessageRole: conv.messages[0]?.role || null,
          lastMessageAt: conv.lastMessageAt,
          reservationStatus: conv.reservation.status,
          reservationId: conv.reservation.id,
          checkIn: conv.reservation.checkIn,
          checkOut: conv.reservation.checkOut,
          reservationCreatedAt: conv.reservation.createdAt,
          hostawayConversationId: conv.hostawayConversationId,
        })));
      } catch (err) {
        console.error('[Conversations] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: {
            guest: true,
            property: true,
            reservation: true,
            messages: { orderBy: { sentAt: 'asc' } },
          },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        await prisma.conversation.updateMany({ where: { id, tenantId }, data: { unreadCount: 0 } });
        broadcastToTenant(tenantId, 'unread_count_changed', { conversationId: id, unreadCount: 0 });

        // Fetch AI logs for this conversation to attach SOP/tool metadata to AI messages
        const aiLogs = await prisma.aiApiLog.findMany({
          where: { conversationId: id, tenantId },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true, ragContext: true },
        });

        // Build a lookup: for each AI message, find the closest AiApiLog by timestamp
        const aiMessages = conversation.messages.filter(m => m.role === 'AI');
        const aiMetaMap = new Map<string, { sopCategories?: string[]; toolName?: string; toolNames?: string[]; confidence?: number; autopilotDowngraded?: boolean }>();
        for (const aiMsg of aiMessages) {
          let bestLog: (typeof aiLogs)[0] | null = null;
          let bestDiff = Infinity;
          for (const log of aiLogs) {
            const diff = Math.abs(aiMsg.sentAt.getTime() - log.createdAt.getTime());
            if (diff < bestDiff) {
              bestDiff = diff;
              bestLog = log;
            }
          }
          if (bestLog && bestDiff < 60000) { // within 60 seconds
            const rc = bestLog.ragContext as any;
            if (rc) {
              // Collect all tool names from the AI call
              const toolNames: string[] = rc.toolNames || (rc.toolName ? [rc.toolName] : []);
              aiMetaMap.set(aiMsg.id, {
                sopCategories: rc.sopCategories || rc.classifierLabels || undefined,
                toolName: toolNames[0] || undefined,
                toolNames: toolNames.length > 0 ? toolNames : undefined,
                confidence: typeof rc.confidence === 'number' ? rc.confidence : undefined,
                autopilotDowngraded: rc.autopilotDowngraded === true ? true : undefined,
              });
            }
          }
        }

        res.json({
          id: conversation.id,
          status: conversation.status,
          channel: conversation.channel,
          starred: conversation.starred,
          lastMessageAt: conversation.lastMessageAt,
          hostawayConversationId: conversation.hostawayConversationId,
          guest: {
            id: conversation.guest.id,
            name: conversation.guest.name,
            email: conversation.guest.email,
            phone: conversation.guest.phone,
            nationality: conversation.guest.nationality,
          },
          property: {
            id: conversation.property.id,
            name: conversation.property.name,
            address: conversation.property.address,
            customKnowledgeBase: conversation.property.customKnowledgeBase,
          },
          reservation: {
            id: conversation.reservation.id,
            checkIn: conversation.reservation.checkIn,
            checkOut: conversation.reservation.checkOut,
            guestCount: conversation.reservation.guestCount,
            channel: conversation.reservation.channel,
            status: conversation.reservation.status,
            aiEnabled: conversation.reservation.aiEnabled,
            aiMode: conversation.reservation.aiMode,
            // Feature 043 — per-reservation scheduled time overrides
            scheduledCheckInAt: conversation.reservation.scheduledCheckInAt,
            scheduledCheckOutAt: conversation.reservation.scheduledCheckOutAt,
          },
          documentChecklist: ((conversation.reservation.screeningAnswers as any)?.documentChecklist) || null,
          messages: conversation.messages.map(m => {
            // Merge ragContext-derived aiMeta with the Message.aiConfidence column.
            // The column is authoritative for confidence (persisted at send time);
            // ragContext is authoritative for sopCategories/toolNames (populated
            // during the generation turn).
            const logMeta = aiMetaMap.get(m.id);
            const mergedAiMeta = (logMeta || (m as any).aiConfidence != null)
              ? {
                  ...(logMeta || {}),
                  ...((m as any).aiConfidence != null ? { confidence: (m as any).aiConfidence } : {}),
                }
              : undefined;
            return {
              id: m.id,
              role: m.role,
              content: m.content,
              channel: m.channel,
              sentAt: m.sentAt,
              imageUrls: m.imageUrls,
              // Feature 040: Copilot Shadow Mode preview fields — without these the
              // frontend renders preview bubbles as normal sent messages and the
              // Send/Edit buttons never appear after a page refresh.
              previewState: m.previewState,
              originalAiText: m.originalAiText,
              editedByUserId: m.editedByUserId,
              ...(mergedAiMeta ? { aiMeta: mergedAiMeta } : {}),
            };
          }),
        });
      } catch (err) {
        console.error('[Conversations] get error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async getReservation(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: { guest: true, property: true, reservation: true },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        res.json({
          reservation: {
            id: conversation.reservation.id,
            hostawayReservationId: conversation.reservation.hostawayReservationId,
            checkIn: conversation.reservation.checkIn,
            checkOut: conversation.reservation.checkOut,
            guestCount: conversation.reservation.guestCount,
            channel: conversation.reservation.channel,
            status: conversation.reservation.status,
            aiEnabled: conversation.reservation.aiEnabled,
            aiMode: conversation.reservation.aiMode,
            screeningAnswers: conversation.reservation.screeningAnswers,
          },
          guest: {
            id: conversation.guest.id,
            name: conversation.guest.name,
            email: conversation.guest.email,
            phone: conversation.guest.phone,
            nationality: conversation.guest.nationality,
          },
          property: {
            id: conversation.property.id,
            name: conversation.property.name,
            address: conversation.property.address,
            listingDescription: conversation.property.listingDescription,
            customKnowledgeBase: conversation.property.customKnowledgeBase,
          },
        });
      } catch (err) {
        console.error('[Conversations] getReservation error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async aiToggleAll(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const parsed = aiToggleSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        // Bugfix (2026-04-22): the previous version had no status filter,
        // so toggling AI on at the tenant level re-enabled it on
        // CANCELLED + CHECKED_OUT reservations. Webhook G4 explicitly
        // sets aiEnabled=false on those statuses for safety; if a guest
        // replied after the toggle, the AI pipeline would fire on a
        // booking that was supposed to be terminal. Restrict the
        // updateMany to active statuses only.
        const result = await prisma.reservation.updateMany({
          where: {
            tenantId,
            status: { notIn: ['CANCELLED' as any, 'CHECKED_OUT' as any] },
          },
          data: { aiEnabled: parsed.data.aiEnabled },
        });
        res.json({ ok: true, aiEnabled: parsed.data.aiEnabled, updated: result.count });
      } catch (err) {
        console.error('[Conversations] aiToggleAll error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async aiToggleProperty(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { propertyId, aiMode } = req.body as { propertyId?: string; aiMode?: string };

        if (!propertyId || typeof propertyId !== 'string') {
          res.status(400).json({ error: 'propertyId is required' });
          return;
        }

        const validModes = ['autopilot', 'copilot', 'off'];
        if (!aiMode || !validModes.includes(aiMode)) {
          res.status(400).json({ error: `aiMode must be one of: ${validModes.join(', ')}` });
          return;
        }

        // Verify property belongs to tenant
        const property = await prisma.property.findFirst({
          where: { id: propertyId, tenantId },
        });
        if (!property) {
          res.status(404).json({ error: 'Property not found' });
          return;
        }

        const aiEnabled = aiMode !== 'off';

        // Bugfix (2026-04-22): the previous version wrote
        // `aiMode: aiEnabled ? aiMode : 'autopilot'` when toggling OFF.
        // That silently overwrote the prior aiMode preference with
        // 'autopilot', so any later flip to enabled (e.g. via
        // aiToggleAll) jumped every conversation to autopilot — even
        // ones that were previously in copilot. Autopilot sends
        // directly without manager approval, so this was a silent
        // safety regression on every property toggle off→on cycle.
        // Fix: persist the actual aiMode value ('off' is a legitimate
        // mode in the column already) so a later "on" can come back to
        // the prior preference. Same for status filter — don't
        // re-enable on CANCELLED/CHECKED_OUT (parity with aiToggleAll).
        const result = await prisma.reservation.updateMany({
          where: {
            tenantId,
            propertyId,
            status: { notIn: ['CANCELLED' as any, 'CHECKED_OUT' as any] },
          },
          data: { aiEnabled, aiMode },
        });

        broadcastToTenant(tenantId, 'property_ai_changed', { propertyId, aiMode, aiEnabled });

        res.json({ ok: true, propertyId, aiMode, updated: result.count });
      } catch (err) {
        console.error('[Conversations] aiToggleProperty error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async inquiryAction(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const { action } = req.body as { action: 'accept' | 'reject' };

        if (action !== 'accept' && action !== 'reject') {
          res.status(400).json({ error: 'action must be accept or reject' });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: { tenant: true, reservation: true },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        if (conversation.reservation.status !== ReservationStatus.INQUIRY) {
          res.status(400).json({ error: 'Reservation is not an inquiry' });
          return;
        }

        const hostawayStatus = action === 'accept' ? 'confirmed' : 'cancelled';
        try {
          await hostawayService.updateReservationStatus(
            conversation.tenant.hostawayAccountId,
            conversation.tenant.hostawayApiKey,
            conversation.reservation.hostawayReservationId,
            hostawayStatus
          );
        } catch (hostawayErr: unknown) {
          const axiosErr = hostawayErr as { response?: { data?: { message?: string }; status?: number } };
          const msg = axiosErr?.response?.data?.message || 'Hostaway API error';
          console.error('[Conversations] inquiryAction Hostaway error:', msg);
          res.status(502).json({ error: msg });
          return;
        }

        const newStatus = action === 'accept' ? ReservationStatus.CONFIRMED : ReservationStatus.CANCELLED;
        // Bugfix (2026-04-22): the Hostaway commit at line ~374 has
        // already succeeded by this point. If the local DB update
        // fails (timeout, transient connection), Hostaway says the
        // reservation is CONFIRMED but our DB still treats it as
        // INQUIRY (restricted access, no door code, no auto-replies).
        // The webhook eventually resyncs but the window is operator-
        // visible.
        //
        // Safe-retry the local update with a short backoff so a
        // transient blip self-heals before we punt to the webhook.
        // We don't retry the Hostaway call itself — that's already
        // committed and Hostaway is the source of truth.
        let updateOk = false;
        let lastUpdateErr: unknown = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await prisma.reservation.update({
              where: { id: conversation.reservationId },
              data: { status: newStatus },
            });
            updateOk = true;
            break;
          } catch (err) {
            lastUpdateErr = err;
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
            }
          }
        }
        if (!updateOk) {
          // Hostaway succeeded but we couldn't persist locally. Surface
          // a 207 Multi-Status with a clear note so the operator knows
          // the action landed remotely; the webhook will resync.
          console.error(
            '[Conversations] inquiryAction local update failed after 3 retries (Hostaway already committed):',
            lastUpdateErr,
          );
          res.status(207).json({
            ok: true,
            status: newStatus,
            warning: 'HOSTAWAY_COMMITTED_LOCAL_UPDATE_DEFERRED',
            detail:
              'The action committed remotely on Hostaway. Local state will resync via webhook within a minute.',
          });
          return;
        }

        // After acceptance, Airbnb releases phone/email that were hidden during inquiry.
        // Pull the fresh reservation from Hostaway and update the Guest record so the
        // inspector panel stops showing blank fields. Non-fatal — the accept already
        // succeeded; enrichment is best-effort.
        if (action === 'accept') {
          try {
            const { result: fresh } = await hostawayService.getReservation(
              conversation.tenant.hostawayAccountId,
              conversation.tenant.hostawayApiKey,
              conversation.reservation.hostawayReservationId
            );
            const guestUpdate: { phone?: string; email?: string; nationality?: string; name?: string } = {};
            const freshPhone = fresh.phone || fresh.guestPhone;
            if (freshPhone) guestUpdate.phone = freshPhone;
            if (fresh.guestEmail && !fresh.guestEmail.includes('@guest.hostaway')) guestUpdate.email = fresh.guestEmail;
            if (fresh.guestCountry) guestUpdate.nationality = fresh.guestCountry;
            const freshName = fresh.guestName
              || [fresh.guestFirstName, fresh.guestLastName].filter(Boolean).join(' ');
            if (freshName) guestUpdate.name = freshName;
            if (Object.keys(guestUpdate).length > 0) {
              await prisma.guest.update({
                where: { id: conversation.guestId },
                data: guestUpdate,
              });
              broadcastToTenant(tenantId, 'guest_updated', {
                conversationId: conversation.id,
                guest: guestUpdate,
              });
            }
          } catch (enrichErr: unknown) {
            const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
            console.warn(`[Conversations] inquiryAction guest enrichment failed (non-fatal): ${msg}`);
          }
        }

        res.json({ ok: true, status: newStatus });
      } catch (err) {
        console.error('[Conversations] inquiryAction error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async sendAiNow(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const pending = await getPendingReplyForConversation(id, prisma);
        if (!pending) {
          res.status(404).json({ error: 'No pending AI reply' });
          return;
        }

        const { conversation } = pending;
        if (!conversation?.reservation || !conversation.tenant || !conversation.property || !conversation.guest) {
          res.status(422).json({ error: 'Incomplete conversation data' });
          return;
        }

        // Verify ownership
        if (conversation.tenantId !== tenantId) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }

        // Mark fired so the normal poll doesn't double-fire
        await markFired(pending.id, prisma);

        const { reservation, tenant, property, guest } = conversation;
        const customKb = (property.customKnowledgeBase as Record<string, unknown> | null) ?? {};

        // Fire immediately (don't await — respond right away)
        generateAndSendAiReply(
          {
            tenantId: tenant.id,
            conversationId: conversation.id,
            propertyId: property.id,
            windowStartedAt: pending.createdAt,
            hostawayConversationId: conversation.hostawayConversationId,
            hostawayApiKey: tenant.hostawayApiKey,
            hostawayAccountId: tenant.hostawayAccountId,
            guestName: guest.name,
            checkIn: reservation.checkIn.toISOString().split('T')[0],
            checkOut: reservation.checkOut.toISOString().split('T')[0],
            guestCount: reservation.guestCount,
            reservationStatus: reservation.status,
            listing: {
              name: property.name,
              internalListingName: property.name,
              address: property.address,
              doorSecurityCode: (customKb as any)?.doorCode || (customKb as any)?.doorSecurityCode || '',
              wifiUsername: (customKb as any)?.wifiName || (customKb as any)?.wifiUsername || '',
              wifiPassword: (customKb as any)?.wifiPassword || '',
            },
            customKnowledgeBase: customKb,
            listingDescription: property.listingDescription,
            aiMode: reservation.aiMode,
            channel: reservation.channel,
            reservationId: reservation.id,
            screeningAnswers: reservation.screeningAnswers as Record<string, unknown>,
          },
          prisma
        ).catch(err => console.error(`[sendAiNow] Error for conv ${id}:`, err));

        res.json({ ok: true });
      } catch (err) {
        console.error('[Conversations] sendAiNow error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async cancelPendingAi(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const conversation = await prisma.conversation.findFirst({ where: { id, tenantId } });
        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        await cancelPendingAiReply(id, prisma);
        res.json({ ok: true });
      } catch (err) {
        console.error('[Conversations] cancelPendingAi error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async setAiMode(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const { aiMode } = req.body as { aiMode: string };
        if (!['autopilot', 'copilot', 'off'].includes(aiMode)) {
          res.status(400).json({ error: 'aiMode must be autopilot, copilot, or off' });
          return;
        }
        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: { reservation: true },
        });
        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }
        await prisma.reservation.update({
          where: { id: conversation.reservationId },
          data: { aiMode },
        });
        broadcastToTenant(tenantId, 'ai_mode_changed', { conversationId: id, aiMode });
        res.json({ aiMode });
      } catch (err) {
        console.error('[Conversations] setAiMode error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async approveSuggestion(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const { editedText } = req.body as { editedText?: string };

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: { tenant: true, reservation: true, property: true },
        });
        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        const pendingReply = await prisma.pendingAiReply.findFirst({
          where: { conversationId: id, suggestion: { not: null } },
          orderBy: { createdAt: 'desc' },
        });
        if (!pendingReply?.suggestion && !editedText) {
          res.status(404).json({ error: 'No pending suggestion' });
          return;
        }

        const messageText = editedText || pendingReply!.suggestion!;

        const { hostawayAccountId, hostawayApiKey } = conversation.tenant;
        const hostawayConvId = conversation.hostawayConversationId;

        // Use the channel of the last received guest message — so WhatsApp replies go via WhatsApp
        const lastGuestMsg = await prisma.message.findFirst({
          where: { conversationId: id, role: 'GUEST' },
          orderBy: { sentAt: 'desc' },
        });
        const lastMsgChannel = lastGuestMsg?.channel ?? conversation.channel;
        const communicationType = lastMsgChannel === 'WHATSAPP' ? 'whatsapp' : 'channel';

        // Sprint-049 A1: Hostaway-first, rollback-safe ordering. Before the
        // reorder, a Hostaway throw left PendingAiReply.suggestion=null +
        // fired=true while returning 500 — the operator's retry 404'd because
        // the draft had been swallowed. Mirror shadow-preview.controller.ts:96-128:
        // call Hostaway first, commit DB state only on success, return 502 on
        // delivery failure so the UI keeps the pill and can retry.
        let hostawayResult: any;
        try {
          hostawayResult = await hostawayService.sendMessageToConversation(
            hostawayAccountId,
            hostawayApiKey,
            hostawayConvId,
            messageText,
            communicationType,
          );
        } catch (err: any) {
          console.warn(`[Conversations] approveSuggestion Hostaway send failed (no DB state changed): ${err?.message || err}`);
          res.status(502).json({
            error: 'HOSTAWAY_DELIVERY_FAILED',
            detail: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const hostawayMsgId = String((hostawayResult as any)?.result?.id || '');

        const sentAt = new Date();
        const editorUserId = (req as any).userId ?? null;

        // Link the most-recent AiApiLog so the diagnostic's evidence bundle
        // can pull RAG context. Mirrors messages.controller.ts:124-131 —
        // only bother looking when there was a pending AI draft that the
        // operator might have edited (no draft = no diagnostic to run).
        const recentAiApiLog = pendingReply?.suggestion
          ? await prisma.aiApiLog
              .findFirst({
                where: { tenantId, conversationId: id },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              })
              .catch(() => null)
          : null;

        // Audit trail parity with Path A (messages.controller.ts:156-158):
        // when editedText is provided (operator routed through the approve
        // flow with a deliberate payload), stamp originalAiText +
        // editedByUserId so evidence-bundle replay can see the edit.
        const msg = await prisma.message.create({
          data: {
            conversationId: id,
            tenantId,
            role: 'AI',
            content: messageText,
            sentAt,
            channel: lastMsgChannel,
            communicationType,
            hostawayMessageId: hostawayMsgId,
            originalAiText: editedText ? pendingReply?.suggestion ?? null : null,
            editedByUserId: editedText ? editorUserId : null,
            aiApiLogId: editedText ? recentAiApiLog?.id ?? null : null,
          },
        });

        await prisma.conversation.updateMany({
          where: { id, tenantId },
          data: { lastMessageAt: sentAt },
        });

        broadcastCritical(tenantId, 'message', {
          conversationId: id,
          message: { id: msg.id, role: 'AI', content: messageText, sentAt: sentAt.toISOString(), channel: String(lastMsgChannel), imageUrls: [] },
          lastMessageRole: 'AI',
          lastMessageAt: sentAt.toISOString(),
        });

        // Clear the PendingAiReply row(s) for this conversation — including
        // any sibling debounce row without `suggestion` that could fire a
        // second AI reply on top of this just-sent manual one. Matches Path A
        // (messages.controller.ts:168).
        await cancelPendingAiReply(id, prisma);

        // Sprint-049 A2: Path B tuning diagnostic fire. Only when the
        // operator actually changed the AI draft. EDIT vs REJECT split via
        // semanticSimilarity < 0.3 (wholesale replacement = REJECT). Fire-
        // and-forget, deduped 60s per-message by shouldProcessTrigger, errors
        // swallowed per CLAUDE.md rule #2. Mirrors messages.controller.ts:
        // 170-205 and shadow-preview.controller.ts:148-186.
        const originalSuggestion = pendingReply?.suggestion?.trim() ?? null;
        const trimmedEdit = editedText?.trim();
        if (originalSuggestion && trimmedEdit && trimmedEdit !== originalSuggestion) {
          const similarity = semanticSimilarity(originalSuggestion, trimmedEdit);
          const triggerType: 'EDIT_TRIGGERED' | 'REJECT_TRIGGERED' =
            similarity < 0.3 ? 'REJECT_TRIGGERED' : 'EDIT_TRIGGERED';

          if (shouldProcessTrigger(triggerType, msg.id)) {
            void (async () => {
              try {
                const result = await runDiagnostic(
                  {
                    triggerType,
                    tenantId,
                    messageId: msg.id,
                    note: triggerType === 'REJECT_TRIGGERED'
                      ? 'Manager replaced the AI copilot draft wholesale via approve-suggestion (similarity < 0.3).'
                      : 'Manager edited the AI copilot draft via approve-suggestion before sending.',
                  },
                  prisma,
                );
                if (result) {
                  await writeSuggestionFromDiagnostic(result, {}, prisma);
                }
              } catch (diagErr) {
                logTuningDiagnosticFailure({
                  phase: 'diagnostic',
                  path: 'conversations',
                  tenantId,
                  messageId: msg.id,
                  triggerType,
                  error: diagErr,
                });
              }
            })();
          } else {
            console.log(`[Conversations] [${msg.id}] copilot diagnostic deduped (60s window).`);
          }
        }

        res.json({ ok: true });
      } catch (err) {
        console.error('[Conversations] approveSuggestion error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async getSuggestion(req: AuthenticatedRequest, res: Response): Promise<void> {
      const tenantId = req.tenantId;
      const id = req.params.id;
      try {
        const pending = await prisma.pendingAiReply.findFirst({
          where: { conversationId: id, tenantId, suggestion: { not: null } },
          select: { suggestion: true },
        });
        res.json({ suggestion: pending?.suggestion || null });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch suggestion' });
      }
    },

    async toggleStar(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const { starred } = req.body as { starred: boolean };

        if (typeof starred !== 'boolean') {
          res.status(400).json({ error: 'starred must be a boolean' });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        await prisma.conversation.updateMany({
          where: { id, tenantId },
          data: { starred },
        });

        broadcastToTenant(tenantId, 'conversation_starred', { conversationId: id, starred });

        res.json({ starred });
      } catch (err) {
        console.error('[Conversations] toggleStar error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async resolve(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const { status } = req.body as { status: 'OPEN' | 'RESOLVED' };

        if (status !== 'OPEN' && status !== 'RESOLVED') {
          res.status(400).json({ error: 'status must be OPEN or RESOLVED' });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        await prisma.conversation.updateMany({
          where: { id, tenantId },
          data: { status },
        });

        broadcastToTenant(tenantId, 'conversation_resolved', { conversationId: id, status });

        res.json({ status });
      } catch (err) {
        console.error('[Conversations] resolve error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async aiToggle(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const parsed = aiToggleSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const conversation = await prisma.conversation.findFirst({
          where: { id, tenantId },
          include: { reservation: true },
        });

        if (!conversation) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        await prisma.reservation.update({
          where: { id: conversation.reservationId },
          data: { aiEnabled: parsed.data.aiEnabled },
        });

        broadcastToTenant(tenantId, 'ai_toggled', { conversationId: id, aiEnabled: parsed.data.aiEnabled });

        res.json({ aiEnabled: parsed.data.aiEnabled });
      } catch (err) {
        console.error('[Conversations] aiToggle error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async syncConversation(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const conversationId = req.params.id;

        const conv = await prisma.conversation.findFirst({
          where: { id: conversationId, tenantId },
          include: {
            reservation: {
              include: {
                tenant: {
                  select: { hostawayAccountId: true, hostawayApiKey: true },
                },
              },
            },
          },
        });

        if (!conv) {
          res.status(404).json({ error: 'Conversation not found' });
          return;
        }

        const { hostawayAccountId, hostawayApiKey } = conv.reservation.tenant;

        // Verify reservation exists in Hostaway — if not, it's an orphan (test data)
        try {
          await hostawayService.getReservation(hostawayAccountId, hostawayApiKey, conv.reservation.hostawayReservationId);
        } catch (hwErr: any) {
          // Hostaway returned 404 or error — this reservation doesn't exist in Hostaway
          if (hwErr?.response?.status === 404 || hwErr?.message?.includes('404')) {
            console.log(`[Conversations] Orphan detected: reservation ${conv.reservation.hostawayReservationId} not found in Hostaway — deleting local data`);
            await deleteOrphanReservation(prisma, conv.reservation.id, conversationId);
            res.json({ ok: true, deleted: true, reason: 'Reservation not found in Hostaway — orphan cleaned up' });
            return;
          }
          // Other Hostaway errors — don't delete, just proceed with sync
          console.warn(`[Conversations] Hostaway verification failed (non-404): ${hwErr.message}`);
        }

        const force = req.query.force === 'true';

        const result = await syncConversationMessages(
          prisma,
          conversationId,
          conv.hostawayConversationId,
          tenantId,
          hostawayAccountId,
          hostawayApiKey,
          { force },
        );

        if (result.skipped) {
          res.json({ ok: true, skipped: true, reason: result.reason, lastSyncedAt: result.lastSyncedAt });
        } else {
          res.json({ ok: true, newMessages: result.newMessages, updatedMessages: result.updatedMessages, backfilled: result.backfilled, syncedAt: result.syncedAt });
        }
      } catch (err) {
        console.error('[Conversations] syncConversation error:', err);
        res.status(500).json({ error: 'Sync failed' });
      }
    },
  };
}
