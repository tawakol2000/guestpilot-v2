/**
 * AI Debounce Service
 * Manages PendingAiReply records for the 2-minute debounce window.
 * When a guest sends multiple messages, only one AI reply fires — 2 mins after the LAST message.
 */

import { PrismaClient } from '@prisma/client';
import { getAiConfig } from './ai-config.service';
import { broadcastToTenant } from './sse.service';

const POLL_INTERVAL_MS = 30 * 1000; // job polls every 30s — added to expectedAt for accurate countdown

export async function scheduleAiReply(
  conversationId: string,
  tenantId: string,
  prisma: PrismaClient
): Promise<void> {
  const delay = getAiConfig().debounceDelayMs ?? 120000;
  const scheduledAt = new Date(Date.now() + delay);
  // expectedAt = when the AI will actually fire (scheduledAt + up to one poll cycle)
  const expectedAt = new Date(scheduledAt.getTime() + POLL_INTERVAL_MS);

  // Check for existing unfired pending reply
  const existing = await prisma.pendingAiReply.findFirst({
    where: { conversationId, fired: false },
  });

  if (existing) {
    // Reset timer — update scheduledAt to now + delay
    await prisma.pendingAiReply.update({
      where: { id: existing.id },
      data: { scheduledAt },
    });
  } else {
    // Create new pending reply
    await prisma.pendingAiReply.create({
      data: { conversationId, tenantId, scheduledAt, fired: false },
    });
  }

  // Broadcast typing indicator to browser
  broadcastToTenant(tenantId, 'ai_typing', { conversationId, expectedAt: expectedAt.toISOString() });
}

export async function cancelPendingAiReply(
  conversationId: string,
  prisma: PrismaClient
): Promise<void> {
  // Find first to get tenantId for SSE broadcast
  const existing = await prisma.pendingAiReply.findFirst({
    where: { conversationId, fired: false },
  });

  await prisma.pendingAiReply.updateMany({
    where: { conversationId, fired: false },
    data: { fired: true },
  });

  if (existing) {
    broadcastToTenant(existing.tenantId, 'ai_typing_clear', { conversationId });
  }
}

export async function getDuePendingReplies(prisma: PrismaClient) {
  return prisma.pendingAiReply.findMany({
    where: {
      fired: false,
      scheduledAt: { lte: new Date() },
    },
    include: {
      conversation: {
        include: {
          reservation: true,
          property: true,
          guest: true,
          tenant: true,
        },
      },
    },
  });
}

export async function getPendingReplyForConversation(conversationId: string, prisma: PrismaClient) {
  return prisma.pendingAiReply.findFirst({
    where: { conversationId, fired: false },
    include: {
      conversation: {
        include: {
          reservation: true,
          property: true,
          guest: true,
          tenant: true,
        },
      },
    },
  });
}

export async function markFired(id: string, prisma: PrismaClient): Promise<void> {
  await prisma.pendingAiReply.update({
    where: { id },
    data: { fired: true },
  });
}
