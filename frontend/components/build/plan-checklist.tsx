'use client'

/**
 * Sprint 055-A F1 — PlanChecklist rewrite as a progress tracker.
 *
 * Key changes vs Sprint 045/046:
 *  - Auto-approve on mount (useEffect, fires exactly once via useRef guard).
 *  - Approve/Dismiss buttons removed. Roll Back moved to three-dot overflow menu.
 *  - Per-row state glyph: ○ pending, ● current, ✓ done, × cancelled.
 *  - Per-row hover + keyboard "+" seed-composer affordance.
 *  - `appliedItems` prop drives done/pending row state.
 *  - Legacy graceful degradation: missing transactionId or pre-populated
 *    approvedAt in data → renders in approved state, headline "Plan proposed".
 */
import { useState, useEffect, useRef } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, MoreHorizontal, Plus, RotateCcw, X } from 'lucide-react'
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

// ─── Types ─────────────────────────────────────────────────────────────────

type RowState = 'pending' | 'current' | 'done' | 'cancelled'

type PlanState =
  | { kind: 'idle' }
  | { kind: 'approved'; approvedAt: string }
  | { kind: 'rolling-back' }
  | { kind: 'rolled-back' }
  | { kind: 'error' }

// ─── Color tokens ──────────────────────────────────────────────────────────

const TYPE_STYLE: Record<BuildPlanItem['type'], { bg: string; fg: string; label: string }> = {
  sop: { bg: '#FEF9C3', fg: '#854D0E', label: 'SOP' },
  faq: { bg: '#CCFBF1', fg: '#0F766E', label: 'FAQ' },
  system_prompt: { bg: '#DBEAFE', fg: '#1E40AF', label: 'System prompt' },
  tool_definition: { bg: '#EDE9FE', fg: '#6D28D9', label: 'Tool' },
}

const ROW_GLYPH: Record<RowState, string> = {
  pending: '○',
  current: '●',
  done: '✓',
  cancelled: '×',
}

const ROW_GLYPH_COLOR: Record<RowState, string> = {
  pending: STUDIO_COLORS.inkSubtle,
  current: STUDIO_COLORS.accent,
  done: STUDIO_COLORS.successFg,
  cancelled: STUDIO_COLORS.dangerFg,
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function deriveRowState(
  item: BuildPlanItem,
  idx: number,
  appliedItems: Array<{ type: BuildPlanItem['type']; name: string }>,
  isCancelled: boolean,
): RowState {
  if (isCancelled) return 'cancelled'
  const isDone = appliedItems.some((a) => a.type === item.type && a.name === item.name)
  if (isDone) return 'done'
  // Current = first item not yet done
  const firstPending = appliedItems.length
  if (idx === firstPending) return 'current'
  return 'pending'
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
  const summary =
    parts.length > 0 ? `This will remove ${parts.join(' and ')}` : 'This will revert every artifact'
  return `${summary} added in tx_${transactionId.slice(0, 8)}…. The main pipeline will pick up the revert within 60 seconds.`
}

// ─── Main component ────────────────────────────────────────────────────────

export function PlanChecklist({
  data,
  appliedItems = [],
  onApproved,
  onRolledBack,
  onSeedComposer,
}: {
  data: BuildPlanData
  appliedItems?: Array<{ type: BuildPlanItem['type']; name: string }>
  onApproved?: (transactionId: string) => void
  onRolledBack?: (transactionId: string) => void
  onSeedComposer?: (text: string) => void
}) {
  // Legacy graceful degradation: if transactionId is missing or the data
  // already carries an approvedAt, treat as already approved.
  const isLegacy = !data.transactionId
  const preApproved = isLegacy

  const [state, setState] = useState<PlanState>(
    preApproved ? { kind: 'approved', approvedAt: data.plannedAt ?? new Date().toISOString() } : { kind: 'idle' },
  )
  const [retryError, setRetryError] = useState(false)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const approveCalledRef = useRef(false)
  const overflowRef = useRef<HTMLDivElement>(null)

  // Auto-approve on mount — fires exactly once.
  useEffect(() => {
    if (preApproved) return
    if (approveCalledRef.current) return
    approveCalledRef.current = true

    apiApproveBuildPlan(data.transactionId)
      .then((res) => {
        setState({ kind: 'approved', approvedAt: res.approvedAt })
        onApproved?.(data.transactionId)
      })
      .catch(() => {
        setRetryError(true)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function retryApprove() {
    setRetryError(false)
    apiApproveBuildPlan(data.transactionId)
      .then((res) => {
        setState({ kind: 'approved', approvedAt: res.approvedAt })
        onApproved?.(data.transactionId)
      })
      .catch(() => {
        setRetryError(true)
      })
  }

  async function confirmRollback() {
    setState({ kind: 'rolling-back' })
    try {
      await withBuildToast('Couldn\'t roll back plan', () =>
        apiRollbackBuildPlan(data.transactionId),
      )
      setState({ kind: 'rolled-back' })
      onRolledBack?.(data.transactionId)
    } catch (err) {
      setState({ kind: 'error' })
    }
  }

  // Close overflow on outside click
  useEffect(() => {
    if (!overflowOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [overflowOpen])

  const isCancelled = state.kind === 'rolled-back' || state.kind === 'rolling-back'
  const isApproved = state.kind === 'approved' || state.kind === 'rolling-back' || state.kind === 'rolled-back'

  // Headline: "Plan proposed" for legacy (no transactionId), otherwise "Build plan"
  const headlineText = isLegacy ? 'Plan proposed' : 'Build plan'

  return (
    <article
      className="w-full overflow-hidden rounded-xl bg-white"
      style={{ border: `1px solid ${STUDIO_COLORS.hairline}` }}
    >
      {/* Header */}
      <header
        className="flex flex-wrap items-center gap-2 border-b px-4 py-3"
        style={{
          borderColor: STUDIO_COLORS.hairlineSoft,
          background: STUDIO_COLORS.surfaceRaised,
        }}
      >
        <span className="text-sm font-semibold" style={{ color: STUDIO_COLORS.ink }}>
          {headlineText}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: STUDIO_COLORS.accentSoft, color: STUDIO_COLORS.accent }}
        >
          {data.items.length} item{data.items.length === 1 ? '' : 's'}
        </span>
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10.5px]"
          style={{ background: STUDIO_COLORS.surfaceSunken, color: STUDIO_COLORS.inkSubtle }}
          title={data.transactionId}
        >
          tx_{data.transactionId ? data.transactionId.slice(0, 8) : '?'}…
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Three-dot overflow menu */}
        {data.transactionId && (
          <div className="relative" ref={overflowRef}>
            <button
              type="button"
              aria-label="Plan actions"
              onClick={() => setOverflowOpen((v) => !v)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md"
              style={{ color: STUDIO_COLORS.inkSubtle }}
            >
              <MoreHorizontal size={15} strokeWidth={2} />
            </button>
            {overflowOpen && (
              <div
                className="absolute right-0 top-full z-10 mt-1 min-w-[140px] rounded-lg border py-1 shadow-lg"
                style={{
                  background: STUDIO_COLORS.surfaceRaised,
                  borderColor: STUDIO_COLORS.hairline,
                }}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
                  style={{ color: STUDIO_COLORS.dangerFg }}
                  onClick={() => {
                    setOverflowOpen(false)
                    setRollbackOpen(true)
                  }}
                  disabled={state.kind === 'rolling-back' || state.kind === 'rolled-back'}
                >
                  <RotateCcw size={12} strokeWidth={2.25} />
                  Roll back
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {/* Retry error pill */}
      {retryError && (
        <div
          className="flex items-center gap-2 border-b px-4 py-2 text-xs"
          style={{
            background: STUDIO_COLORS.dangerBg,
            borderColor: STUDIO_COLORS.hairlineSoft,
            color: STUDIO_COLORS.dangerFg,
          }}
        >
          <span>Couldn&apos;t confirm plan — retry</span>
          <button
            type="button"
            onClick={retryApprove}
            className="rounded px-2 py-0.5 text-[11px] font-medium underline"
            style={{ color: STUDIO_COLORS.dangerFg }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Body */}
      <div className="px-4 py-3" style={{ background: STUDIO_COLORS.surfaceRaised }}>
        <p className="mb-3 text-[13px] leading-5" style={{ color: STUDIO_COLORS.ink }}>
          {data.rationale}
        </p>
        <ul className="flex flex-col gap-1.5">
          {data.items.map((item, idx) => {
            const rowState = deriveRowState(item, idx, appliedItems, isCancelled)
            return (
              <PlanRow
                key={idx}
                item={item}
                rowState={rowState}
                onSeedComposer={onSeedComposer}
              />
            )
          })}
        </ul>
      </div>

      {/* Footer */}
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
            Roll back failed
          </div>
        ) : state.kind === 'rolled-back' ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: STUDIO_COLORS.inkMuted }}
          >
            <RotateCcw size={12} strokeWidth={2.25} />
            Rolled back
          </div>
        ) : state.kind === 'rolling-back' ? (
          <div
            className="mr-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: STUDIO_COLORS.inkMuted }}
          >
            <Loader2 size={12} strokeWidth={2.25} className="animate-spin" />
            Rolling back…
          </div>
        ) : isApproved ? (
          <div
            className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium"
            style={{ color: STUDIO_COLORS.successFg }}
          >
            <Check size={12} strokeWidth={2.25} />
            Plan approved
            {state.kind === 'approved' && state.approvedAt && (
              <span style={{ color: STUDIO_COLORS.inkSubtle }}>
                ·{' '}
                {new Date(state.approvedAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>
        ) : (
          <span
            className="mr-auto font-mono text-[11px]"
            style={{ color: STUDIO_COLORS.inkSubtle }}
          >
            Confirming plan…
          </span>
        )}
      </footer>

      <ConfirmRollbackDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        title="Roll back this plan?"
        summary={summariseRollback(data.items, data.transactionId ?? '')}
        onConfirm={confirmRollback}
      />
    </article>
  )
}

// ─── Plan row ─────────────────────────────────────────────────────────────

function PlanRow({
  item,
  rowState,
  onSeedComposer,
}: {
  item: BuildPlanItem
  rowState: RowState
  onSeedComposer?: (text: string) => void
}) {
  const style = TYPE_STYLE[item.type] ?? {
    bg: STUDIO_COLORS.surfaceSunken,
    fg: STUDIO_COLORS.inkMuted,
    label: item.type,
  }
  const chip = renderTargetChip(item.target)
  const [diffOpen, setDiffOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const hasDiff = !!item.previewDiff
  const showSeed = (hovered || focused) && !!onSeedComposer

  function handleSeed() {
    onSeedComposer?.(`@item:${item.type}:${item.name}`)
  }

  return (
    <li
      className="flex flex-col gap-1 rounded-md border px-2.5 py-2"
      style={{
        borderColor: STUDIO_COLORS.hairlineSoft,
        background: STUDIO_COLORS.canvas,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-start gap-2">
        {/* State glyph */}
        <span
          className="mt-0.5 shrink-0 font-mono text-[12px] font-semibold leading-none"
          style={{ color: ROW_GLYPH_COLOR[rowState], minWidth: 12 }}
          title={rowState}
          aria-label={rowState}
        >
          {ROW_GLYPH[rowState]}
        </span>

        {/* Type badge + content */}
        <div className="min-w-0 flex-1">
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
        </div>

        {/* Seed composer + button */}
        <div className="shrink-0" style={{ width: 24, minHeight: 20 }}>
          {showSeed && (
            <button
              type="button"
              aria-label={`Seed composer with ${item.name}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded"
              style={{ color: STUDIO_COLORS.inkSubtle }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onClick={handleSeed}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSeed()
              }}
            >
              <Plus size={12} strokeWidth={2.25} />
            </button>
          )}
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
              <pre
                className="max-h-40 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px]"
                style={{
                  background: STUDIO_COLORS.diffAddBg,
                  color: STUDIO_COLORS.diffAddFg,
                  borderColor: 'rgba(17,122,61,0.25)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {item.previewDiff.after}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
