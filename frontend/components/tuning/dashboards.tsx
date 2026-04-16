'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronsRight, ChevronsLeft } from 'lucide-react'
import {
  apiTuningCategoryStats,
  apiTuningCoverage,
  apiTuningGraduationMetrics,
  type TuningCategoryStatsRow,
  type TuningCoverage,
  type TuningGraduationMetrics,
  type TuningDiagnosticCategory,
} from '@/lib/api'
import { CATEGORY_ACCENT, CATEGORY_STYLES, TUNING_COLORS } from './tokens'

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
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([apiTuningCategoryStats(), apiTuningCoverage()]).then((out) => {
      if (cancelled) return
      const [s, c] = out
      if (s.status === 'fulfilled') setStats(s.value.stats)
      if (c.status === 'fulfilled') setCoverage(c.value)
      if (s.status === 'rejected' && c.status === 'rejected') {
        setErr('Stats unavailable')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="space-y-4">
      <SectionHeader title="Tuning velocity" meta="Last 14 days" />

      {err ? (
        <div className="text-xs text-[#9CA3AF]">{err}</div>
      ) : null}

      {/* Coverage hero card */}
      <div
        className="rounded-xl p-5"
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
                const meta = CATEGORY_STYLES[cat]
                const color = CATEGORY_ACCENT[cat]
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
        ) : (
          <p className="text-xs leading-5 text-[#9CA3AF]">
            No category signal yet — accept or dismiss a suggestion to start.
          </p>
        )}
      </div>
    </section>
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

  return (
    <section
      className="space-y-4 border-t pt-5"
      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
    >
      <SectionHeader title="Graduation" meta={meta} />
      {err ? <div className="text-xs text-[#9CA3AF]">{err}</div> : null}
      <div
        className="rounded-xl p-5"
        style={{
          background: TUNING_COLORS.surfaceRaised,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        <div className="grid grid-cols-2 gap-5 gap-y-6">
          <Stat
            label="Edit rate"
            value={fmtPct(m?.editRate, 1)}
            warn={(m?.editRate ?? 0) > 0.1}
            hint="target <10%"
          />
          <Stat
            label="Edit magnitude"
            value={fmtPct(m?.editMagnitude, 1)}
            hint="avg"
          />
          <Stat
            label="Escalation rate"
            value={fmtPct(m?.escalationRate, 1)}
            warn={(m?.escalationRate ?? 0) > 0.05}
            hint="target ≤5%"
          />
          <Stat
            label="Acceptance rate"
            value={fmtPct(m?.acceptanceRate, 0)}
            hint="composite"
          />
        </div>
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
        <div className="flex-1 space-y-5 overflow-auto px-5 pb-8">
          <VelocityDashboard />
          <GraduationDashboard />
        </div>
      ) : null}
    </aside>
  )
}
