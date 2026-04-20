'use client'

import type { TuningDiagnosticCategory } from '@/lib/api'
import { categoryStyle } from '../studio/tokens'

/**
 * Sprint 07: category pills are rendered as a small rounded-full chip.
 * The sub-label is intentionally NOT embedded — call sites render it
 * adjacent as muted metadata so the pill stays tight and scannable.
 */
export function CategoryPill({
  category,
  subLabel,
}: {
  category: TuningDiagnosticCategory | null
  // subLabel is accepted for backwards-compat but no longer rendered inside
  // the pill. Passing anything truthy will be ignored; render it as a
  // sibling with muted text instead.
  subLabel?: string | null
}) {
  const s = categoryStyle(category)
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium leading-none"
      style={{ background: s.bg, color: s.fg }}
      aria-label={subLabel ? `${s.label} · ${subLabel}` : s.label}
    >
      {s.label}
    </span>
  )
}
