'use client'

/**
 * Sprint 045 Gate 6 — PlanChecklist. Renders a `data-build-plan` SSE part
 * with Approve / Discard buttons. Approve calls POST /api/build/plan/:id/approve;
 * discard is a client-side dismiss (the agent's BUILD addendum treats a
 * discarded plan as a no-op until the manager asks for another plan).
 *
 * Once approved, the agent's create_* calls proceed with this
 * transactionId and the actual artifact writes happen as follow-up tool
 * calls. The frontend shows a PropagationBanner briefly after the first
 * successful write (wired from the page shell).
 */
import { useState } from 'react'
import { Check, Loader2, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { TUNING_COLORS } from '../tuning/tokens'
import {
  apiApproveBuildPlan,
  apiRollbackBuildPlan,
  withBuildToast,
  type BuildPlanData,
  type BuildPlanItem,
} from '@/lib/build-api'
import { ConfirmRollbackDialog } from './confirm-dialog'

type PlanState =
  | { kind: 'idle' }
  | { kind: 'approving' }
  | { kind: 'approved'; approvedAt: string }
  | { kind: 'rolling-back' }
  | { kind: 'rolled-back' }
  | { kind: 'dismissed' }
  | { kind: 'error'; message: string }

const TYPE_STYLE: Record<BuildPlanItem['type'], { bg: string; fg: string; label: string }> = {
  sop: { bg: '#FEF9C3', fg: '#854D0E', label: 'SOP' },
  faq: { bg: '#CCFBF1', fg: '#0F766E', label: 'FAQ' },
  system_prompt: { bg: '#DBEAFE', fg: '#1E40AF', label: 'System prompt' },
  tool_definition: { bg: '#EDE9FE', fg: '#6D28D9', label: 'Tool' },
}

export function PlanChecklist({
  data,
  onApproved,
  onRolledBack,
}: {
  data: BuildPlanData
  onApproved?: (transactionId: string) => void
  onRolledBack?: (transactionId: string) => void
}) {
  const [state, setState] = useState<PlanState>({ kind: 'idle' })
  const [rollbackOpen, setRollbackOpen] = useState(false)

  async function approve() {
    setState({ kind: 'approving' })
    try {
      const res = await withBuildToast('Couldn’t approve plan', () =>
        apiApproveBuildPlan(data.transactionId),
      )
      setState({ kind: 'approved', approvedAt: res.approvedAt })
      toast.success('Plan approved', {
        description: 'The agent will write these artifacts next.',
      })
      onApproved?.(data.transactionId)
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function confirmRollback() {
    setState({ kind: 'rolling-back' })
    try {
      await withBuildToast('Couldn’t roll back plan', () =>
        apiRollbackBuildPlan(data.transactionId),
      )
      setState({ kind: 'rolled-back' })
      toast.success('Plan rolled back', {
        description: `Reverted every artifact in tx_${data.transactionId.slice(0, 8)}…`,
      })
      onRolledBack?.(data.transactionId)
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const approved = state.kind === 'approved' || state.kind === 'rolling-back' || state.kind === 'rolled-back'
  const disabled =
    state.kind === 'approving' ||
    state.kind === 'rolling-back' ||
    state.kind === 'dismissed' ||
    state.kind === 'rolled-back'

  return (
    <article
      className="w-full overflow-hidden rounded-xl bg-white shadow-sm"
      style={{ border: `1px solid ${TUNING_COLORS.hairline}` }}
    >
      <header
        className="flex flex-wrap items-center gap-2 border-b px-4 py-3"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: TUNING_COLORS.surfaceRaised,
        }}
      >
        <span className="text-sm font-semibold" style={{ color: TUNING_COLORS.ink }}>
          Proposed build plan
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: TUNING_COLORS.accentSoft, color: TUNING_COLORS.accent }}
        >
          {data.items.length} item{data.items.length === 1 ? '' : 's'}
        </span>
        <span
          className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px]"
          style={{ background: TUNING_COLORS.surfaceSunken, color: TUNING_COLORS.inkSubtle }}
          title={data.transactionId}
        >
          tx_{data.transactionId.slice(0, 8)}…
        </span>
      </header>

      <div className="px-4 py-3" style={{ background: TUNING_COLORS.surfaceRaised }}>
        <p className="mb-3 text-[13px] leading-5" style={{ color: TUNING_COLORS.ink }}>
          {data.rationale}
        </p>
        <ul className="flex flex-col gap-1.5">
          {data.items.map((item, idx) => {
            const style = TYPE_STYLE[item.type] ?? {
              bg: TUNING_COLORS.surfaceSunken,
              fg: TUNING_COLORS.inkMuted,
              label: item.type,
            }
            return (
              <li
                key={idx}
                className="grid items-center gap-3 rounded-md border px-2.5 py-2"
                style={{
                  gridTemplateColumns: '110px 1fr',
                  borderColor: TUNING_COLORS.hairlineSoft,
                  background: TUNING_COLORS.canvas,
                }}
              >
                <span
                  className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
                  style={{ background: style.bg, color: style.fg }}
                >
                  {style.label}
                </span>
                <div className="min-w-0">
                  <div
                    className="truncate text-[13px] font-medium"
                    style={{ color: TUNING_COLORS.ink }}
                    title={item.name}
                  >
                    {item.name}
                  </div>
                  <div
                    className="mt-0.5 line-clamp-2 text-[11.5px]"
                    style={{ color: TUNING_COLORS.inkMuted }}
                  >
                    {item.rationale}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <footer
        className="flex flex-wrap items-center gap-2 border-t px-4 py-3"
        style={{ borderColor: TUNING_COLORS.hairlineSoft, background: TUNING_COLORS.surfaceSunken }}
      >
        {state.kind === 'error' ? (
          <div
            className="mr-auto rounded-md border-l-2 px-3 py-1.5 text-xs"
            style={{
              borderLeftColor: TUNING_COLORS.dangerFg,
              background: TUNING_COLORS.dangerBg,
              color: TUNING_COLORS.dangerFg,
            }}
          >
            {state.message}
          </div>
        ) : state.kind === 'rolled-back' ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: TUNING_COLORS.inkMuted }}
          >
            <RotateCcw size={12} strokeWidth={2.25} />
            Rolled back
          </div>
        ) : approved ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: TUNING_COLORS.successFg }}
          >
            <Check size={12} strokeWidth={2.25} />
            Approved · agent will write these next
          </div>
        ) : state.kind === 'dismissed' ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs"
            style={{ color: TUNING_COLORS.inkMuted }}
          >
            <X size={12} strokeWidth={2.25} />
            Dismissed
          </div>
        ) : (
          <span
            className="mr-auto font-mono text-[11px]"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            Atomic · revert any one, revert all
          </span>
        )}

        {!approved && state.kind !== 'dismissed' ? (
          <>
            <button
              type="button"
              onClick={approve}
              disabled={disabled}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-white disabled:opacity-60"
              style={{ background: TUNING_COLORS.accent }}
            >
              {state.kind === 'approving' ? (
                <Loader2 size={12} strokeWidth={2.25} className="animate-spin" />
              ) : (
                <Check size={12} strokeWidth={2.25} />
              )}
              Approve plan
            </button>
            <button
              type="button"
              onClick={() => setState({ kind: 'dismissed' })}
              disabled={disabled}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-white px-3 text-xs font-medium disabled:opacity-60"
              style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.inkMuted }}
            >
              Dismiss
            </button>
          </>
        ) : null}

        {state.kind === 'approved' ? (
          <button
            type="button"
            onClick={() => setRollbackOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-white px-3 text-xs font-medium"
            style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.dangerFg }}
          >
            <RotateCcw size={12} strokeWidth={2.25} />
            Roll back
          </button>
        ) : null}
      </footer>
      <ConfirmRollbackDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        title="Roll back this plan?"
        summary={summariseRollback(data.items, data.transactionId)}
        onConfirm={confirmRollback}
      />
    </article>
  )
}

function summariseRollback(items: BuildPlanItem[], transactionId: string): string {
  const counts: Record<BuildPlanItem['type'], number> = {
    sop: 0,
    faq: 0,
    system_prompt: 0,
    tool_definition: 0,
  }
  for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1
  const parts: string[] = []
  if (counts.sop) parts.push(`${counts.sop} SOP${counts.sop === 1 ? '' : 's'}`)
  if (counts.faq) parts.push(`${counts.faq} FAQ${counts.faq === 1 ? '' : 's'}`)
  if (counts.system_prompt)
    parts.push(
      `${counts.system_prompt} system prompt change${counts.system_prompt === 1 ? '' : 's'}`,
    )
  if (counts.tool_definition)
    parts.push(`${counts.tool_definition} tool${counts.tool_definition === 1 ? '' : 's'}`)
  const summary = parts.length > 0 ? `This will remove ${parts.join(' and ')}` : 'This will revert every artifact'
  return `${summary} added in tx_${transactionId.slice(0, 8)}…. The main pipeline will pick up the revert within 60 seconds.`
}
