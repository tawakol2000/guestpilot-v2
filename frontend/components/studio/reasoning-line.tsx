'use client'

/**
 * Sprint 046 Session B — Reasoning line.
 *
 * Replaces the old chevron-accordion reasoning disclosure from
 * tuning/chat-parts.tsx. Shows a single muted line ("Thought for 4s")
 * that opens into a scrollable drawer, not an in-place accordion (an
 * in-place expand would shift the layout — plan §6.1).
 *
 * This component is layout-only: the drawer is rendered in place (fixed
 * position, slide-over). The Session C shell can swap the drawer for a
 * side-panel if it prefers — the public API is just
 * `ReasoningLine({durationMs, content})`.
 */
import { useEffect, useState } from 'react'
import { STUDIO_COLORS } from './tokens'

export interface ReasoningLineProps {
  /** Rendered as "Thought for Ns". If not supplied a generic label is used. */
  durationMs?: number
  /** The reasoning text. Often long — the drawer is scrollable. */
  content: string
}

export function ReasoningLine({ durationMs, content }: ReasoningLineProps) {
  const [open, setOpen] = useState(false)
  // Bugfix (2026-04-23): the drawer only closed on click-outside — the
  // Esc key did nothing. Keyboard users couldn't dismiss it. Artifact-
  // drawer already does this; mirror the same pattern here.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const label =
    typeof durationMs === 'number' && durationMs > 0
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : 'Agent reasoning'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          all: 'unset',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 0',
          fontStyle: 'italic',
          color: STUDIO_COLORS.inkSubtle,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {label} ·
        <span
          style={{
            color: STUDIO_COLORS.inkMuted,
            fontStyle: 'normal',
            fontWeight: 500,
          }}
        >
          view
        </span>
      </button>
      {open && (
        <>
          <div
            aria-hidden
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(10, 10, 10, 0.25)',
              zIndex: 50,
            }}
          />
          <aside
            role="dialog"
            aria-label="Agent reasoning"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(440px, 90vw)',
              background: STUDIO_COLORS.surfaceRaised,
              borderLeft: `1px solid ${STUDIO_COLORS.hairline}`,
              zIndex: 51,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <header
              style={{
                padding: '12px 16px',
                borderBottom: `1px solid ${STUDIO_COLORS.hairline}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  color: STUDIO_COLORS.ink,
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                }}
              >
                {label}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  color: STUDIO_COLORS.inkMuted,
                  fontSize: 12,
                }}
              >
                Close
              </button>
            </header>
            <pre
              style={{
                flex: 1,
                margin: 0,
                padding: 16,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.55,
                color: STUDIO_COLORS.ink,
                background: STUDIO_COLORS.surfaceRaised,
              }}
            >
              {content}
            </pre>
          </aside>
        </>
      )}
    </>
  )
}
