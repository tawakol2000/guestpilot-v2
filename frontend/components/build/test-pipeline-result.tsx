'use client'

/**
 * Sprint 045 Gate 6 — TestPipelineResult. Renders a
 * `data-test-pipeline-result` SSE part. One card per test run: the AI's
 * reply, the judge's score (warning-colored when < 0.7), and the judge's
 * rationale.
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { TUNING_COLORS } from '../studio/tokens'
import type { TestPipelineResultData } from '@/lib/build-api'

export function TestPipelineResult({ data }: { data: TestPipelineResultData }) {
  const score = typeof data.judgeScore === 'number' ? data.judgeScore : 0
  const pct = Math.round(score * 100)
  const isFailing = score < 0.7
  return (
    <article
      className="w-full overflow-hidden rounded-xl bg-white shadow-sm"
      style={{ border: `1px solid ${TUNING_COLORS.hairline}` }}
    >
      <header
        className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: TUNING_COLORS.hairlineSoft, background: TUNING_COLORS.surfaceRaised }}
      >
        <span className="text-sm font-semibold" style={{ color: TUNING_COLORS.ink }}>
          Test run
        </span>
        <span
          className="ml-auto font-mono text-[11px]"
          style={{ color: TUNING_COLORS.inkSubtle }}
        >
          {data.replyModel} · {data.latencyMs}ms
        </span>
      </header>

      <div className="px-4 py-3" style={{ background: TUNING_COLORS.surfaceRaised }}>
        <div
          className="text-[10.5px] font-semibold uppercase tracking-wide"
          style={{ color: TUNING_COLORS.inkSubtle }}
        >
          Reply
        </div>
        <p
          className="mt-1 whitespace-pre-wrap rounded-md border px-3 py-2 text-[13px] leading-5"
          style={{
            borderColor: TUNING_COLORS.hairlineSoft,
            background: TUNING_COLORS.canvas,
            color: TUNING_COLORS.ink,
          }}
        >
          {data.reply}
        </p>
      </div>

      <div
        className="flex items-start gap-3 border-t px-4 py-3"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: isFailing ? TUNING_COLORS.warnBg : TUNING_COLORS.surfaceRaised,
        }}
      >
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: isFailing ? '#FEF3C7' : '#ECFDF5',
            color: isFailing ? TUNING_COLORS.warnFg : TUNING_COLORS.successFg,
          }}
        >
          {isFailing ? (
            <AlertTriangle size={15} strokeWidth={2} />
          ) : (
            <CheckCircle2 size={15} strokeWidth={2} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-lg font-semibold"
              style={{ color: isFailing ? TUNING_COLORS.warnFg : TUNING_COLORS.ink }}
            >
              {pct}%
            </span>
            <span
              className="text-[10.5px] font-semibold uppercase tracking-wide"
              style={{ color: TUNING_COLORS.inkSubtle }}
            >
              Judge score
            </span>
            {data.judgeFailureCategory ? (
              <span
                className="ml-auto rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                style={{ background: TUNING_COLORS.surfaceSunken, color: TUNING_COLORS.inkMuted }}
              >
                {data.judgeFailureCategory}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-5" style={{ color: TUNING_COLORS.inkMuted }}>
            {data.judgeRationale?.trim() || 'No rationale provided.'}
          </p>
          <div
            className="mt-2 font-mono text-[10.5px]"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            {data.judgeModel} · {data.judgePromptVersion}
          </div>
        </div>
      </div>
    </article>
  )
}
