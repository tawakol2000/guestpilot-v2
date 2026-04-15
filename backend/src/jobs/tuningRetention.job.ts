/**
 * Feature 041 sprint 05 §4 — appliedAndRetained7d retention job.
 *
 * Closes the loop on the column pre-wired in sprint 01. Once a day, find every
 * ACCEPTED TuningSuggestion whose `appliedAt` is between 7 and 8 days ago and
 * decide whether the resulting artifact edit is still in effect.
 *
 * Retention rule (intentionally conservative):
 *   - If a NEWER ACCEPTED suggestion targeting the same artifact exists since
 *     the candidate's appliedAt → not retained (the candidate was overwritten
 *     or reversed).
 *   - Otherwise → retained.
 *
 * Idempotent: re-runs leave the same answer in place. Cheap: indexed scans on
 * (tenantId, status, appliedAt) + a single per-target lookup.
 */
import { PrismaClient, TuningActionType } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

export function startTuningRetentionJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[TuningRetention] Job started (interval: 24h, 7d window)');

  // First run after 90s so it doesn't pile onto cold-start work.
  setTimeout(async () => {
    await runRetentionSweep(prisma);
  }, 90_000);

  return setInterval(async () => {
    await runRetentionSweep(prisma);
  }, 24 * 60 * 60 * 1000);
}

export async function runRetentionSweep(prisma: PrismaClient): Promise<{
  scanned: number;
  retained: number;
  reverted: number;
}> {
  const now = Date.now();
  const upper = new Date(now - 7 * DAY_MS);
  const lower = new Date(now - 8 * DAY_MS);

  let scanned = 0;
  let retained = 0;
  let reverted = 0;

  try {
    const candidates = await prisma.tuningSuggestion.findMany({
      where: {
        status: 'ACCEPTED',
        appliedAt: { gte: lower, lte: upper },
        // appliedAndRetained7d may already be set — re-evaluate idempotently.
      },
      select: {
        id: true,
        tenantId: true,
        actionType: true,
        sopCategory: true,
        sopStatus: true,
        sopPropertyId: true,
        faqEntryId: true,
        systemPromptVariant: true,
        appliedAt: true,
        appliedAndRetained7d: true,
      },
    });

    for (const c of candidates) {
      scanned++;
      const isRetained = await evaluateRetention(prisma, c);
      if (isRetained === c.appliedAndRetained7d) {
        // No change — skip the write.
        if (isRetained) retained++;
        else reverted++;
        continue;
      }
      try {
        await prisma.tuningSuggestion.update({
          where: { id: c.id },
          data: { appliedAndRetained7d: isRetained },
        });
      } catch (err) {
        console.warn('[TuningRetention] update failed for', c.id, err);
        continue;
      }
      if (isRetained) retained++;
      else reverted++;
    }

    if (scanned > 0) {
      console.log(
        `[TuningRetention] Sweep complete: scanned=${scanned} retained=${retained} reverted=${reverted}`
      );
    }
    return { scanned, retained, reverted };
  } catch (err: any) {
    console.error('[TuningRetention] sweep failed:', err?.message ?? err);
    return { scanned, retained, reverted };
  }
}

interface RetentionCandidate {
  id: string;
  tenantId: string;
  actionType: TuningActionType;
  sopCategory: string | null;
  sopStatus: string | null;
  sopPropertyId: string | null;
  faqEntryId: string | null;
  systemPromptVariant: string | null;
  appliedAt: Date | null;
}

/**
 * Returns true if the artifact edit from this suggestion is still in effect
 * 7d later. Heuristic: if any newer ACCEPTED suggestion targets the same
 * artifact (same SOP variant, same FAQ entry, same system prompt variant),
 * the original was overwritten — count as not retained.
 */
async function evaluateRetention(
  prisma: PrismaClient,
  c: RetentionCandidate
): Promise<boolean> {
  if (!c.appliedAt) return true;
  const newerWhere: any = {
    tenantId: c.tenantId,
    status: 'ACCEPTED',
    appliedAt: { gt: c.appliedAt },
    actionType: c.actionType,
    NOT: { id: c.id },
  };
  switch (c.actionType) {
    case 'EDIT_SYSTEM_PROMPT':
      if (!c.systemPromptVariant) return true; // can't decide; assume retained
      newerWhere.systemPromptVariant = c.systemPromptVariant;
      break;
    case 'EDIT_FAQ':
      if (!c.faqEntryId) return true;
      newerWhere.faqEntryId = c.faqEntryId;
      break;
    case 'EDIT_SOP_CONTENT':
    case 'EDIT_SOP_ROUTING':
    case 'CREATE_SOP':
      if (!c.sopCategory) return true;
      newerWhere.sopCategory = c.sopCategory;
      if (c.sopStatus) newerWhere.sopStatus = c.sopStatus;
      if (c.sopPropertyId) newerWhere.sopPropertyId = c.sopPropertyId;
      break;
    case 'CREATE_FAQ':
      // A creation is retained unless the created FAQ has been ARCHIVED.
      if (!c.faqEntryId) return true;
      try {
        const faq = await prisma.faqEntry.findUnique({
          where: { id: c.faqEntryId },
          select: { status: true },
        });
        if (!faq) return false; // entry deleted
        return faq.status !== 'ARCHIVED';
      } catch {
        return true; // pessimistic-safe: assume retained
      }
    default:
      return true;
  }
  const newer = await prisma.tuningSuggestion.findFirst({
    where: newerWhere,
    select: { id: true },
  });
  return newer === null;
}
