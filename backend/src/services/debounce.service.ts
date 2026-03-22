/**
 * AI Debounce Service
 * Manages PendingAiReply records for the debounce window.
 * When a guest sends multiple messages, only one AI reply fires — after the LAST message.
 * Respects working hours: if outside working hours, defers scheduledAt to next window start.
 */

import { PrismaClient, TenantAiConfig } from '@prisma/client';
import { getTenantAiConfig } from './tenant-config.service';
import { broadcastToTenant } from './sse.service';
import { addAiReplyJob, removeAiReplyJob } from './queue.service';

const POLL_INTERVAL_MS = 30 * 1000; // job polls every 30s — added to expectedAt for accurate countdown

// ── Working hours helpers ─────────────────────────────────────────────────────

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

function getLocalMinutes(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
  } catch {
    // Fallback to UTC if timezone is invalid
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function getTodayMidnightInTimezone(now: Date, timezone: string): Date {
  try {
    // Get the local date string in the target timezone (e.g. "2025-03-16")
    const localDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);

    // Determine the UTC offset at that local midnight by comparing two interpretations
    const nominalMidnight = new Date(`${localDateStr}T00:00:00Z`); // treated as UTC
    const offsetProbe = new Date(
      new Date(`${localDateStr}T00:00:00`).toLocaleString('en-US', { timeZone: timezone }) + ' UTC'
    );
    const utcProbe = new Date(
      new Date(`${localDateStr}T00:00:00`).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC'
    );
    const offsetMs = utcProbe.getTime() - offsetProbe.getTime();
    return new Date(nominalMidnight.getTime() + offsetMs);
  } catch {
    // Fallback: UTC midnight
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

function isWithinWorkingHours(cfg: TenantAiConfig, now: Date): boolean {
  if (!cfg.workingHoursEnabled) return true;
  const current = getLocalMinutes(now, cfg.workingHoursTimezone);
  const { h: sh, m: sm } = parseHHMM(cfg.workingHoursStart);
  const { h: eh, m: em } = parseHHMM(cfg.workingHoursEnd);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin <= endMin) {
    // Same day window: e.g. 08:00–22:00
    return current >= startMin && current < endMin;
  } else {
    // Wraps midnight: e.g. 08:00–01:00 (active until 1 AM next day)
    return current >= startMin || current < endMin;
  }
}

function nextWorkingHoursStart(cfg: TenantAiConfig, now: Date): Date {
  const { h: sh, m: sm } = parseHHMM(cfg.workingHoursStart);
  const startMin = sh * 60 + sm;
  const currentMin = getLocalMinutes(now, cfg.workingHoursTimezone);

  const todayMidnight = getTodayMidnightInTimezone(now, cfg.workingHoursTimezone);
  const todayStart = new Date(todayMidnight.getTime() + startMin * 60 * 1000);

  if (currentMin < startMin) {
    // Working hours start later today
    return todayStart;
  } else {
    // Working hours start tomorrow
    return new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scheduleAiReply(
  conversationId: string,
  tenantId: string,
  prisma: PrismaClient
): Promise<void> {
  const cfg = await getTenantAiConfig(tenantId, prisma);
  const now = new Date();

  // ── Adaptive debounce: extend delay when guest sends rapid-fire messages ───
  let effectiveDelayMs = cfg.debounceDelayMs;
  if (cfg.adaptiveDebounce) {
    try {
      const sixtySecondsAgo = new Date(now.getTime() - 60_000);
      const recentGuestMessages = await prisma.message.count({
        where: {
          conversationId,
          role: 'GUEST',
          sentAt: { gte: sixtySecondsAgo },
        },
      });
      if (recentGuestMessages >= 6) {
        effectiveDelayMs = cfg.debounceDelayMs * 6;
        console.log(`[Debounce] Adaptive: 6+ messages in 60s (${recentGuestMessages}) — delay x6 → ${effectiveDelayMs}ms`);
      } else if (recentGuestMessages >= 3) {
        effectiveDelayMs = cfg.debounceDelayMs * 3;
        console.log(`[Debounce] Adaptive: 3-5 messages in 60s (${recentGuestMessages}) — delay x3 → ${effectiveDelayMs}ms`);
      }
    } catch (err) {
      // Non-fatal — fall back to base delay
      console.warn('[Debounce] Adaptive debounce query failed (non-fatal):', err);
    }
  }

  let scheduledAt: Date;
  if (isWithinWorkingHours(cfg, now)) {
    scheduledAt = new Date(now.getTime() + effectiveDelayMs);
  } else {
    // Outside working hours — defer all messages to next window open
    scheduledAt = nextWorkingHoursStart(cfg, now);
    console.log(`[Debounce] Outside working hours tenantId=${tenantId} — deferring to ${scheduledAt.toISOString()}`);
  }

  // expectedAt = when the AI will actually fire (scheduledAt + up to one poll cycle)
  const expectedAt = new Date(scheduledAt.getTime() + POLL_INTERVAL_MS);

  // Cleanup old completed (fired) records — but only if they were scheduled more than 60s ago
  // to avoid deleting a record that a worker is currently processing
  const oldFiredCutoff = new Date(now.getTime() - 60000);
  await prisma.pendingAiReply.deleteMany({
    where: { conversationId, fired: true, scheduledAt: { lt: oldFiredCutoff } },
  });

  // Check if there's a currently active (fired) pending reply — if so, don't reset it
  // This prevents re-triggering while a worker is mid-processing
  const activeFired = await prisma.pendingAiReply.findFirst({
    where: { conversationId, fired: true },
  });

  if (activeFired) {
    // Worker is currently processing — create a NEW pending reply instead of resetting
    // The unique constraint is on conversationId, so we can't upsert with fired: false
    // Just log and let the current response handle the accumulated messages
    console.log(`[Debounce] Worker already processing conv ${conversationId} — skipping re-schedule`);
    return;
  }

  // Atomic upsert — eliminates findFirst+create/update race condition (FR-006)
  await prisma.pendingAiReply.upsert({
    where: { conversationId },
    create: { conversationId, tenantId, scheduledAt, fired: false },
    update: { scheduledAt, fired: false },
  });

  // Broadcast typing indicator to browser
  broadcastToTenant(tenantId, 'ai_typing', { conversationId, expectedAt: expectedAt.toISOString() });

  // Also enqueue in BullMQ (if Redis available) — fire-and-forget, never breaks DB debounce
  addAiReplyJob(conversationId, tenantId, effectiveDelayMs).catch(err =>
    console.warn('[Debounce] BullMQ enqueue failed (non-fatal):', err)
  );
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

  // Also cancel BullMQ job if Redis available
  removeAiReplyJob(conversationId).catch(err =>
    console.warn('[Debounce] BullMQ cancel failed (non-fatal):', err)
  );
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
