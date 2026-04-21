/**
 * Sprint 058-A F4 — session-diff card tests.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SessionDiffCard, type SessionDiffSummaryData } from '../session-diff-card'

describe('SessionDiffCard', () => {
  it('renders tallies for a full multi-category turn', () => {
    const data: SessionDiffSummaryData = {
      written: { created: 2, edited: 1, reverted: 0 },
      tested: { runs: 1, totalVariants: 3, passed: 2 },
      plans: { cancelled: 1 },
      note: 'Tightened early-checkin SOP',
    }
    render(<SessionDiffCard data={data} />)
    expect(screen.getByTestId('session-diff-card')).toBeInTheDocument()
    expect(screen.getByTestId('session-diff-written').textContent).toMatch(/Wrote 2/)
    expect(screen.getByTestId('session-diff-edited').textContent).toMatch(/Edited 1/)
    expect(screen.getByTestId('session-diff-tested').textContent).toMatch(/Tested 1/)
    expect(screen.getByTestId('session-diff-tested').textContent).toMatch(/\(2\/3\)/)
    expect(screen.getByTestId('session-diff-reverted').textContent).toMatch(/Reverted 0/)
    expect(screen.getByTestId('session-diff-cancelled').textContent).toMatch(/Cancelled 1/)
    expect(screen.getByTestId('session-diff-note').textContent).toMatch(
      /Tightened early-checkin SOP/,
    )
  })

  it('renders nothing when all counts are zero and no note', () => {
    const { container } = render(<SessionDiffCard data={{}} />)
    expect(container.firstChild).toBeNull()
  })

  it('hides the tested row when runs is zero', () => {
    render(
      <SessionDiffCard
        data={{
          written: { created: 1 },
        }}
      />,
    )
    expect(screen.queryByTestId('session-diff-tested')).toBeNull()
  })

  it('renders when only written.created is present (graceful partial)', () => {
    render(<SessionDiffCard data={{ written: { created: 3 } }} />)
    expect(screen.getByTestId('session-diff-written').textContent).toMatch(/Wrote 3/)
    expect(screen.getByTestId('session-diff-edited').textContent).toMatch(/Edited 0/)
  })

  it('renders the note on its own line', () => {
    render(
      <SessionDiffCard
        data={{ written: { created: 1 }, note: 'Short explainer' }}
      />,
    )
    expect(screen.getByTestId('session-diff-note').textContent).toBe('Short explainer')
  })

  it('coerces non-finite numbers to zero', () => {
    render(
      <SessionDiffCard
        data={{
          // @ts-expect-error — intentionally bad input to test safeNum
          written: { created: NaN, edited: 'bad' },
          note: 'guard',
        }}
      />,
    )
    expect(screen.getByTestId('session-diff-written').textContent).toMatch(/Wrote 0/)
    expect(screen.getByTestId('session-diff-edited').textContent).toMatch(/Edited 0/)
  })

  it('renders when only a note is present', () => {
    render(<SessionDiffCard data={{ note: 'Just a note' }} />)
    expect(screen.getByTestId('session-diff-note').textContent).toBe('Just a note')
  })
})
