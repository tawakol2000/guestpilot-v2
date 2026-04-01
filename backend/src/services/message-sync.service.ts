/**
 * Message Sync Service — Fetches messages from Hostaway and merges missing ones into local DB.
 *
 * Three triggers call this same function:
 *   1. Pre-response sync — before AI generates a reply (ai.service.ts)
 *   2. Background sync   — every 2 min for active conversations (messageSync.job.ts)
 *   3. On-demand sync    — when manager opens a conversation or clicks sync indicator
 *
 * Core principles:
 *   - Never modify or remove local messages (AI, private notes)
 *   - Deduplicate by hostawayMessageId (Set-based in-memory diff)
 *   - Fuzzy AI match for outgoing messages (±60s, first 100 chars)
 *   - Graceful failure — never block the AI from responding
 *   - Idempotent — running twice produces the same result
 */

import { PrismaClient, MessageRole, Channel } from '@prisma/client';
import * as hostawayService from './hostaway.service';
import { broadcastCritical } from './socket.service';

// ── Stats tracking ───────────────────────────────────────────────────────────

let _callCount = 0;
let _syncedMessages = 0;
let _backfilledCount = 0;
let _skipCount = 0;
let _errorCount = 0;
let _totalDurationMs = 0;

export function getMessageSyncStats() {
  return {
    calls: _callCount,
    syncedMessages: _syncedMessages,
    backfilled: _backfilledCount,
    skips: _skipCount,
    errors: _errorCount,
    avgDurationMs: _callCount > 0 ? Math.round(_totalDurationMs / _callCount) : 0,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseHostawayDate(val: unknown): Date {
  if (!val) return new Date();
  if (typeof val === 'number') {
    return val > 1e12 ? new Date(val) : new Date(val * 1000);
  }
  if (typeof val === 'string') {
    const iso = val.replace(' ', 'T');
    return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  }
  return new Date();
}

// ── Core sync function ──────────────────────────────────────────────────────

export interface SyncOptions {
  force?: boolean; // bypass 30s cooldown
}

export interface SyncResult {
  newMessages: number;
  backfilled: number;
  skipped: boolean;
  reason?: string;
  hostRespondedAfterGuest: boolean;
  syncedAt?: string;
  lastSyncedAt?: string;
}

export async function syncConversationMessages(
  prisma: PrismaClient,
  conversationId: string,
  hostawayConversationId: string,
  tenantId: string,
  hostawayAccountId: string,
  hostawayApiKey: string,
  options?: SyncOptions,
): Promise<SyncResult> {
  _callCount++;
  const startMs = Date.now();

  try {
    // Skip if no Hostaway conversation ID
    if (!hostawayConversationId) {
      _skipCount++;
      return { newMessages: 0, backfilled: 0, skipped: true, reason: 'no-hostaway-conversation-id', hostRespondedAfterGuest: false };
    }

    // Cooldown check: skip if synced within last 30 seconds (unless force)
    if (!options?.force) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { lastSyncedAt: true },
      });
      if (conversation?.lastSyncedAt) {
        const elapsed = Date.now() - conversation.lastSyncedAt.getTime();
        if (elapsed < 30_000) {
          _skipCount++;
          const durationMs = Date.now() - startMs;
          _totalDurationMs += durationMs;
          return {
            newMessages: 0, backfilled: 0, skipped: true,
            reason: 'recently-synced', hostRespondedAfterGuest: false,
            lastSyncedAt: conversation.lastSyncedAt.toISOString(),
          };
        }
      }
    }

    // Fetch messages from Hostaway (max 100, with 2s timeout via retryWithBackoff)
    const { result: hostawayMessages } = await hostawayService.listConversationMessages(
      hostawayAccountId, hostawayApiKey, hostawayConversationId, 100
    );

    if (!hostawayMessages || hostawayMessages.length === 0) {
      await prisma.conversation.update({ where: { id: conversationId }, data: { lastSyncedAt: new Date() } });
      const durationMs = Date.now() - startMs;
      _totalDurationMs += durationMs;
      return { newMessages: 0, backfilled: 0, skipped: false, hostRespondedAfterGuest: false, syncedAt: new Date().toISOString() };
    }

    // Load local messages for diff
    const localMessages = await prisma.message.findMany({
      where: { conversationId },
      select: { id: true, hostawayMessageId: true, role: true, content: true, sentAt: true },
    });

    // Build Set of local hostawayMessageIds for O(1) lookup
    const localIdSet = new Set<string>();
    for (const msg of localMessages) {
      if (msg.hostawayMessageId && msg.hostawayMessageId !== '') {
        localIdSet.add(msg.hostawayMessageId);
      }
    }

    // Local AI messages for fuzzy matching (outgoing messages without hostawayMessageId)
    const localAiMessages = localMessages.filter(
      m => m.role === MessageRole.AI && (!m.hostawayMessageId || m.hostawayMessageId === '')
    );

    // Load conversation for channel info
    const convWithReservation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channel: true, lastMessageAt: true, unreadCount: true },
    });
    const defaultChannel = convWithReservation?.channel || Channel.OTHER;

    let newMessages = 0;
    let newGuestMessages = 0;
    let backfilled = 0;
    let latestSyncedSentAt: Date | null = null;
    let hostRespondedAfterGuest = false;
    let latestHostSentAt: Date | null = null;

    for (const hwMsg of hostawayMessages) {
      if (!hwMsg.body && !hwMsg.id) continue;

      const hostawayMsgId = String(hwMsg.id);
      if (!hostawayMsgId || hostawayMsgId === '') continue;

      // Already have this message
      if (localIdSet.has(hostawayMsgId)) continue;

      const isIncoming = hwMsg.isIncoming === 1;
      const sentAt = parseHostawayDate(
        hwMsg.insertedOn ?? hwMsg.createdAt ?? (hwMsg as Record<string, unknown>)['date']
      );
      const content = hwMsg.body || '';
      const commType = ((hwMsg as Record<string, unknown>).communicationType as string | undefined)?.toLowerCase();
      const msgChannel = commType === 'whatsapp' ? Channel.WHATSAPP : defaultChannel;

      if (!isIncoming) {
        // Outgoing message — check if it's our AI message (fuzzy match)
        const contentPrefix = content.substring(0, 100);
        const matchingAi = localAiMessages.find(ai => {
          const timeDiff = Math.abs(sentAt.getTime() - ai.sentAt.getTime());
          if (timeDiff > 60_000) return false; // ±60 seconds
          const aiPrefix = (ai.content || '').substring(0, 100);
          return aiPrefix === contentPrefix;
        });

        if (matchingAi) {
          // Backfill hostawayMessageId on existing AI message
          await prisma.message.update({
            where: { id: matchingAi.id },
            data: { hostawayMessageId: hostawayMsgId },
          });
          backfilled++;
          // Remove from fuzzy match pool so it's not matched again
          const idx = localAiMessages.indexOf(matchingAi);
          if (idx >= 0) localAiMessages.splice(idx, 1);
          localIdSet.add(hostawayMsgId);
          continue;
        }

        // Not our AI message — it's a manager message sent directly
        latestHostSentAt = (!latestHostSentAt || sentAt.getTime() > latestHostSentAt.getTime()) ? sentAt : latestHostSentAt;
      }

      // Insert the missing message
      const role = isIncoming ? MessageRole.GUEST : MessageRole.HOST;

      try {
        const created = await prisma.message.create({
          data: {
            conversationId,
            tenantId,
            role,
            content,
            channel: msgChannel,
            communicationType: commType || 'channel',
            sentAt,
            hostawayMessageId: hostawayMsgId,
            imageUrls: (hwMsg.imagesUrls as string[] | undefined) || [],
          },
        });

        newMessages++;
        if (role === MessageRole.GUEST) newGuestMessages++;
        localIdSet.add(hostawayMsgId);

        // Track latest synced message timestamp
        if (!latestSyncedSentAt || sentAt > latestSyncedSentAt) {
          latestSyncedSentAt = sentAt;
        }

        // Broadcast the new message
        broadcastCritical(tenantId, 'message', {
          conversationId,
          message: {
            id: created.id,
            role: created.role,
            content: created.content,
            sentAt: created.sentAt.toISOString(),
            channel: created.channel,
            imageUrls: created.imageUrls,
          },
          lastMessageRole: created.role,
          lastMessageAt: created.sentAt.toISOString(),
        });
      } catch (err: any) {
        // P2002 = unique constraint violation (race with webhook) — skip
        if (err?.code === 'P2002') {
          localIdSet.add(hostawayMsgId);
          continue;
        }
        throw err;
      }
    }

    // Update conversation metadata
    const updateData: Record<string, unknown> = { lastSyncedAt: new Date() };

    // Update lastMessageAt if synced messages are newer
    if (latestSyncedSentAt && convWithReservation?.lastMessageAt) {
      if (latestSyncedSentAt > convWithReservation.lastMessageAt) {
        updateData.lastMessageAt = latestSyncedSentAt;
      }
    }

    // Increment unreadCount for synced GUEST messages
    if (newGuestMessages > 0) {
      updateData.unreadCount = (convWithReservation?.unreadCount || 0) + newGuestMessages;
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: updateData as any,
    });

    // Check if host responded after guest (for AI cancellation)
    if (latestHostSentAt) {
      // Check if there are pending guest messages that came before the host response
      const latestGuestMsg = localMessages
        .filter(m => m.role === MessageRole.GUEST)
        .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];

      if (latestGuestMsg && latestHostSentAt > latestGuestMsg.sentAt) {
        hostRespondedAfterGuest = true;
      }
    }

    const durationMs = Date.now() - startMs;
    _totalDurationMs += durationMs;
    _syncedMessages += newMessages;
    _backfilledCount += backfilled;

    if (newMessages > 0 || backfilled > 0) {
      console.log(`[MessageSync] conv=${conversationId} new=${newMessages} backfilled=${backfilled} host_responded=${hostRespondedAfterGuest} [${durationMs}ms]`);
    }

    return {
      newMessages, backfilled, skipped: false,
      hostRespondedAfterGuest,
      syncedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    _errorCount++;
    const durationMs = Date.now() - startMs;
    _totalDurationMs += durationMs;
    console.warn(`[MessageSync] Failed (non-fatal) conv=${conversationId}: ${err.message}`);
    return { newMessages: 0, backfilled: 0, skipped: true, reason: 'sync-error', hostRespondedAfterGuest: false };
  }
}
