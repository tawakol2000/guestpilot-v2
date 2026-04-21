'use client'

/**
 * Sprint 052 A C3 — JSON-schema diff renderer for the tool-view
 * "View changes" path.
 *
 * Walks prev + current in parallel, recording per-path add / remove /
 * modify deltas. Lightweight — no external diff library; the payload
 * sizes are bounded (tool parameters are typically ≤ 30 keys) so a
 * depth-first compare is plenty and avoids a ~30 kB dep.
 *
 * Sanitisation is the load-bearing invariant. `prev` may contain a
 * secret that was removed this session — rendering it naively on the
 * "removed" side would leak the thing the 050-A sanitiser was built to
 * prevent. Both sides are fed through `sanitiseToolPayload` at the
 * caller tier BEFORE the diff walk, so every rendered value is already
 * redacted. Admin tier still respects redact-by-key (the sanitiser
 * enforces that) — the `showFullSensitive` admin toggle only loosens
 * the length-heuristic fallback.
 *
 * Empty diff (prev identical to current) renders a subtle "no changes"
 * note so the toggle state is obvious. Pending grammar (italic grey)
 * extends A1 — same CSS shape as `MarkdownBody`.
 */
import { useMemo } from 'react'
import { sanitiseToolPayload, type SanitiseTier } from '@/lib/tool-call-sanitise'
import { STUDIO_COLORS } from '../tokens'

export interface JsonDiffBodyProps {
  prev: unknown
  current: unknown
  isPending: boolean
  /**
   * Tier passed through to `sanitiseToolPayload`. Operator tier redacts
   * sensitive keys + truncates long strings + middle-redacts opaque-
   * token-shaped values. Admin tier preserves verbatim (still
   * redact-by-key, still no length heuristic).
   */
  tier: SanitiseTier
}

type DiffKind = 'equal' | 'add' | 'del' | 'mod'

interface DiffNode {
  kind: DiffKind
  path: string
  key: string
  depth: number
  prev?: unknown
  current?: unknown
}

export function JsonDiffBody({
  prev,
  current,
  isPending,
  tier,
}: JsonDiffBodyProps) {
  const nodes = useMemo(() => {
    const sanitisedPrev = sanitiseToolPayload(prev, { tier })
    const sanitisedCurrent = sanitiseToolPayload(current, { tier })
    return diff(sanitisedPrev, sanitisedCurrent, '', '', 0)
  }, [prev, current, tier])

  const hasDelta = nodes.some((n) => n.kind !== 'equal')
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
        No changes relative to the pre-session schema.
      </div>
    )
  }

  return (
    <pre
      data-origin={isPending ? 'pending' : 'agent'}
      data-json-diff
      style={{
        margin: 0,
        padding: 12,
        background: STUDIO_COLORS.surfaceSunken,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.55,
        color: isPending ? STUDIO_COLORS.inkMuted : STUDIO_COLORS.ink,
        fontStyle: isPending ? 'italic' : 'normal',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      {nodes.map((n, i) => (
        <DiffLine key={`${n.path}:${i}`} node={n} />
      ))}
    </pre>
  )
}

function DiffLine({ node }: { node: DiffNode }) {
  const indent = '  '.repeat(node.depth)
  const label = node.key ? `${node.key}: ` : ''
  if (node.kind === 'equal') {
    return (
      <span data-diff="equal" data-path={node.path}>
        {indent}
        {label}
        {formatValue(node.current)}
        {'\n'}
      </span>
    )
  }
  if (node.kind === 'add') {
    return (
      <span
        data-diff="add"
        data-path={node.path}
        style={{
          display: 'block',
          background: STUDIO_COLORS.successBg,
          color: STUDIO_COLORS.successFg,
          borderLeft: `2px solid ${STUDIO_COLORS.successFg}`,
          paddingLeft: 6,
          textDecoration: 'underline',
        }}
      >
        {indent}+ {label}
        {formatValue(node.current)}
        {'\n'}
      </span>
    )
  }
  if (node.kind === 'del') {
    return (
      <span
        data-diff="del"
        data-path={node.path}
        style={{
          display: 'block',
          background: STUDIO_COLORS.dangerBg,
          color: STUDIO_COLORS.dangerFg,
          borderLeft: `2px solid ${STUDIO_COLORS.dangerFg}`,
          paddingLeft: 6,
          textDecoration: 'line-through',
        }}
      >
        {indent}- {label}
        {formatValue(node.prev)}
        {'\n'}
      </span>
    )
  }
  // modify
  return (
    <span data-diff="mod" data-path={node.path} style={{ display: 'block' }}>
      <span
        style={{
          display: 'block',
          background: STUDIO_COLORS.dangerBg,
          color: STUDIO_COLORS.dangerFg,
          borderLeft: `2px solid ${STUDIO_COLORS.dangerFg}`,
          paddingLeft: 6,
          textDecoration: 'line-through',
        }}
      >
        {indent}- {label}
        {formatValue(node.prev)}
        {'\n'}
      </span>
      <span
        style={{
          display: 'block',
          background: STUDIO_COLORS.successBg,
          color: STUDIO_COLORS.successFg,
          borderLeft: `2px solid ${STUDIO_COLORS.successFg}`,
          paddingLeft: 6,
          textDecoration: 'underline',
        }}
      >
        {indent}+ {label}
        {formatValue(node.current)}
        {'\n'}
      </span>
    </span>
  )
}

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Depth-first compare. Paths are dotted (`a.b.c`) for objects and
 * bracketed (`a[0].b`) for arrays. Ordering: keys from both sides
 * merged, stable in encounter order — prev first, then new keys from
 * current. Arrays compare by index (a removed element at index 2
 * renders as a `del` at `path[2]`).
 */
export function diff(
  prev: unknown,
  current: unknown,
  path: string,
  key: string,
  depth: number,
): DiffNode[] {
  if (prev === undefined && current === undefined) return []
  if (prev === undefined) {
    return [{ kind: 'add', path, key, depth, current }]
  }
  if (current === undefined) {
    return [{ kind: 'del', path, key, depth, prev }]
  }
  const prevIsObj = isPlainObject(prev)
  const currIsObj = isPlainObject(current)
  const prevIsArr = Array.isArray(prev)
  const currIsArr = Array.isArray(current)

  if (prevIsObj && currIsObj) {
    const out: DiffNode[] = []
    const keys = mergeKeys(
      Object.keys(prev as Record<string, unknown>),
      Object.keys(current as Record<string, unknown>),
    )
    const anyDelta = keys.some(
      (k) =>
        !deepEqual(
          (prev as Record<string, unknown>)[k],
          (current as Record<string, unknown>)[k],
        ),
    )
    out.push({
      kind: anyDelta ? 'equal' : 'equal',
      path,
      key,
      depth,
      current: Array.isArray(current) ? '[' : '{',
      prev: Array.isArray(prev) ? '[' : '{',
    })
    for (const k of keys) {
      out.push(
        ...diff(
          (prev as Record<string, unknown>)[k],
          (current as Record<string, unknown>)[k],
          joinObjPath(path, k),
          k,
          depth + 1,
        ),
      )
    }
    out.push({
      kind: 'equal',
      path,
      key: '',
      depth,
      current: '}',
      prev: '}',
    })
    return out
  }

  if (prevIsArr && currIsArr) {
    const out: DiffNode[] = []
    const prevArr = prev as unknown[]
    const currArr = current as unknown[]
    const len = Math.max(prevArr.length, currArr.length)
    out.push({
      kind: 'equal',
      path,
      key,
      depth,
      current: '[',
      prev: '[',
    })
    for (let i = 0; i < len; i++) {
      out.push(
        ...diff(prevArr[i], currArr[i], joinArrPath(path, i), String(i), depth + 1),
      )
    }
    out.push({
      kind: 'equal',
      path,
      key: '',
      depth,
      current: ']',
      prev: ']',
    })
    return out
  }

  // Scalar or mismatched shapes.
  if (deepEqual(prev, current)) {
    return [{ kind: 'equal', path, key, depth, prev, current }]
  }
  return [{ kind: 'mod', path, key, depth, prev, current }]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergeKeys(a: string[], b: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of a) {
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  for (const k of b) {
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

function joinObjPath(parent: string, key: string): string {
  if (!parent) return key
  return `${parent}.${key}`
}

function joinArrPath(parent: string, index: number): string {
  return `${parent}[${index}]`
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>)
    const bk = Object.keys(b as Record<string, unknown>)
    if (ak.length !== bk.length) return false
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    )
  }
  return false
}
