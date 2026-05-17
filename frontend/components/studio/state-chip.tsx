'use client'

// Sprint 060-C — Studio mode/phase indicator. Persistent in the top bar;
// reflects the {outer_mode, inner_state} the backend asserted for this
// conversation.
//
// Updates flow in three ways:
//   1. Initial paint from GET /tuning/conversations/:id (response carries
//      stateMachineSnapshot).
//   2. Mid-turn refresh via the transient SSE part data-state-machine-
//      snapshot the runtime emits at every turn-end.
//   3. Re-renders on parent state change.
//
// 2026-05-17 redesign: outer mode (Tuning vs Building) is now LOCKED at
// chat creation. The mid-chat reclassify button was removed because
// flipping mode mid-conversation broke the operator's mental model and
// silently mutated the persisted snapshot. The chip is now a status
// indicator only — no actions. To switch modes, start a new chat and
// pick the mode in the chooser.
//
// The inner state (phase) is shown as a 3-step progress indicator so
// the operator can see at a glance where they are in the workflow:
// Asking → Drafting → Verifying.

import { STUDIO_TOKENS_V2 } from './tokens'
import {
  type StudioInnerState,
  type StudioOuterMode,
  type StudioStateMachineSnapshot,
} from '@/lib/api'

export interface StateChipProps {
  conversationId: string
  snapshot: StudioStateMachineSnapshot | null
  // Kept on the prop type for back-compat with parent wiring even though
  // we no longer mutate the snapshot here (reclassify removed). Marked
  // optional so call sites can drop it over time.
  onSnapshotChange?: (s: StudioStateMachineSnapshot) => void
}

// 2026-05-15 polish: operator-friendly labels. Internal state-machine
// names ("scoping", "drafting", "verifying") leaked into the chip; non-
// engineers can't intuit what state they're in. The internal enum stays
// in the title-tooltip below for power users / debugging.
const INNER_LABEL: Record<StudioInnerState, string> = {
  scoping: 'Asking',
  drafting: 'Drafting',
  verifying: 'Verifying',
}
const OUTER_LABEL: Record<StudioOuterMode, string> = {
  BUILD: 'Building',
  TUNE: 'Tuning',
}

const INNER_COLOR: Record<StudioInnerState, string> = {
  scoping: '#3b82f6', // blue — info gathering
  drafting: '#a855f7', // purple — mutation
  verifying: '#10b981', // green — evaluation
}

const PHASE_ORDER: readonly StudioInnerState[] = ['scoping', 'drafting', 'verifying'] as const

function safeInnerLabel(s: StudioInnerState | string): string {
  if (INNER_LABEL[s as StudioInnerState]) return INNER_LABEL[s as StudioInnerState]
  const raw = String(s ?? 'unknown')
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}
function safeOuterLabel(o: StudioOuterMode | string): string {
  if (OUTER_LABEL[o as StudioOuterMode]) return OUTER_LABEL[o as StudioOuterMode]
  const raw = String(o ?? 'unknown')
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
}

export function StateChip({ snapshot }: StateChipProps) {
  const inner: StudioInnerState = snapshot?.inner_state ?? 'scoping'
  const outer: StudioOuterMode = snapshot?.outer_mode ?? 'BUILD'
  const currentIndex = PHASE_ORDER.indexOf(inner)
  const safeIndex = currentIndex >= 0 ? currentIndex : 0

  return (
    <div
      role="status"
      aria-label={`Studio mode ${safeOuterLabel(outer)}, current phase ${safeInnerLabel(inner)}`}
      title={
        snapshot?.last_transition_reason
          ? `Last transition: ${snapshot.last_transition_reason} (state-machine: ${outer.toLowerCase()}/${inner})`
          : `state-machine: ${outer.toLowerCase()}/${inner}`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: 99,
        padding: '4px 12px',
        fontSize: 11.5,
        color: STUDIO_TOKENS_V2.muted,
      }}
    >
      {/* Outer-mode badge — fixed at chat creation, no longer toggleable */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontWeight: 600,
          color: STUDIO_TOKENS_V2.ink,
          fontSize: 11.5,
          letterSpacing: '0.02em',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: outer === 'TUNE' ? '#f59e0b' /* amber */ : '#3b82f6' /* blue */,
          }}
        />
        {safeOuterLabel(outer)}
      </span>

      {/* Divider */}
      <span aria-hidden style={{ color: STUDIO_TOKENS_V2.muted2, fontSize: 11 }}>
        ·
      </span>

      {/* Inline phase progression — 3 dots + active label */}
      <span
        aria-label={`Phase ${safeIndex + 1} of 3: ${safeInnerLabel(inner)}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        {PHASE_ORDER.map((phase, idx) => {
          const isActive = idx === safeIndex
          const isPast = idx < safeIndex
          return (
            <span
              key={phase}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <span
                aria-hidden
                style={{
                  width: isActive ? 8 : 6,
                  height: isActive ? 8 : 6,
                  borderRadius: '50%',
                  background: isActive
                    ? INNER_COLOR[phase]
                    : isPast
                      ? STUDIO_TOKENS_V2.muted2
                      : 'transparent',
                  border: isActive
                    ? `1px solid ${INNER_COLOR[phase]}`
                    : isPast
                      ? `1px solid ${STUDIO_TOKENS_V2.muted2}`
                      : `1px solid ${STUDIO_TOKENS_V2.border}`,
                  transition: 'all 120ms ease',
                }}
              />
              {isActive ? (
                <span
                  style={{
                    color: INNER_COLOR[phase],
                    fontWeight: 600,
                    fontSize: 11.5,
                  }}
                >
                  {safeInnerLabel(phase)}
                </span>
              ) : null}
              {idx < PHASE_ORDER.length - 1 ? (
                <span aria-hidden style={{ color: STUDIO_TOKENS_V2.border, fontSize: 10 }}>
                  →
                </span>
              ) : null}
            </span>
          )
        })}
      </span>
    </div>
  )
}
