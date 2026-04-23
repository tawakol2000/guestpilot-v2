'use client'

/**
 * Sprint 046 Session B — Suggested Fix card.
 *
 * Renders a `data-suggested-fix` SSE part: before/after diff, target
 * chip, category pill, rationale, and inline Accept / Reject buttons.
 *
 * Presentation-only — the Accept / Reject handlers are callbacks that
 * the Session C shell wires to real endpoints. Until that wiring lands
 * the default handlers are no-ops, which is fine for dogfooding the
 * card surface in isolation.
 */
import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { STUDIO_COLORS, getStudioCategoryStyle, attributedStyle } from './tokens'

export interface SuggestedFixTarget {
  artifact?: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property_override'
  artifactId?: string
  sectionId?: string
  slotKey?: string
  lineRange?: [number, number]
  // Sprint 047 Session A — category-specific apply hints threaded through
  // so the Studio accept-on-preview path can dispatch the write without
  // re-asking the agent. Additive; pre-session-A emitters omit them.
  sopCategory?: string
  // Bugfix (2026-04-23): was missing PENDING and CHECKED_OUT, so a
  // suggested-fix targeting a PENDING-variant SOP would fail the
  // typed apply path silently (TypeScript narrowed away the value
  // before the server saw it). Matches the backend
  // ApplyFromUiInput + Prisma enum — all six reservation statuses.
  sopStatus?:
    | 'DEFAULT'
    | 'INQUIRY'
    | 'PENDING'
    | 'CONFIRMED'
    | 'CHECKED_IN'
    | 'CHECKED_OUT'
  sopPropertyId?: string
  faqEntryId?: string
  systemPromptVariant?: 'coordinator' | 'screening'
}

export interface SuggestedFixCardProps {
  id: string
  target: SuggestedFixTarget
  before: string
  after: string
  rationale: string
  impact?: string
  category?: string
  createdAt?: string
  onAccept?: (id: string) => void | Promise<void>
  onReject?: (id: string) => void | Promise<void>
  onOpenInEditor?: (target: SuggestedFixTarget) => void
}

const TARGET_LABEL: Record<NonNullable<SuggestedFixTarget['artifact']>, string> = {
  system_prompt: 'System prompt',
  sop: 'SOP',
  faq: 'FAQ',
  tool_definition: 'Tool',
  property_override: 'Property override',
}

function renderTargetChip(target: SuggestedFixTarget): string {
  const base = target.artifact ? TARGET_LABEL[target.artifact] : 'Untargeted'
  const detail = [
    target.sectionId && `§${target.sectionId}`,
    target.slotKey && `{${target.slotKey}}`,
    target.lineRange && `L${target.lineRange[0]}–${target.lineRange[1]}`,
    target.artifactId && target.artifactId.slice(0, 8),
  ]
    .filter(Boolean)
    .join(' · ')
  return detail ? `${base} · ${detail}` : base
}

type CardState = 'idle' | 'accepting' | 'accepted' | 'rejecting' | 'rejected' | 'error'

export function SuggestedFixCard(props: SuggestedFixCardProps) {
  const [state, setState] = useState<CardState>('idle')
  const categoryStyle = getStudioCategoryStyle(props.category)

  async function handleAccept() {
    if (!props.onAccept) return
    setState('accepting')
    try {
      await props.onAccept(props.id)
      setState('accepted')
    } catch {
      setState('error')
    }
  }
  async function handleReject() {
    if (!props.onReject) return
    setState('rejecting')
    try {
      await props.onReject(props.id)
      setState('rejected')
    } catch {
      setState('error')
    }
  }

  const isSettled = state === 'accepted' || state === 'rejected'

  return (
    <article
      data-studio-card="suggested-fix"
      data-suggested-fix-id={props.id}
      style={{
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 8,
        background: STUDIO_COLORS.surfaceRaised,
        padding: 16,
        marginTop: 8,
        opacity: isSettled ? 0.55 : 1,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        {props.category && (
          <span
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              background: categoryStyle.bg,
              color: categoryStyle.fg,
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 4,
              letterSpacing: 0.1,
            }}
          >
            {categoryStyle.label}
          </span>
        )}
        <button
          type="button"
          onClick={() => props.onOpenInEditor?.(props.target)}
          title="Open target in editor"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            background: STUDIO_COLORS.surfaceSunken,
            color: STUDIO_COLORS.ink,
            fontSize: 11,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            borderRadius: 4,
            cursor: props.onOpenInEditor ? 'pointer' : 'default',
          }}
        >
          {renderTargetChip(props.target)}
        </button>
      </header>

      <DiffBlock
        before={props.before}
        after={props.after}
        pending={state === 'idle' || state === 'accepting'}
      />

      <p
        style={{
          margin: '12px 0 0',
          ...attributedStyle('ai'),
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {props.rationale}
      </p>
      {props.impact && (
        <p
          style={{
            margin: '4px 0 0',
            ...attributedStyle('ai'),
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {props.impact}
        </p>
      )}

      <footer
        style={{
          display: 'flex',
          gap: 8,
          marginTop: 14,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          onClick={handleAccept}
          disabled={state !== 'idle' || !props.onAccept}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            border: '1px solid transparent',
            background:
              state === 'accepted' ? STUDIO_COLORS.successFg : STUDIO_COLORS.accent,
            color: '#FFFFFF',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            cursor: state === 'idle' && props.onAccept ? 'pointer' : 'not-allowed',
          }}
        >
          <Check size={14} />
          {state === 'accepting' ? 'Accepting…' : state === 'accepted' ? 'Accepted' : 'Accept'}
        </button>
        <button
          type="button"
          onClick={handleReject}
          disabled={state !== 'idle' || !props.onReject}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            background: STUDIO_COLORS.surfaceRaised,
            color: STUDIO_COLORS.ink,
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 6,
            cursor: state === 'idle' && props.onReject ? 'pointer' : 'not-allowed',
          }}
        >
          <X size={14} />
          {state === 'rejecting' ? 'Rejecting…' : state === 'rejected' ? 'Rejected' : 'Reject'}
        </button>
        {state === 'error' && (
          <span style={{ fontSize: 12, color: STUDIO_COLORS.dangerFg }}>
            Something went wrong. Try again.
          </span>
        )}
      </footer>
    </article>
  )
}

function DiffBlock({
  before,
  after,
  pending,
}: {
  before: string
  after: string
  pending: boolean
}) {
  const mono =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
  const cellStyle: React.CSSProperties = {
    padding: '8px 10px',
    fontFamily: mono,
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: `1px solid ${STUDIO_COLORS.hairline}`,
    borderRadius: 6,
    maxHeight: 220,
    overflowY: 'auto',
  }
  return (
    <div style={{ display: 'grid', gap: 6 }} data-origin={pending ? 'pending' : 'agent'}>
      {before.length > 0 && (
        <pre
          aria-label="Before"
          style={{
            ...cellStyle,
            background: STUDIO_COLORS.diffDelBg,
            color: STUDIO_COLORS.diffDelFg,
            borderColor: 'rgba(180, 35, 24, 0.25)',
            margin: 0,
          }}
        >
          {before}
        </pre>
      )}
      {pending && (
        <span
          aria-label="Unsaved"
          style={{
            display: 'inline-flex',
            width: 'fit-content',
            alignItems: 'center',
            padding: '1px 6px',
            background: STUDIO_COLORS.surfaceSunken,
            color: STUDIO_COLORS.attributionUnsavedFg,
            border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.1,
            fontStyle: 'italic',
          }}
        >
          Unsaved
        </span>
      )}
      <pre
        aria-label="After"
        style={{
          ...cellStyle,
          background: STUDIO_COLORS.diffAddBg,
          color: STUDIO_COLORS.diffAddFg,
          borderColor: 'rgba(17, 122, 61, 0.25)',
          margin: 0,
          fontStyle: pending ? 'italic' : 'normal',
        }}
      >
        {after}
      </pre>
    </div>
  )
}
