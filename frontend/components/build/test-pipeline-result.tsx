'use client'

/**
 * Sprint 054-A F4 — verdict-forward TestPipelineResult card.
 *
 * Replaces the sprint-045 score-forward layout. Multi-variant payload:
 *   Headline: `3/3 passed` / `2/3 passed — 1 failed` / `0/3 passed`
 *   Second-most-prominent: aggregate reasoning hint.
 *   Per-variant rows: collapsed by default, expand to reveal trigger + reply + judge rationale.
 *   Source-write chip at top when linked to a ritual: opens artifact drawer.
 *
 * Failed verdicts get a subtle amber/red edge accent; passed verdicts
 * have no accent (quiet success, per spec §F4).
 *
 * A single 1/1 passed rendering reads "1/1 passed" — honest, never
 * "1/3 passed" just to pad. The ratio reflects the variants that
 * actually ran, not a fixed denominator.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { TUNING_COLORS } from '../studio/tokens'
import {
  apiRevertArtifactFromHistory,
  type AggregateVerdict,
  type BuildArtifactType,
  type TestPipelineResultData,
  type TestPipelineVariant,
} from '@/lib/build-api'
import { ConfirmRollbackDialog } from './confirm-dialog'

export interface TestPipelineResultProps {
  data: TestPipelineResultData
  /**
   * Optional cross-link — when the ritual wrote back to a history row
   * (sourceWriteHistoryId), the chip is clickable and the host opens
   * the artifact drawer in history-view mode.
   */
  onOpenSourceWrite?: (historyId: string) => void
  /**
   * Optional artifact label for the source-write chip. When the host
   * knows the ledger row's artifact type + label (from the ledger
   * rail), pass it here for "Testing: UPDATE sop — late_checkout".
   * Absent → chip just reads "Testing: linked edit".
   */
  sourceWriteLabel?: {
    operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT'
    artifactType: BuildArtifactType | 'tool_definition'
    artifactId: string
  }
}

const TYPE_SHORT: Record<string, string> = {
  sop: 'sop',
  faq: 'faq',
  system_prompt: 'system_prompt',
  tool: 'tool',
  tool_definition: 'tool',
  property_override: 'override',
}

export function TestPipelineResult(props: TestPipelineResultProps) {
  const { data, onOpenSourceWrite, sourceWriteLabel } = props
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [alreadyReverted, setAlreadyReverted] = useState(false)
  const [revertError, setRevertError] = useState(false)
  const variants = Array.isArray(data.variants) ? data.variants : []
  const total = variants.length
  const passed = variants.filter((v) => v.verdict === 'passed').length
  const failed = total - passed
  const aggregate = data.aggregateVerdict ?? computeAggregate(passed, failed)
  const headline = renderHeadline(aggregate, passed, failed, total)
  const isFailing = aggregate !== 'all_passed'
  const accentStyle = isFailing
    ? {
        borderColor: aggregate === 'all_failed' ? TUNING_COLORS.dangerFg : TUNING_COLORS.warnFg,
      }
    : { borderColor: TUNING_COLORS.hairline }
  return (
    <article
      data-testid="test-pipeline-result"
      data-aggregate={aggregate}
      className="w-full overflow-hidden rounded-xl bg-white shadow-sm"
      style={{ border: `1px solid ${accentStyle.borderColor}` }}
    >
      {data.sourceWriteHistoryId && sourceWriteLabel ? (
        <SourceWriteChip
          historyId={data.sourceWriteHistoryId}
          label={sourceWriteLabel}
          onClick={onOpenSourceWrite}
        />
      ) : null}

      <header
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: TUNING_COLORS.surfaceRaised,
        }}
      >
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: aggregate === 'all_passed' ? '#ECFDF5' : '#FEF3C7',
            color: aggregate === 'all_passed' ? TUNING_COLORS.successFg : TUNING_COLORS.warnFg,
          }}
        >
          {aggregate === 'all_passed' ? (
            <CheckCircle2 size={16} strokeWidth={2.25} />
          ) : (
            <AlertTriangle size={16} strokeWidth={2.25} />
          )}
        </span>
        <div className="flex min-w-0 flex-col">
          <span
            data-testid="test-pipeline-result-headline"
            className="text-[15px] font-bold"
            style={{
              color:
                aggregate === 'all_failed'
                  ? TUNING_COLORS.dangerFg
                  : aggregate === 'partial'
                  ? TUNING_COLORS.warnFg
                  : TUNING_COLORS.ink,
            }}
          >
            {headline}
          </span>
          <span
            className="text-[10.5px] font-medium uppercase tracking-wide"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            Verification ritual · {data.ritualVersion ?? ''}
          </span>
        </div>
      </header>

      <div
        className="border-b px-4 py-3"
        style={{ borderColor: TUNING_COLORS.hairlineSoft }}
      >
        <div
          className="text-[10.5px] font-semibold uppercase tracking-wide"
          style={{ color: TUNING_COLORS.inkSubtle }}
        >
          Judge reasoning
        </div>
        <ul
          data-testid="test-pipeline-result-reasoning-list"
          className="mt-1 space-y-1"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {variants.map((v, i) => (
            <li
              key={i}
              className="text-[13px] leading-5"
              style={{ color: TUNING_COLORS.inkMuted }}
            >
              <span
                className="mr-1.5 font-semibold"
                style={{
                  color:
                    v.verdict === 'passed'
                      ? TUNING_COLORS.successFg
                      : TUNING_COLORS.warnFg,
                }}
              >
                {v.verdict === 'passed' ? 'Passed.' : "Didn't work."}
              </span>
              {v.judgeReasoning || '(no reasoning provided)'}
            </li>
          ))}
        </ul>
      </div>

      <details className="group">
        <summary
          className="flex cursor-pointer items-center gap-1.5 border-b px-4 py-2.5 text-[11.5px] font-medium"
          style={{
            borderColor: TUNING_COLORS.hairlineSoft,
            color: TUNING_COLORS.inkMuted,
            listStyle: 'none',
          }}
        >
          <ChevronRight
            size={13}
            className="transition-transform group-open:rotate-90"
          />
          Per-variant detail ({total})
        </summary>
        <ul
          data-testid="test-pipeline-result-variants"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {variants.map((v, i) => (
            <VariantRow key={i} variant={v} />
          ))}
        </ul>
      </details>

      {isFailing && data.sourceWriteHistoryId && (
        <footer
          data-testid="test-pipeline-result-rollback-footer"
          className="flex items-center justify-between border-t px-4 py-2.5"
          style={{ borderColor: TUNING_COLORS.hairlineSoft, background: TUNING_COLORS.surfaceSunken }}
        >
          <span className="text-[11.5px]" style={{ color: TUNING_COLORS.inkMuted }}>
            Something not right? Roll back the write that triggered this test.
          </span>
          <button
            type="button"
            data-testid="test-pipeline-result-rollback-btn"
            disabled={alreadyReverted}
            title={alreadyReverted ? 'Already rolled back' : undefined}
            onClick={() => {
              setRevertError(false)
              setRollbackOpen(true)
            }}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              borderColor: TUNING_COLORS.dangerFg,
              color: TUNING_COLORS.dangerFg,
              background: 'transparent',
            }}
          >
            <RotateCcw size={11} strokeWidth={2.25} />
            {alreadyReverted ? 'Already rolled back' : 'Roll back this write'}
          </button>
          <ConfirmRollbackDialog
            open={rollbackOpen}
            onOpenChange={setRollbackOpen}
            title="Roll back this write?"
            summary="This will revert the artifact to its state before the write that triggered this test ritual. The main pipeline picks up the revert within 60 seconds."
            onConfirm={async () => {
              await apiRevertArtifactFromHistory(data.sourceWriteHistoryId!)
              setAlreadyReverted(true)
              toast.success('Write rolled back successfully.')
            }}
          />
        </footer>
      )}
    </article>
  )
}

function renderHeadline(
  aggregate: AggregateVerdict,
  passed: number,
  failed: number,
  total: number,
): string {
  // Single-variant rituals read honestly — "1/1 passed", never "1/3".
  if (aggregate === 'all_passed') return `${total}/${total} passed`
  if (aggregate === 'all_failed') return `0/${total} passed`
  // partial
  return `${passed}/${total} passed — ${failed} failed`
}

function computeAggregate(passed: number, failed: number): AggregateVerdict {
  if (passed > 0 && failed === 0) return 'all_passed'
  if (passed === 0) return 'all_failed'
  return 'partial'
}

function SourceWriteChip({
  historyId,
  label,
  onClick,
}: {
  historyId: string
  label: NonNullable<TestPipelineResultProps['sourceWriteLabel']>
  onClick?: (id: string) => void
}) {
  const short = TYPE_SHORT[label.artifactType] ?? label.artifactType
  return (
    <button
      type="button"
      data-testid="test-pipeline-result-source-chip"
      onClick={() => onClick && onClick(historyId)}
      style={{
        all: 'unset',
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        fontSize: 11,
        color: TUNING_COLORS.inkMuted,
        borderBottom: `1px solid ${TUNING_COLORS.hairlineSoft}`,
        background: TUNING_COLORS.surfaceSunken,
      }}
    >
      <span
        className="font-semibold uppercase tracking-wide"
        style={{ fontSize: 10.5, color: TUNING_COLORS.inkSubtle }}
      >
        Testing:
      </span>
      <span className="font-mono" style={{ color: TUNING_COLORS.ink }}>
        {label.operation} {short} — {label.artifactId}
      </span>
    </button>
  )
}

function VariantRow({ variant }: { variant: TestPipelineVariant }) {
  const [open, setOpen] = useState(false)
  const ChevIcon = open ? ChevronDown : ChevronRight
  const isFail = variant.verdict === 'failed'
  return (
    <li
      data-testid="test-pipeline-result-variant-row"
      data-verdict={variant.verdict}
      style={{
        borderBottom: `1px solid ${TUNING_COLORS.hairlineSoft}`,
        borderLeft: isFail ? `3px solid ${TUNING_COLORS.warnFg}` : 'none',
        paddingLeft: isFail ? 9 : 12,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          all: 'unset',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          cursor: 'pointer',
          padding: '8px 12px',
        }}
      >
        <ChevIcon size={12} color={TUNING_COLORS.inkSubtle} />
        <span
          className="font-semibold uppercase tracking-wide"
          style={{
            fontSize: 10,
            color: isFail ? TUNING_COLORS.warnFg : TUNING_COLORS.successFg,
            minWidth: 52,
          }}
        >
          {variant.verdict === 'passed' ? 'Passed' : 'Failed'}
        </span>
        <span
          className="truncate"
          style={{ fontSize: 12, color: TUNING_COLORS.ink, flex: 1 }}
        >
          {variant.triggerMessage}
        </span>
        <span
          style={{ fontSize: 10.5, fontFamily: 'monospace', color: TUNING_COLORS.inkSubtle }}
        >
          {Math.round(variant.judgeScore * 100)}%
        </span>
      </button>
      {open ? (
        <div style={{ padding: '0 12px 10px 24px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>
            <div
              className="font-semibold uppercase tracking-wide"
              style={{ fontSize: 10.5, color: TUNING_COLORS.inkSubtle }}
            >
              Pipeline reply
            </div>
            <p
              className="mt-0.5 whitespace-pre-wrap rounded-md border px-3 py-1.5 text-[12.5px] leading-5"
              style={{
                borderColor: TUNING_COLORS.hairlineSoft,
                background: TUNING_COLORS.canvas,
                color: TUNING_COLORS.ink,
              }}
            >
              {variant.pipelineOutput}
            </p>
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: TUNING_COLORS.inkSubtle,
              fontFamily: 'monospace',
            }}
          >
            {variant.judgeModel} · {variant.judgePromptVersion} · {variant.latencyMs}ms
          </div>
        </div>
      ) : null}
    </li>
  )
}
