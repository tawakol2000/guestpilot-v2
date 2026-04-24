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
}

export interface InterviewProgressCardProps {
  /** Operator-visible title ("Greenfield onboarding", "Late-arrival audit", …). */
  title: string
  slots: InterviewSlot[]
  /** Called when the operator clicks a pending slot to jump the agent there. */
  onSlotClick?: (slotId: string) => void
}

export function InterviewProgressCard({
  title,
  slots,
  onSlotClick,
}: InterviewProgressCardProps) {
  const total = slots.length
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
    </div>
  )
  return clickable ? (
    <button type="button" onClick={onClick} style={{ all: 'unset', display: 'block', width: '100%' }}>
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
