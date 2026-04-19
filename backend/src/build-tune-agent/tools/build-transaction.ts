/**
 * Shared BuildTransaction helpers for the BUILD-mode `create_*` tools.
 *
 * Every BUILD-mode create_* tool optionally accepts a `transactionId` that
 * ties the write to a `plan_build_changes` approval. This helper validates
 * that id at write time:
 *   - tenant-scoped (no cross-tenant smuggling)
 *   - status must be PLANNED or EXECUTING (not COMPLETED/PARTIAL/ROLLED_BACK)
 *   - on first use we flip PLANNED → EXECUTING so the state transition is
 *     observable in telemetry
 *
 * Returns the validated id or null (no transaction). Rejects with an
 * `asError` payload caller-side on invalid state — tools propagate the
 * error straight back to the agent.
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
