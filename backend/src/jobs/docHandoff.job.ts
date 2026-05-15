/**
 * Feature 044: Doc-handoff polling job.
 * 2-minute tick (matches plan.md decision). Wraps evaluateDueRows in try/catch so one bad tick
 * never crashes the process. Fires-and-forgets — failures logged per-row inside the evaluator.
 */
import { PrismaClient } from '@prisma/client';
import { evaluateDueRows } from '../services/doc-handoff.service';
import { DOC_HANDOFF_TICK_MS } from '../config/doc-handoff-defaults';

export function startDocHandoffJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log(`[DocHandoff] Polling job started (interval: ${DOC_HANDOFF_TICK_MS / 1000}s)`);

  // 2026-05-15 M8: overlap guard — mirror messageSync.job.ts. A slow tick
  // (WAsender timeout across many due rows) used to stack subsequent
  // ticks on top, holding DB connections and inflating claimRaces.
  let running = false;
  const guarded = async () => {
    if (running) {
      console.warn('[DocHandoff] previous tick still running — skipping this tick');
      return;
    }
    running = true;
    try {
      await runTick(prisma);
    } finally {
      running = false;
    }
  };

  // Run once ~30s after boot to clear any backlog without competing with other startup tasks.
  setTimeout(guarded, 30_000);

  return setInterval(guarded, DOC_HANDOFF_TICK_MS);
}

async function runTick(prisma: PrismaClient): Promise<void> {
  try {
    const result = await evaluateDueRows(prisma);
    if (result.scanned > 0) {
      console.log(
        `[DocHandoff] tick — scanned=${result.scanned} sent=${result.sent} deferred=${result.deferred} failed=${result.failed} skipped=${result.skipped} claimRaces=${result.claimRaces}`
      );
    }
  } catch (err: any) {
    console.error('[DocHandoff] tick failed:', err?.message ?? err);
  }
}
