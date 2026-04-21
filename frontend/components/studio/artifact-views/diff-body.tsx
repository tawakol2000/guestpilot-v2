'use client'

/**
 * Sprint 051 A B2 — diff rendering for SOP (line-level) + FAQ
 * (token-level) inside the artifact drawer.
 *
 * No external diff lib — the palette only surfaces add/remove deltas,
 * so a zero-dep LCS is cheaper than pulling a dependency for one view.
 * LCS runs on:
 *   - lines for SOPs (markdown paragraphs read better per-line)
 *   - whitespace-separated tokens for FAQs (one Q + one A is short
 *     enough that per-word deltas are legible)
 *
 * Empty diff (identical prev/next) renders a subtle "no changes" note
 * so the toggle state is obvious.
 */
import { STUDIO_COLORS } from '../tokens'

export type DiffMode = 'line' | 'token'

export interface DiffBodyProps {
  prev: string
  next: string
  mode: DiffMode
}

type Op = { kind: 'equal' | 'add' | 'del'; text: string }

export function DiffBody({ prev, next, mode }: DiffBodyProps) {
  const ops = computeDiff(prev, next, mode)
  const hasDelta = ops.some((o) => o.kind !== 'equal')
  if (!hasDelta) {
    return (
      <div
        role="status"
        style={{
          fontSize: 12,
          color: STUDIO_COLORS.inkSubtle,
          fontStyle: 'italic',
          padding: '8px 12px',
          background: STUDIO_COLORS.surfaceRaised,
          border: `1px dashed ${STUDIO_COLORS.hairline}`,
          borderRadius: 5,
        }}
      >
        No changes relative to the pre-session body.
      </div>
    )
  }
  const sep = mode === 'line' ? '\n' : ' '
  return (
    <pre
      data-diff-mode={mode}
      style={{
        margin: 0,
        padding: 12,
        background: STUDIO_COLORS.surfaceSunken,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.55,
        color: STUDIO_COLORS.ink,
        whiteSpace: mode === 'line' ? 'pre-wrap' : 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      {ops.map((op, i) => {
        if (op.kind === 'equal') {
          return (
            <span key={i} data-diff="equal">
              {op.text}
              {i < ops.length - 1 ? sep : ''}
            </span>
          )
        }
        if (op.kind === 'add') {
          return (
            <span
              key={i}
              data-diff="add"
              style={{
                background: STUDIO_COLORS.successBg,
                color: STUDIO_COLORS.successFg,
                textDecoration: mode === 'token' ? 'underline' : 'none',
                borderLeft:
                  mode === 'line'
                    ? `2px solid ${STUDIO_COLORS.successFg}`
                    : 'none',
                paddingLeft: mode === 'line' ? 6 : 2,
                paddingRight: 2,
                display: mode === 'line' ? 'inline-block' : 'inline',
                width: mode === 'line' ? '100%' : 'auto',
              }}
            >
              {op.text}
              {i < ops.length - 1 ? sep : ''}
            </span>
          )
        }
        return (
          <span
            key={i}
            data-diff="del"
            style={{
              background: STUDIO_COLORS.dangerBg,
              color: STUDIO_COLORS.dangerFg,
              textDecoration: 'line-through',
              borderLeft:
                mode === 'line'
                  ? `2px solid ${STUDIO_COLORS.dangerFg}`
                  : 'none',
              paddingLeft: mode === 'line' ? 6 : 2,
              paddingRight: 2,
              display: mode === 'line' ? 'inline-block' : 'inline',
              width: mode === 'line' ? '100%' : 'auto',
            }}
          >
            {op.text}
            {i < ops.length - 1 ? sep : ''}
          </span>
        )
      })}
    </pre>
  )
}

/**
 * Compute a minimal add/delete op list using LCS. Good enough for the
 * sizes we render (SOP ~20–200 lines, FAQ ~10–80 tokens). Not exported
 * from the module's public surface — but exposed via the test seam
 * below for the unit suite.
 */
export function computeDiff(prev: string, next: string, mode: DiffMode): Op[] {
  const a = mode === 'line' ? prev.split(/\r?\n/) : prev.split(/\s+/)
  const b = mode === 'line' ? next.split(/\r?\n/) : next.split(/\s+/)
  const aFilt = mode === 'line' ? a : a.filter((t) => t.length > 0)
  const bFilt = mode === 'line' ? b : b.filter((t) => t.length > 0)
  const lcs = lcsTable(aFilt, bFilt)
  const ops: Op[] = []
  let i = aFilt.length
  let j = bFilt.length
  while (i > 0 && j > 0) {
    if (aFilt[i - 1] === bFilt[j - 1]) {
      ops.unshift({ kind: 'equal', text: aFilt[i - 1]! })
      i--
      j--
    } else if (lcs[i - 1]![j]! >= lcs[i]![j - 1]!) {
      ops.unshift({ kind: 'del', text: aFilt[i - 1]! })
      i--
    } else {
      ops.unshift({ kind: 'add', text: bFilt[j - 1]! })
      j--
    }
  }
  while (i > 0) {
    ops.unshift({ kind: 'del', text: aFilt[i - 1]! })
    i--
  }
  while (j > 0) {
    ops.unshift({ kind: 'add', text: bFilt[j - 1]! })
    j--
  }
  return ops
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const t: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!)
    }
  }
  return t
}
