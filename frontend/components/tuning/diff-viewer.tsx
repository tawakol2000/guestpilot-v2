'use client'

import { useMemo } from 'react'
import { TUNING_COLORS } from './tokens'

// Minimal word-level LCS-based diff. Good enough for conversational edits
// (40-800 chars). Keeps us from adding a dependency for sprint 03.
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
      <div className="rounded-md border border-dashed border-[#E7E5E4] bg-[#F5F4F1] p-4 text-center text-xs text-[#A8A29E]">
        No diff available
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border border-[#E7E5E4] bg-white">
      {title ? (
        <div className="flex items-center justify-between border-b border-[#E7E5E4] bg-[#F5F4F1] px-3 py-2">
          <span className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">{title}</span>
          <span className="font-mono text-[10px] text-[#A8A29E]">word-level diff</span>
        </div>
      ) : null}
      <pre
        className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6"
        style={{ padding: '14px 16px' }}
      >
        {tokens.map((t, i) => {
          if (t.type === 'equal') {
            return (
              <span key={i} style={{ color: TUNING_COLORS.ink }}>
                {t.text}
              </span>
            )
          }
          if (t.type === 'add') {
            return (
              <span
                key={i}
                style={{
                  background: TUNING_COLORS.diffAddBg,
                  color: TUNING_COLORS.diffAddFg,
                  borderRadius: 2,
                }}
              >
                {t.text}
              </span>
            )
          }
          return (
            <span
              key={i}
              style={{
                background: TUNING_COLORS.diffDelBg,
                color: TUNING_COLORS.diffDelFg,
                textDecoration: 'line-through',
                textDecorationThickness: '1px',
                borderRadius: 2,
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
