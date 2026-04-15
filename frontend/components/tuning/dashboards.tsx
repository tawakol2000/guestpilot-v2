'use client'

import { useEffect, useState } from 'react'
import {
  apiTuningCategoryStats,
  apiTuningCoverage,
  apiTuningGraduationMetrics,
  type TuningCategoryStatsRow,
  type TuningCoverage,
  type TuningGraduationMetrics,
  type TuningDiagnosticCategory,
} from '@/lib/api'
import { CATEGORY_STYLES, TUNING_COLORS } from './tokens'

function Bar({ value, max = 1, color }: { value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100
  return (
    <span
      className="relative inline-block h-[3px] w-full overflow-hidden rounded-full"
      style={{ background: TUNING_COLORS.hairline }}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
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
    <div className="rounded-md border border-[#E7E5E4] bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#A8A29E]">{label}</div>
      <div
        className="mt-0.5 font-mono text-base"
        style={{ color: warn ? '#92400E' : '#0C0A09' }}
      >
        {value}
        {warn ? <span className="ml-1 text-[11px]">▲</span> : null}
      </div>
      {hint ? <div className="mt-0.5 text-[10px] text-[#A8A29E]">{hint}</div> : null}
    </div>
  )
}

function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
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
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-[family-name:var(--font-playfair)] text-base text-[#0C0A09]">
          Tuning velocity
        </h3>
        <span className="text-[10px] uppercase tracking-[0.14em] text-[#A8A29E]">14d</span>
      </div>
      {err ? (
        <div className="text-xs text-[#A8A29E]">{err}</div>
      ) : null}
      <div className="grid grid-cols-1 gap-2">
        <Stat
          label="Coverage — unedited sends"
          value={fmtPct(coverage?.coverage ?? null, 0)}
          hint={
            coverage
              ? `${coverage.unedited}/${coverage.totalSent} in ${coverage.windowDays}d`
              : 'loading…'
          }
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-[0.14em] text-[#A8A29E]">
          Acceptance rate by category
        </div>
        {stats && stats.length ? (
          <ul className="space-y-1">
            {stats
              .slice()
              .sort((a, b) => b.acceptCount + b.rejectCount - (a.acceptCount + a.rejectCount))
              .map((row) => {
                const cat = row.category as TuningDiagnosticCategory
                const meta = CATEGORY_STYLES[cat]
                const total = row.acceptCount + row.rejectCount
                return (
                  <li key={cat} className="space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px]"
                        style={{ background: meta.bg, color: meta.fg }}
                      >
                        {meta.label}
                      </span>
                      <span className="font-mono text-[10px] text-[#57534E]">
                        {row.acceptRateEma.toFixed(2)} · {total}
                      </span>
                    </div>
                    <Bar value={row.acceptRateEma} />
                  </li>
                )
              })}
          </ul>
        ) : (
          <p className="text-[11px] italic text-[#A8A29E]">
            No category signal yet. Accept or dismiss a suggestion to start.
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
  return (
    <section className="space-y-3 border-t border-[#E7E5E4] pt-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-[family-name:var(--font-playfair)] text-base text-[#0C0A09]">
          Graduation
        </h3>
        <span className="text-[10px] uppercase tracking-[0.14em] text-[#A8A29E]">
          {m ? `${m.windowDays}d · n=${m.sampleSize}` : '14d'}
        </span>
      </div>
      {err ? <div className="text-xs text-[#A8A29E]">{err}</div> : null}
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Edit rate"
          value={fmtPct(m?.editRate, 1)}
          warn={(m?.editRate ?? 0) > 0.1}
          hint="target <10%"
        />
        <Stat label="Edit magnitude" value={fmtPct(m?.editMagnitude, 1)} hint="avg" />
        <Stat
          label="Escalation rate"
          value={fmtPct(m?.escalationRate, 1)}
          warn={(m?.escalationRate ?? 0) > 0.05}
          hint="target ≤5%"
        />
        <Stat label="Acceptance rate" value={fmtPct(m?.acceptanceRate, 0)} hint="composite" />
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
      className="flex h-full flex-col border-l border-[#E7E5E4] bg-[#FAFAF9] transition-all"
      style={{ width: open ? 320 : 44 }}
    >
      <div className="flex items-center justify-between px-3 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[#57534E] hover:bg-[#F5F4F1]"
          aria-expanded={open}
          aria-label={open ? 'Collapse dashboards' : 'Expand dashboards'}
        >
          {open ? 'Dashboards ▸' : '◂'}
        </button>
      </div>
      {open ? (
        <div className="flex-1 space-y-6 overflow-auto px-4 pb-6">
          <VelocityDashboard />
          <GraduationDashboard />
        </div>
      ) : null}
    </aside>
  )
}
