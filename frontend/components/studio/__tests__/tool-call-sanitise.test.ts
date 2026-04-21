/**
 * Sprint 050 A2 — tool-call payload sanitiser unit tests.
 *
 * Covers: redact-by-key across the supported name patterns, operator-
 * tier 1000-char truncation, admin-tier passthrough of long strings,
 * nested object walking, cycle safety, and non-JSON primitives.
 */
import { describe, it, expect } from 'vitest'

import {
  sanitiseToolPayload,
  TOOL_CALL_SANITISE_INTERNALS,
} from '@/lib/tool-call-sanitise'

const {
  REDACTED,
  TRUNCATE_AT,
  TRUNCATE_SUFFIX,
  LIKELY_SECRET_MIDDLE,
} = TOOL_CALL_SANITISE_INTERNALS

describe('sanitiseToolPayload', () => {
  it('redacts values at known sensitive keys, case-insensitive and separator-tolerant', () => {
    const input = {
      apiKey: 'sk-live-1234',
      api_key: 'sk-live-abc',
      'api-key': 'sk-live-xyz',
      Token: 'eyJ…',
      Secret: 'hush',
      Authorization: 'Bearer eyJ…',
      password: 'hunter2',
      credential: 'x509',
      // Non-sensitive sibling stays intact
      conversationId: 'conv-1',
    }
    const out = sanitiseToolPayload(input) as Record<string, unknown>
    expect(out.apiKey).toBe(REDACTED)
    expect(out.api_key).toBe(REDACTED)
    expect(out['api-key']).toBe(REDACTED)
    expect(out.Token).toBe(REDACTED)
    expect(out.Secret).toBe(REDACTED)
    expect(out.Authorization).toBe(REDACTED)
    expect(out.password).toBe(REDACTED)
    expect(out.credential).toBe(REDACTED)
    expect(out.conversationId).toBe('conv-1')
  })

  it('walks nested objects and arrays and redacts at every level', () => {
    const input = {
      outer: {
        inner: {
          apiKey: 'sk-deep',
          fine: 'ok',
        },
        list: [{ token: 'xxx' }, { ok: 1 }],
      },
    }
    const out = sanitiseToolPayload(input) as any
    expect(out.outer.inner.apiKey).toBe(REDACTED)
    expect(out.outer.inner.fine).toBe('ok')
    expect(out.outer.list[0].token).toBe(REDACTED)
    expect(out.outer.list[1].ok).toBe(1)
  })

  it('truncates operator-tier string values longer than 1000 chars', () => {
    // Prose with spaces so the length-heuristic doesn't fire — we're
    // exercising the plain truncate path here.
    const big = ('lorem ipsum dolor sit amet ' as string).repeat(80)
    expect(big.length).toBeGreaterThan(TRUNCATE_AT)
    const out = sanitiseToolPayload({ body: big }) as Record<string, unknown>
    const bodyStr = out.body as string
    expect(bodyStr.length).toBe(TRUNCATE_AT + TRUNCATE_SUFFIX.length)
    expect(bodyStr.endsWith(TRUNCATE_SUFFIX)).toBe(true)
  })

  it('admin tier preserves long strings verbatim and still redacts sensitive keys', () => {
    const big = ('lorem ipsum dolor sit amet ' as string).repeat(80)
    const out = sanitiseToolPayload(
      { body: big, apiKey: 'sk-admin' },
      { tier: 'admin' },
    ) as Record<string, unknown>
    expect(out.body).toBe(big)
    // Redaction is tier-agnostic — admin still must not see the raw key.
    expect(out.apiKey).toBe(REDACTED)
  })

  it('short strings are left untouched regardless of tier', () => {
    const s = 'hello world'
    const out = sanitiseToolPayload({ greeting: s }) as Record<string, unknown>
    expect(out.greeting).toBe(s)
  })

  it('handles cyclic references without throwing', () => {
    const node: any = { name: 'root' }
    node.self = node
    const out = sanitiseToolPayload(node) as any
    expect(out.name).toBe('root')
    expect(out.self).toBe('[cycle]')
  })

  it('middle-redacts opaque ≥32-char alnum strings on operator tier (length heuristic)', () => {
    // Arbitrary custom-tool field name the key regex wouldn't catch; the
    // value looks like a bearer-style token.
    const likelySecret = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6'
    expect(likelySecret.length).toBe(32)
    const out = sanitiseToolPayload({
      customField: likelySecret,
    }) as Record<string, unknown>
    const redacted = out.customField as string
    expect(redacted.startsWith('A1B2')).toBe(true)
    expect(redacted.endsWith('O5P6')).toBe(true)
    expect(redacted).toContain(LIKELY_SECRET_MIDDLE)
    // And admin tier sees it verbatim (full-output escape hatch).
    const adminOut = sanitiseToolPayload(
      { customField: likelySecret },
      { tier: 'admin' },
    ) as Record<string, unknown>
    expect(adminOut.customField).toBe(likelySecret)
  })

  it('length heuristic does not fire on strings with whitespace, punctuation, or short length', () => {
    const prose = 'This is a perfectly normal sentence with spaces.'
    const shortOpaque = 'abc-123'
    const punctuated = 'value=42;flag=true;role=admin-user'
    const out = sanitiseToolPayload({
      prose,
      shortOpaque,
      punctuated,
    }) as Record<string, unknown>
    expect(out.prose).toBe(prose)
    expect(out.shortOpaque).toBe(shortOpaque)
    expect(out.punctuated).toBe(punctuated)
  })

  it('redact-by-key wins over the length heuristic when both would apply', () => {
    // Value would match /^[A-Za-z0-9_\-]{32,}$/ on its own, but the key
    // is sensitive — the key-based redaction short-circuits the walker
    // before the string rule ever runs, so we get the literal [redacted]
    // marker rather than a middle-redacted leak of the first/last 4.
    // Fake opaque token — deliberately avoids any real SDK prefix so
    // GitHub secret-scanning push-protection doesn't flag it.
    const obviousSecret = 'fake_key_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
    const out = sanitiseToolPayload({
      apiKey: obviousSecret,
    }) as Record<string, unknown>
    expect(out.apiKey).toBe(REDACTED)
    expect(out.apiKey).not.toContain(LIKELY_SECRET_MIDDLE)
  })

  it('passes primitives through and drops functions/symbols', () => {
    expect(sanitiseToolPayload(42)).toBe(42)
    expect(sanitiseToolPayload(true)).toBe(true)
    expect(sanitiseToolPayload(null)).toBe(null)
    const out = sanitiseToolPayload({
      fn: () => 1,
      sym: Symbol('x'),
      ok: 'fine',
    }) as Record<string, unknown>
    expect(out.fn).toBeUndefined()
    expect(out.sym).toBeUndefined()
    expect(out.ok).toBe('fine')
  })
})
