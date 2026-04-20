'use client'

import { TUNING_COLORS } from '../studio/tokens'

/**
 * Sprint 07: thinner track (3px), rounded-full both track and fill,
 * gradient accent for confident (>0.6) values, solid gray for low.
 * The numeric label is separated from the bar for cleaner alignment.
 */
export function ConfidenceBar({
  value,
  compact,
}: {
  value: number | null
  compact?: boolean
}) {
  if (value === null || Number.isNaN(value)) return null
  const pct = Math.max(0, Math.min(1, value)) * 100
  const width = compact ? 32 : 48
  const high = value >= 0.6
  const mid = value >= 0.3
  const fill = high
    ? `linear-gradient(90deg, ${TUNING_COLORS.accent}, ${TUNING_COLORS.accentMuted})`
    : mid
      ? TUNING_COLORS.accentMuted
      : TUNING_COLORS.inkSubtle
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
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${pct}%`, background: fill }}
        />
      </span>
      {!compact ? (
        <span
          className="font-mono text-[10px] tabular-nums"
          style={{ color: TUNING_COLORS.inkMuted }}
        >
          {value.toFixed(2)}
        </span>
      ) : null}
    </span>
  )
}
