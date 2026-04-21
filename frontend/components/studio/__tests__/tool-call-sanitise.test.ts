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

const { REDACTED, TRUNCATE_AT, TRUNCATE_SUFFIX } = TOOL_CALL_SANITISE_INTERNALS

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
    const big = 'a'.repeat(1500)
    const out = sanitiseToolPayload({ body: big }) as Record<string, unknown>
    const bodyStr = out.body as string
    expect(bodyStr.length).toBe(TRUNCATE_AT + TRUNCATE_SUFFIX.length)
    expect(bodyStr.endsWith(TRUNCATE_SUFFIX)).toBe(true)
  })

  it('admin tier preserves long strings verbatim and still redacts sensitive keys', () => {
    const big = 'b'.repeat(1500)
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
