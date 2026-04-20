/**
 * Shared BuildTransaction helpers for the BUILD-mode `create_*` tools.
 *
 * Every BUILD-mode create_* tool optionally accepts a `transactionId` that
 * ties the write to a `plan_build_changes` approval. This module owns the
 * transaction state machine:
 *
 *   PLANNED ──first create_* reference──▶ EXECUTING
 *   EXECUTING ──all planned items written──▶ COMPLETED
 *   EXECUTING ──any create_* fails post-validation──▶ PARTIAL
 *   {COMPLETED, PARTIAL} ──POST /plan/:id/rollback──▶ ROLLED_BACK
 *
 * Only PLANNED and EXECUTING accept further writes. COMPLETED/PARTIAL/
 * ROLLED_BACK reject new writes so a half-broken or half-approved plan
 * can't silently accumulate items under the wrong id.
 */
import type { PrismaClient } from '@prisma/client';

export type BuildTransactionStatus =
  | 'PLANNED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'ROLLED_BACK';

export interface ValidatedTransaction {
  id: string;
  status: BuildTransactionStatus;
}

export async function validateBuildTransaction(
  prisma: PrismaClient,
  tenantId: string,
  transactionId: string | null | undefined
): Promise<
  | { ok: true; transaction: ValidatedTransaction | null }
  | { ok: false; error: string }
> {
  if (!transactionId) return { ok: true, transaction: null };

  const tx = await prisma.buildTransaction.findFirst({
    where: { id: transactionId, tenantId },
    select: { id: true, status: true },
  });
  if (!tx) {
    return {
      ok: false,
      error: `BuildTransaction ${transactionId} not found for this tenant. Call plan_build_changes first, or drop transactionId for an un-tracked write.`,
    };
  }
  const status = tx.status as BuildTransactionStatus;
  if (status === 'COMPLETED' || status === 'PARTIAL' || status === 'ROLLED_BACK') {
    return {
      ok: false,
      error: `BuildTransaction ${transactionId} is ${status} — cannot add more items. Create a fresh plan with plan_build_changes for additional artifacts.`,
    };
  }
  // Flip PLANNED → EXECUTING on first create_* reference so telemetry
  // shows when execution actually began vs just planning.
  if (status === 'PLANNED') {
    await prisma.buildTransaction
      .update({
        where: { id: transactionId },
        data: { status: 'EXECUTING' },
      })
      .catch(() => {
        /* race-safe: another call beat us to the flip */
      });
    return { ok: true, transaction: { id: tx.id, status: 'EXECUTING' } };
  }
  return { ok: true, transaction: { id: tx.id, status } };
}

/**
 * Called by each create_* tool after a successful write. Counts child
 * rows linked to the transaction; once the count reaches plannedItems
 * length, flips EXECUTING → COMPLETED. Best-effort — failures are
 * swallowed so a telemetry hiccup never blocks a legitimate write.
 */
export async function finalizeBuildTransactionIfComplete(
  prisma: PrismaClient,
  tenantId: string,
  transactionId: string | null | undefined
): Promise<{ completed: boolean; writeCount: number; plannedCount: number }> {
  if (!transactionId) return { completed: false, writeCount: 0, plannedCount: 0 };
  try {
    const tx = await prisma.buildTransaction.findFirst({
      where: { id: transactionId, tenantId },
      select: {
        id: true,
        status: true,
        plannedItems: true,
        _count: {
          select: {
            sopVariants: true,
            sopPropertyOverrides: true,
            faqEntries: true,
            toolDefinitions: true,
            aiConfigVersions: true,
          },
        },
      },
    });
    if (!tx) return { completed: false, writeCount: 0, plannedCount: 0 };
    const plannedCount = Array.isArray(tx.plannedItems)
      ? (tx.plannedItems as unknown[]).length
      : 0;
    const counts = tx._count ?? {
      sopVariants: 0,
      sopPropertyOverrides: 0,
      faqEntries: 0,
      toolDefinitions: 0,
      aiConfigVersions: 0,
    };
    const writeCount =
      (counts.sopVariants ?? 0) +
      (counts.sopPropertyOverrides ?? 0) +
      (counts.faqEntries ?? 0) +
      (counts.toolDefinitions ?? 0) +
      (counts.aiConfigVersions ?? 0);
    const status = tx.status as BuildTransactionStatus;
    const terminal =
      status === 'COMPLETED' ||
      status === 'PARTIAL' ||
      status === 'ROLLED_BACK';
    if (terminal) {
      return {
        completed: status === 'COMPLETED',
        writeCount,
        plannedCount,
      };
    }
    if (plannedCount > 0 && writeCount >= plannedCount) {
      await prisma.buildTransaction
        .update({
          where: { id: transactionId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        })
        .catch(() => {
          /* race-safe: another call beat us to the flip */
        });
      return { completed: true, writeCount, plannedCount };
    }
    return { completed: false, writeCount, plannedCount };
  } catch (err) {
    console.warn('[finalizeBuildTransactionIfComplete] failed:', err);
    return { completed: false, writeCount: 0, plannedCount: 0 };
  }
}

/**
 * Called by each create_* tool when a write fails post-validation. Marks
 * the transaction PARTIAL and stamps a short diagnostic onto `rationale`
 * so the UI / audit log preserves which tool failed. Terminal
 * transactions are left alone. No-ops if transactionId is null.
 */
export async function markBuildTransactionPartial(
  prisma: PrismaClient,
  tenantId: string,
  transactionId: string | null | undefined,
  diagnostic: { failedTool: string; message: string }
): Promise<void> {
  if (!transactionId) return;
  try {
    const tx = await prisma.buildTransaction.findFirst({
      where: { id: transactionId, tenantId },
      select: { id: true, status: true, rationale: true },
    });
    if (!tx) return;
    const status = tx.status as BuildTransactionStatus;
    if (status === 'COMPLETED' || status === 'PARTIAL' || status === 'ROLLED_BACK') {
      return;
    }
    const stamp = `[PARTIAL ${new Date().toISOString()}] ${diagnostic.failedTool}: ${diagnostic.message.slice(0, 300)}`;
    const merged = tx.rationale ? `${tx.rationale}\n${stamp}` : stamp;
    await prisma.buildTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'PARTIAL',
        completedAt: new Date(),
        rationale: merged.slice(0, 2000),
      },
    });
  } catch (err) {
    console.warn('[markBuildTransactionPartial] failed:', err);
  }
}
