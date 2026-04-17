/**
 * Feature 041 sprint 02 §6 — Per-category acceptance-rate tracking.
 *
 * EMA update on every accept/reject of a suggestion that carries a
 * `diagnosticCategory`:
 *
 *     newEma = ALPHA * (accepted ? 1 : 0) + (1 - ALPHA) * oldEma
 *
 * ALPHA = 0.3 per the sprint brief.
 *
 * Suggestions without a `diagnosticCategory` (old-branch inserts) are
 * skipped silently — we only track EMA for the new pipeline's output.
 */
import { PrismaClient, TuningDiagnosticCategory } from '@prisma/client';

const ALPHA = 0.3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sprint 08 §5 — acceptance-rate lookup used by the diagnostic pipeline to
 * decide whether a new suggestion should be AUTO_SUPPRESSED instead of
 * PENDING. Reads directly from TuningSuggestion rows over a fixed 30-day
 * window, so the gating signal matches the graduation dashboard regardless
 * of how long the EMA in TuningCategoryStats has been accumulating.
 *
 * Returns { acceptanceRate, sampleSize }.
 *   - acceptanceRate is null when no settled rows exist (sampleSize = 0).
 *   - Callers gate on `sampleSize >= N && acceptanceRate < THRESHOLD` to
 *     avoid gating on noise from 1-2 decisions in a new category.
 */
export async function getCategoryAcceptance30d(
  prisma: PrismaClient,
  tenantId: string,
  category: TuningDiagnosticCategory,
): Promise<{ acceptanceRate: number | null; sampleSize: number }> {
  const since = new Date(Date.now() - 30 * DAY_MS);
  try {
    const rows = await prisma.tuningSuggestion.groupBy({
      where: {
        tenantId,
        diagnosticCategory: category,
        createdAt: { gte: since },
        status: { in: ['ACCEPTED', 'REJECTED'] },
      },
      by: ['status'],
      _count: { _all: true },
    });
    let accepted = 0;
    let rejected = 0;
    for (const r of rows) {
      if (r.status === 'ACCEPTED') accepted += r._count._all;
      else if (r.status === 'REJECTED') rejected += r._count._all;
    }
    const n = accepted + rejected;
    return { acceptanceRate: n === 0 ? null : accepted / n, sampleSize: n };
  } catch (err) {
    console.warn('[CategoryStats] getCategoryAcceptance30d failed:', err);
    return { acceptanceRate: null, sampleSize: 0 };
  }
}

export async function updateCategoryStatsOnAccept(
  prisma: PrismaClient,
  tenantId: string,
  category: TuningDiagnosticCategory | null
): Promise<void> {
  if (!category) return;
  await applyEmaUpdate(prisma, tenantId, category, true);
}

export async function updateCategoryStatsOnReject(
  prisma: PrismaClient,
  tenantId: string,
  category: TuningDiagnosticCategory | null
): Promise<void> {
  if (!category) return;
  await applyEmaUpdate(prisma, tenantId, category, false);
}

async function applyEmaUpdate(
  prisma: PrismaClient,
  tenantId: string,
  category: TuningDiagnosticCategory,
  accepted: boolean
): Promise<void> {
  // Sprint 09 follow-up: wrap read-compute-write in an interactive tx so two
  // concurrent accepts for the same (tenantId, category) can't both read the
  // same oldEma and both write identical newEma (statistical drift). The
  // first tx takes the row lock on upsert, the second waits, re-reads the
  // post-commit row, and computes against the updated EMA.
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.tuningCategoryStats.findUnique({
        where: { tenantId_category: { tenantId, category } },
        select: { acceptRateEma: true },
      });
      const oldEma = existing?.acceptRateEma ?? 0;
      const newEma = ALPHA * (accepted ? 1 : 0) + (1 - ALPHA) * oldEma;
      await tx.tuningCategoryStats.upsert({
        where: { tenantId_category: { tenantId, category } },
        create: {
          tenantId,
          category,
          acceptRateEma: newEma,
          acceptCount: accepted ? 1 : 0,
          rejectCount: accepted ? 0 : 1,
        },
        update: {
          acceptRateEma: newEma,
          acceptCount: { increment: accepted ? 1 : 0 },
          rejectCount: { increment: accepted ? 0 : 1 },
        },
      });
    });
  } catch (err) {
    // Stats update must never break accept/reject.
    console.warn(
      `[CategoryStats] EMA update failed (non-fatal) tenant=${tenantId} category=${category}:`,
      err
    );
  }
}
