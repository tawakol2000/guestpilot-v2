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

const INNER_LABEL: Record<StudioInnerState, string> = {
  scoping: 'Scoping',
  drafting: 'Drafting',
  verifying: 'Verifying',
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
          ? `Last transition: ${snapshot.last_transition_reason}`
          : `Mode ${outer} · inner state ${inner}`
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
      <span style={{ color: STUDIO_TOKENS_V2.ink, fontWeight: 500 }}>{outer}</span>
      <span style={{ color: STUDIO_TOKENS_V2.muted2 }}>·</span>
      <span>{INNER_LABEL[inner]}</span>
      <button
        type="button"
        onClick={onReclassify}
        disabled={busy}
        title={`Reclassify to ${target}`}
        aria-label={`Reclassify conversation to ${target}`}
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
        → {target}
      </button>
      {err ? (
        <span role="alert" style={{ color: '#dc2626', fontSize: 11 }}>
          {err}
        </span>
      ) : null}
    </div>
  )
}
