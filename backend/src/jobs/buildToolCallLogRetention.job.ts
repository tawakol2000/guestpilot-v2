/**
 * Sprint 047 Session B — BuildToolCallLog retention sweep.
 *
 * Once per day, delete BuildToolCallLog rows older than `RETENTION_DAYS`
 * in bounded batches so a large backlog never holds a lock long. The
 * delete helper in `build-tool-call-log.service.ts` does the actual id-
 * then-delete — this job is just the scheduler + batch loop.
 *
 * Shape mirrors `tuningRetention.job.ts`: `setTimeout` for the first
 * run (aimed at a low-traffic hour), then `setInterval` 24h. Failures
 * log to stderr and never crash the host process per CLAUDE.md rule 2.
 */
import type { PrismaClient } from '@prisma/client';
import { deleteOldToolCalls } from '../services/build-tool-call-log.service';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = 30;
export const BATCH_SIZE = 10_000;
/** Safety cap: even a huge backlog can't spin here forever. */
const MAX_BATCHES_PER_RUN = 50;
/** Target wall-clock hour (UTC) for the sweep — low-traffic for a US+EU tenant base. */
const TARGET_HOUR_UTC = 3;

export function startBuildToolCallLogRetentionJob(
  prisma: PrismaClient
): NodeJS.Timeout {
  const firstDelay = msUntilNextTargetHour(new Date(), TARGET_HOUR_UTC);
  console.log(
    `[BuildToolCallLogRetention] Job started (interval: 24h, first run in ${Math.round(
      firstDelay / 60_000
    )}m, retention: ${RETENTION_DAYS}d)`
  );

  setTimeout(() => {
    void runRetentionSweep(prisma);
  }, firstDelay);

  return setInterval(() => {
    void runRetentionSweep(prisma);
  }, DAY_MS);
}

export async function runRetentionSweep(
  prisma: PrismaClient,
  opts: { retentionDays?: number; batchSize?: number; now?: Date } = {}
): Promise<{ deleted: number; batches: number; truncated: boolean }> {
  const retentionDays = opts.retentionDays ?? RETENTION_DAYS;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = new Date(now - retentionDays * DAY_MS);

  let totalDeleted = 0;
  let batches = 0;
  let truncated = false;

  try {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const deleted = await deleteOldToolCalls(prisma, cutoff, batchSize);
      if (deleted === 0) break;
      totalDeleted += deleted;
      batches++;
      if (deleted < batchSize) break; // drained
    }
    if (batches >= MAX_BATCHES_PER_RUN) {
      truncated = true;
      console.warn(
        `[BuildToolCallLogRetention] Hit MAX_BATCHES_PER_RUN=${MAX_BATCHES_PER_RUN}; ${totalDeleted} rows deleted, more remain for next run`
      );
    }
    if (totalDeleted > 0) {
      console.log(
        `[BuildToolCallLogRetention] Sweep complete: deleted=${totalDeleted} batches=${batches} cutoff=${cutoff.toISOString()}`
      );
    }
  } catch (err: any) {
    console.error('[BuildToolCallLogRetention] sweep failed:', err?.message ?? err);
  }

  return { deleted: totalDeleted, batches, truncated };
}

/**
 * Milliseconds from `from` until the next wall-clock instance of
 * `hourUtc:00:00`. Always returns a strictly-positive value.
 */
function msUntilNextTargetHour(from: Date, hourUtc: number): number {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, 0, 0, 0)
  );
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - from.getTime();
}
