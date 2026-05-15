'use client'

// Sprint 060-C — Studio mode restructure: state-indicator chip +
// reclassify control. Persistent in the top bar; reflects the
// {outer_mode, inner_state} the backend asserted for this conversation.
//
// Updates flow in three ways:
//   1. Initial paint from GET /tuning/conversations/:id (response carries
//      stateMachineSnapshot).
//   2. Mid-turn refresh via the transient SSE part data-state-machine-
//      snapshot the runtime emits at every turn-end.
//   3. Local optimistic update on reclassify button click.

import { useState } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'
import {
  apiReclassifyConversation,
  type StudioInnerState,
  type StudioOuterMode,
  type StudioStateMachineSnapshot,
} from '@/lib/api'

export interface StateChipProps {
  conversationId: string
  snapshot: StudioStateMachineSnapshot | null
  onSnapshotChange: (s: StudioStateMachineSnapshot) => void
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

// 2026-05-16: defensive fallback when the backend ships a value outside
// the enum (e.g. a future state we don't recognise yet). Returns a
// sentence-cased version of the raw value rather than `undefined`.
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

const INNER_COLOR: Record<StudioInnerState, string> = {
  scoping: '#3b82f6', // blue — info gathering
  drafting: '#a855f7', // purple — mutation
  verifying: '#10b981', // green — evaluation
}

export function StateChip({ conversationId, snapshot, onSnapshotChange }: StateChipProps) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const inner: StudioInnerState = snapshot?.inner_state ?? 'scoping'
  const outer: StudioOuterMode = snapshot?.outer_mode ?? 'BUILD'
  const target: StudioOuterMode = outer === 'BUILD' ? 'TUNE' : 'BUILD'

  const onReclassify = async () => {
    if (busy) return
    setErr(null)
    setBusy(true)
    try {
      const res = await apiReclassifyConversation(conversationId, target)
      onSnapshotChange(res.stateMachineSnapshot)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'reclassify failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      aria-label={`Studio mode ${outer}, inner state ${inner}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: 99,
        padding: '4px 4px 4px 9px',
        fontSize: 11.5,
        color: STUDIO_TOKENS_V2.muted,
      }}
      title={
        snapshot?.last_transition_reason
          ? `Last transition: ${snapshot.last_transition_reason} (state-machine: ${outer.toLowerCase()}/${inner})`
          : `state-machine: ${outer.toLowerCase()}/${inner}`
      }
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: INNER_COLOR[inner],
        }}
      />
      <span style={{ color: STUDIO_TOKENS_V2.ink, fontWeight: 500 }}>{safeOuterLabel(outer)}</span>
      <span style={{ color: STUDIO_TOKENS_V2.muted2 }}>·</span>
      <span>{safeInnerLabel(inner)}</span>
      <button
        type="button"
        onClick={onReclassify}
        disabled={busy}
        title={`Switch to ${safeOuterLabel(target).toLowerCase()}`}
        aria-label={`Switch this conversation to ${safeOuterLabel(target).toLowerCase()} mode`}
        style={{
          marginLeft: 4,
          padding: '2px 8px',
          border: `1px solid ${STUDIO_TOKENS_V2.border}`,
          borderRadius: 99,
          background: busy ? STUDIO_TOKENS_V2.surface : STUDIO_TOKENS_V2.bg,
          color: STUDIO_TOKENS_V2.muted,
          fontSize: 11,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        → {safeOuterLabel(target)}
      </button>
      {err ? (
        <span role="alert" style={{ color: '#dc2626', fontSize: 11 }}>
          {err}
        </span>
      ) : null}
    </div>
  )
}
