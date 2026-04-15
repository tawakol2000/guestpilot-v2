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
  try {
    const existing = await prisma.tuningCategoryStats.findUnique({
      where: { tenantId_category: { tenantId, category } },
      select: { acceptRateEma: true, acceptCount: true, rejectCount: true },
    });
    const oldEma = existing?.acceptRateEma ?? 0;
    const newEma = ALPHA * (accepted ? 1 : 0) + (1 - ALPHA) * oldEma;
    await prisma.tuningCategoryStats.upsert({
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
  } catch (err) {
    // Stats update must never break accept/reject.
    console.warn(
      `[CategoryStats] EMA update failed (non-fatal) tenant=${tenantId} category=${category}:`,
      err
    );
  }
}
