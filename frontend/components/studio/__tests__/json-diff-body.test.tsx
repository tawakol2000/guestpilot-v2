/**
 * Sprint 052 A C3 — JSON diff renderer tests.
 *
 * Load-bearing: sanitisation must apply on BOTH sides of the diff.
 * A "removed value" line that rendered a raw secret would nullify the
 * 050-A4 redact-by-key invariant.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import { JsonDiffBody, diff } from '../artifact-views/json-diff-body'

describe('diff (pure)', () => {
  it('reports an added top-level key', () => {
    const nodes = diff({ a: 1 }, { a: 1, b: 2 }, '', '', 0)
    const add = nodes.find((n) => n.kind === 'add')
    expect(add?.key).toBe('b')
    expect(add?.current).toBe(2)
  })

  it('reports a removed top-level key', () => {
    const nodes = diff({ a: 1, b: 2 }, { a: 1 }, '', '', 0)
    const del = nodes.find((n) => n.kind === 'del')
    expect(del?.key).toBe('b')
    expect(del?.prev).toBe(2)
  })

  it('reports a modified scalar', () => {
    const nodes = diff({ a: 1 }, { a: 2 }, '', '', 0)
    const mod = nodes.find((n) => n.kind === 'mod')
    expect(mod?.prev).toBe(1)
    expect(mod?.current).toBe(2)
  })

  it('recurses into nested objects', () => {
    const nodes = diff(
      { outer: { inner: 'old' } },
      { outer: { inner: 'new' } },
      '',
      '',
      0,
    )
    const mod = nodes.find((n) => n.kind === 'mod')
    expect(mod?.path).toBe('outer.inner')
    expect(mod?.prev).toBe('old')
    expect(mod?.current).toBe('new')
  })

  it('diffs arrays element-wise', () => {
    const nodes = diff([1, 2, 3], [1, 9, 3], '', '', 0)
    const mod = nodes.find((n) => n.kind === 'mod')
    expect(mod?.path).toBe('[1]')
    expect(mod?.prev).toBe(2)
    expect(mod?.current).toBe(9)
  })

  it('reports identical objects with all equal kinds', () => {
    const nodes = diff({ a: 1 }, { a: 1 }, '', '', 0)
    expect(nodes.every((n) => n.kind === 'equal')).toBe(true)
  })

  it('reports deeply nested changes with a dotted path', () => {
    const nodes = diff(
      { a: { b: { c: 1 } } },
      { a: { b: { c: 2 } } },
      '',
      '',
      0,
    )
    const mod = nodes.find((n) => n.kind === 'mod')
    expect(mod?.path).toBe('a.b.c')
  })
})

describe('JsonDiffBody', () => {
  it('renders "no changes" banner when prev === current', () => {
    const { getByRole } = render(
      <JsonDiffBody
        prev={{ a: 1 }}
        current={{ a: 1 }}
        isPending={false}
        tier="operator"
      />,
    )
    expect(getByRole('status').textContent).toMatch(/no changes/i)
  })

  it('redacts sensitive keys on both sides at operator tier', () => {
    // prev has an apiKey with a live value; current has it removed.
    // Without sanitisation, the "removed" line would leak the secret.
    const { container } = render(
      <JsonDiffBody
        prev={{ apiKey: 'sk-live-deadbeefcafe', name: 'slack' }}
        current={{ name: 'slack' }}
        isPending={false}
        tier="operator"
      />,
    )
    expect(container.textContent).toContain('[redacted]')
    expect(container.textContent).not.toContain('sk-live-deadbeefcafe')
  })

  it('middle-redacts long opaque-token values on operator tier', () => {
    // Key name doesn't match the redact regex; the length-heuristic
    // fallback kicks in and middle-redacts.
    const longToken = 'Z'.repeat(40)
    const { container } = render(
      <JsonDiffBody
        prev={{ customField: longToken }}
        current={{ customField: 'short' }}
        isPending={false}
        tier="operator"
      />,
    )
    expect(container.textContent).toContain('[likely-secret]')
    expect(container.textContent).not.toContain(longToken)
  })

  it('renders a modify block as strike + underline for a changed scalar', () => {
    const { container } = render(
      <JsonDiffBody
        prev={{ timeout: 5000 }}
        current={{ timeout: 10000 }}
        isPending={false}
        tier="operator"
      />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('- timeout: 5000')
    expect(text).toContain('+ timeout: 10000')
  })

  it('applies A1 pending grammar on the <pre> wrapper', () => {
    const { container } = render(
      <JsonDiffBody
        prev={{ a: 1 }}
        current={{ a: 2 }}
        isPending
        tier="operator"
      />,
    )
    const pre = container.querySelector('pre[data-origin="pending"]')
    expect(pre).not.toBeNull()
    expect((pre as HTMLElement).style.fontStyle).toBe('italic')
  })

  it('diffs nested arrays with index-path annotations', () => {
    const { container } = render(
      <JsonDiffBody
        prev={{ triggers: ['a', 'b', 'c'] }}
        current={{ triggers: ['a', 'z', 'c'] }}
        isPending={false}
        tier="operator"
      />,
    )
    const modLine = container.querySelector('[data-diff="mod"][data-path="triggers[1]"]')
    expect(modLine).not.toBeNull()
  })

  it('treats admin tier as preserving verbatim values (no length heuristic)', () => {
    const longToken = 'Z'.repeat(40)
    const { container } = render(
      <JsonDiffBody
        prev={{ customField: longToken }}
        current={{ customField: 'short' }}
        isPending={false}
        tier="admin"
      />,
    )
    expect(container.textContent).toContain(longToken)
  })

  it('still redacts-by-key on admin tier (050-A4 invariant)', () => {
    // Removal of an apiKey entry — the redact-by-key invariant must
    // hold even on admin tier so the "removed value" path can't leak
    // the raw secret. (prev and current have different shapes so the
    // diff renders a real del line rather than collapsing to equal.)
    const { container } = render(
      <JsonDiffBody
        prev={{ apiKey: 'sk-live-deadbeefcafe', name: 'slack' }}
        current={{ name: 'slack' }}
        isPending={false}
        tier="admin"
      />,
    )
    expect(container.textContent).toContain('[redacted]')
    expect(container.textContent).not.toContain('sk-live-deadbeefcafe')
  })
})
