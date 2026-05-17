'use client'

/**
 * Tuning Edit Queue section (2026-05-17).
 *
 * Renders above the existing Suggestions list. Two visible buckets:
 *   - "Pending analysis" — edits captured in manual mode (or auto-mode runs
 *     that haven't yet completed). Each card exposes "Run analysis" and
 *     "Dismiss" actions.
 *   - "Recently analyzed" (collapsed by default) — short history of items
 *     that were already run, with their outcome (suggestion id, skipped,
 *     failed). Lets the operator double-check whether a recent edit landed.
 *
 * Lives in its own file so the (already-large) suggestions-tab.tsx stays
 * scannable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  apiListTuningQueue,
  apiAnalyzeTuningQueueItem,
  apiDismissTuningQueueItem,
  type TuningQueueItem,
} from '@/lib/api'
import { STUDIO_COLORS, STUDIO_TOKENS_V2 } from '../tokens'
import { ChevronDownIcon, CloseIcon, SparkleIcon } from '../icons'

export interface EditQueueSectionProps {
  /** Called after a successful analysis run so the parent can refresh its suggestions list. */
  onAnalyzed?: () => void
}

export function EditQueueSection({ onAnalyzed }: EditQueueSectionProps) {
  const [pending, setPending] = useState<TuningQueueItem[]>([])
  const [analyzed, setAnalyzed] = useState<TuningQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [rowBusy, setRowBusy] = useState<Record<string, 'analyzing' | 'dismissing'>>({})

  const refresh = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        apiListTuningQueue({ bucket: 'pending', limit: 50 }),
        apiListTuningQueue({ bucket: 'analyzed', limit: 20 }),
      ])
      setPending(p.items)
      setAnalyzed(a.items)
    } catch (e) {
      // Silent: queue is supplementary; failure shouldn't blank the panel.
      console.warn('[EditQueue] list failed:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAnalyze = useCallback(
    async (item: TuningQueueItem) => {
      setRowBusy((m) => ({ ...m, [item.id]: 'analyzing' }))
      try {
        const res = await apiAnalyzeTuningQueueItem(item.id)
        toast.success('Analysis complete', {
          description:
            res.status === 'ANALYZED'
              ? res.suggestionId
                ? 'A new tuning suggestion is below.'
                : 'No fix proposed.'
              : prettyStatus(res.status),
        })
        await refresh()
        if (onAnalyzed) onAnalyzed()
      } catch (e) {
        toast.error('Could not run analysis', {
          description: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setRowBusy((m) => {
          const { [item.id]: _, ...rest } = m
          return rest
        })
      }
    },
    [refresh, onAnalyzed],
  )

  const handleDismiss = useCallback(
    async (item: TuningQueueItem) => {
      setRowBusy((m) => ({ ...m, [item.id]: 'dismissing' }))
      try {
        await apiDismissTuningQueueItem(item.id)
        await refresh()
      } catch (e) {
        toast.error('Could not dismiss', {
          description: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setRowBusy((m) => {
          const { [item.id]: _, ...rest } = m
          return rest
        })
      }
    },
    [refresh],
  )

  const headerCount = pending.length

  if (loading) return null
  if (pending.length === 0 && analyzed.length === 0) return null

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingBottom: 12,
        borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Edit queue
        </span>
        <span
          style={{
            fontSize: 11,
            color: STUDIO_TOKENS_V2.muted,
          }}
        >
          {headerCount === 0
            ? 'no pending edits'
            : `${headerCount} pending analysis`}
        </span>
      </header>

      {pending.length > 0 ? (
        <ul style={listReset}>
          {pending.map((item) => (
            <PendingCard
              key={item.id}
              item={item}
              busy={rowBusy[item.id]}
              onAnalyze={() => void handleAnalyze(item)}
              onDismiss={() => void handleDismiss(item)}
            />
          ))}
        </ul>
      ) : null}

      {analyzed.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            style={historyToggleStyle}
          >
            <ChevronDownIcon
              size={11}
              style={{
                transform: historyOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 140ms ease',
              }}
            />
            Recently analyzed ({analyzed.length})
          </button>
          {historyOpen ? (
            <ul style={{ ...listReset, marginTop: 8 }}>
              {analyzed.map((item) => (
                <AnalyzedRow key={item.id} item={item} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

// ─── Pending card ───────────────────────────────────────────────────────────

function PendingCard({
  item,
  busy,
  onAnalyze,
  onDismiss,
}: {
  item: TuningQueueItem
  busy: 'analyzing' | 'dismissing' | undefined
  onAnalyze: () => void
  onDismiss: () => void
}) {
  const cat = item.preClassifierCategory
  const conf = item.preClassifierConfidence ?? null
  const triggerColor =
    item.triggerType === 'REJECT_TRIGGERED' ? STUDIO_TOKENS_V2.red : STUDIO_TOKENS_V2.amber

  return (
    <li
      style={{
        listStyle: 'none',
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.bg,
        padding: 12,
        boxShadow: STUDIO_TOKENS_V2.shadowSm,
        marginBottom: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '2px 7px',
            borderRadius: 999,
            background: cat ? STUDIO_TOKENS_V2.blueSoft : STUDIO_TOKENS_V2.surface2,
            color: cat ? STUDIO_TOKENS_V2.blue : STUDIO_TOKENS_V2.muted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {cat ? formatCat(cat) : 'unclassified'}
        </span>
        {conf !== null ? (
          <span style={{ fontSize: 10.5, color: STUDIO_TOKENS_V2.muted2 }}>
            conf {(conf * 100).toFixed(0)}%
          </span>
        ) : null}
        <span
          style={{
            fontSize: 10.5,
            color: STUDIO_TOKENS_V2.muted,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            aria-hidden
            style={{ width: 5, height: 5, borderRadius: 999, background: triggerColor }}
          />
          {item.triggerType === 'REJECT_TRIGGERED' ? 'wholesale rewrite' : 'edit'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: STUDIO_TOKENS_V2.muted2 }}>
          {formatAge(item.createdAt)}
        </span>
      </header>

      <DiffPair before={item.originalText} after={item.editedText} />

      {item.preClassifierRationale ? (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            lineHeight: 1.5,
            color: STUDIO_TOKENS_V2.ink2,
          }}
        >
          <span
            style={{
              color: STUDIO_TOKENS_V2.muted2,
              fontWeight: 600,
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginRight: 6,
            }}
          >
            Pre-classifier
          </span>
          {item.preClassifierRationale}
        </p>
      ) : null}

      <footer style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={!!busy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 600,
            color: '#ffffff',
            background: STUDIO_TOKENS_V2.blue,
            border: '1px solid transparent',
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
        >
          <SparkleIcon size={12} />
          {busy === 'analyzing' ? 'Analyzing…' : 'Run analysis'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={!!busy}
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
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          <CloseIcon size={12} />
          {busy === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
        </button>
      </footer>
    </li>
  )
}

// ─── Analyzed history row (compact) ─────────────────────────────────────────

function AnalyzedRow({ item }: { item: TuningQueueItem }) {
  const verdict = describeAnalyzedOutcome(item)
  return (
    <li
      style={{
        listStyle: 'none',
        padding: '8px 10px',
        fontSize: 11.5,
        color: STUDIO_TOKENS_V2.ink2,
        borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: 4,
          background: verdict.bg,
          color: verdict.fg,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {verdict.label}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: STUDIO_TOKENS_V2.muted }}>
        {item.editedText}
      </span>
      <span style={{ fontSize: 10.5, color: STUDIO_TOKENS_V2.muted2 }}>
        {formatAge(item.analyzedAt ?? item.createdAt)}
      </span>
    </li>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function DiffPair({ before, after }: { before: string; after: string }) {
  const mono =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <DiffLine kind="before" text={before} mono={mono} />
      <DiffLine kind="after" text={after} mono={mono} />
    </div>
  )
}

function DiffLine({
  kind,
  text,
  mono,
}: {
  kind: 'before' | 'after'
  text: string
  mono: string
}) {
  const isAfter = kind === 'after'
  return (
    <div
      style={{
        border: `1px solid ${isAfter ? 'rgba(10, 91, 255, 0.18)' : 'rgba(220, 38, 38, 0.18)'}`,
        background: isAfter ? STUDIO_TOKENS_V2.diffAddBg : STUDIO_TOKENS_V2.diffDelBg,
        color: isAfter ? STUDIO_TOKENS_V2.diffAddFg : STUDIO_TOKENS_V2.diffDelFg,
        borderRadius: STUDIO_TOKENS_V2.radiusSm,
        padding: '6px 8px',
        fontFamily: mono,
        fontSize: 11.5,
        lineHeight: 1.5,
        maxHeight: 100,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  )
}

function describeAnalyzedOutcome(item: TuningQueueItem): {
  label: string
  bg: string
  fg: string
} {
  switch (item.status) {
    case 'ANALYZED':
      if (item.suggestion) {
        return { label: 'Suggestion', bg: STUDIO_TOKENS_V2.blueSoft, fg: STUDIO_TOKENS_V2.blue }
      }
      return { label: 'No fix', bg: STUDIO_TOKENS_V2.surface2, fg: STUDIO_TOKENS_V2.muted }
    case 'SKIPPED_NO_FIX':
      return { label: 'Skipped · polish', bg: STUDIO_TOKENS_V2.surface2, fg: STUDIO_TOKENS_V2.muted }
    case 'SKIPPED_COOLDOWN':
      return { label: 'Skipped · cooldown', bg: STUDIO_TOKENS_V2.surface2, fg: STUDIO_TOKENS_V2.muted }
    case 'DISMISSED':
      return { label: 'Dismissed', bg: STUDIO_TOKENS_V2.surface2, fg: STUDIO_TOKENS_V2.muted2 }
    case 'FAILED':
      return { label: 'Failed', bg: STUDIO_COLORS.dangerBg, fg: STUDIO_COLORS.dangerFg }
    case 'ANALYZING':
      return { label: 'Running…', bg: STUDIO_TOKENS_V2.blueSoft, fg: STUDIO_TOKENS_V2.blue }
    case 'PENDING':
    default:
      return { label: 'Pending', bg: STUDIO_TOKENS_V2.surface2, fg: STUDIO_TOKENS_V2.muted }
  }
}

function prettyStatus(s: string): string {
  switch (s) {
    case 'SKIPPED_NO_FIX':
      return 'Pre-classifier said NO_FIX — diagnostic skipped.'
    case 'SKIPPED_COOLDOWN':
      return 'Recent similar fix on cooldown — diagnostic skipped.'
    case 'FAILED':
      return 'Diagnostic failed.'
    default:
      return s
  }
}

function formatCat(c: string): string {
  return c.replace(/_/g, ' ').toLowerCase()
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

const listReset: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
}

const historyToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  fontSize: 11,
  fontWeight: 500,
  color: STUDIO_TOKENS_V2.muted,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
}
