'use client'

import { TUNING_COLORS } from './tokens'

export function ConfidenceBar({
  value,
  compact,
}: {
  value: number | null
  compact?: boolean
}) {
  if (value === null || Number.isNaN(value)) return null
  const pct = Math.max(0, Math.min(1, value)) * 100
  const width = compact ? 36 : 48
  return (
    <span
      className="inline-flex items-center gap-1.5 align-middle"
      title={`Confidence ${value.toFixed(2)}`}
      aria-label={`Confidence ${value.toFixed(2)}`}
    >
      <span
        className="relative inline-block h-[3px] overflow-hidden rounded-full"
        style={{ width, background: TUNING_COLORS.hairline }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: TUNING_COLORS.accent }}
        />
      </span>
      {!compact ? (
        <span className="font-mono text-[10px] text-[color:var(--tuning-ink-muted,#57534E)]">
          {value.toFixed(2)}
        </span>
      ) : null}
    </span>
  )
}
