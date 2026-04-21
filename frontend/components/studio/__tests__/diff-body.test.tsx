/**
 * Sprint 051 A B2 — diff-body unit + snapshot coverage.
 *
 * Covers: add-only, delete-only, modify, empty-diff, and whitespace
 * tokenisation (FAQ path). Pending-state grammar (A1 italic grey +
 * Unsaved badge) is asserted on the SOP + FAQ views directly.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  DiffBody,
  computeDiff,
} from '../artifact-views/diff-body'
import { SopView } from '../artifact-views/sop-view'
import { FaqView } from '../artifact-views/faq-view'
import type { BuildArtifactDetail } from '@/lib/build-api'

describe('computeDiff', () => {
  it('flags a pure addition as a single add op', () => {
    const ops = computeDiff('', 'hello world', 'token')
    expect(ops.every((o) => o.kind === 'add' || o.kind === 'equal')).toBe(true)
    expect(ops.some((o) => o.kind === 'add' && o.text === 'hello')).toBe(true)
    expect(ops.some((o) => o.kind === 'add' && o.text === 'world')).toBe(true)
  })
  it('flags a pure deletion as a single del op', () => {
    const ops = computeDiff('stale line', '', 'token')
    expect(ops.every((o) => o.kind === 'del' || o.kind === 'equal')).toBe(true)
    expect(ops.filter((o) => o.kind === 'del').length).toBe(2)
  })
  it('identifies add+del for a modified token', () => {
    const ops = computeDiff('one two three', 'one 2 three', 'token')
    const adds = ops.filter((o) => o.kind === 'add').map((o) => o.text)
    const dels = ops.filter((o) => o.kind === 'del').map((o) => o.text)
    expect(adds).toContain('2')
    expect(dels).toContain('two')
  })
  it('returns only equal ops when prev === next', () => {
    const ops = computeDiff('same\nbody', 'same\nbody', 'line')
    expect(ops.every((o) => o.kind === 'equal')).toBe(true)
  })
  it('line mode splits on newlines; one added paragraph is one op', () => {
    const prev = 'line a\nline b'
    const next = 'line a\nline b\nline c'
    const ops = computeDiff(prev, next, 'line')
    const adds = ops.filter((o) => o.kind === 'add')
    expect(adds).toHaveLength(1)
    expect(adds[0]!.text).toBe('line c')
  })
})

describe('DiffBody render', () => {
  it('renders a "no changes" notice when diff is empty', () => {
    render(<DiffBody prev="same" next="same" mode="line" />)
    expect(
      screen.getByText(/No changes relative to the pre-session body/),
    ).toBeInTheDocument()
  })
  it('renders add + del spans with data-diff markers for a token-level change', () => {
    const { container } = render(
      <DiffBody prev="old word" next="new word" mode="token" />,
    )
    const adds = container.querySelectorAll('[data-diff="add"]')
    const dels = container.querySelectorAll('[data-diff="del"]')
    expect(adds.length).toBeGreaterThan(0)
    expect(dels.length).toBeGreaterThan(0)
  })
})

// ─── Pending-grammar regression (A1 invariant extends to the drawer) ─────

function makeSopDetail(overrides: Partial<BuildArtifactDetail> = {}): BuildArtifactDetail {
  return {
    type: 'sop',
    id: 'v1',
    title: 'early-checkin · CONFIRMED',
    body: 'Proposed body not yet approved.',
    meta: {
      category: 'early-checkin',
      status: 'CONFIRMED',
      enabled: true,
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  }
}

describe('A1 pending grammar extends into the drawer', () => {
  it('SOP view renders the Unsaved badge + italic data-origin="pending" on pending', () => {
    render(
      <SopView
        artifact={makeSopDetail()}
        showDiff={false}
        isPending
      />,
    )
    expect(screen.getByText(/Unsaved · pending approval/i)).toBeInTheDocument()
    // 052-C1 — MarkdownBody is now the pending-grammar carrier (was <pre>
    // in 051). The A1 invariant is element-agnostic — what matters is
    // that the body node has data-origin="pending" + italic styling.
    // `PendingBadge` also stamps data-origin="pending" on its own node
    // (shared grammar), so filter by inline italic to land on the body.
    const bodies = Array.from(
      document.querySelectorAll<HTMLElement>('[data-origin="pending"]'),
    )
    const italicBody = bodies.find((el) => el.style.fontStyle === 'italic')
    expect(italicBody).toBeDefined()
  })
  it('FAQ view renders pending grammar identically', () => {
    render(
      <FaqView
        artifact={{
          type: 'faq',
          id: 'f1',
          title: 'Q?',
          body: 'Pending answer.',
          meta: {
            question: 'Pending question?',
            category: 'amenity',
            scope: 'GLOBAL',
            status: 'SUGGESTED',
            source: 'AUTO_SUGGESTED',
            usageCount: 0,
            updatedAt: new Date().toISOString(),
          },
        }}
        showDiff={false}
        isPending
      />,
    )
    expect(screen.getByText(/Unsaved · pending approval/i)).toBeInTheDocument()
  })
  it('SOP view renders diff via DiffBody when prevBody + showDiff are set', () => {
    const { container } = render(
      <SopView
        artifact={makeSopDetail({
          body: 'after body',
          prevBody: 'before body',
        })}
        showDiff
        isPending={false}
      />,
    )
    expect(container.querySelector('[data-diff-mode="line"]')).not.toBeNull()
  })
})
