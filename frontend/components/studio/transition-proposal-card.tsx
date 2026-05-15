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

// 2026-05-16 polish: operator-facing labels mirror state-chip.tsx so
// confirm/reject text doesn't read "Confirm transition to Verifying"
// next to a chip that says "Asking / Drafting / Verifying" — keep one
// vocabulary across the surface. Internal enum still drives logic.
const STATE_LABEL: Record<StudioInnerState, string> = {
  scoping: 'Asking',
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
  // 2026-05-04 — confirm/reject must wake the agent for the next turn.
  // The backend updates the snapshot but does not auto-fire a turn; the
  // agent's promised follow-up ("I'll push the edit on confirm") only
  // lands if the host sends a message after confirm, which is when the
  // <state_transition> block in Region C is rendered to the agent.
  // Mirrors how QuestionChoicesCard sends the chosen label as text on
  // selection.
  onSendText?: (text: string) => void
}

export function TransitionProposalCard({
  conversationId,
  currentState,
  proposedState,
  because,
  nonce,
  expiresAt,
  onResolved,
  onSendText,
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
      // Wake the agent for the follow-up turn. The backend's confirm
      // endpoint only mutates the snapshot; the <state_transition>
      // block in Region C is rendered to the agent the next time it
      // gets a turn, which only happens when the host sends a message.
      // Without this, the agent's promise of "I'll push the edit on
      // confirm" never resolves and the user sees nothing happen.
      onSendText?.(`Confirmed — proceed with ${STATE_LABEL[proposedState]}.`)
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
      onSendText?.(`Keeping ${STATE_LABEL[currentState]}.`)
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
      {/* 2026-05-16: skip the quote block when `because` is blank
         (the agent occasionally omits the rationale). Without this
         the operator saw an empty pair of curly quotes — looks like
         a render bug. */}
      {because && because.trim() ? (
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
      ) : null}
      {expired ? (
        <p style={{ margin: 0, fontSize: 11, color: STUDIO_TOKENS_V2.amber }}>
          Proposal expired — start a fresh one if still needed.
        </p>
      ) : null}
      {/* 2026-05-15 polish: flex-wrap so the buttons stack instead of
          overflowing on narrow widths (≤360px) — the "Confirm transition
          to Verifying" label is ~28 chars and was overflowing the 520px
          card border on mobile rail layouts. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={confirm}
          disabled={disabled}
          style={{
            flex: '1 1 auto',
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
            flex: '0 0 auto',
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
