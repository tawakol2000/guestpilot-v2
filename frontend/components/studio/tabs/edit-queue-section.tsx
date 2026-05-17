'use client'

/**
 * Tuning Edit Queue section (2026-05-17, redesign).
 *
 * Visual goals:
 *   - Match the studio suggestion-card aesthetic (hairline cards on white,
 *     same radius / shadow / typography).
 *   - One header, one count. No nested toggle clutter.
 *   - Pending: card with the AFTER text prominent, original tucked under
 *     a "vs original" disclosure. Single primary CTA + dismiss.
 *   - Processed: compact one-line rows with a status dot and the edited
 *     text. Click to expand into a clean detail card with the diagnostic
 *     outcome — NOT a wall of debugging text.
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
  const [rowBusy, setRowBusy] = useState<Record<string, 'analyzing' | 'dismissing'>>({})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        apiListTuningQueue({ bucket: 'pending', limit: 50 }),
        apiListTuningQueue({ bucket: 'analyzed', limit: 20 }),
      ])
      setPending(p.items)
      setAnalyzed(a.items)
    } catch (e) {
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
            res.status === 'ANALYZED' && res.suggestionId
              ? 'New suggestion below.'
              : 'No fix was needed for this edit.',
        })
        await refresh()
        if (onAnalyzed) onAnalyzed()
      } catch (e) {
        toast.error('Analysis failed', {
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

  if (loading) return null
  if (pending.length === 0 && analyzed.length === 0) return null

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingBottom: 14,
        borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
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
        <span style={{ fontSize: 11.5, color: STUDIO_TOKENS_V2.muted }}>
          {pending.length > 0
            ? `${pending.length} waiting${analyzed.length ? ` · ${analyzed.length} done` : ''}`
            : `${analyzed.length} processed`}
        </span>
      </header>

      {pending.length > 0 ? (
        <ul style={listReset}>
          {pending.map((item) => (
            <li key={item.id} style={{ listStyle: 'none', marginBottom: 8 }}>
              <PendingCard
                item={item}
                busy={rowBusy[item.id]}
                onAnalyze={() => void handleAnalyze(item)}
                onDismiss={() => void handleDismiss(item)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {analyzed.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 0',
              fontSize: 11.5,
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
                transform: historyOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 140ms ease',
              }}
            />
            History ({analyzed.length})
          </button>
          {historyOpen ? (
            <ul style={{ ...listReset, marginTop: 6 }}>
              {analyzed.map((item) => (
                <ProcessedRow
                  key={item.id}
                  item={item}
                  expanded={expandedRow === item.id}
                  onToggle={() => setExpandedRow((x) => (x === item.id ? null : item.id))}
                />
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
  const [showOriginal, setShowOriginal] = useState(false)
  const cat = item.preClassifierCategory
  const triggerColor =
    item.triggerType === 'REJECT_TRIGGERED' ? STUDIO_TOKENS_V2.red : STUDIO_TOKENS_V2.amber

  return (
    <article
      style={{
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.bg,
        padding: '12px 14px',
        boxShadow: STUDIO_TOKENS_V2.shadowSm,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: triggerColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 11.5, color: STUDIO_TOKENS_V2.muted2, fontWeight: 500 }}>
          {item.triggerType === 'REJECT_TRIGGERED' ? 'Rewrote AI draft' : 'Edited AI draft'}
        </span>
        {cat ? (
          <span style={{ fontSize: 11, color: STUDIO_TOKENS_V2.muted }}>
            · likely {prettyCategory(cat)}
          </span>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: STUDIO_TOKENS_V2.muted2 }}>
          {formatAge(item.createdAt)}
        </span>
      </header>

      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.55,
          color: STUDIO_TOKENS_V2.ink,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {item.editedText}
      </p>

      <button
        type="button"
        onClick={() => setShowOriginal((v) => !v)}
        aria-expanded={showOriginal}
        style={{
          alignSelf: 'flex-start',
          padding: '2px 0',
          fontSize: 11,
          fontWeight: 500,
          color: STUDIO_TOKENS_V2.muted,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'inline-flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        <ChevronDownIcon
          size={10}
          style={{
            transform: showOriginal ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 140ms ease',
          }}
        />
        {showOriginal ? 'Hide original AI draft' : 'Show original AI draft'}
      </button>
      {showOriginal ? (
        <p
          style={{
            margin: 0,
            padding: '8px 10px',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: STUDIO_TOKENS_V2.muted,
            background: STUDIO_TOKENS_V2.surface,
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {item.originalText}
        </p>
      ) : null}

      <footer style={{ display: 'flex', gap: 6, paddingTop: 2 }}>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={!!busy}
          style={primaryBtn(busy === 'analyzing')}
        >
          <SparkleIcon size={12} />
          {busy === 'analyzing' ? 'Analyzing…' : 'Run analysis'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={!!busy}
          style={ghostBtn(busy === 'dismissing')}
        >
          <CloseIcon size={12} />
          {busy === 'dismissing' ? 'Dismissing…' : 'Dismiss'}
        </button>
      </footer>
    </article>
  )
}

// ─── Processed row (compact, expandable) ────────────────────────────────────

function ProcessedRow({
  item,
  expanded,
  onToggle,
}: {
  item: TuningQueueItem
  expanded: boolean
  onToggle: () => void
}) {
  const verdict = describeOutcome(item)

  return (
    <li
      style={{
        listStyle: 'none',
        borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: '100%',
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          padding: '8px 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 12,
          color: STUDIO_TOKENS_V2.ink2,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: verdict.dotColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 11.5, color: STUDIO_TOKENS_V2.muted2, flexShrink: 0, minWidth: 90 }}>
          {verdict.label}
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: STUDIO_TOKENS_V2.ink2,
          }}
        >
          {item.editedText}
        </span>
        <span style={{ fontSize: 10.5, color: STUDIO_TOKENS_V2.muted2, flexShrink: 0 }}>
          {formatAge(item.analyzedAt ?? item.createdAt)}
        </span>
      </button>
      {expanded ? (
        <div style={{ padding: '0 0 12px 16px' }}>
          <div
            style={{
              padding: '10px 12px',
              background: STUDIO_TOKENS_V2.surface,
              borderRadius: STUDIO_TOKENS_V2.radiusMd,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.55,
                color: STUDIO_TOKENS_V2.ink2,
              }}
            >
              {verdict.explainer}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.5,
                color: STUDIO_TOKENS_V2.ink,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {item.editedText}
            </p>
            {item.errorMessage ? (
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
                {item.errorMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function describeOutcome(item: TuningQueueItem): {
  label: string
  dotColor: string
  explainer: string
} {
  switch (item.status) {
    case 'ANALYZED':
      if (item.suggestion) {
        return {
          label: 'Suggestion ready',
          dotColor: STUDIO_TOKENS_V2.blue,
          explainer: 'A new tuning suggestion was created. Find it in the list below.',
        }
      }
      return {
        label: 'No change needed',
        dotColor: STUDIO_TOKENS_V2.muted2,
        explainer:
          "Analysis ran but didn't propose a fix — your edit didn't reveal a pattern worth changing.",
      }
    case 'SKIPPED_NO_FIX':
      return {
        label: 'Polish only',
        dotColor: STUDIO_TOKENS_V2.muted2,
        explainer:
          'This looked like a wording polish, so the full analysis was skipped. If you want a real tuning fix, dismiss this and edit again with a clearer change.',
      }
    case 'SKIPPED_COOLDOWN':
      return {
        label: 'Skipped (legacy)',
        dotColor: STUDIO_TOKENS_V2.muted2,
        explainer:
          'Legacy cooldown skip. The cooldown was removed; this row is here for history only.',
      }
    case 'DISMISSED':
      return {
        label: 'Dismissed',
        dotColor: STUDIO_TOKENS_V2.muted2,
        explainer: 'You dismissed this edit without running analysis.',
      }
    case 'FAILED':
      return {
        label: 'Failed',
        dotColor: STUDIO_TOKENS_V2.red,
        explainer: 'Analysis crashed. See the error message below.',
      }
    case 'ANALYZING':
      return {
        label: 'Running…',
        dotColor: STUDIO_TOKENS_V2.blue,
        explainer: 'Analysis is in flight.',
      }
    case 'PENDING':
    default:
      return {
        label: 'Pending',
        dotColor: STUDIO_TOKENS_V2.amber,
        explainer: 'Waiting for you to start analysis.',
      }
  }
}

function prettyCategory(c: string): string {
  switch (c) {
    case 'SYSTEM_PROMPT':
      return 'system-prompt fix'
    case 'SOP':
      return 'SOP fix'
    case 'FAQ':
      return 'FAQ fix'
    case 'NO_FIX':
      return 'polish only'
    default:
      return c.toLowerCase()
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

// ─── Styles ─────────────────────────────────────────────────────────────────

const listReset: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
}

function primaryBtn(busy: boolean): React.CSSProperties {
  return {
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
  }
}

function ghostBtn(busy: boolean): React.CSSProperties {
  return {
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
  }
}
