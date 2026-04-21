'use client'

/**
 * Sprint 058-A F4 — session-diff summary card.
 *
 * Renders at the end of an agent turn when the agent emits a
 * `data-session-diff-summary` SSE part (via the new `emit_session_summary`
 * tool). One compact horizontal row with emoji-prefixed tallies plus an
 * optional 1-liner note on a second line.
 *
 * Attribution: grey-for-AI per 057-A F2 grammar (this is agent-emitted
 * content, not operator typography).
 *
 * Graceful degradation: partial data (e.g. only `written` present) still
 * renders — missing fields default to zero.
 */
import { STUDIO_COLORS, attributedStyle } from './tokens'

export interface SessionDiffSummaryData {
  written?: {
    created?: number
    edited?: number
    reverted?: number
  }
  tested?: {
    runs?: number
    totalVariants?: number
    passed?: number
  }
  plans?: {
    cancelled?: number
  }
  note?: string | null
}

export interface SessionDiffCardProps {
  data: SessionDiffSummaryData
}

function safeNum(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function SessionDiffCard({ data }: SessionDiffCardProps) {
  const created = safeNum(data.written?.created)
  const edited = safeNum(data.written?.edited)
  const reverted = safeNum(data.written?.reverted)
  const runs = safeNum(data.tested?.runs)
  const totalVariants = safeNum(data.tested?.totalVariants)
  const passed = safeNum(data.tested?.passed)
  const cancelled = safeNum(data.plans?.cancelled)

  const hasAnyActivity =
    created + edited + reverted + runs + cancelled > 0 || Boolean(data.note)
  if (!hasAnyActivity) return null

  const testedLabel =
    runs > 0
      ? `Tested ${runs} (${passed}/${totalVariants})`
      : null

  return (
    <section
      data-testid="session-diff-card"
      role="region"
      aria-label="Session turn summary"
      style={{
        marginTop: 10,
        padding: '10px 12px',
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 6,
        background: STUDIO_COLORS.surfaceSunken,
        ...attributedStyle('ai'),
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div
        data-testid="session-diff-tally"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          alignItems: 'center',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 11.5,
        }}
      >
        <span data-testid="session-diff-written">
          <span aria-hidden>✏️</span> Wrote {created}
        </span>
        <span data-testid="session-diff-edited">
          <span aria-hidden>🔧</span> Edited {edited}
        </span>
        {testedLabel ? (
          <span data-testid="session-diff-tested">
            <span aria-hidden>🧪</span> {testedLabel}
          </span>
        ) : null}
        <span data-testid="session-diff-reverted">
          <span aria-hidden>⤺</span> Reverted {reverted}
        </span>
        <span data-testid="session-diff-cancelled">
          <span aria-hidden>✖</span> Cancelled {cancelled}
        </span>
      </div>
      {data.note ? (
        <div
          data-testid="session-diff-note"
          style={{
            marginTop: 6,
            fontSize: 11.5,
            color: STUDIO_COLORS.inkMuted,
          }}
        >
          {data.note}
        </div>
      ) : null}
    </section>
  )
}
