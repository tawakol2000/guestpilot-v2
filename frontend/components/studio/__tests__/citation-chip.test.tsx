/**
 * Sprint 051 A B3 — citation-chip click behaviour.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { CitationChip } from '../citation-chip'

describe('CitationChip', () => {
  it('invokes onOpen with artifact + id + section on click', () => {
    const onOpen = vi.fn()
    render(
      <CitationChip
        artifact="sop"
        artifactId="sop-abc"
        section="early-checkin"
        onOpen={onOpen}
      />,
    )
    const btn = screen.getByRole('button', { name: /Open SOP: sop-abc/ })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledWith('sop', 'sop-abc', 'early-checkin')
  })
  it('renders without onOpen (purely informational)', () => {
    render(<CitationChip artifact="faq" artifactId="faq-x" section={null} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })
})
