'use client'

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  MinusCircle,
  PackageCheck,
  XCircle,
} from 'lucide-react'
import {
  apiTuningCategoryStats,
  apiTuningCoverage,
  apiTuningGraduationMetrics,
  apiTuningRetentionSummary,
  type TuningCategoryStatsRow,
  type TuningCoverage,
  type TuningGraduationMetrics,
  type TuningRetentionSummary,
  type TuningDiagnosticCategory,
} from '@/lib/api'
import { TUNING_COLORS, categoryAccent, categoryStyle } from './tokens'

function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

function Bar({
  value,
  max = 1,
  color,
}: {
  value: number
  max?: number
  color?: string
}) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100
  return (
    <span
      className="relative block h-[4px] w-full overflow-hidden rounded-full"
      style={{ background: TUNING_COLORS.hairlineSoft }}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%`, background: color ?? TUNING_COLORS.accent }}
      />
    </span>
  )
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string
  value: string
  hint?: string
  warn?: boolean
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-2xl font-semibold tabular-nums tracking-tight"
          style={{ color: TUNING_COLORS.ink }}
        >
          {value}
        </span>
        {warn ? (
          <span
            className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: TUNING_COLORS.warnFg }}
            aria-label="Above target threshold"
            title="Above target threshold"
          />
        ) : null}
      </div>
      <div className="mt-1 text-xs font-medium text-[#6B7280]">{label}</div>
      {hint ? <div className="mt-0.5 text-xs text-[#9CA3AF]">{hint}</div> : null}
    </div>
  )
}

function SectionHeader({
  title,
  meta,
}: {
  title: string
  meta?: string
}) {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="text-sm font-semibold tracking-tight text-[#1A1A1A]">{title}</h3>
      {meta ? (
        <span className="font-mono text-xs text-[#9CA3AF]">{meta}</span>
      ) : null}
    </div>
  )
}

function VelocityDashboard() {
  const [stats, setStats] = useState<TuningCategoryStatsRow[] | null>(null)
  const [coverage, setCoverage] = useState<TuningCoverage | null>(null)
  // Bug fix (round 14) — track per-request error state instead of a single
  // `err` that only fires when BOTH reject. Previously a partial failure
  // (e.g. coverage fetch fails, stats succeeds) left the coverage hero
  // card stuck showing "loading…" forever because `coverage` stayed null
  // with no error signal.
  const [coverageErr, setCoverageErr] = useState(false)
  const [statsErr, setStatsErr] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([apiTuningCategoryStats(), apiTuningCoverage()]).then((out) => {
      if (cancelled) return
      const [s, c] = out
      if (s.status === 'fulfilled') setStats(s.value.stats)
      else setStatsErr(true)
      if (c.status === 'fulfilled') setCoverage(c.value)
      else setCoverageErr(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="space-y-4">
      <SectionHeader title="Tuning velocity" meta="Last 14 days" />

      {/* Coverage hero card */}
      <div
        className="rounded-xl p-4"
        style={{
          background: TUNING_COLORS.surfaceRaised,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        <div className="flex items-end justify-between">
          <div>
            <div className="text-xs font-medium text-[#6B7280]">Coverage</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-[#1A1A1A]">
              {fmtPct(coverage?.coverage ?? null, 0)}
            </div>
          </div>
          <div className="text-right text-xs text-[#9CA3AF]">
            {coverage ? (
              <>
                <div className="tabular-nums">
                  {coverage.unedited} / {coverage.totalSent}
                </div>
                <div>unedited · {coverage.windowDays}d</div>
              </>
            ) : coverageErr ? (
              'unavailable'
            ) : (
              'loading…'
            )}
          </div>
        </div>
        <div className="mt-3">
          <Bar value={coverage?.coverage ?? 0} />
        </div>
      </div>

      {/* Acceptance by category */}
      <div>
        <div className="mb-2 text-xs font-medium text-[#6B7280]">
          Acceptance by category
        </div>
        {stats && stats.length ? (
          <ul className="space-y-2">
            {stats
              .slice()
              .sort((a, b) => b.acceptCount + b.rejectCount - (a.acceptCount + a.rejectCount))
              .map((row) => {
                const cat = row.category as TuningDiagnosticCategory
                // Bug fix (round 12) — use the categoryStyle() / categoryAccent()
                // helpers rather than the raw Record lookups, so an unknown
                // category (e.g. backend ships a new enum before the frontend
                // deploys) falls back to LEGACY/neutral instead of crashing
                // on `meta.bg`.
                const meta = categoryStyle(cat)
                const color = categoryAccent(cat)
                const total = row.acceptCount + row.rejectCount
                return (
                  <li key={cat} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span
                        className="rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{ background: meta.bg, color: meta.fg }}
                      >
                        {meta.label}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-[#6B7280]">
                        {row.acceptRateEma.toFixed(2)}
                        <span className="ml-1 text-[#9CA3AF]">· {total}</span>
                      </span>
                    </div>
                    <Bar value={row.acceptRateEma} color={color} />
                  </li>
                )
              })}
          </ul>
        ) : statsErr ? (
          <p className="text-xs leading-5 text-[#9CA3AF]">
            Category stats unavailable.
          </p>
        ) : stats ? (
          <p className="text-xs leading-5 text-[#9CA3AF]">
            No category signal yet — accept or dismiss a suggestion to start.
          </p>
        ) : null}
      </div>
    </section>
  )
}

function RetentionDashboard() {
  const [s, setS] = useState<TuningRetentionSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    apiTuningRetentionSummary()
      .then((v) => !cancelled && setS(v))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : 'unavailable'))
    return () => {
      cancelled = true
    }
  }, [])

  const hasAnyAccepts = !!s && s.retained + s.reverted + s.pending > 0
  const big =
    s && s.retentionRate !== null
      ? `${Math.round(s.retentionRate * 100)}%`
      : '—'

  return (
    <section
      className="space-y-4 border-t pt-5"
      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
    >
      <SectionHeader title="Retention" meta="7d after apply" />
      <div
        className="rounded-xl p-4"
        style={{
          background: TUNING_COLORS.surfaceRaised,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        {err ? (
          <p className="text-xs leading-5 text-[#9CA3AF]">Retention unavailable.</p>
        ) : !s ? (
          <p className="text-xs leading-5 text-[#9CA3AF]">Loading…</p>
        ) : !hasAnyAccepts ? (
          <div className="flex items-start gap-3">
            <span
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#6C5CE7]"
              style={{ background: TUNING_COLORS.accentSoft }}
            >
              <PackageCheck size={14} strokeWidth={2} aria-hidden />
            </span>
            <div>
              <div className="text-sm font-medium text-[#1A1A1A]">
                No accepted suggestions yet
              </div>
              <p className="mt-0.5 text-xs leading-5 text-[#6B7280]">
                Retention will appear here once edits have settled for 7 days.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div
              className="flex items-end justify-between"
              title="Share of accepted suggestions still in effect seven days after apply. Measured against suggestions accepted 7–14 days ago."
            >
              <div>
                <div className="text-xs font-medium text-[#6B7280]">Retained at 7d</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-[#1A1A1A]">
                  {big}
                </div>
              </div>
              <div className="text-right text-xs tabular-nums text-[#9CA3AF]">
                <div>
                  {s.retained} retained · {s.reverted} reverted
                </div>
                <div>{s.pending} pending · {s.windowDays}d</div>
              </div>
            </div>
            <div className="mt-3">
              <Bar value={s.retentionRate ?? 0} />
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// Sprint 08 §4 — traffic-light state for a single graduation criterion.
type TrafficLight = 'pass' | 'warn' | 'fail'

function trafficLightIcon(state: TrafficLight) {
  if (state === 'pass') {
    return (
      <CheckCircle2
        size={12}
        strokeWidth={2}
        aria-hidden
        style={{ color: TUNING_COLORS.successFg }}
      />
    )
  }
  if (state === 'warn') {
    return (
      <AlertTriangle
        size={12}
        strokeWidth={2}
        aria-hidden
        style={{ color: TUNING_COLORS.warnFg }}
      />
    )
  }
  return (
    <XCircle
      size={12}
      strokeWidth={2}
      aria-hidden
      style={{ color: TUNING_COLORS.dangerFg }}
    />
  )
}

function ThresholdStat({
  label,
  value,
  hint,
  state,
}: {
  label: string
  value: string
  hint: string
  state: TrafficLight
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-2xl font-semibold tabular-nums tracking-tight"
          style={{ color: TUNING_COLORS.ink }}
        >
          {value}
        </span>
        {trafficLightIcon(state)}
      </div>
      <div className="mt-1 text-xs font-medium text-[#6B7280]">{label}</div>
      <div className="mt-0.5 text-xs text-[#9CA3AF]">{hint}</div>
    </div>
  )
}

function GraduationDashboard() {
  const [m, setM] = useState<TuningGraduationMetrics | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    apiTuningGraduationMetrics()
      .then((v) => !cancelled && setM(v))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : 'unavailable'))
    return () => {
      cancelled = true
    }
  }, [])

  const meta = m ? `${m.windowDays}d · n=${m.sampleSize}` : 'Loading…'

  // Sprint 08 §4 — traffic-light states.
  const editRateState: TrafficLight = !m
    ? 'warn'
    : m.editRate <= 0.1
      ? 'pass'
      : m.editRate <= 0.15
        ? 'warn'
        : 'fail'
  const escalationState: TrafficLight = !m
    ? 'warn'
    : m.escalationRate <= 0.05
      ? 'pass'
      : m.escalationRate <= 0.08
        ? 'warn'
        : 'fail'
  const criticalTarget = m?.criticalFailuresTarget ?? 0
  const criticalCount = m?.criticalFailures30d ?? 0
  const criticalState: TrafficLight =
    criticalCount <= criticalTarget ? 'pass' : criticalCount <= 1 ? 'warn' : 'fail'
  const convTarget = m?.conversationCountTarget ?? 200
  const convCount = m?.conversationCount30d ?? 0
  const convState: TrafficLight =
    convCount >= convTarget
      ? 'pass'
      : convCount >= convTarget * 0.8
        ? 'warn'
        : 'fail'

  const gatedCategories = m?.categoryConfidenceGating
    ? Object.entries(m.categoryConfidenceGating).filter(([, v]) => v.gated)
    : []

  return (
    <section
      className="space-y-4 border-t pt-5"
      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
    >
      <SectionHeader title="Graduation" meta={meta} />
      {err ? <div className="text-xs text-[#9CA3AF]">{err}</div> : null}
      <div
        className="rounded-xl p-4"
        style={{
          background: TUNING_COLORS.surfaceRaised,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        <div className="grid grid-cols-2 gap-4 gap-y-5">
          <ThresholdStat
            label="Edit rate"
            value={fmtPct(m?.editRate, 1)}
            hint="target ≤ 10%"
            state={editRateState}
          />
          <Stat
            label="Edit magnitude"
            value={fmtPct(m?.editMagnitude, 1)}
            hint="avg"
          />
          <ThresholdStat
            label="Escalation rate"
            value={fmtPct(m?.escalationRate, 1)}
            hint="target ≤ 5%"
            state={escalationState}
          />
          <Stat
            label="Acceptance rate"
            value={fmtPct(m?.acceptanceRate, 0)}
            hint="composite"
          />
          <ThresholdStat
            label="Critical failures"
            value={
              m?.criticalFailures30d === undefined ? '—' : String(m.criticalFailures30d)
            }
            hint={`target: ${criticalTarget} · 30d`}
            state={criticalState}
          />
          <ThresholdStat
            label="Conversations"
            value={
              m?.conversationCount30d === undefined ? '—' : String(m.conversationCount30d)
            }
            hint={`target: ${convTarget} · 30d`}
            state={convState}
          />
        </div>

        {gatedCategories.length > 0 ? (
          <div
            className="mt-4 rounded-lg px-3 py-2 text-xs"
            style={{
              background: TUNING_COLORS.warnBg,
              color: TUNING_COLORS.warnFg,
            }}
          >
            <div className="flex items-start gap-2">
              <MinusCircle
                size={12}
                strokeWidth={2}
                className="mt-0.5 shrink-0"
                aria-hidden
              />
              <div>
                <div className="font-medium">
                  {gatedCategories.length}{' '}
                  {gatedCategories.length === 1 ? 'category' : 'categories'} gated
                </div>
                <div className="mt-0.5 text-[11px] leading-4">
                  {gatedCategories.map(([cat, v]) => (
                    <span key={cat} className="mr-2">
                      {cat.toLowerCase().replace(/_/g, ' ')} ·{' '}
                      {v.acceptanceRate === null
                        ? '—'
                        : `${Math.round(v.acceptanceRate * 100)}%`}{' '}
                      (n={v.sampleSize})
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {((m?.editRate ?? 0) > 0.1 || (m?.escalationRate ?? 0) > 0.05) ? (
          <div
            className="mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
            style={{
              background: TUNING_COLORS.warnBg,
              color: TUNING_COLORS.warnFg,
            }}
          >
            <AlertTriangle
              size={12}
              strokeWidth={2}
              className="mt-0.5 shrink-0"
              aria-hidden
            />
            <span>One or more targets missed — review recent edits.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export function DashboardsPanel({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  return (
    <aside
      className="hidden h-full shrink-0 flex-col border-l bg-[#F9FAFB] transition-[width] duration-300 ease-in-out motion-reduce:transition-none md:flex"
      style={{
        width: open ? 340 : 48,
        borderColor: TUNING_COLORS.hairline,
      }}
      aria-label="Dashboards"
    >
      <div className="flex items-center justify-between px-3 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-sm font-medium text-[#6B7280] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
          aria-expanded={open}
          aria-label={open ? 'Collapse dashboards' : 'Expand dashboards'}
          title={open ? 'Collapse dashboards' : 'Expand dashboards'}
        >
          {open ? (
            <>
              <span>Dashboards</span>
              <ChevronsRight size={14} strokeWidth={2} aria-hidden />
            </>
          ) : (
            <ChevronsLeft size={14} strokeWidth={2} aria-hidden />
          )}
        </button>
      </div>
      {open ? (
        <div className="flex-1 space-y-4 overflow-auto px-4 pb-6">
          <VelocityDashboard />
          <RetentionDashboard />
          <GraduationDashboard />
        </div>
      ) : null}
    </aside>
  )
}
