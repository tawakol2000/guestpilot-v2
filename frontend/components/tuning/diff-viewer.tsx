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
  // Sprint-07 follow-up — when `plain` is true, render full text on each side
  // with no token-level del/add highlighting. The two panes already make
  // before/after obvious; the strikethrough/green overlay was overkill and
  // looked broken when before/after weren't lexically comparable (e.g.
  // SYSTEM_PROMPT proposals where "before" is a reply draft and "after" is
  // a prompt clause).
  plain = false,
  leftLabel = 'Before',
  rightLabel = 'After',
  leftAccent = 'red',
  rightAccent = 'green',
  rightPlaceholder,
  leftPlaceholder,
}: {
  before: string | null | undefined
  after: string | null | undefined
  title?: string
  plain?: boolean
  leftLabel?: string
  rightLabel?: string
  leftAccent?: 'red' | 'green' | 'muted'
  rightAccent?: 'red' | 'green' | 'muted'
  /** Shown in italic gray when `after` is empty/null. */
  rightPlaceholder?: string
  /** Shown in italic gray when `before` is empty/null. */
  leftPlaceholder?: string
}) {
  const tokens = useMemo(() => {
    if (plain) return [] // skip the LCS pass when not used
    const a = tokenize(before ?? '')
    const b = tokenize(after ?? '')
    return diffTokens(a, b)
  }, [before, after, plain])

  // Sprint 09 fix 14: warn when either input exceeds the 1600-token
  // internal cap so the reader knows the displayed diff may be incomplete.
  // Count tokens on the input strings, not `tokens` (which is post-LCS).
  const truncated = useMemo(() => {
    if (plain) return false
    const aCount = tokenize(before ?? '').length
    const bCount = tokenize(after ?? '').length
    return aCount > 1600 || bCount > 1600
  }, [before, after, plain])

  const empty = !before && !after && !leftPlaceholder && !rightPlaceholder
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

  // Two-panel side-by-side rendering. In `plain` mode each pane just shows
  // its own text in full. In diff mode (the default) we use word-level LCS:
  //   LEFT panel  → equal + del tokens (the "before" state). Deletions get
  //                 the red overlay + line-through so you can see what was
  //                 cut without scanning around.
  //   RIGHT panel → equal + add tokens (the "after" state). Additions get
  //                 the green overlay so the new text is obvious in context.
  //
  // Equal tokens appear on BOTH sides (so the reader always has the surrounding
  // prose to anchor against), with a subtle muted color. del tokens are
  // skipped on the right; add tokens are skipped on the left.
  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{
        background: TUNING_COLORS.surfaceRaised,
        border: `1px solid ${TUNING_COLORS.hairlineSoft}`,
      }}
    >
      {title ? (
        <div
          className="flex items-center justify-between border-b px-3 py-2"
          style={{ borderColor: TUNING_COLORS.hairlineSoft }}
        >
          <span className="text-xs font-medium text-[#6B7280]">{title}</span>
          {!plain ? (
            <span className="font-mono text-[10px] text-[#9CA3AF]">word-level diff</span>
          ) : null}
        </div>
      ) : null}

      {truncated ? (
        <div
          className="border-b px-3 py-2 text-xs"
          style={{
            background: TUNING_COLORS.warnBg,
            color: TUNING_COLORS.warnFg,
            borderColor: TUNING_COLORS.hairlineSoft,
          }}
        >
          Diff truncated to first 1,600 tokens for performance. Full text available in the editor.
        </div>
      ) : null}

      <div
        className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0"
        style={{ borderColor: TUNING_COLORS.hairlineSoft }}
      >
        {plain ? (
          <>
            <PlainPane label={leftLabel} text={before ?? ''} accent={leftAccent} placeholder={leftPlaceholder} />
            <PlainPane label={rightLabel} text={after ?? ''} accent={rightAccent} placeholder={rightPlaceholder} />
          </>
        ) : (
          <>
            <DiffPane label={leftLabel} tokens={tokens} kind="before" />
            <DiffPane label={rightLabel} tokens={tokens} kind="after" />
          </>
        )}
      </div>
    </div>
  )
}

function PlainPane({
  label,
  text,
  accent,
  placeholder,
}: {
  label: string
  text: string
  accent: 'red' | 'green' | 'muted'
  placeholder?: string
}) {
  const dotColor =
    accent === 'red'
      ? TUNING_COLORS.diffDelFg
      : accent === 'green'
        ? TUNING_COLORS.diffAddFg
        : TUNING_COLORS.inkSubtle
  return (
    <div
      className="flex flex-col"
      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-1.5"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: TUNING_COLORS.surfaceSunken,
        }}
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: dotColor }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#6B7280]">
          {label}
        </span>
      </div>
      <pre
        className="min-h-[3em] whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-6"
        style={{ color: TUNING_COLORS.ink }}
      >
        {text.trim() ? text : (
          <span className="italic text-[#9CA3AF]">{placeholder ?? '—'}</span>
        )}
      </pre>
    </div>
  )
}

function DiffPane({
  label,
  tokens,
  kind,
}: {
  label: string
  tokens: Token[]
  kind: 'before' | 'after'
}) {
  const isBefore = kind === 'before'
  // Filter: equal on both; del only on before; add only on after.
  const visible = tokens.filter((t) => {
    if (t.type === 'equal') return true
    return isBefore ? t.type === 'del' : t.type === 'add'
  })
  const highlightType = isBefore ? 'del' : 'add'
  const isEmpty = visible.every((t) => t.type === 'equal' && !t.text.trim())
    || visible.length === 0
    || !visible.some((t) => t.type === highlightType || t.text.trim())

  return (
    <div
      className="flex flex-col"
      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
    >
      <div
        className="flex items-center gap-2 border-b px-3 py-1.5"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: TUNING_COLORS.surfaceSunken,
        }}
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            background: isBefore ? TUNING_COLORS.diffDelFg : TUNING_COLORS.diffAddFg,
          }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#6B7280]">
          {label}
        </span>
      </div>
      <pre
        className="min-h-[3em] whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-6"
        style={{ color: TUNING_COLORS.ink }}
      >
        {isEmpty ? (
          <span className="italic text-[#9CA3AF]">—</span>
        ) : (
          visible.map((t, i) => {
            if (t.type === 'equal') {
              return (
                <span key={i} style={{ color: TUNING_COLORS.inkMuted }}>
                  {t.text}
                </span>
              )
            }
            if (isBefore && t.type === 'del') {
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
            }
            if (!isBefore && t.type === 'add') {
              return (
                <span
                  key={i}
                  className="rounded-sm px-0.5 font-semibold"
                  style={{
                    background: TUNING_COLORS.diffAddBg,
                    color: TUNING_COLORS.diffAddFg,
                  }}
                >
                  {t.text}
                </span>
              )
            }
            return null
          })
        )}
      </pre>
    </div>
  )
}
