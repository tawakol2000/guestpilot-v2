/**
 * AI Debounce Background Job
 * Runs every 30 seconds. For each PendingAiReply where scheduledAt <= now and fired = false:
 *   1. Mark fired = true
 *   2. Check reservation.aiEnabled — skip if disabled
 *   3. Call generateAndSendAiReply
 */

import { PrismaClient } from '@prisma/client';
import { getDuePendingReplies } from '../services/debounce.service';
import { generateAndSendAiReply } from '../services/ai.service';

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

export function startAiDebounceJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[AiDebounceJob] Starting — polling every 30s');

  const timer = setInterval(async () => {
    try {
      const due = await getDuePendingReplies(prisma);
      if (due.length === 0) return;

      console.log(`[AiDebounceJob] Processing ${due.length} pending replies`);

      for (const pending of due) {
        // T025: Atomic claim guard — prevents double-firing across overlapping polls
        const claimed = await prisma.pendingAiReply.updateMany({
          where: { id: pending.id, fired: false },
          data: { fired: true },
        });
        if (claimed.count === 0) { console.log('[AiDebounceJob] Already claimed, skipping'); continue; }

        const { conversation } = pending;
        if (!conversation) continue;

        const reservation = conversation.reservation;
        if (!reservation) continue;

        // Respect aiEnabled flag and aiMode (whitelist valid modes)
        if (!reservation.aiEnabled || !['autopilot', 'auto', 'copilot'].includes(reservation.aiMode)) {
          console.log(`[AiDebounceJob] AI disabled for conversation ${conversation.id} (aiEnabled=${reservation.aiEnabled}, aiMode=${reservation.aiMode}) — skipping`);
          continue;
        }

        const tenant = conversation.tenant;
        if (!tenant) continue;

        const property = conversation.property;
        if (!property) continue;

        const guest = conversation.guest;
        if (!guest) continue;

        // Build context for AI
        const customKb = property.customKnowledgeBase as Record<string, unknown> | null ?? {};

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
            },
            customKnowledgeBase: customKb,
            listingDescription: property.listingDescription,
            aiMode: reservation.aiMode,
            channel: reservation.channel,
            reservationId: reservation.id,
            screeningAnswers: reservation.screeningAnswers as Record<string, unknown>,
          },
          prisma
        ).catch(err => {
          console.error(`[AiDebounceJob] Error generating reply for conv ${conversation.id}:`, err);
        });
      }
    } catch (err) {
      console.error('[AiDebounceJob] Poll error:', err);
    }
  }, POLL_INTERVAL_MS);

  return timer;
}
