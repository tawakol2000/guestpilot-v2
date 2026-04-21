/**
 * Sprint 052 A C1 — markdown-body render + heading-anchor tests.
 *
 * Covers the renderer's main responsibilities: GFM markdown output,
 * heading-anchor slug stamping, scroll-to-section hit/miss, and the
 * A1 origin-grammar invariant (pending → italic + inkMuted).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { MarkdownBody } from '../artifact-views/markdown-body'

describe('MarkdownBody', () => {
  beforeEach(() => {
    // rAF runs synchronously under jsdom if the polyfill is naive — let
    // the real timer drive it so the useEffect scroll fires in order.
    vi.useRealTimers()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders headings, lists, bold, and code blocks', () => {
    const body = [
      '## Early check-in',
      '',
      '**Before** 14:00 we only permit check-in when:',
      '',
      '- The room is ready',
      '- The cleaning team has signed off',
      '',
      '`door_code` is printed on the arrival note.',
    ].join('\n')
    render(<MarkdownBody body={body} isPending={false} />)
    expect(screen.getByRole('heading', { level: 2, name: /early check-in/i })).toBeInTheDocument()
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText(/room is ready/i)).toBeInTheDocument()
    expect(screen.getByText('door_code')).toBeInTheDocument()
  })

  it('assigns slug-id + data-section to h2/h3 headings', () => {
    const body = '## Early check-in\n\n### Overnight guests?\n'
    const { container } = render(
      <MarkdownBody body={body} isPending={false} />,
    )
    const h2 = container.querySelector('h2[data-section="early-check-in"]')
    const h3 = container.querySelector('h3[data-section="overnight-guests"]')
    expect(h2).not.toBeNull()
    expect(h2?.id).toBe('early-check-in')
    expect(h3).not.toBeNull()
    expect(h3?.id).toBe('overnight-guests')
  })

  it('scrolls the matching heading into view on hit', async () => {
    const body = '## Early check-in\n\n## Overnight guests\n'
    render(
      <MarkdownBody
        body={body}
        isPending={false}
        scrollToSectionSlug="overnight-guests"
      />,
    )
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    })
    const call = (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock
    const self = call.instances[0] as HTMLElement | undefined
    expect(self?.tagName.toLowerCase()).toBe('h2')
    expect(self?.getAttribute('data-section')).toBe('overnight-guests')
  })

  it('no-ops silently when the scrollToSection slug does not match', async () => {
    const body = '## Early check-in\n'
    render(
      <MarkdownBody
        body={body}
        isPending={false}
        scrollToSectionSlug="does-not-exist"
      />,
    )
    // One rAF frame is enough for the effect to run. Wait, then assert
    // no scroll happened.
    await new Promise((r) => setTimeout(r, 20))
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('applies A1 pending grammar (italic + data-origin="pending")', () => {
    const { container } = render(
      <MarkdownBody body="## Hello" isPending />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.getAttribute('data-origin')).toBe('pending')
    expect(root.style.fontStyle).toBe('italic')
  })

  it('renders GFM task-list items (remark-gfm is wired)', () => {
    const body = '- [x] done\n- [ ] pending\n'
    const { container } = render(<MarkdownBody body={body} isPending={false} />)
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
  })

  it('renders GFM tables', () => {
    const body = [
      '| col a | col b |',
      '| ----- | ----- |',
      '| 1     | 2     |',
    ].join('\n')
    render(<MarkdownBody body={body} isPending={false} />)
    expect(screen.getByText('col a')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('handles an empty body without crashing', () => {
    const { container } = render(<MarkdownBody body="" isPending={false} />)
    expect(container.firstElementChild).not.toBeNull()
  })
})
