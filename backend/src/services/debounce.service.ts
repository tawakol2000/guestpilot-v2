/**
 * AI Debounce Service
 * Manages PendingAiReply records for the debounce window.
 * When a guest sends multiple messages, only one AI reply fires — after the LAST message.
 * Respects working hours: if outside working hours, defers scheduledAt to next window start.
 */

import { PrismaClient, TenantAiConfig } from '@prisma/client';
import { getTenantAiConfig } from './tenant-config.service';
import { broadcastToTenant } from './socket.service';
import { addAiReplyJob, removeAiReplyJob } from './queue.service';

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
    // Bugfix (2026-04-22): the previous implementation parsed
    // `toLocaleString('en-US', ...)` strings (e.g. "3/20/2026, 12:00:00 AM")
    // as Date inputs with an appended ` UTC` suffix. Those strings are
    // not spec-compliant Date inputs; Node parses them best-effort but
    // the resulting offsetMs was unreliable for many time zones,
    // especially across DST boundaries. nextWorkingHoursStart consumed
    // this offset to defer guest messages outside working hours, so a
    // broken offset → messages scheduled for the wrong local time
    // (sometimes hours off).
    //
    // New approach: use Intl.DateTimeFormat parts to read the local
    // year/month/day/hour/minute in the target timezone, then build
    // the corresponding UTC instant by adjusting until the formatter
    // round-trips to the desired local clock. Same approach
    // doc-handoff.service.ts:atLocalTime() already uses; this one
    // targets local midnight specifically.
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (t: string) => Number(dateParts.find((p) => p.type === t)?.value);
    const year = part('year');
    const month = part('month');
    const day = part('day');

    // Naively assume local midnight = UTC midnight on that calendar day,
    // then adjust by however much the formatter says we're off.
    const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const probed = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(naiveUtc));
    const probedH = Number(probed.find((p) => p.type === 'hour')?.value);
    const probedM = Number(probed.find((p) => p.type === 'minute')?.value);
    // Difference from desired (00:00) to what the formatter shows.
    // Note: probedH can be 24 in some Intl outputs at midnight; treat as 0.
    const normalisedProbedH = probedH === 24 ? 0 : probedH;
    const diffMinutes = (0 - normalisedProbedH) * 60 + (0 - probedM);
    return new Date(naiveUtc + diffMinutes * 60_000);
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

  // Copilot mode: near-instant suggestion (2s batch window only)
  try {
    const reservation = await prisma.reservation.findFirst({
      where: { conversations: { some: { id: conversationId } } },
      select: { aiMode: true },
    });
    if (reservation?.aiMode === 'copilot') {
      effectiveDelayMs = 2000; // 2s batch window for rapid messages
      console.log(`[Debounce] Copilot mode — instant suggestion (2s batch)`);
    }
  } catch { /* non-fatal */ }

  let scheduledAt: Date;
  if (isWithinWorkingHours(cfg, now)) {
    scheduledAt = new Date(now.getTime() + effectiveDelayMs);
  } else {
    // Outside working hours — defer all messages to next window open
    scheduledAt = nextWorkingHoursStart(cfg, now);
    console.log(`[Debounce] Outside working hours tenantId=${tenantId} — deferring to ${scheduledAt.toISOString()}`);
  }

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
    // Worker is currently processing — delete the old fired record and create a new pending one.
    // This ensures new messages are NOT dropped while the AI is mid-response.
    console.log(`[Debounce] Worker processing conv ${conversationId} — queuing follow-up reply`);
    await prisma.pendingAiReply.delete({ where: { id: activeFired.id } }).catch(() => {});
  }

  // Atomic upsert — eliminates findFirst+create/update race condition (FR-006)
  await prisma.pendingAiReply.upsert({
    where: { conversationId },
    create: { conversationId, tenantId, scheduledAt, fired: false },
    update: { scheduledAt, fired: false, suggestion: null },
  });

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
    where: { conversationId },
    data: { fired: true, suggestion: null },
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
