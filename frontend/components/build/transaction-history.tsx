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
 */
import { useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { TUNING_COLORS } from '../tuning/tokens'
import {
  apiRollbackBuildPlan,
  type BuildLastTransaction,
} from '@/lib/build-api'

export function TransactionHistory({
  last,
  onRolledBack,
}: {
  last?: BuildLastTransaction
  onRolledBack?: (transactionId: string) => void
}) {
  const [rollingBack, setRollingBack] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

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
        <div className="mt-2">No build transactions yet.</div>
      </section>
    )
  }

  async function rollback() {
    if (!last) return
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `Roll back the last build transaction (${last.id.slice(0, 8)}…)? Every artifact written under it reverts.`,
      )
      if (!ok) return
    }
    setRollingBack(true)
    setMessage(null)
    try {
      await apiRollbackBuildPlan(last.id)
      setMessage('Rolled back.')
      onRolledBack?.(last.id)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setRollingBack(false)
    }
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
            onClick={rollback}
            disabled={rollingBack}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-white px-2.5 text-[11px] font-medium disabled:opacity-60"
            style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.dangerFg }}
          >
            {rollingBack ? (
              <Loader2 size={11} strokeWidth={2.25} className="animate-spin" />
            ) : (
              <RotateCcw size={11} strokeWidth={2.25} />
            )}
            Roll back
          </button>
        ) : null}
      </div>
      {message ? (
        <div className="mt-2 text-[11px]" style={{ color: TUNING_COLORS.inkMuted }}>
          {message}
        </div>
      ) : null}
    </section>
  )
}
