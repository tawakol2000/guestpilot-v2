'use client'

/**
 * Sprint 045 Gate 6 — SetupProgress widget. Shows how much of the tenant's
 * BUILD surface is populated at coarse grain: SOPs / FAQs / custom tools /
 * properties. Data comes from the existing /api/build/tenant-state endpoint
 * (Gate 5) — no new backend surface.
 *
 * We deliberately do NOT render slot-level interview progress here: that
 * data lives in the BUILD system prompt (per the Gate 5 session-4 design)
 * and is not emitted over SSE. Exposing it would require a new endpoint,
 * which is out of scope for Gate 6.
 */
import { TUNING_COLORS } from '../tuning/tokens'
import type { BuildTenantState } from '@/lib/build-api'

export function SetupProgress({ state }: { state: BuildTenantState }) {
  const rows = [
    { label: 'Properties', value: state.propertyCount },
    { label: 'SOPs', value: state.sopCount },
    { label: 'FAQs (global)', value: state.faqCounts.global },
    { label: 'FAQs (property)', value: state.faqCounts.perProperty },
    { label: 'Custom tools', value: state.customToolCount },
  ]
  return (
    <section
      className="rounded-lg border px-3 py-3"
      style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
    >
      <div
        className="text-[10.5px] font-semibold uppercase tracking-wider"
        style={{ color: TUNING_COLORS.inkSubtle }}
      >
        Your setup
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between text-xs">
            <span style={{ color: TUNING_COLORS.inkMuted }}>{r.label}</span>
            <span className="font-mono font-semibold" style={{ color: TUNING_COLORS.ink }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
