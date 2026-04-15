'use client'

import type { TuningDiagnosticCategory } from '@/lib/api'
import { categoryStyle } from './tokens'

export function CategoryPill({
  category,
  subLabel,
}: {
  category: TuningDiagnosticCategory | null
  subLabel?: string | null
}) {
  const s = categoryStyle(category)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide"
      style={{ background: s.bg, color: s.fg }}
      aria-label={subLabel ? `${s.label} · ${subLabel}` : s.label}
    >
      <span>{s.label}</span>
      {subLabel ? (
        <span className="text-[10px] font-normal opacity-80">· {subLabel}</span>
      ) : null}
    </span>
  )
}
