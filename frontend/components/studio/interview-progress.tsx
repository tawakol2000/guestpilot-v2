'use client'

/**
 * Sprint 046 — Interview Progress card.
 *
 * Renders a `data-interview-progress` SSE part during a multi-question
 * interview flow (greenfield onboarding, deep audit, etc.). Requested
 * by the agent in the operator's own Studio session ("the slot-fill
 * progress (0/6 load-bearing) exists as metadata but there's no
 * visual card I can emit mid-interview to show the manager where they
 * stand").
 *
 * Shows:
 *   - A progress bar with filled / total slot counts
 *   - A list of slots with per-slot status (pending / asking / filled)
 *   - A summary line ("3 of 6 answered — 3 remaining") in the header
 */

import { STUDIO_TOKENS_V2 } from './tokens'
import { CheckIcon } from './icons'

export type InterviewSlotStatus = 'pending' | 'asking' | 'filled' | 'skipped'

export interface InterviewSlot {
  id: string
  label: string
  status: InterviewSlotStatus
  /** Optional short summary of the answer (shown on filled rows). */
  answer?: string
  /** Load-bearing = agent will fall back to defaults if skipped. */
  loadBearing?: boolean
  // 2026-05-04 (research-backed refactor): default-marking surface
  // emitted by the BUILD agent. Maps to the GDPR/CPRA-style "marked
  // default beats silent default" pattern (research synthesis §1, Q4).
  /** True when this slot's answer is a corpus default, not operator-stated. */
  isDefault?: boolean
  /**
   * Where the default came from when isDefault=true (e.g. "canonical
   * short-stay template"). Surfaced in the slot row's hover title.
   */
  defaultProvenance?: string
}

export interface InterviewContradiction {
  /** First operator quote, verbatim. */
  quoteA: string
  /** Second operator quote that conflicts with the first, verbatim. */
  quoteB: string
  /**
   * Non-confrontational reconciliation framed as a question, e.g.
   * "It sounds like the rule is X, and also Y in the Tahoe property —
   * is the rule property-specific, or did one of these change recently?"
   */
  proposedReconciliation: string
}

export interface InterviewProgressCardProps {
  /** Operator-visible title ("Greenfield onboarding", "Late-arrival audit", …). */
  title: string
  slots: InterviewSlot[]
  /** Called when the operator clicks a pending slot to jump the agent there. */
  onSlotClick?: (slotId: string) => void
  /**
   * 2026-05-04 (research-backed refactor): cross-statement
   * contradictions the BUILD agent surfaced this turn. Rendered above
   * the slot list as warning-style rows. Empty / undefined skips the
   * section entirely.
   */
  contradictions?: InterviewContradiction[]
}

export function InterviewProgressCard({
  title,
  slots,
  onSlotClick,
  contradictions,
}: InterviewProgressCardProps) {
  const total = slots.length
  // 2026-05-16: hide the card entirely when there are no slots — the
  // header would read "0 of 0 answered" with a 0% bar, which an
  // operator reads as "interview broken" rather than "no slots
  // tracked yet". The agent emits interview-progress only when slots
  // delta, so an empty render is upstream noise.
  if (total === 0) return null
  const filled = slots.filter((s) => s.status === 'filled').length
  const skipped = slots.filter((s) => s.status === 'skipped').length
  const remaining = total - filled - skipped
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0

  return (
    <article
      data-studio-card="interview-progress"
      style={{
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.bg,
        marginTop: 8,
        overflow: 'hidden',
        boxShadow: STUDIO_TOKENS_V2.shadowSm,
      }}
    >
      <header
        style={{
          padding: '14px 16px',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: STUDIO_TOKENS_V2.muted2,
              }}
            >
              Interview progress
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: STUDIO_TOKENS_V2.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </span>
          </div>
          <span
            style={{
              fontSize: 11.5,
              color: STUDIO_TOKENS_V2.muted,
              fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
              flexShrink: 0,
            }}
          >
            {filled} of {total} answered
            {remaining > 0 ? ` — ${remaining} remaining` : ''}
          </span>
        </div>
        {/* Progress bar */}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={filled}
          aria-label={`${filled} of ${total} slots filled`}
          style={{
            height: 4,
            background: STUDIO_TOKENS_V2.surface3,
            borderRadius: 99,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: STUDIO_TOKENS_V2.blue,
              transition: 'width 400ms ease-out',
            }}
          />
        </div>
      </header>

      {contradictions && contradictions.length > 0 ? (
        <ContradictionsSection contradictions={contradictions} />
      ) : null}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {slots.map((slot, idx) => (
          <li
            key={slot.id}
            style={{
              borderTop: idx === 0 ? 'none' : `1px solid ${STUDIO_TOKENS_V2.border}`,
            }}
          >
            <SlotRow slot={slot} onClick={onSlotClick ? () => onSlotClick(slot.id) : undefined} />
          </li>
        ))}
      </ul>
    </article>
  )
}

// ─── Contradictions section ────────────────────────────────────────────
//
// Renders the cross-statement conflicts the BUILD agent surfaced this
// turn, framed as the labeling-tactic question pattern from Miller &
// Rollnick 2013 (motivational interviewing / "developing discrepancy").
// Each row stacks the two operator quotes verbatim above the agent's
// proposed reconciliation. The colour palette borrows from warnBg/amber
// to signal "operator action needed" without screaming danger — the
// goal is "help me reconcile this," not "you contradicted yourself."
function ContradictionsSection({
  contradictions,
}: {
  contradictions: InterviewContradiction[]
}) {
  return (
    <section
      aria-label="Cross-statement conflicts the agent noticed"
      style={{
        borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
        background: STUDIO_TOKENS_V2.warnBg,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: STUDIO_TOKENS_V2.amber,
        }}
      >
        Conflicts to reconcile · {contradictions.length}
      </span>
      {contradictions.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 10px',
            background: STUDIO_TOKENS_V2.bg,
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
          }}
        >
          <blockquote
            style={{
              margin: 0,
              padding: 0,
              fontSize: 12,
              lineHeight: 1.5,
              color: STUDIO_TOKENS_V2.ink2,
              fontStyle: 'italic',
            }}
          >
            “{c.quoteA}”
          </blockquote>
          <span
            style={{
              fontSize: 10,
              color: STUDIO_TOKENS_V2.muted2,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            and also
          </span>
          <blockquote
            style={{
              margin: 0,
              padding: 0,
              fontSize: 12,
              lineHeight: 1.5,
              color: STUDIO_TOKENS_V2.ink2,
              fontStyle: 'italic',
            }}
          >
            “{c.quoteB}”
          </blockquote>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 12,
              lineHeight: 1.5,
              color: STUDIO_TOKENS_V2.ink,
            }}
          >
            {c.proposedReconciliation}
          </p>
        </div>
      ))}
    </section>
  )
}

function SlotRow({
  slot,
  onClick,
}: {
  slot: InterviewSlot
  onClick?: () => void
}) {
  const clickable = Boolean(onClick) && slot.status !== 'filled'
  const content = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <SlotIcon status={slot.status} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 13,
            color: slot.status === 'filled' ? STUDIO_TOKENS_V2.muted : STUDIO_TOKENS_V2.ink2,
            fontWeight: slot.status === 'asking' ? 500 : 400,
          }}
        >
          {slot.label}
        </span>
        {slot.answer ? (
          <span
            style={{
              fontSize: 12,
              color: STUDIO_TOKENS_V2.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={slot.answer}
          >
            {slot.answer}
          </span>
        ) : null}
      </div>
      {slot.loadBearing && slot.status !== 'filled' ? (
        <span
          aria-label="Load-bearing slot"
          style={{
            flexShrink: 0,
            padding: '1px 7px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.amber,
            background: STUDIO_TOKENS_V2.warnBg,
            borderRadius: 99,
          }}
        >
          Load-bearing
        </span>
      ) : null}
      {/* 2026-05-04 (research-backed refactor): default-marker pill.
          Maps the GDPR/CPRA "marked default beats silent default"
          pattern into operator-visible UI. Hover surfaces provenance
          when the agent populated it ("canonical short-stay template",
          etc.). Stays subdued (muted-grey on surface-sunken) — the
          purpose is to make the default visible without pulling
          attention from the operator's own answers. */}
      {slot.isDefault ? (
        <span
          aria-label="Filled with a corpus default"
          title={
            slot.defaultProvenance
              ? `Default — please review (${slot.defaultProvenance})`
              : 'Default — please review'
          }
          style={{
            flexShrink: 0,
            padding: '1px 7px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted,
            background: STUDIO_TOKENS_V2.surface2,
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: 99,
          }}
        >
          Default
        </span>
      ) : null}
    </div>
  )
  return clickable ? (
    <button
      type="button"
      onClick={onClick}
      // 2026-05-16 a11y: drop `all: 'unset'` — it wipes the focus-visible
      // outline so keyboard users tabbing through the interview slots
      // see no focus ring. Restore via inset focus ring on :focus-visible.
      className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-500"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      {content}
    </button>
  ) : (
    content
  )
}

function SlotIcon({ status }: { status: InterviewSlotStatus }) {
  if (status === 'filled') {
    return (
      <span
        aria-label="Filled"
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: STUDIO_TOKENS_V2.blue,
          color: '#FFFFFF',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CheckIcon size={10} />
      </span>
    )
  }
  if (status === 'asking') {
    return (
      <span
        aria-label="Asking"
        style={{
          flexShrink: 0,
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: `1.5px solid ${STUDIO_TOKENS_V2.blue}`,
          borderTopColor: 'transparent',
          animation: 'spin 0.9s linear infinite',
        }}
      />
    )
  }
  if (status === 'skipped') {
    return (
      <span
        aria-label="Skipped"
        style={{
          flexShrink: 0,
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: `1.5px solid ${STUDIO_TOKENS_V2.muted2}`,
          background: STUDIO_TOKENS_V2.surface2,
        }}
      />
    )
  }
  // pending
  return (
    <span
      aria-label="Pending"
      style={{
        flexShrink: 0,
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: `1.5px dashed ${STUDIO_TOKENS_V2.border}`,
      }}
    />
  )
}
