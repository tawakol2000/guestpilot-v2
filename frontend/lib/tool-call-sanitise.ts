/**
 * Sprint 050 A2 — redaction + truncation for tool-call payloads shown
 * in the operator-tier drawer.
 *
 * The operator-tier drawer renders agent tool call `input` / `output`
 * payloads directly. We must not leak:
 *   - secrets (api keys, tokens, credentials)
 *   - long raw model outputs (truncate to a bounded size for operator
 *     view; admins see full payloads)
 *
 * Admin-only callers pass `{ tier: 'admin' }` to skip truncation and
 * preserve keys verbatim. Redact-by-key is mandatory on ALL tiers —
 * an admin operator reading a trace still shouldn't see a live api key
 * rendered in plain text.
 */

const SENSITIVE_KEY_REGEX =
  /(api[_-]?key|token|secret|authorization|password|credential)/i
const REDACTED = '[redacted]'
const TRUNCATE_AT = 1000
const TRUNCATE_SUFFIX = '…[truncated]'

// Length-heuristic fallback (sprint-051-A pre-flight tighten-up).
// Custom-tool configs can put secrets at arbitrary field names the
// redact-by-key regex doesn't know about. Any string that looks like
// an opaque token (≥32 chars of alnum / `_` / `-`, no whitespace or
// punctuation) is middle-redacted on operator tier. Admin tier is
// untouched — the drawer's existing admin full-output toggle is the
// single escape hatch.
const LIKELY_SECRET_REGEX = /^[A-Za-z0-9_\-]{32,}$/
const LIKELY_SECRET_MIDDLE = '…[likely-secret]…'

export type SanitiseTier = 'operator' | 'admin'

export interface SanitiseOptions {
  tier?: SanitiseTier
}

/**
 * Deep-clone a JSON-ish value with sensitive keys redacted and long
 * strings truncated (operator tier only). Cycles are collapsed to the
 * literal string "[cycle]".
 */
export function sanitiseToolPayload(value: unknown, opts: SanitiseOptions = {}): unknown {
  const tier: SanitiseTier = opts.tier ?? 'operator'
  return walk(value, tier, new WeakSet())
}

function walk(value: unknown, tier: SanitiseTier, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (tier !== 'operator') return value
    if (LIKELY_SECRET_REGEX.test(value)) return middleRedact(value)
    return truncate(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, tier, seen))
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (seen.has(obj)) return '[cycle]'
    seen.add(obj)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = REDACTED
        continue
      }
      out[k] = walk(v, tier, seen)
    }
    return out
  }

  return undefined
}

function truncate(s: string): string {
  if (s.length <= TRUNCATE_AT) return s
  return s.slice(0, TRUNCATE_AT) + TRUNCATE_SUFFIX
}

function middleRedact(s: string): string {
  return s.slice(0, 4) + LIKELY_SECRET_MIDDLE + s.slice(-4)
}

/** Exposed for tests. */
export const TOOL_CALL_SANITISE_INTERNALS = {
  REDACTED,
  TRUNCATE_AT,
  TRUNCATE_SUFFIX,
  SENSITIVE_KEY_REGEX,
  LIKELY_SECRET_REGEX,
  LIKELY_SECRET_MIDDLE,
}
