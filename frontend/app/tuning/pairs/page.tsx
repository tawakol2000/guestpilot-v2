'use client'

/**
 * Feature 041 sprint 08 §3 — /tuning/pairs
 *
 * Read-only viewer over the `PreferencePair` table. Each row is a
 * (context, rejected suggestion, preferred final) triple captured on every
 * reject or edit-then-accept in sprint 03. V1 never surfaced these rows;
 * sprint 08 exposes them so the manager can see what the agent learned.
 *
 * Follows the existing /tuning/history and /tuning/capability-requests page
 * pattern: TuningTopNav, max-w-3xl centered main, skeleton → list → empty
 * state path. Detail expansion renders the full JSON triple side-by-side
 * with DiffViewer between rejected and preferred final.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, ChevronDown } from 'lucide-react'
import {
  apiGetPreferencePair,
  apiGetPreferencePairStats,
  apiListPreferencePairs,
  type TuningPreferencePairDetail,
  type TuningPreferencePairStats,
  type TuningPreferencePairSummary,
  type TuningDiagnosticCategory,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { DiffViewer } from '@/components/tuning/diff-viewer'
import { RelativeTime } from '@/components/tuning/relative-time'
import { CategoryPill } from '@/components/tuning/category-pill'
import { CATEGORY_STYLES, TUNING_COLORS, categoryStyle } from '@/components/tuning/tokens'

function pickText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (typeof obj.answer === 'string') return obj.answer
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function StatsBanner({ stats }: { stats: TuningPreferencePairStats | null }) {
  if (!stats || stats.total === 0) return null
  const entries = Object.entries(stats.byCategory)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  return (
    <div
      className="mt-5 flex flex-col gap-3 rounded-xl p-4 md:flex-row md:items-center md:justify-between"
      style={{
        background: TUNING_COLORS.surfaceRaised,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      <div>
        <div className="text-xs font-medium text-[#6B7280]">Total pairs</div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums text-[#1A1A1A]">
          {stats.total}
        </div>
        {stats.oldestAt && stats.newestAt ? (
          <div className="mt-1 text-xs text-[#9CA3AF]">
            first <RelativeTime iso={stats.oldestAt} /> · latest{' '}
            <RelativeTime iso={stats.newestAt} />
          </div>
        ) : null}
      </div>
      <ul className="flex flex-wrap items-center gap-1.5">
        {entries.map(([key, count]) => {
          const cat = (key === 'LEGACY' ? null : (key as TuningDiagnosticCategory))
          const meta = categoryStyle(cat)
          return (
            <li
              key={key}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: meta.bg, color: meta.fg }}
              title={`${meta.label} · ${count} pair${count === 1 ? '' : 's'}`}
            >
              <span>{meta.label}</span>
              <span className="tabular-nums opacity-70">· {count}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PairRow({ pair }: { pair: TuningPreferencePairSummary }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<TuningPreferencePairDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadDetail = useCallback(async () => {
    if (detail || loading) return
    setLoading(true)
    setDetailErr(null)
    try {
      const d = await apiGetPreferencePair(pair.id)
      setDetail(d)
    } catch (e) {
      setDetailErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [detail, loading, pair.id])

  const onToggle = useCallback(() => {
    const next = !open
    setOpen(next)
    if (next) void loadDetail()
  }, [loadDetail, open])

  return (
    <li
      className="py-5"
      style={{ borderBottom: `1px solid ${TUNING_COLORS.hairlineSoft}` }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group grid w-full grid-cols-[auto_1fr_1fr_1fr_auto] items-start gap-4 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
      >
        <div className="shrink-0">
          <CategoryPill category={pair.category} subLabel={null} />
        </div>
        <Excerpt label="Context" text={pair.contextExcerpt} />
        <Excerpt label="Rejected" text={pair.rejectedExcerpt} accent="#B91C1C" />
        <Excerpt label="Accepted" text={pair.acceptedExcerpt} accent="#047857" />
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] tabular-nums text-[#9CA3AF]">
            <RelativeTime iso={pair.createdAt} />
          </span>
          <ChevronDown
            size={14}
            strokeWidth={2}
            className="text-[#9CA3AF] transition-transform duration-200"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
            aria-hidden
          />
        </div>
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          {detailErr ? (
            <div
              className="rounded-lg border-l-2 px-3 py-2 text-xs"
              style={{
                background: TUNING_COLORS.dangerBg,
                borderLeftColor: TUNING_COLORS.dangerFg,
                color: TUNING_COLORS.dangerFg,
              }}
            >
              {detailErr}
            </div>
          ) : null}
          {loading && !detail ? (
            <div className="text-xs text-[#9CA3AF]">Loading…</div>
          ) : detail ? (
            <>
              <DetailBlock label="Context" value={detail.context} />
              <div>
                <div className="mb-1.5 text-xs font-medium text-[#6B7280]">
                  Rejected → Accepted
                </div>
                <DiffViewer
                  before={pickText(detail.rejectedSuggestion)}
                  after={pickText(detail.preferredFinal)}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function Excerpt({
  label,
  text,
  accent,
}: {
  label: string
  text: string
  accent?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium text-[#9CA3AF]">{label}</div>
      <div
        className="mt-0.5 line-clamp-3 text-xs leading-5"
        style={{ color: accent ?? TUNING_COLORS.ink }}
      >
        {text || <span className="italic text-[#9CA3AF]">(empty)</span>}
      </div>
    </div>
  )
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  const text = pickText(value)
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-[#6B7280]">{label}</div>
      <pre
        className="overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 text-xs leading-5"
        style={{ background: TUNING_COLORS.surfaceSunken, color: TUNING_COLORS.ink }}
      >
        {text || '(empty)'}
      </pre>
    </div>
  )
}

function PairsPageInner() {
  const [pairs, setPairs] = useState<TuningPreferencePairSummary[] | null>(null)
  const [stats, setStats] = useState<TuningPreferencePairStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [listRes, statsRes] = await Promise.all([
        apiListPreferencePairs({ limit: 50 }),
        apiGetPreferencePairStats(),
      ])
      setPairs(listRes.pairs)
      setStats(statsRes)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const isEmpty = !loading && !error && pairs !== null && pairs.length === 0

  const headline = useMemo(() => {
    if (!stats) return 'Preference pairs'
    if (stats.total === 0) return 'Preference pairs'
    return `${stats.total} preference pair${stats.total === 1 ? '' : 's'}`
  }, [stats])

  return (
    <div className="flex min-h-dvh flex-col">
      <TuningTopNav />
      <main className="mx-auto w-full max-w-4xl px-5 py-6 md:px-8 md:py-8">
        <header className="space-y-2">
          <div className="text-xs font-medium text-[#6B7280]">Preference pairs</div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
            {headline}
          </h1>
          <p className="max-w-prose text-sm leading-6 text-[#6B7280]">
            Every reject or edit-then-accept captures a (context, rejected
            suggestion, preferred final) triple. These are the training signal
            the agent learns from over time.
          </p>
        </header>

        <StatsBanner stats={stats} />

        {error ? (
          <div
            className="mt-8 rounded-lg border-l-2 px-4 py-3 text-sm"
            style={{
              background: TUNING_COLORS.dangerBg,
              borderLeftColor: TUNING_COLORS.dangerFg,
              color: TUNING_COLORS.dangerFg,
            }}
            role="alert"
          >
            Couldn&rsquo;t load preference pairs: {error}
          </div>
        ) : null}

        <ul className="mt-8">
          {loading && pairs === null ? (
            Array.from({ length: 4 }).map((_, i) => (
              <li
                key={`skel-${i}`}
                className="my-3 h-20 animate-pulse rounded-lg"
                style={{ background: TUNING_COLORS.surfaceSunken }}
              />
            ))
          ) : null}
          {isEmpty ? (
            <li className="flex flex-col items-center justify-center gap-4 py-16 text-center">
              <span
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#6C5CE7]"
                style={{ background: TUNING_COLORS.accentSoft }}
              >
                <ArrowLeftRight size={18} strokeWidth={2} aria-hidden />
              </span>
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-[#1A1A1A]">
                  No preference pairs yet
                </h2>
                <p className="mt-1.5 max-w-prose text-sm leading-6 text-[#6B7280]">
                  Reject or edit a suggestion to start building training signal.
                </p>
              </div>
            </li>
          ) : null}
          {pairs?.map((p) => <PairRow key={p.id} pair={p} />)}
        </ul>
      </main>
    </div>
  )
}

// Silence unused-import warning from strict linters (CATEGORY_STYLES is
// part of the token set we depend on for stable category palette).
void CATEGORY_STYLES

export default function PairsPage() {
  return (
    <TuningAuthGate>
      <PairsPageInner />
    </TuningAuthGate>
  )
}
