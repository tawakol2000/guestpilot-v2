/**
 * Message Sync Job — Polls for active conversations and syncs messages from Hostaway.
 * Runs every 2 minutes. Processes max 10 conversations per cycle.
 */

import { PrismaClient } from '@prisma/client';
import { syncConversationMessages } from '../services/message-sync.service';

export function startMessageSyncJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[MessageSync] Background sync job started (interval: 120s)');

  return setInterval(async () => {
    try {
      const now = new Date();
      const twoMinAgo = new Date(now.getTime() - 120_000);

      // Find active conversations needing sync
      const conversations = await prisma.conversation.findMany({
        where: {
          status: 'OPEN',
          reservation: {
            status: { in: ['INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          },
          // No lastMessageAt filter — sync all active conversations regardless of when
          // the last message was. A quiet guest can message after days of silence.
          OR: [
            { lastSyncedAt: null },
            { lastSyncedAt: { lt: twoMinAgo } },
          ],
        },
        include: {
          reservation: {
            include: {
              tenant: {
                select: { id: true, hostawayAccountId: true, hostawayApiKey: true },
              },
            },
          },
        },
        orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
        take: 10,
      });

      if (conversations.length === 0) return;

      let synced = 0;
      let totalNew = 0;
      let skipped = 0;

      for (const conv of conversations) {
        const tenant = conv.reservation.tenant;

        // Skip if tenant lacks Hostaway credentials
        if (!tenant.hostawayAccountId || !tenant.hostawayApiKey) {
          skipped++;
          continue;
        }

        // Skip if no Hostaway conversation ID
        if (!conv.hostawayConversationId) {
          skipped++;
          continue;
        }

        try {
          const result = await syncConversationMessages(
            prisma, conv.id, conv.hostawayConversationId,
            tenant.id, tenant.hostawayAccountId, tenant.hostawayApiKey,
          );
          if (!result.skipped) {
            synced++;
            totalNew += result.newMessages;
          }
        } catch (err: any) {
          console.warn(`[MessageSync] Failed for conv=${conv.id}: ${err.message}`);
          // Continue with next conversation
        }
      }

      if (synced > 0 || totalNew > 0) {
        console.log(`[MessageSync] Cycle: synced=${synced} new=${totalNew} skipped=${skipped}`);
      }
    } catch (err: any) {
      console.error('[MessageSync] Job cycle failed:', err.message);
    }
  }, 120_000);
}
