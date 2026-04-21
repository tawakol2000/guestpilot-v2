/**
 * Sprint 053-A — shared sanitiser for BUILD-tool artifact payloads.
 *
 * One function, two callers:
 *   - D1 dry-run preview returned to the agent / drawer for tool_definition
 *     writes — must not leak credentials in the preview body.
 *   - D2 BuildArtifactHistory storage for tool_definition rows — must not
 *     bake credentials into a new persistent table.
 *
 * The two paths run identical input → identical output. A test in
 * `__tests__/sanitise-artifact-payload.test.ts` asserts parity so the
 * preview view and the history view never disagree on what's redacted.
 *
 * Mirrors the redact-by-key + likely-secret heuristics in
 * `frontend/lib/tool-call-sanitise.ts` so a sensitive value is hidden the
 * same way regardless of which surface renders it.
 */
const SENSITIVE_KEY_REGEX =
  /(api[_-]?key|token|secret|authorization|password|credential)/i;
const REDACTED = '[redacted]';

// Length-heuristic fallback: any string that looks like an opaque token
// (≥32 chars of alnum / `_` / `-`, no whitespace or punctuation) is
// middle-redacted. Custom-tool configs can put secrets at arbitrary field
// names the regex doesn't know about.
const LIKELY_SECRET_REGEX = /^[A-Za-z0-9_\-]{32,}$/;
const LIKELY_SECRET_MIDDLE = '…[likely-secret]…';

export function sanitiseArtifactPayload(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (LIKELY_SECRET_REGEX.test(value)) return middleRedact(value);
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, seen));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[cycle]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, seen);
    }
    return out;
  }

  return undefined;
}

function middleRedact(s: string): string {
  return s.slice(0, 4) + LIKELY_SECRET_MIDDLE + s.slice(-4);
}

export const SANITISE_INTERNALS = {
  REDACTED,
  SENSITIVE_KEY_REGEX,
  LIKELY_SECRET_REGEX,
  LIKELY_SECRET_MIDDLE,
};
