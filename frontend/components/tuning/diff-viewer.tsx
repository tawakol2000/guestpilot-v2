'use client'

import { useMemo } from 'react'
import { TUNING_COLORS } from './tokens'

// Minimal word-level LCS-based diff. Good enough for conversational edits
// (40-800 chars). Keeps us from adding a dependency.
type Token = { text: string; type: 'equal' | 'add' | 'del' }

function tokenize(text: string): string[] {
  // Keep whitespace as tokens so reinsertion is stable.
  return text.match(/\s+|[^\s]+/g) ?? []
}

function diffTokens(a: string[], b: string[]): Token[] {
  const n = a.length
  const m = b.length
  // Classic LCS DP. O(n*m). Fine up to ~2000 tokens each; we cap for safety.
  const N = Math.min(n, 1600)
  const M = Math.min(m, 1600)
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0))
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out: Token[] = []
  let i = N
  let j = M
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ text: a[i - 1], type: 'equal' })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ text: a[i - 1], type: 'del' })
      i--
    } else {
      out.push({ text: b[j - 1], type: 'add' })
      j--
    }
  }
  while (i > 0) {
    out.push({ text: a[i - 1], type: 'del' })
    i--
  }
  while (j > 0) {
    out.push({ text: b[j - 1], type: 'add' })
    j--
  }
  out.reverse()
  return out
}

export function DiffViewer({
  before,
  after,
  title,
}: {
  before: string | null | undefined
  after: string | null | undefined
  title?: string
}) {
  const tokens = useMemo(() => {
    const a = tokenize(before ?? '')
    const b = tokenize(after ?? '')
    return diffTokens(a, b)
  }, [before, after])

  const empty = !before && !after
  if (empty) {
    return (
      <div
        className="rounded-lg p-4 text-center text-xs"
        style={{
          background: TUNING_COLORS.surfaceSunken,
          color: TUNING_COLORS.inkSubtle,
        }}
      >
        No changes
      </div>
    )
  }

  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{ background: TUNING_COLORS.surfaceSunken }}
    >
      {title ? (
        <div
          className="flex items-center justify-between border-b px-4 py-2.5"
          style={{ borderColor: TUNING_COLORS.hairlineSoft }}
        >
          <span className="text-xs font-medium text-[#6B7280]">{title}</span>
          <span className="font-mono text-[10px] text-[#9CA3AF]">word-level diff</span>
        </div>
      ) : null}
      <pre
        className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-7"
        style={{ color: TUNING_COLORS.ink }}
      >
        {tokens.map((t, i) => {
          if (t.type === 'equal') {
            return <span key={i}>{t.text}</span>
          }
          if (t.type === 'add') {
            return (
              <span
                key={i}
                className="rounded-sm px-0.5"
                style={{
                  background: TUNING_COLORS.diffAddBg,
                  color: TUNING_COLORS.diffAddFg,
                }}
              >
                {t.text}
              </span>
            )
          }
          // Deletion: use line-through without opacity to avoid muddy
          // translucent-red overlay (per design review).
          return (
            <span
              key={i}
              className="rounded-sm px-0.5"
              style={{
                background: TUNING_COLORS.diffDelBg,
                color: TUNING_COLORS.diffDelFg,
                textDecoration: 'line-through',
                textDecorationThickness: '1px',
              }}
            >
              {t.text}
            </span>
          )
        })}
      </pre>
    </div>
  )
}
