'use client'

/**
 * Sprint 045 Gate 6 — PlanChecklist. Renders a `data-build-plan` SSE part
 * with Approve / Discard buttons.
 *
 * Sprint 046 Session C — re-palettised to the Studio tokens and extended
 * to render the Session-B `target` chip + `previewDiff` disclosure per
 * item. No category-pastel change (plan §3.3 decision #3 keeps them on
 * artifact-type labels).
 */
import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { STUDIO_COLORS } from '../studio/tokens'
import {
  apiApproveBuildPlan,
  apiRollbackBuildPlan,
  withBuildToast,
  type BuildPlanData,
  type BuildPlanItem,
  type BuildPlanItemTarget,
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

function renderTargetChip(target: BuildPlanItemTarget | undefined): string | null {
  if (!target) return null
  const parts = [
    target.sectionId && `§${target.sectionId}`,
    target.slotKey && `{${target.slotKey}}`,
    target.lineRange && `L${target.lineRange[0]}–${target.lineRange[1]}`,
    target.artifactId && target.artifactId.slice(0, 8),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
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
  // Sprint 050 A1 — "unsaved" typographic grammar while the plan is
  // still proposed-but-not-approved. Drops as soon as the operator
  // approves so the diff moves to a committed-agent-write style.
  const isPending = state.kind === 'idle' || state.kind === 'approving'

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
      className="w-full overflow-hidden rounded-xl bg-white"
      style={{ border: `1px solid ${STUDIO_COLORS.hairline}` }}
    >
      <header
        className="flex flex-wrap items-center gap-2 border-b px-4 py-3"
        style={{
          borderColor: STUDIO_COLORS.hairlineSoft,
          background: STUDIO_COLORS.surfaceRaised,
        }}
      >
        <span className="text-sm font-semibold" style={{ color: STUDIO_COLORS.ink }}>
          Proposed build plan
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: STUDIO_COLORS.accentSoft, color: STUDIO_COLORS.accent }}
        >
          {data.items.length} item{data.items.length === 1 ? '' : 's'}
        </span>
        <span
          className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px]"
          style={{ background: STUDIO_COLORS.surfaceSunken, color: STUDIO_COLORS.inkSubtle }}
          title={data.transactionId}
        >
          tx_{data.transactionId.slice(0, 8)}…
        </span>
      </header>

      <div className="px-4 py-3" style={{ background: STUDIO_COLORS.surfaceRaised }}>
        <p className="mb-3 text-[13px] leading-5" style={{ color: STUDIO_COLORS.ink }}>
          {data.rationale}
        </p>
        <ul className="flex flex-col gap-1.5">
          {data.items.map((item, idx) => (
            <PlanRow key={idx} item={item} pending={isPending} />
          ))}
        </ul>
      </div>

      <footer
        className="flex flex-wrap items-center gap-2 border-t px-4 py-3"
        style={{ borderColor: STUDIO_COLORS.hairlineSoft, background: STUDIO_COLORS.surfaceSunken }}
      >
        {state.kind === 'error' ? (
          <div
            className="mr-auto rounded-md border-l-2 px-3 py-1.5 text-xs"
            style={{
              borderLeftColor: STUDIO_COLORS.dangerFg,
              background: STUDIO_COLORS.dangerBg,
              color: STUDIO_COLORS.dangerFg,
            }}
          >
            {state.message}
          </div>
        ) : state.kind === 'rolled-back' ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: STUDIO_COLORS.inkMuted }}
          >
            <RotateCcw size={12} strokeWidth={2.25} />
            Rolled back
          </div>
        ) : approved ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: STUDIO_COLORS.successFg }}
          >
            <Check size={12} strokeWidth={2.25} />
            Approved · agent will write these next
          </div>
        ) : state.kind === 'dismissed' ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs"
            style={{ color: STUDIO_COLORS.inkMuted }}
          >
            <X size={12} strokeWidth={2.25} />
            Dismissed
          </div>
        ) : (
          <span
            className="mr-auto font-mono text-[11px]"
            style={{ color: STUDIO_COLORS.inkSubtle }}
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
              style={{ background: STUDIO_COLORS.ink }}
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
              style={{ borderColor: STUDIO_COLORS.hairline, color: STUDIO_COLORS.inkMuted }}
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
            style={{ borderColor: STUDIO_COLORS.hairline, color: STUDIO_COLORS.dangerFg }}
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

function PlanRow({ item, pending }: { item: BuildPlanItem; pending: boolean }) {
  const style = TYPE_STYLE[item.type] ?? {
    bg: STUDIO_COLORS.surfaceSunken,
    fg: STUDIO_COLORS.inkMuted,
    label: item.type,
  }
  const chip = renderTargetChip(item.target)
  const [diffOpen, setDiffOpen] = useState(false)
  const hasDiff = !!item.previewDiff
  return (
    <li
      className="flex flex-col gap-1 rounded-md border px-2.5 py-2"
      style={{
        borderColor: STUDIO_COLORS.hairlineSoft,
        background: STUDIO_COLORS.canvas,
      }}
    >
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: '110px 1fr' }}>
        <span
          className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
          style={{ background: style.bg, color: style.fg }}
        >
          {style.label}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div
              className="truncate text-[13px] font-medium"
              style={{ color: STUDIO_COLORS.ink }}
              title={item.name}
            >
              {item.name}
            </div>
            {chip && (
              <span
                className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-mono"
                style={{
                  background: STUDIO_COLORS.surfaceSunken,
                  color: STUDIO_COLORS.inkMuted,
                  border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                }}
                title="Target"
              >
                {chip}
              </span>
            )}
          </div>
          <div
            className="mt-0.5 line-clamp-2 text-[11.5px]"
            style={{ color: STUDIO_COLORS.inkMuted }}
          >
            {item.rationale}
          </div>
        </div>
      </div>
      {hasDiff && (
        <div className="pl-[118px]">
          <button
            type="button"
            onClick={() => setDiffOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium"
            style={{ color: STUDIO_COLORS.inkMuted }}
          >
            {diffOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {diffOpen ? 'Hide preview' : 'Preview diff'}
          </button>
          {diffOpen && item.previewDiff && (
            <div className="mt-1 grid gap-1">
              {item.previewDiff.before && (
                <pre
                  className="max-h-40 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px]"
                  style={{
                    background: STUDIO_COLORS.diffDelBg,
                    color: STUDIO_COLORS.diffDelFg,
                    borderColor: 'rgba(180,35,24,0.25)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {item.previewDiff.before}
                </pre>
              )}
              <div className="flex flex-col gap-1" data-origin={pending ? 'pending' : 'agent'}>
                {pending && (
                  <span
                    className="inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                    style={{
                      background: STUDIO_COLORS.surfaceSunken,
                      color: STUDIO_COLORS.attributionUnsavedFg,
                      border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                      fontStyle: 'italic',
                    }}
                  >
                    Unsaved
                  </span>
                )}
                <pre
                  className="max-h-40 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px]"
                  style={{
                    background: STUDIO_COLORS.diffAddBg,
                    color: STUDIO_COLORS.diffAddFg,
                    borderColor: 'rgba(17,122,61,0.25)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontStyle: pending ? 'italic' : 'normal',
                  }}
                >
                  {item.previewDiff.after}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
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
