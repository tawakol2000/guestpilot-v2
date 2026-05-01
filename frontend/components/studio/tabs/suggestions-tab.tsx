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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  apiAcceptTuningSuggestion,
  apiListTuningSuggestions,
  apiRejectTuningSuggestion,
  type TuningSuggestion,
  type TuningSuggestionStatus,
} from '@/lib/api'
import {
  STUDIO_COLORS,
  STUDIO_TOKENS_V2,
  getStudioCategoryStyle,
  triggerLabel,
} from '../tokens'
import { SparkleIcon, CheckIcon, CloseIcon, ChevronDownIcon } from '../icons'

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
}

export function SuggestionsTab({ onPendingCountChange }: SuggestionsTabProps) {
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
        await apiAcceptTuningSuggestion(s.id, {})
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
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
      </header>

      <FilterPills
        value={filter}
        onChange={(v) => {
          setFilter(v)
          setRowState({})
        }}
      />

      {error ? (
        <div
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
}: {
  suggestion: TuningSuggestion
  state: RowState
  index: number
  onAccept: () => void
  onReject: () => void
}) {
  const [showFullBefore, setShowFullBefore] = useState(false)
  const [showFullAfter, setShowFullAfter] = useState(false)

  const cat = getStudioCategoryStyle(suggestion.diagnosticCategory)
  const trigger = triggerLabel(suggestion.triggerType)
  const isSettled = state.kind === 'accepted' || state.kind === 'rejected'
  const isMutating = state.kind === 'accepting' || state.kind === 'rejecting'

  const ageLabel = formatAge(suggestion.createdAt)
  const before = suggestion.beforeText ?? ''
  const after = suggestion.proposedText ?? ''

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
            {before ? (
              <DiffPane
                kind="before"
                text={before}
                expanded={showFullBefore}
                onToggle={() => setShowFullBefore((v) => !v)}
              />
            ) : null}
            {after ? (
              <DiffPane
                kind="after"
                text={after}
                expanded={showFullAfter}
                onToggle={() => setShowFullAfter((v) => !v)}
              />
            ) : null}
          </div>
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
        </footer>
      </article>
    </li>
  )
}

function DiffPane({
  kind,
  text,
  expanded,
  onToggle,
}: {
  kind: 'before' | 'after'
  text: string
  expanded: boolean
  onToggle: () => void
}) {
  const isAfter = kind === 'after'
  const label = isAfter ? 'After' : 'Before'
  const bg = isAfter ? STUDIO_TOKENS_V2.diffAddBg : STUDIO_TOKENS_V2.diffDelBg
  const fg = isAfter ? STUDIO_TOKENS_V2.diffAddFg : STUDIO_TOKENS_V2.diffDelFg
  const borderColor = isAfter
    ? 'rgba(10, 91, 255, 0.18)'
    : 'rgba(220, 38, 38, 0.18)'
  const truncatable = text.length > 220
  const visibleText = expanded || !truncatable ? text : text.slice(0, 220) + '…'
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
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          fontFamily: mono,
          fontSize: 11.5,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: bg,
          color: fg,
          border: `1px solid ${borderColor}`,
          borderRadius: STUDIO_TOKENS_V2.radiusSm,
          maxHeight: expanded ? undefined : 140,
          overflow: 'hidden',
        }}
      >
        {visibleText}
      </pre>
      {truncatable ? (
        <button
          type="button"
          onClick={onToggle}
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
              transform: expanded ? 'rotate(180deg)' : 'none',
              transition: 'transform 140ms ease',
            }}
          />
          {expanded ? 'Show less' : 'Show full'}
        </button>
      ) : null}
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
