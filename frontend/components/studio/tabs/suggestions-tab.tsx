'use client'

// Tuning suggestions tab. Lists TuningSuggestion rows the diagnostic
// pipeline writes when a manager edits an AI draft in the inbox
// (Feature 041 — runDiagnostic → writeSuggestionFromDiagnostic). Until
// this tab landed the rows had no UI — they were stranded in the DB
// after /tuning/page.tsx was retired in commit fd63b36.
//
// Visual language mirrors the Plan / Tests tabs: 16/14 padded column,
// 10.5px uppercase eyebrow + 15px ink title, hairline cards on white,
// blue-accent primary CTA, category pastels for the diagnostic chip.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  apiAcceptTuningSuggestion,
  apiCreateTuningConversation,
  apiGetConversation,
  apiListTuningSuggestions,
  apiRejectTuningSuggestion,
  type ApiConversationDetail,
  type ApiMessage,
  type TuningSuggestion,
  type TuningSuggestionStatus,
} from '@/lib/api'
import {
  STUDIO_COLORS,
  STUDIO_TOKENS_V2,
  getStudioCategoryStyle,
  triggerLabel,
} from '../tokens'
import { useStudioShell } from '../studio-shell-context'
import {
  SparkleIcon,
  CheckIcon,
  CloseIcon,
  ChevronDownIcon,
  MessageSquareIcon,
} from '../icons'

type Filter = 'PENDING' | 'ALL'

type RowState =
  | { kind: 'idle' }
  | { kind: 'accepting' }
  | { kind: 'accepted' }
  | { kind: 'rejecting' }
  | { kind: 'rejected' }
  | { kind: 'error'; message: string }

export interface SuggestionsTabProps {
  /**
   * Optional callback invoked whenever the pending count changes so the
   * shell can mirror it into the tab badge. Fires once on initial fetch
   * and on every accept / reject mutation.
   */
  onPendingCountChange?: (count: number) => void
  /**
   * "Discuss in tuning" wires through here — the surface creates a
   * tuning conversation seeded with this suggestion's context and then
   * navigates to it. The tab itself doesn't know about routing.
   */
  onDiscuss?: (conversationId: string) => void
}

export function SuggestionsTab({ onPendingCountChange, onDiscuss }: SuggestionsTabProps) {
  const { rightWide, setRightWide } = useStudioShell()
  const [filter, setFilter] = useState<Filter>('PENDING')
  const [items, setItems] = useState<TuningSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})

  const reportPending = useCallback(
    (rows: TuningSuggestion[]) => {
      if (!onPendingCountChange) return
      const pending = rows.filter((r) => r.status === 'PENDING').length
      onPendingCountChange(pending)
    },
    [onPendingCountChange],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status: TuningSuggestionStatus | 'ALL' =
        filter === 'PENDING' ? 'PENDING' : 'ALL'
      const res = await apiListTuningSuggestions({ status, limit: 30 })
      setItems(res.suggestions)
      reportPending(res.suggestions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filter, reportPending])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAccept = useCallback(
    async (s: TuningSuggestion) => {
      setRowState((m) => ({ ...m, [s.id]: { kind: 'accepting' } }))
      try {
        if (s.diagnosticCategory === 'TOOL_CONFIG') {
          // Accept-tool-config requires a toolDefinitionId. The diagnostic
          // doesn't always pre-fill one, so for v1 we surface a clear
          // toast and route the operator to the legacy detail picker.
          throw new Error(
            'Tool-config suggestions need a target tool — open the legacy /tuning detail to pick one.',
          )
        }
        // Bug fix (2026-05-04): empty body 400'd for SOP_CONTENT /
        // SOP_ROUTING / PROPERTY_OVERRIDE / FAQ rows whose suggestions
        // were written by the diagnostic pipeline with sopStatus=null
        // and (for new FAQs) faqScope=null. The accept controller
        // hits RequiredFieldsError before reaching the apply path.
        // Pass sensible defaults so v1 accepts succeed; the operator
        // can still override via per-category UI later.
        const acceptBody: Parameters<typeof apiAcceptTuningSuggestion>[1] = {}
        const isSopFlavor =
          s.diagnosticCategory === 'SOP_CONTENT' ||
          s.diagnosticCategory === 'SOP_ROUTING' ||
          s.diagnosticCategory === 'PROPERTY_OVERRIDE'
        if (isSopFlavor && !s.sopStatus) {
          // DEFAULT is the broadest variant — applies to every
          // reservation status that doesn't have its own override.
          // Safer than guessing INQUIRY / CONFIRMED / CHECKED_IN.
          acceptBody.sopStatus = 'DEFAULT'
        }
        const isNewFaq = s.diagnosticCategory === 'FAQ' && !s.faqEntryId
        if (isNewFaq && !s.faqScope) {
          // GLOBAL is the safer default than PROPERTY-scoped — a
          // global FAQ applies broadly; mis-targeting to a specific
          // property would silently miss other listings.
          acceptBody.faqScope = 'GLOBAL'
        }
        await apiAcceptTuningSuggestion(s.id, acceptBody)
        setRowState((m) => ({ ...m, [s.id]: { kind: 'accepted' } }))
        toast.success('Suggestion accepted', {
          description: 'The tuning artifact has been updated.',
        })
        // Drop the row from the visible list after a brief settle so the
        // operator sees the green confirmation before it animates out.
        window.setTimeout(() => {
          setItems((rows) => {
            const next = rows.filter((r) => r.id !== s.id)
            reportPending(next)
            return next
          })
        }, 600)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setRowState((m) => ({ ...m, [s.id]: { kind: 'error', message } }))
        toast.error('Could not accept suggestion', { description: message })
      }
    },
    [reportPending],
  )

  const handleReject = useCallback(
    async (s: TuningSuggestion) => {
      setRowState((m) => ({ ...m, [s.id]: { kind: 'rejecting' } }))
      try {
        await apiRejectTuningSuggestion(s.id)
        setRowState((m) => ({ ...m, [s.id]: { kind: 'rejected' } }))
        window.setTimeout(() => {
          setItems((rows) => {
            const next = rows.filter((r) => r.id !== s.id)
            reportPending(next)
            return next
          })
        }, 400)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setRowState((m) => ({ ...m, [s.id]: { kind: 'error', message } }))
        toast.error('Could not reject suggestion', { description: message })
      }
    },
    [reportPending],
  )

  const handleDiscuss = useCallback(
    async (s: TuningSuggestion) => {
      try {
        const cat = getStudioCategoryStyle(s.diagnosticCategory)
        const trigger = triggerLabel(s.triggerType).toLowerCase()
        const initialMessage =
          `Let's discuss this tuning suggestion (id: ${s.id}). ` +
          `Trigger: ${trigger}. Category: ${cat.label}. ` +
          (s.rationale ? `Rationale: ${s.rationale}` : '')
        const res = await apiCreateTuningConversation({
          anchorMessageId: s.sourceMessageId ?? null,
          triggerType: s.triggerType ?? 'MANUAL',
          initialMessage,
          title: `Discuss: ${cat.label}`,
          // "Discuss in tuning" is unambiguous — always land in TUNE,
          // never BUILD. Don't rely on triggerType inference (a MANUAL
          // trigger on a tuning-suggestion would otherwise pick BUILD).
          initialOuterMode: 'TUNE',
        })
        if (onDiscuss) {
          onDiscuss(res.conversation.id)
        } else {
          toast.success('Conversation created', {
            description: 'Switch to the studio chat to continue.',
          })
        }
      } catch (e) {
        toast.error('Could not start discussion', {
          description: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [onDiscuss],
  )

  const pendingCount = useMemo(
    () => items.filter((r) => r.status === 'PENDING').length,
    [items],
  )

  return (
    <div
      style={{
        padding: '16px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: STUDIO_TOKENS_V2.muted2,
            }}
          >
            Suggestions
          </span>
          <span style={{ fontSize: 15, fontWeight: 500, color: STUDIO_TOKENS_V2.ink }}>
            {loading
              ? 'Loading…'
              : filter === 'PENDING'
                ? `${pendingCount} pending`
                : `${items.length} total`}
          </span>
        </div>
        <WidthToggle wide={rightWide} onToggle={() => setRightWide(!rightWide)} />
      </header>

      <FilterPills
        value={filter}
        onChange={(v) => {
          setFilter(v)
          setRowState({})
        }}
      />

      {error ? (
        // 2026-05-16 a11y: role="alert" so SR users hear the load
        // failure without having to tab to it.
        <div
          role="alert"
          style={{
            border: `1px solid rgba(220, 38, 38, 0.25)`,
            background: STUDIO_COLORS.dangerBg,
            color: STUDIO_COLORS.dangerFg,
            padding: '10px 12px',
            borderRadius: STUDIO_TOKENS_V2.radiusMd,
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span>Could not load suggestions: {error}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 500,
              color: STUDIO_COLORS.dangerFg,
              background: 'transparent',
              border: `1px solid rgba(220, 38, 38, 0.4)`,
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <SkeletonStack />
      ) : items.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {items.map((s, idx) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              state={rowState[s.id] ?? { kind: 'idle' }}
              index={idx}
              onAccept={() => void handleAccept(s)}
              onReject={() => void handleReject(s)}
              onDiscuss={() => void handleDiscuss(s)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Filter pills ───────────────────────────────────────────────────────────

function FilterPills({
  value,
  onChange,
}: {
  value: Filter
  onChange: (v: Filter) => void
}) {
  const options: { id: Filter; label: string }[] = [
    { id: 'PENDING', label: 'Pending' },
    { id: 'ALL', label: 'All' },
  ]
  return (
    <div
      role="tablist"
      aria-label="Filter suggestions"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: STUDIO_TOKENS_V2.surface,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusSm,
        alignSelf: 'flex-start',
      }}
    >
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 500,
              color: active ? STUDIO_TOKENS_V2.ink : STUDIO_TOKENS_V2.muted,
              background: active ? STUDIO_TOKENS_V2.bg : 'transparent',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
              boxShadow: active ? STUDIO_TOKENS_V2.shadowSm : 'none',
              transition: 'background 120ms ease',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ filter }: { filter: Filter }) {
  return (
    <div
      style={{
        border: `1px dashed ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        padding: '28px 18px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        textAlign: 'center',
        background: STUDIO_TOKENS_V2.surface,
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: STUDIO_TOKENS_V2.blueSoft,
          color: STUDIO_TOKENS_V2.blue,
          borderRadius: 999,
        }}
        aria-hidden
      >
        <SparkleIcon size={18} />
      </span>
      <p
        style={{
          margin: 0,
          fontSize: 13.5,
          fontWeight: 500,
          color: STUDIO_TOKENS_V2.ink,
        }}
      >
        {filter === 'PENDING' ? 'No pending suggestions' : 'No suggestions yet'}
      </p>
      <p
        style={{
          margin: 0,
          fontSize: 12,
          lineHeight: 1.55,
          color: STUDIO_TOKENS_V2.muted,
          maxWidth: 260,
        }}
      >
        Edit an AI draft in the inbox before sending and the diagnostic agent
        will surface a tuning fix here within a few seconds.
      </p>
    </div>
  )
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function SkeletonStack() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusLg,
            padding: 14,
            background: STUDIO_TOKENS_V2.bg,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            opacity: 1 - i * 0.18,
          }}
        >
          <SkeletonBar width="55%" height={12} />
          <SkeletonBar width="100%" height={42} />
          <SkeletonBar width="80%" height={12} />
        </div>
      ))}
    </div>
  )
}

function SkeletonBar({
  width,
  height,
}: {
  width: string | number
  height: number
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 4,
        background: `linear-gradient(90deg, ${STUDIO_TOKENS_V2.surface2} 0%, ${STUDIO_TOKENS_V2.surface3} 50%, ${STUDIO_TOKENS_V2.surface2} 100%)`,
        backgroundSize: '200% 100%',
        animation: 'studio-skeleton-shimmer 1.4s ease-in-out infinite',
      }}
    />
  )
}

// ─── Suggestion card ────────────────────────────────────────────────────────

function SuggestionCard({
  suggestion,
  state,
  index,
  onAccept,
  onReject,
  onDiscuss,
}: {
  suggestion: TuningSuggestion
  state: RowState
  index: number
  onAccept: () => void
  onReject: () => void
  onDiscuss: () => void
}) {
  const [showFull, setShowFull] = useState(false)
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [discussing, setDiscussing] = useState(false)

  const cat = getStudioCategoryStyle(suggestion.diagnosticCategory)
  const trigger = triggerLabel(suggestion.triggerType)
  const isSettled = state.kind === 'accepted' || state.kind === 'rejected'
  const isMutating = state.kind === 'accepting' || state.kind === 'rejecting'

  const ageLabel = formatAge(suggestion.createdAt)
  const before = suggestion.beforeText ?? ''
  const after = suggestion.proposedText ?? ''
  // Slice to show only the changed hunk by default. The diagnostic
  // pipeline often returns full-artifact bodies (especially for
  // SYSTEM_PROMPT) — surfacing 200 lines of identical prose around a
  // 4-line edit is the wrong default. `showFull` flips back to the
  // raw before/after if the operator wants the whole picture.
  const sliced = useMemo(() => sliceDiff(before, after), [before, after])

  return (
    <li
      style={{
        listStyle: 'none',
        animation: `studio-suggestion-fade-in 240ms ease-out both`,
        animationDelay: `${Math.min(index, 8) * 35}ms`,
      }}
    >
      <article
        data-suggestion-id={suggestion.id}
        style={{
          border: `1px solid ${STUDIO_TOKENS_V2.border}`,
          borderRadius: STUDIO_TOKENS_V2.radiusLg,
          background: STUDIO_TOKENS_V2.bg,
          padding: 14,
          boxShadow: STUDIO_TOKENS_V2.shadowSm,
          opacity: isSettled ? 0.45 : 1,
          transition: 'opacity 200ms ease, transform 200ms ease',
          transform: state.kind === 'accepted' ? 'translateY(-2px)' : 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              background: cat.bg,
              color: cat.fg,
              fontSize: 10.5,
              fontWeight: 600,
              borderRadius: 999,
              letterSpacing: 0.1,
              textTransform: 'uppercase',
            }}
          >
            {cat.label}
          </span>
          <span
            style={{
              fontSize: 11.5,
              color: STUDIO_TOKENS_V2.muted,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Dot color={triggerDotColor(suggestion.triggerType)} />
            {trigger}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: STUDIO_TOKENS_V2.muted2 }}>
            {ageLabel}
          </span>
        </header>

        {before || after ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sliced.identical ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 11.5,
                  fontStyle: 'italic',
                  color: STUDIO_TOKENS_V2.muted2,
                }}
              >
                No textual change — see rationale below.
              </p>
            ) : (
              <>
                {(showFull ? before : sliced.beforeChunk) ? (
                  <DiffPane
                    kind="before"
                    text={showFull ? before : sliced.beforeChunk}
                    contextAbove={!showFull ? sliced.prefixLines : 0}
                    contextBelow={!showFull ? sliced.suffixLines : 0}
                  />
                ) : null}
                {(showFull ? after : sliced.afterChunk) ? (
                  <DiffPane
                    kind="after"
                    text={showFull ? after : sliced.afterChunk}
                    contextAbove={!showFull ? sliced.prefixLines : 0}
                    contextBelow={!showFull ? sliced.suffixLines : 0}
                  />
                ) : null}
                {sliced.prefixLines + sliced.suffixLines > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowFull((v) => !v)}
                    style={{
                      alignSelf: 'flex-start',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      fontSize: 11,
                      fontWeight: 500,
                      color: STUDIO_TOKENS_V2.muted,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <ChevronDownIcon
                      size={11}
                      style={{
                        transform: showFull ? 'rotate(180deg)' : 'none',
                        transition: 'transform 140ms ease',
                      }}
                    />
                    {showFull ? 'Show only changed lines' : 'Show full artifact'}
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {(suggestion.triggerType === 'EDIT_TRIGGERED' ||
          suggestion.triggerType === 'REJECT_TRIGGERED') &&
        suggestion.sourceConversationId ? (
          <TriggerContextDisclosure
            open={triggerOpen}
            onToggle={() => setTriggerOpen((v) => !v)}
            sourceConversationId={suggestion.sourceConversationId}
            sourceMessageId={suggestion.sourceMessageId ?? null}
            triggerType={suggestion.triggerType}
            fallbackBefore={suggestion.beforeText ?? null}
          />
        ) : null}

        {suggestion.rationale ? (
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              lineHeight: 1.55,
              color: STUDIO_TOKENS_V2.ink2,
            }}
          >
            <span
              style={{
                color: STUDIO_TOKENS_V2.muted2,
                fontWeight: 600,
                marginRight: 6,
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Why
            </span>
            {suggestion.rationale}
          </p>
        ) : null}

        {state.kind === 'error' ? (
          <p
            style={{
              margin: 0,
              fontSize: 11.5,
              color: STUDIO_COLORS.dangerFg,
              background: STUDIO_COLORS.dangerBg,
              padding: '6px 8px',
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
            }}
          >
            {state.message}
          </p>
        ) : null}

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
          }}
        >
          <button
            type="button"
            onClick={onAccept}
            disabled={isMutating || isSettled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              color: '#ffffff',
              background:
                state.kind === 'accepted'
                  ? STUDIO_TOKENS_V2.green
                  : STUDIO_TOKENS_V2.blue,
              border: '1px solid transparent',
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              cursor: isMutating || isSettled ? 'default' : 'pointer',
              opacity: isMutating || isSettled ? 0.85 : 1,
              transition: 'background 140ms ease, opacity 140ms ease',
            }}
          >
            <CheckIcon size={13} />
            {state.kind === 'accepting'
              ? 'Accepting…'
              : state.kind === 'accepted'
                ? 'Accepted'
                : 'Accept'}
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={isMutating || isSettled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              color: STUDIO_TOKENS_V2.ink2,
              background: STUDIO_TOKENS_V2.bg,
              border: `1px solid ${STUDIO_TOKENS_V2.border}`,
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              cursor: isMutating || isSettled ? 'default' : 'pointer',
              opacity: isMutating || isSettled ? 0.6 : 1,
            }}
          >
            <CloseIcon size={13} />
            {state.kind === 'rejecting'
              ? 'Rejecting…'
              : state.kind === 'rejected'
                ? 'Rejected'
                : 'Reject'}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (discussing || isSettled) return
              setDiscussing(true)
              try {
                await onDiscuss()
              } finally {
                setDiscussing(false)
              }
            }}
            disabled={discussing || isSettled}
            title="Open a tuning conversation about this suggestion"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              fontSize: 12,
              fontWeight: 500,
              color: STUDIO_TOKENS_V2.blue,
              background: 'transparent',
              border: `1px solid ${STUDIO_TOKENS_V2.border}`,
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              cursor: discussing || isSettled ? 'default' : 'pointer',
              opacity: discussing || isSettled ? 0.6 : 1,
              transition: 'background 140ms ease, border-color 140ms ease',
            }}
            onMouseEnter={(e) => {
              if (!discussing && !isSettled) {
                e.currentTarget.style.background = STUDIO_TOKENS_V2.blueTint
                e.currentTarget.style.borderColor = STUDIO_TOKENS_V2.blueSoft
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = STUDIO_TOKENS_V2.border
            }}
          >
            <MessageSquareIcon size={13} />
            {discussing ? 'Opening…' : 'Discuss in tuning'}
          </button>
        </footer>
      </article>
    </li>
  )
}

function DiffPane({
  kind,
  text,
  contextAbove = 0,
  contextBelow = 0,
}: {
  kind: 'before' | 'after'
  text: string
  /** When > 0, render a "… N unchanged lines" cap above the body. */
  contextAbove?: number
  /** When > 0, render a "… N unchanged lines" cap below the body. */
  contextBelow?: number
}) {
  const isAfter = kind === 'after'
  const label = isAfter ? 'After' : 'Before'
  const bg = isAfter ? STUDIO_TOKENS_V2.diffAddBg : STUDIO_TOKENS_V2.diffDelBg
  const fg = isAfter ? STUDIO_TOKENS_V2.diffAddFg : STUDIO_TOKENS_V2.diffDelFg
  const borderColor = isAfter
    ? 'rgba(10, 91, 255, 0.18)'
    : 'rgba(220, 38, 38, 0.18)'
  const mono =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          color: STUDIO_TOKENS_V2.muted2,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </span>
      {/* 2026-05-15 polish: cap body height so a single legacy
          suggestion (full system-prompt body × 2 panes) doesn't blow
          the list to ~2300px and force scrolling forever. Overflow
          scrolls within the pane; the operator can still see the
          context boundary cards above/below. */}
      <div
        style={{
          border: `1px solid ${borderColor}`,
          borderRadius: STUDIO_TOKENS_V2.radiusSm,
          overflow: 'auto',
          maxHeight: 260,
          background: bg,
        }}
      >
        {contextAbove > 0 ? <ContextRule count={contextAbove} position="top" /> : null}
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            fontFamily: mono,
            fontSize: 11.5,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: fg,
            background: 'transparent',
          }}
        >
          {text}
        </pre>
        {contextBelow > 0 ? <ContextRule count={contextBelow} position="bottom" /> : null}
      </div>
    </div>
  )
}

function ContextRule({ count, position }: { count: number; position: 'top' | 'bottom' }) {
  return (
    <div
      aria-hidden
      style={{
        padding: '4px 10px',
        fontSize: 10.5,
        color: STUDIO_TOKENS_V2.muted2,
        background: STUDIO_TOKENS_V2.surface,
        borderTop: position === 'bottom' ? `1px solid ${STUDIO_TOKENS_V2.borderStrong}` : 'none',
        borderBottom: position === 'top' ? `1px solid ${STUDIO_TOKENS_V2.borderStrong}` : 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontStyle: 'italic',
      }}
    >
      <span style={{ letterSpacing: '0.1em' }}>···</span>
      {count} unchanged line{count === 1 ? '' : 's'} {position === 'top' ? 'above' : 'below'}
    </div>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────────

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
      }}
    />
  )
}

function triggerDotColor(trigger: TuningSuggestion['triggerType']): string {
  switch (trigger) {
    case 'REJECT_TRIGGERED':
      return STUDIO_TOKENS_V2.red
    case 'EDIT_TRIGGERED':
      return STUDIO_TOKENS_V2.amber
    case 'COMPLAINT_TRIGGERED':
    case 'THUMBS_DOWN_TRIGGERED':
      return STUDIO_TOKENS_V2.amber
    case 'ESCALATION_TRIGGERED':
      return STUDIO_TOKENS_V2.red
    default:
      return STUDIO_TOKENS_V2.muted2
  }
}

function formatAge(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diffMs = Date.now() - t
  const m = Math.round(diffMs / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

// ─── Diff slicing ──────────────────────────────────────────────────────────
//
// The diagnostic pipeline tends to round-trip whole-artifact bodies for
// SYSTEM_PROMPT and SOP edits — beforeText and proposedText differ in
// only a handful of lines but each carries hundreds. Rendering all of
// it forces the operator to scan the entire prompt to spot the change.
//
// Strategy: line-level common prefix / common suffix slicing. We trim
// matching lines from the top and bottom of both bodies and only show
// the divergent middle. The number of trimmed lines is surfaced as a
// "… N unchanged lines" rule above and below so the operator knows the
// elision happened.

interface SlicedDiff {
  beforeChunk: string
  afterChunk: string
  prefixLines: number
  suffixLines: number
  identical: boolean
}

function sliceDiff(before: string, after: string): SlicedDiff {
  if (before === after) {
    return {
      beforeChunk: before,
      afterChunk: after,
      prefixLines: 0,
      suffixLines: 0,
      identical: true,
    }
  }
  const a = before.split('\n')
  const b = after.split('\n')
  let prefix = 0
  const limit = Math.min(a.length, b.length)
  while (prefix < limit && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < limit - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  // Don't elide tiny artifacts — under ~12 lines the full view is fine.
  if (a.length <= 12 && b.length <= 12) {
    return {
      beforeChunk: before,
      afterChunk: after,
      prefixLines: 0,
      suffixLines: 0,
      identical: false,
    }
  }
  // Always keep at least one line of context inside the chunk to avoid
  // mid-paragraph cuts when the very next/prev line is unchanged.
  const ctx = 1
  const prefixKept = Math.max(0, prefix - ctx)
  const suffixKept = Math.max(0, suffix - ctx)
  const beforeChunk = a
    .slice(prefixKept, a.length - suffixKept)
    .join('\n')
  const afterChunk = b.slice(prefixKept, b.length - suffixKept).join('\n')
  return {
    beforeChunk,
    afterChunk,
    prefixLines: prefixKept,
    suffixLines: suffixKept,
    identical: false,
  }
}

// ─── Trigger context disclosure ────────────────────────────────────────────
//
// Lazy-loads the source conversation when the operator opens the
// "AI suggested vs your edit" disclosure. The conversation fetch is
// the same one the legacy /tuning detail-panel uses; we just mount the
// minimal slice that's relevant to this row.

function TriggerContextDisclosure({
  open,
  onToggle,
  sourceConversationId,
  sourceMessageId,
  triggerType,
  fallbackBefore,
}: {
  open: boolean
  onToggle: () => void
  sourceConversationId: string
  sourceMessageId: string | null
  triggerType: TuningSuggestion['triggerType']
  /**
   * Used as the AI-draft fallback for legacy rows where the source
   * message is no longer fetchable but the suggestion captured the
   * draft text in `beforeText`.
   */
  fallbackBefore: string | null
}) {
  const [convo, setConvo] = useState<ApiConversationDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (fetchedFor.current === sourceConversationId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGetConversation(sourceConversationId)
      .then((d) => {
        if (cancelled) return
        setConvo(d)
        fetchedFor.current = sourceConversationId
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sourceConversationId])

  const message: ApiMessage | null = useMemo(() => {
    if (!convo || !sourceMessageId) return null
    return convo.messages.find((m) => m.id === sourceMessageId) ?? null
  }, [convo, sourceMessageId])

  const aiDraft =
    message?.originalAiText ??
    (triggerType === 'EDIT_TRIGGERED' || triggerType === 'REJECT_TRIGGERED'
      ? fallbackBefore
      : null)
  const sentText = message?.content ?? null

  return (
    <div
      style={{
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusMd,
        background: STUDIO_TOKENS_V2.surface,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 11.5,
          fontWeight: 500,
          color: STUDIO_TOKENS_V2.ink2,
          textAlign: 'left',
        }}
      >
        <ChevronDownIcon
          size={11}
          style={{
            color: STUDIO_TOKENS_V2.muted,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 140ms ease',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>AI suggested vs your edit</span>
        <span style={{ fontSize: 10.5, color: STUDIO_TOKENS_V2.muted2 }}>
          inbox draft
        </span>
      </button>
      {open ? (
        <div
          style={{
            padding: '0 10px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
            paddingTop: 10,
          }}
        >
          {loading ? (
            <p style={{ margin: 0, fontSize: 11.5, color: STUDIO_TOKENS_V2.muted }}>
              Loading inbox conversation…
            </p>
          ) : error ? (
            <p style={{ margin: 0, fontSize: 11.5, color: STUDIO_COLORS.dangerFg }}>
              Could not load source message: {error}
            </p>
          ) : !aiDraft && !sentText ? (
            <p style={{ margin: 0, fontSize: 11.5, color: STUDIO_TOKENS_V2.muted }}>
              The inbox message that triggered this suggestion is no longer
              available.
            </p>
          ) : (
            <>
              <MessageBubble
                kind="ai"
                label="AI suggested"
                text={aiDraft ?? '(no AI draft captured)'}
              />
              <MessageBubble
                kind="human"
                label="You sent"
                text={sentText ?? '(message not found)'}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function MessageBubble({
  kind,
  label,
  text,
}: {
  kind: 'ai' | 'human'
  label: string
  text: string
}) {
  const isHuman = kind === 'human'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          color: STUDIO_TOKENS_V2.muted2,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </span>
      <div
        style={{
          padding: '8px 10px',
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: isHuman ? STUDIO_TOKENS_V2.bg : STUDIO_TOKENS_V2.surface2,
          color: STUDIO_TOKENS_V2.ink2,
          border: `1px solid ${STUDIO_TOKENS_V2.border}`,
          borderRadius: STUDIO_TOKENS_V2.radiusSm,
        }}
      >
        {text}
      </div>
    </div>
  )
}

// ─── Width toggle ──────────────────────────────────────────────────────────
//
// Lets the operator widen the right panel from the default 340px rail
// to roughly half the centre pane, so the diff/message panes get
// breathing room. State lives in StudioShell so any tab can read it,
// but only the Suggestions header surfaces the toggle today — the
// other tabs already fit comfortably at 340px.

function WidthToggle({
  wide,
  onToggle,
}: {
  wide: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={wide}
      title={wide ? 'Shrink panel' : 'Expand panel wide'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        flexShrink: 0,
        color: wide ? STUDIO_TOKENS_V2.blue : STUDIO_TOKENS_V2.muted,
        background: wide ? STUDIO_TOKENS_V2.blueSoft : 'transparent',
        border: `1px solid ${wide ? STUDIO_TOKENS_V2.blueSoft : STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusSm,
        cursor: 'pointer',
        transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
      }}
      onMouseEnter={(e) => {
        if (!wide) {
          e.currentTarget.style.background = STUDIO_TOKENS_V2.surface2
          e.currentTarget.style.color = STUDIO_TOKENS_V2.ink2
        }
      }}
      onMouseLeave={(e) => {
        if (!wide) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = STUDIO_TOKENS_V2.muted
        }
      }}
    >
      {wide ? <ContractIcon size={14} /> : <ExpandIcon size={14} />}
    </button>
  )
}

function ExpandIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 9V5h4" />
      <path d="M20 9V5h-4" />
      <path d="M4 15v4h4" />
      <path d="M20 15v4h-4" />
    </svg>
  )
}

function ContractIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 4v4H5" />
      <path d="M15 4v4h4" />
      <path d="M9 20v-4H5" />
      <path d="M15 20v-4h4" />
    </svg>
  )
}
