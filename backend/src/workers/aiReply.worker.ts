/**
 * BullMQ worker — processes the 'ai-replies' queue.
 * For each delayed job: fetches full conversation context, checks AI flags,
 * then calls generateAndSendAiReply().
 *
 * This complements (never replaces) the aiDebounce.job.ts poll fallback.
 * When BullMQ processes jobs, the poll finds no due PendingAiReplies — correct.
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { generateAndSendAiReply } from '../services/ai.service';

export function startAiReplyWorker(prisma: PrismaClient): Worker | null {
  const { REDIS_URL } = process.env;
  if (!REDIS_URL) {
    console.log('[Worker] REDIS_URL missing — BullMQ worker not started, using poll fallback');
    return null;
  }

  // Use URL string directly to avoid ioredis version conflicts with bullmq's bundled ioredis
  const connection = { url: REDIS_URL, maxRetriesPerRequest: null } as any;

  const worker = new Worker(
    'ai-replies',
    async (job: Job) => {
      const { conversationId, tenantId } = job.data as { conversationId: string; tenantId: string };
      console.log(`[Worker] Processing job for conversation ${conversationId}`);

      // Fetch full conversation with all required relations
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        include: {
          reservation: {
            include: {
              property: true,
              guest: true,
              tenant: true,
            },
          },
          guest: true,
          property: true,
          tenant: true,
        },
      });

      if (!conversation) {
        console.warn(`[Worker] Conversation ${conversationId} not found — skipping`);
        return;
      }

      const { reservation } = conversation;
      if (!reservation) {
        console.warn(`[Worker] No reservation for conversation ${conversationId} — skipping`);
        return;
      }

      if (!reservation.aiEnabled) {
        console.log(`[Worker] AI disabled for conversation ${conversationId} — skipping`);
        return;
      }

      const { aiMode } = reservation;
      if (aiMode !== 'autopilot' && aiMode !== 'auto' && aiMode !== 'copilot') {
        console.log(`[Worker] aiMode=${aiMode} for ${conversationId} — skipping`);
        return;
      }

      // Fetch PendingAiReply to get window start time, then atomically mark fired
      const pending = await prisma.pendingAiReply.findFirst({
        where: { conversationId, fired: false },
      });
      if (!pending) {
        console.log(`[Worker] PendingAiReply for ${conversationId} already fired by poll — skipping`);
        return;
      }
      const claimed = await prisma.pendingAiReply.updateMany({
        where: { id: pending.id, fired: false },
        data: { fired: true },
      });
      if (claimed.count === 0) {
        console.log(`[Worker] PendingAiReply for ${conversationId} claimed by poll between find/update — skipping`);
        return;
      }

      const { property, guest, tenant } = reservation;
      const customKb = property.customKnowledgeBase as Record<string, string> | null;

      const context = {
        tenantId,
        conversationId,
        propertyId: property.id,
        windowStartedAt: pending.createdAt,
        hostawayConversationId: conversation.hostawayConversationId,
        hostawayApiKey: tenant.hostawayApiKey,
        hostawayAccountId: tenant.hostawayAccountId,
        guestName: guest.name,
        checkIn: reservation.checkIn.toISOString().split('T')[0],
        checkOut: reservation.checkOut.toISOString().split('T')[0],
        guestCount: reservation.guestCount,
        reservationStatus: reservation.status as string,
        listing: {
          name: property.name,
          internalListingName: property.name,
          address: property.address,
          doorSecurityCode: customKb?.doorCode || customKb?.doorSecurityCode || '',
          wifiUsername: customKb?.wifiName || customKb?.wifiUsername || '',
          wifiPassword: customKb?.wifiPassword || '',
        },
        customKnowledgeBase: property.customKnowledgeBase as Record<string, unknown>,
        listingDescription: property.listingDescription,
        aiMode,
      };

      await generateAndSendAiReply(context, prisma);
      console.log(`[Worker] Successfully processed conversation ${conversationId}`);
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[Worker] Job failed for ${job?.data?.conversationId}:`, err.message);
  });

  worker.on('completed', (job: Job) => {
    console.log(`[Worker] Job completed for ${job.data.conversationId}`);
  });

  console.log('[Worker] BullMQ AI reply worker started (concurrency: 5)');
  return worker;
}
