'use client'

/**
 * Sprint 045 Gate 6 — transaction history. Backend today exposes only the
 * most recent BuildTransaction via /api/build/tenant-state
 * (lastBuildTransaction). Listing more than one would require a new
 * endpoint, which is out of scope for Gate 6 per the session-5 hard
 * constraint ("Do not modify backend files — Gate 5 API is locked").
 *
 * So we render a single row for the last transaction with a Roll back
 * button. When session 6 ships a `/api/build/transactions` list, extend
 * this component; the rollback path is already wired.
 *
 * Refinement pass (E1) — window.confirm replaced with ConfirmRollbackDialog;
 * errors surface as Sonner toasts instead of inline text.
 */
import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { TUNING_COLORS } from '../tuning/tokens'
import {
  apiRollbackBuildPlan,
  withBuildToast,
  type BuildLastTransaction,
} from '@/lib/build-api'
import { ConfirmRollbackDialog } from './confirm-dialog'

export function TransactionHistory({
  last,
  onRolledBack,
}: {
  last?: BuildLastTransaction
  onRolledBack?: (transactionId: string) => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)

  if (!last) {
    return (
      <section
        className="rounded-lg border px-3 py-3 text-xs"
        style={{
          borderColor: TUNING_COLORS.hairline,
          background: TUNING_COLORS.surfaceRaised,
          color: TUNING_COLORS.inkSubtle,
        }}
      >
        <div
          className="text-[10.5px] font-semibold uppercase tracking-wider"
          style={{ color: TUNING_COLORS.inkSubtle }}
        >
          Recent changes
        </div>
        <div className="mt-2" style={{ color: TUNING_COLORS.inkMuted }}>
          No changes yet. As you build, your change history will appear here.
        </div>
      </section>
    )
  }

  async function confirmRollback() {
    if (!last) return
    await withBuildToast('Couldn’t roll back', async () => {
      await apiRollbackBuildPlan(last.id)
      toast.success('Rolled back', {
        description: `Reverted every artifact in tx_${last.id.slice(0, 8)}…`,
      })
      onRolledBack?.(last.id)
    })
  }

  const approved = !!last.approvedAt
  const rolledBack = last.status === 'ROLLED_BACK'

  return (
    <section
      className="rounded-lg border px-3 py-3"
      style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
    >
      <div
        className="text-[10.5px] font-semibold uppercase tracking-wider"
        style={{ color: TUNING_COLORS.inkSubtle }}
      >
        Recent changes
      </div>
      <div className="mt-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-mono text-[11px]"
            style={{ color: TUNING_COLORS.ink }}
            title={last.id}
          >
            tx_{last.id.slice(0, 8)}…
          </div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: TUNING_COLORS.inkMuted }}>
            {last.itemCount} item{last.itemCount === 1 ? '' : 's'} · {last.status.toLowerCase()}
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: TUNING_COLORS.inkSubtle }}>
            {new Date(last.createdAt).toLocaleString()}
          </div>
          {approved ? (
            <div className="mt-0.5 text-[11px]" style={{ color: TUNING_COLORS.successFg }}>
              Approved
            </div>
          ) : null}
        </div>
        {!rolledBack ? (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-white px-2.5 text-[11px] font-medium"
            style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.dangerFg }}
          >
            <RotateCcw size={11} strokeWidth={2.25} />
            Roll back
          </button>
        ) : null}
      </div>
      <ConfirmRollbackDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Roll back this change?"
        summary={`This reverts every artifact (${last.itemCount} item${last.itemCount === 1 ? '' : 's'}) written under tx_${last.id.slice(0, 8)}…. The main pipeline will pick up the revert within 60 seconds.`}
        onConfirm={confirmRollback}
      />
    </section>
  )
}
