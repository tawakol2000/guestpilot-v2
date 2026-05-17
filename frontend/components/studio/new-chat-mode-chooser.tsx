'use client'

// 2026-05-17 — Studio "New chat" mode chooser.
//
// Replaces the old auto-create-BUILD path with an explicit Tuning vs
// Building picker. Mode is fixed at conversation creation and can no
// longer be toggled mid-chat — flipping the persisted outer_mode after
// the agent's first turn broke the operator's mental model and silently
// rewrote the snapshot via the runner's first-turn-correction block.
//
// Modal pattern: full-screen backdrop with Esc-to-close + click-outside-
// to-close, two large cards side by side. Asks: "what kind of session?".

import { useCallback, useEffect, useRef } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'

export type StudioStartMode = 'TUNE' | 'BUILD'

export interface NewChatModeChooserProps {
  onClose: () => void
  onPick: (mode: StudioStartMode) => void
}

export function NewChatModeChooser({ onClose, onPick }: NewChatModeChooserProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Esc + click-outside to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  // Focus the dialog on mount for keyboard users.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-chat-chooser-title"
      onClick={onBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={{
          background: STUDIO_TOKENS_V2.bg,
          borderRadius: 16,
          border: `1px solid ${STUDIO_TOKENS_V2.border}`,
          boxShadow: '0 24px 60px -12px rgba(15, 23, 42, 0.35)',
          padding: '28px 28px 24px',
          maxWidth: 640,
          width: '100%',
          outline: 'none',
        }}
      >
        <header style={{ marginBottom: 6 }}>
          <h2
            id="new-chat-chooser-title"
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              color: STUDIO_TOKENS_V2.ink,
              letterSpacing: '-0.01em',
            }}
          >
            What kind of session?
          </h2>
          <p
            style={{
              marginTop: 6,
              marginBottom: 0,
              fontSize: 13,
              color: STUDIO_TOKENS_V2.muted,
              lineHeight: 1.55,
            }}
          >
            Mode is locked for the lifetime of this session. To switch later, start a new
            chat.
          </p>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 14,
            marginTop: 20,
          }}
        >
          <ModeCard
            mode="TUNE"
            title="Tuning"
            dotColor="#f59e0b"
            tagline="Fix something specific the AI got wrong."
            bullets={[
              'Patch a wording issue, behaviour bug, or missed escalation.',
              'Anchored to a real reply — pulls evidence and proposes a targeted fix.',
              'Best for "this one message went badly."',
            ]}
            onClick={() => onPick('TUNE')}
          />
          <ModeCard
            mode="BUILD"
            title="Building"
            dotColor="#3b82f6"
            tagline="Set up or expand the AI's knowledge."
            bullets={[
              'Add SOPs, FAQs, custom tools, or system-prompt sections.',
              'Slot-fills the underlying interview to identify missing coverage.',
              'Best for "I want the AI to handle X going forward."',
            ]}
            onClick={() => onPick('BUILD')}
          />
        </div>

        <footer
          style={{
            marginTop: 22,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: STUDIO_TOKENS_V2.muted,
              fontSize: 13,
              cursor: 'pointer',
              padding: '6px 8px',
            }}
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  )
}

function ModeCard({
  mode,
  title,
  tagline,
  bullets,
  dotColor,
  onClick,
}: {
  mode: StudioStartMode
  title: string
  tagline: string
  bullets: string[]
  dotColor: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Start a ${title} session — ${tagline}`}
      style={{
        textAlign: 'left',
        background: STUDIO_TOKENS_V2.surface,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: 12,
        padding: '18px 18px 16px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'transform 80ms ease, border-color 80ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = STUDIO_TOKENS_V2.ink
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = STUDIO_TOKENS_V2.border
      }}
      data-testid={`new-chat-pick-${mode.toLowerCase()}`}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
          }}
        />
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: STUDIO_TOKENS_V2.ink,
            letterSpacing: '0.01em',
          }}
        >
          {title}
        </span>
      </span>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: STUDIO_TOKENS_V2.ink2,
          lineHeight: 1.5,
        }}
      >
        {tagline}
      </p>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {bullets.map((b) => (
          <li
            key={b}
            style={{
              fontSize: 11.5,
              color: STUDIO_TOKENS_V2.muted,
              lineHeight: 1.5,
              paddingLeft: 12,
              position: 'relative',
            }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                top: 7,
                width: 3,
                height: 3,
                borderRadius: '50%',
                background: STUDIO_TOKENS_V2.muted2,
              }}
            />
            {b}
          </li>
        ))}
      </ul>
    </button>
  )
}
