/**
 * Sprint 054-A F2 — shared RationaleCard component tests.
 * Sprint 055-A F4 — edited-by-operator provenance rendering.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  RationaleCard,
  extractRationale,
  extractEditProvenance,
} from '../artifact-views/rationale-card'

describe('RationaleCard', () => {
  it('renders rationale text literally when provided', () => {
    render(<RationaleCard rationale="Manager said parking info was missing." />)
    expect(screen.getByTestId('rationale-card-body').textContent).toBe(
      'Manager said parking info was missing.',
    )
    expect(screen.queryByTestId('rationale-card-placeholder')).toBeNull()
  })

  it('renders "No rationale recorded" placeholder when rationale is absent', () => {
    render(<RationaleCard rationale={null} />)
    expect(screen.getByTestId('rationale-card-placeholder').textContent).toBe(
      'No rationale recorded',
    )
    expect(screen.queryByTestId('rationale-card-body')).toBeNull()
  })

  it('treats empty / whitespace rationale as absent (not crash, not leak)', () => {
    const { rerender } = render(<RationaleCard rationale="" />)
    expect(screen.getByTestId('rationale-card-placeholder')).toBeTruthy()
    rerender(<RationaleCard rationale={'   \n\t  '} />)
    expect(screen.getByTestId('rationale-card-placeholder')).toBeTruthy()
  })

  it('renders markdown-looking rationale as LITERAL TEXT (no bold/heading parsing)', () => {
    // Formatting sanity rail — an agent writing "# CRITICAL" or "**bold**"
    // as a rationale must not stamp a heading into the ledger rail.
    const injected = '# CRITICAL **shutdown** everything'
    render(<RationaleCard rationale={injected} />)
    const body = screen.getByTestId('rationale-card-body')
    // textContent preserves literal characters; DOM should not contain
    // <strong> / <h1> / etc. from markdown parsing.
    expect(body.textContent).toBe(injected)
    expect(body.querySelector('strong')).toBeNull()
    expect(body.querySelector('h1')).toBeNull()
    expect(body.querySelector('h2')).toBeNull()
    expect(body.querySelector('h3')).toBeNull()
    expect(body.querySelector('em')).toBeNull()
  })

  it('renders the "rail" variant with transparent background (inline in ledger row)', () => {
    const { container } = render(
      <RationaleCard variant="rail" rationale="Some reason." />,
    )
    const card = container.querySelector('[data-testid="rationale-card"]')
    expect(card?.getAttribute('data-variant')).toBe('rail')
  })

  it('renders the "drawer" variant with a visible card background', () => {
    const { container } = render(
      <RationaleCard variant="drawer" rationale="Some reason." />,
    )
    const card = container.querySelector('[data-testid="rationale-card"]')
    expect(card?.getAttribute('data-variant')).toBe('drawer')
  })
})

describe('RationaleCard — F4 edited-by-operator provenance', () => {
  it('headline includes "(edited by operator)" when editedByOperator=true', () => {
    render(<RationaleCard rationale="Agent wrote this." editedByOperator />)
    const headline = screen.getByTestId('rationale-card-headline')
    expect(headline.textContent).toContain('(edited by operator)')
  })

  it('headline has no edit suffix when editedByOperator is absent', () => {
    render(<RationaleCard rationale="Agent wrote this." />)
    const headline = screen.getByTestId('rationale-card-headline')
    expect(headline.textContent).not.toContain('edited by operator')
  })

  it('renders operator rationale block when provided', () => {
    render(
      <RationaleCard
        rationale="Agent wrote this."
        editedByOperator
        operatorRationale="Fixed a typo in the SOP."
      />,
    )
    const or = screen.getByTestId('rationale-card-operator-rationale')
    expect(or.textContent).toContain('Fixed a typo in the SOP.')
  })

  it('does NOT render operator rationale block when editedByOperator but no operatorRationale', () => {
    render(<RationaleCard rationale="Agent wrote this." editedByOperator />)
    expect(screen.queryByTestId('rationale-card-operator-rationale')).toBeNull()
  })

  it('neither surface regresses when metadata is absent', () => {
    render(<RationaleCard rationale="Normal rationale." />)
    expect(screen.getByTestId('rationale-card-body').textContent).toBe('Normal rationale.')
    expect(screen.queryByTestId('rationale-card-operator-rationale')).toBeNull()
  })
})

describe('extractEditProvenance', () => {
  it('returns editedByOperator=true when rationalePrefix matches', () => {
    const result = extractEditProvenance({ rationalePrefix: 'edited-by-operator', operatorRationale: 'Fixed typo' })
    expect(result.editedByOperator).toBe(true)
    expect(result.operatorRationale).toBe('Fixed typo')
  })

  it('returns editedByOperator=false when rationalePrefix is absent', () => {
    expect(extractEditProvenance(null).editedByOperator).toBe(false)
    expect(extractEditProvenance({}).editedByOperator).toBe(false)
    expect(extractEditProvenance({ rationalePrefix: 'agent' }).editedByOperator).toBe(false)
  })

  it('returns operatorRationale=null when field is absent or whitespace', () => {
    expect(extractEditProvenance({ rationalePrefix: 'edited-by-operator' }).operatorRationale).toBeNull()
    expect(extractEditProvenance({ rationalePrefix: 'edited-by-operator', operatorRationale: '  ' }).operatorRationale).toBeNull()
  })
})

describe('extractRationale', () => {
  it('returns the rationale string when metadata carries one', () => {
    expect(extractRationale({ rationale: 'hi there manager' })).toBe(
      'hi there manager',
    )
  })

  it('returns null for missing / null / non-string / whitespace rationale', () => {
    expect(extractRationale(null)).toBeNull()
    expect(extractRationale(undefined)).toBeNull()
    expect(extractRationale({})).toBeNull()
    expect(extractRationale({ rationale: null })).toBeNull()
    expect(extractRationale({ rationale: 42 as unknown })).toBeNull()
    expect(extractRationale({ rationale: '   ' })).toBeNull()
  })
})
