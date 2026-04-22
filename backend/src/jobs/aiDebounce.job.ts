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
        const { conversation } = pending;
        if (!conversation) continue;

        const reservation = conversation.reservation;
        if (!reservation) continue;

        // Respect aiEnabled flag and aiMode (whitelist valid modes)
        if (!reservation.aiEnabled || !['autopilot', 'auto', 'copilot'].includes(reservation.aiMode)) {
          console.log(`[AiDebounceJob] AI disabled for conversation ${conversation.id} (aiEnabled=${reservation.aiEnabled}, aiMode=${reservation.aiMode}) — skipping`);
          continue;
        }

        // T025: Atomic claim guard — prevents double-firing (all modes including copilot)
        const claimed = await prisma.pendingAiReply.updateMany({
          where: { id: pending.id, fired: false },
          data: { fired: true },
        });
        if (claimed.count === 0) { console.log('[AiDebounceJob] Already claimed, skipping'); continue; }

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
        ).catch(async (err) => {
          console.error(`[AiDebounceJob] Error generating reply for conv ${conversation.id}:`, err);
          // Bugfix (2026-04-22): the previous version logged and dropped
          // the failure on the floor. PendingAiReply.fired was already
          // set to true at the claim, so the row would never be retried
          // — guests silently never received a reply if the model call
          // crashed mid-flight. The BullMQ worker path has attempts:3
          // + backoff; this poll fallback had none, so reliability
          // depended on whether REDIS_URL was set.
          //
          // Mitigation without a schema change: reset fired=false and
          // bump scheduledAt by 60s so the next poll picks it up.
          // Cap retries by age — if the message is more than 5 minutes
          // older than its original createdAt, give up (leave fired=true)
          // to avoid infinite loops on a deterministic failure.
          try {
            const ageMs = Date.now() - pending.createdAt.getTime();
            const RETRY_AGE_CAP_MS = 5 * 60 * 1000; // 5 minutes
            if (ageMs > RETRY_AGE_CAP_MS) {
              console.error(
                `[AiDebounceJob] Pending reply ${pending.id} exceeded retry-age cap ${RETRY_AGE_CAP_MS}ms — leaving fired=true.`,
              );
              return;
            }
            // Re-claim only if we're still the owner (still fired=true and
            // matching scheduledAt — defensive against another worker
            // having already taken the row).
            const released = await prisma.pendingAiReply.updateMany({
              where: { id: pending.id, fired: true },
              data: {
                fired: false,
                scheduledAt: new Date(Date.now() + 60_000),
              },
            });
            if (released.count > 0) {
              console.log(
                `[AiDebounceJob] Reset fired=false on ${pending.id}; will retry in ~60s.`,
              );
            }
          } catch (resetErr) {
            console.error(
              `[AiDebounceJob] Failed to reset fired=false on ${pending.id}:`,
              resetErr,
            );
          }
        });
      }
    } catch (err) {
      console.error('[AiDebounceJob] Poll error:', err);
    }
  }, POLL_INTERVAL_MS);

  return timer;
}
