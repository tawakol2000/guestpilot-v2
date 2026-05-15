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
import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { STUDIO_COLORS, getStudioCategoryStyle, attributedStyle } from './tokens'

export interface SuggestedFixTarget {
  artifact?: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property_override'
  artifactId?: string
  sectionId?: string
  slotKey?: string
  // 2026-05-15: lineRange is now an object on the backend ({start, end});
  // accept the legacy tuple for back-compat (older emitters in the cached
  // session ledger still produce it).
  lineRange?: { start: number; end: number } | [number, number]
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
  // 2026-05-04 (research-backed refactor): triage-reasoning surface
  // emitted by the TUNE agent. All optional — older rows from before
  // the TUNE addendum refactor (commit 5f826d4) won't carry them.
  /** IteraTeR-aligned edit type the agent classified the operator's edit as. */
  editType?:
    | 'STYLE_WORDING'
    | 'FRAMING_TONE'
    | 'FACTUAL'
    | 'BEHAVIORAL'
    | 'OMISSION'
    | 'REMOVAL'
  /**
   * Verbatim span from the operator's edit that drove the classification.
   * null means "no witness — wording-only edit, NO_FIX." Surfaces below
   * the rationale as a quoted span when present.
   */
  witnessQuote?: string | null
  /**
   * ≥2 reasons this edit might be a one-off operator preference rather
   * than a durable gap. Required on non-NO_FIX classifications. Rendered
   * collapsed by default so the card stays compact; expanded on click.
   */
  reasonsNotToAct?: string[]
  /**
   * Every preferences/* memory key the agent consulted while reaching
   * this classification. Rendered as small pill chips so the operator
   * can see which preferences influenced the call.
   */
  consultedMemoryKeys?: string[]
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
    target.lineRange && renderLineRange(target.lineRange),
    target.artifactId && target.artifactId.slice(0, 8),
  ]
    .filter(Boolean)
    .join(' · ')
  return detail ? `${base} · ${detail}` : base
}

function renderLineRange(lr: NonNullable<SuggestedFixTarget['lineRange']>): string {
  if (Array.isArray(lr)) return `L${lr[0]}–${lr[1]}`
  return `L${lr.start}–${lr.end}`
}

type CardState = 'idle' | 'accepting' | 'accepted' | 'rejecting' | 'rejected' | 'error'

export function SuggestedFixCard(props: SuggestedFixCardProps) {
  const [state, setState] = useState<CardState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const categoryStyle = getStudioCategoryStyle(props.category)

  // 2026-05-15 polish: after a failed accept/reject, auto-return to idle
  // so the operator can retry. Previously the card stuck in 'error' with
  // both buttons disabled (cursor: not-allowed) and no retry affordance.
  useEffect(() => {
    if (state !== 'error') return
    const t = setTimeout(() => {
      setState('idle')
      setErrorMessage(null)
    }, 3000)
    return () => clearTimeout(t)
  }, [state])

  async function handleAccept() {
    if (!props.onAccept) return
    setState('accepting')
    setErrorMessage(null)
    try {
      await props.onAccept(props.id)
      setState('accepted')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Apply failed — retrying enabled in 3s')
      setState('error')
    }
  }
  async function handleReject() {
    if (!props.onReject) return
    setState('rejecting')
    setErrorMessage(null)
    try {
      await props.onReject(props.id)
      setState('rejected')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Reject failed — retrying enabled in 3s')
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
        {props.editType && (
          <span
            title="IteraTeR-aligned edit type the agent classified the operator's edit as"
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              background: STUDIO_COLORS.surfaceSunken,
              color: STUDIO_COLORS.inkMuted,
              fontSize: 10.5,
              fontWeight: 600,
              borderRadius: 4,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              border: `1px solid ${STUDIO_COLORS.hairline}`,
            }}
          >
            {props.editType.replace('_', ' ')}
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
        {props.consultedMemoryKeys && props.consultedMemoryKeys.length > 0 && (
          <span
            title="preferences/* memory keys the agent consulted while reaching this classification"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
                color: STUDIO_COLORS.inkSubtle,
              }}
            >
              consulted
            </span>
            {props.consultedMemoryKeys.slice(0, 4).map((key) => (
              <span
                key={key}
                style={{
                  fontSize: 10.5,
                  padding: '1px 6px',
                  background: STUDIO_COLORS.attributionQuoteBg,
                  color: STUDIO_COLORS.inkMuted,
                  border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                  borderRadius: 999,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                }}
              >
                {key}
              </span>
            ))}
            {props.consultedMemoryKeys.length > 4 && (
              <span
                style={{
                  fontSize: 10,
                  color: STUDIO_COLORS.inkSubtle,
                }}
              >
                +{props.consultedMemoryKeys.length - 4}
              </span>
            )}
          </span>
        )}
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

      {/* Witness quote: verbatim span from the edit that drove the
          classification. Only renders when the agent populated it
          (non-NO_FIX classifications); null/empty means "wording-only
          edit, no witness". Distinct visual style — left-rule + tinted
          surface + monospace — so the operator can spot it as cited
          evidence rather than agent prose. */}
      {props.witnessQuote && (
        <blockquote
          style={{
            margin: '8px 0 0',
            padding: '6px 10px',
            background: STUDIO_COLORS.attributionQuoteBg,
            borderLeft: `2px solid ${STUDIO_COLORS.attributionQuoteRule}`,
            color: STUDIO_COLORS.ink,
            fontSize: 12,
            lineHeight: 1.55,
            fontStyle: 'italic',
            borderRadius: '0 4px 4px 0',
          }}
        >
          <span
            style={{
              display: 'block',
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
              color: STUDIO_COLORS.inkSubtle,
              marginBottom: 2,
              fontStyle: 'normal',
            }}
          >
            Witness from the edit
          </span>
          {props.witnessQuote}
        </blockquote>
      )}

      {props.impact && (
        <p
          style={{
            margin: '4px 0 0',
            ...attributedStyle('ai'),
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {props.impact}
        </p>
      )}

      {/* Reasons-not-to-act: the ≥2 reasons the agent enumerated
          before promoting from NO_FIX. Collapsed by default to keep
          the card compact; expandable for operators who want to
          audit the triage. */}
      {props.reasonsNotToAct && props.reasonsNotToAct.length > 0 && (
        <ReasonsNotToActDetails reasons={props.reasonsNotToAct} />
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
            // 2026-05-15 polish: 'default' cursor when settled — "Accepted"
            // with not-allowed reads as a hard error, but the green colour
            // says success. Pick one signal.
            cursor:
              state === 'idle' && props.onAccept
                ? 'pointer'
                : state === 'accepted'
                  ? 'default'
                  : 'not-allowed',
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
          // 2026-05-16 a11y: role="alert" so screen-reader users hear
          // the failure without re-tabbing onto the error span.
          <span
            role="alert"
            style={{ fontSize: 12, color: STUDIO_COLORS.dangerFg }}
          >
            {errorMessage ?? 'Something went wrong. Try again.'}
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
          fontStyle: !after ? 'italic' : pending ? 'italic' : 'normal',
        }}
      >
        {/* 2026-05-16: render an explicit "(removed)" placeholder for
           removal-only fixes. Without this the green pane was an
           empty 8px-padding block that read as "content here you
           can't see" rather than "nothing here on purpose". */}
        {after || '(removed)'}
      </pre>
    </div>
  )
}

// ─── Reasons-not-to-act expander ────────────────────────────────────────
//
// Collapsed by default. <details>/<summary> gives free keyboard
// support, screen-reader announcement, and operator click-to-expand
// without a controlled-state dance. The tone (caption-grey, italic)
// matches the rest of the card's reasoning surface so it doesn't
// fight the primary actions.
function ReasonsNotToActDetails({ reasons }: { reasons: string[] }) {
  return (
    <details
      style={{
        marginTop: 8,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 500,
          color: STUDIO_COLORS.inkSubtle,
          letterSpacing: 0.2,
          listStyle: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          userSelect: 'none',
        }}
      >
        Why not just leave it? — {reasons.length} reason{reasons.length === 1 ? '' : 's'} considered
      </summary>
      <ul
        style={{
          margin: '6px 0 0 16px',
          padding: 0,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: STUDIO_COLORS.inkMuted,
        }}
      >
        {reasons.map((r, i) => (
          <li key={i} style={{ marginBottom: 2 }}>
            {r}
          </li>
        ))}
      </ul>
    </details>
  )
}
