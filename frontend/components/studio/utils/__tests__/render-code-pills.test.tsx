// Sprint 046 T050 — unit test for the FR-033 code-pill renderer.

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { renderInlineCodePills } from '../render-code-pills'

function renderPills(text: string) {
  return render(<div>{renderInlineCodePills(text)}</div>)
}

describe('renderInlineCodePills', () => {
  it('renders a backtick-wrapped token as a single pill span', () => {
    const { container } = renderPills('Your lockbox code is `4829`.')
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(1)
    expect(spans[0].textContent).toBe('4829')
  })

  it('renders multiple pills in order', () => {
    const { container } = renderPills('Use `4829` or `WIFI-abc`.')
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(2)
    expect(spans[0].textContent).toBe('4829')
    expect(spans[1].textContent).toBe('WIFI-abc')
  })

  it('pairs backticks greedily left-to-right (the simple parser)', () => {
    // The helper uses a `/`([^`\n]+)`/g` regex — first two ticks pair,
    // any stray trailing tick becomes literal text.
    const { container } = renderPills('A lone ` backtick and a pair `ok` here.')
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(1)
    // The span captures everything between the first two backticks.
    expect(spans[0].textContent).toBe(' backtick and a pair ')
    expect(container.textContent).toContain('ok')
  })

  it('returns a single string when there are no pills', () => {
    const { container } = renderPills('Plain text, no codes.')
    const spans = container.querySelectorAll('span')
    expect(spans.length).toBe(0)
    expect(container.textContent).toBe('Plain text, no codes.')
  })
})
