'use client'

// Sprint 060-C — transition-proposal card. Rendered in place of the
// generic question_choices card when the data-question-choices payload
// has discriminator `kind: 'transition_proposal'`. Buttons wire to the
// new /transitions/:nonce/(confirm|reject) endpoints.
//
// Optimistic flow: on Confirm we hit the backend, then the StateChip
// also receives the new snapshot via the SSE part the next turn-end
// emits — so the chip eventually reconciles even if our local state
// diverged.

import { useState } from 'react'
import { toast } from 'sonner'
import { STUDIO_TOKENS_V2 } from './tokens'
import {
  apiConfirmTransition,
  apiRejectTransition,
  type StudioInnerState,
  type StudioStateMachineSnapshot,
} from '@/lib/api'

const STATE_LABEL: Record<StudioInnerState, string> = {
  scoping: 'Scoping',
  drafting: 'Drafting',
  verifying: 'Verifying',
}

const STATE_COLOR: Record<StudioInnerState, string> = {
  scoping: '#3b82f6',
  drafting: '#a855f7',
  verifying: '#10b981',
}

export interface TransitionProposalCardProps {
  conversationId: string
  currentState: StudioInnerState
  proposedState: StudioInnerState
  because: string
  nonce: string
  expiresAt?: string | null
  onResolved?: (snapshot: StudioStateMachineSnapshot) => void
}

export function TransitionProposalCard({
  conversationId,
  currentState,
  proposedState,
  because,
  nonce,
  expiresAt,
  onResolved,
}: TransitionProposalCardProps) {
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null)
  const [resolved, setResolved] = useState<'confirmed' | 'rejected' | null>(null)

  const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false

  const confirm = async () => {
    if (busy || resolved) return
    setBusy('confirm')
    try {
      const res = await apiConfirmTransition(conversationId, nonce)
      onResolved?.(res.stateMachineSnapshot)
      setResolved('confirmed')
      toast.success(`State transitioned to ${STATE_LABEL[proposedState]}`)
    } catch (err) {
      toast.error('Could not confirm transition', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(null)
    }
  }

  const reject = async () => {
    if (busy || resolved) return
    setBusy('reject')
    try {
      const res = await apiRejectTransition(conversationId, nonce)
      onResolved?.(res.stateMachineSnapshot)
      setResolved('rejected')
      toast.message('Kept current state', { description: STATE_LABEL[currentState] })
    } catch (err) {
      toast.error('Could not reject transition', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(null)
    }
  }

  const disabled = !!busy || !!resolved || expired

  return (
    <div
      role="region"
      aria-label="State transition proposal"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.surface,
        maxWidth: 520,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: STUDIO_TOKENS_V2.muted,
        }}
      >
        <span>State transition proposed</span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 13,
          color: STUDIO_TOKENS_V2.ink,
        }}
      >
        <Pill state={currentState} muted />
        <span style={{ color: STUDIO_TOKENS_V2.muted2 }}>→</span>
        <Pill state={proposedState} />
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.5,
          color: STUDIO_TOKENS_V2.ink2,
        }}
      >
        “{because}”
      </p>
      {expired ? (
        <p style={{ margin: 0, fontSize: 11, color: STUDIO_TOKENS_V2.amber }}>
          Proposal expired — start a fresh one if still needed.
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={confirm}
          disabled={disabled}
          style={{
            padding: '6px 12px',
            border: 'none',
            borderRadius: STUDIO_TOKENS_V2.radiusMd,
            background: disabled ? STUDIO_TOKENS_V2.surface3 : STUDIO_TOKENS_V2.blue,
            color: disabled ? STUDIO_TOKENS_V2.muted : '#ffffff',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          {resolved === 'confirmed'
            ? `Transitioned to ${STATE_LABEL[proposedState]}`
            : busy === 'confirm'
              ? 'Confirming…'
              : `Confirm transition to ${STATE_LABEL[proposedState]}`}
        </button>
        <button
          type="button"
          onClick={reject}
          disabled={disabled}
          style={{
            padding: '6px 12px',
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusMd,
            background: STUDIO_TOKENS_V2.bg,
            color: STUDIO_TOKENS_V2.muted,
            fontSize: 12.5,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          {resolved === 'rejected'
            ? `Kept ${STATE_LABEL[currentState]}`
            : busy === 'reject'
              ? 'Dropping…'
              : `Keep ${STATE_LABEL[currentState]}`}
        </button>
      </div>
    </div>
  )
}

function Pill({ state, muted }: { state: StudioInnerState; muted?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 99,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        background: STUDIO_TOKENS_V2.bg,
        color: muted ? STUDIO_TOKENS_V2.muted : STUDIO_TOKENS_V2.ink,
        fontSize: 12,
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: '50%', background: STATE_COLOR[state] }}
      />
      {STATE_LABEL[state]}
    </span>
  )
}
