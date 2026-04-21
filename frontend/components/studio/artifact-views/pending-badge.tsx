'use client'

/**
 * Sprint 051 A B1 — "Unsaved" badge for pending artifact state.
 *
 * Non-negotiable from the brief §2: pending artifact state in the
 * drawer renders in A1's italic grey + Unsaved badge grammar, same as
 * the chat. This component is that badge — the italic/grey styling
 * lives on the body <pre> (see `PreBody` in each view).
 */
import { Circle } from 'lucide-react'
import { STUDIO_COLORS } from '../tokens'

export function PendingBadge() {
  return (
    <div
      data-origin="pending"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 999,
        background: STUDIO_COLORS.warnBg,
        color: STUDIO_COLORS.warnFg,
        fontSize: 10.5,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        width: 'fit-content',
      }}
    >
      <Circle size={8} fill="currentColor" strokeWidth={0} />
      Unsaved · pending approval
    </div>
  )
}
