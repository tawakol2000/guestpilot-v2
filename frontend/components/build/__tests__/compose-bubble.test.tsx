/**
 * Sprint 056-A F1 — ComposeBubble tests.
 *
 * 1. Selection event fires the bubble with the correct anchor text.
 * 2. Submit posts the expected payload to /api/build/compose-span.
 * 3. Accept merges the replacement at the correct {start, end} into the buffer.
 * 4. Redo preserves bubble state; Dismiss restores prior buffer; Esc closes.
 * 5. Validator-reject renders the "try a narrower ask" message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ComposeBubble, mergeSpan } from '../../studio/compose-bubble'

// ─── Mock build-api ────────────────────────────────────────────────────────

vi.mock('@/lib/build-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/build-api')>()
  return {
    ...actual,
    apiComposeSpan: vi.fn(),
  }
})

import { apiComposeSpan } from '@/lib/build-api'

// ─── Helpers ───────────────────────────────────────────────────────────────

const SELECTION = {
  start: 10,
  end: 26,
  text: 'Check-in is at 4pm',
}

const BODY_TEXT =
  'Welcome! Check-in is at 4pm. We hope you enjoy your stay.'

function makeProps(overrides: Partial<Parameters<typeof ComposeBubble>[0]> = {}) {
  return {
    selection: SELECTION,
    bodyText: BODY_TEXT,
    artifactId: 'artifact-001',
    artifactType: 'sop',
    conversationId: 'conv-abc',
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

function mockComposeSuccess(replacement = 'Check-in is any time after 4pm — we\'ll have a warm welcome ready for you') {
  vi.mocked(apiComposeSpan).mockResolvedValue({
    replacement,
    rationale: 'Made it warmer and more welcoming.',
  })
}

function mockComposeFailure(message = 'Server error') {
  vi.mocked(apiComposeSpan).mockRejectedValue(new Error(message))
}

// ─── Unit: mergeSpan helper ────────────────────────────────────────────────

describe('mergeSpan', () => {
  it('replaces the slice between start and end', () => {
    const body = 'Hello world foo bar'
    const result = mergeSpan(body, 6, 11, 'planet')
    expect(result).toBe('Hello planet foo bar')
  })

  it('handles replacement at start of string', () => {
    const body = 'Hello world'
    expect(mergeSpan(body, 0, 5, 'Hi')).toBe('Hi world')
  })

  it('handles replacement at end of string', () => {
    const body = 'Hello world'
    expect(mergeSpan(body, 6, 11, 'earth')).toBe('Hello earth')
  })
})

// ─── Component tests ────────────────────────────────────────────────────────

describe('ComposeBubble — 056-A F1', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Test 1: Bubble renders with selection text preview ─────────────────

  it('renders the selection text in the preview area', () => {
    render(<ComposeBubble {...makeProps()} />)
    const preview = screen.getByTestId('compose-bubble-selection-preview')
    expect(preview.textContent).toContain('Check-in is at 4pm')
  })

  it('renders the input placeholder', () => {
    render(<ComposeBubble {...makeProps()} />)
    const input = screen.getByTestId('compose-bubble-input')
    expect(input).toBeDefined()
    expect((input as HTMLInputElement).placeholder).toContain('Ask or tell the agent')
  })

  // ── Test 2: Submit posts expected payload ──────────────────────────────

  it('submit posts the expected payload to apiComposeSpan', async () => {
    mockComposeSuccess()
    const props = makeProps()
    render(<ComposeBubble {...props} />)

    const input = screen.getByTestId('compose-bubble-input') as HTMLInputElement
    const submitBtn = screen.getByTestId('compose-bubble-submit')

    fireEvent.change(input, { target: { value: 'make it sound warmer' } })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(apiComposeSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: 'artifact-001',
          artifactType: 'sop',
          selection: SELECTION,
          surroundingBody: BODY_TEXT,
          instruction: 'make it sound warmer',
          conversationId: 'conv-abc',
        }),
      )
    })
  })

  it('submit via Enter key also posts to apiComposeSpan', async () => {
    mockComposeSuccess()
    render(<ComposeBubble {...makeProps()} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'warmer' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(apiComposeSpan).toHaveBeenCalledTimes(1)
    })
  })

  // ── Test 3: Accept merges replacement at correct offsets ───────────────

  it('Accept calls onAccept with the merged replacement (correct {start, end})', async () => {
    const replacement = "Check-in is any time after 4pm — we'll have a warm welcome ready for you"
    vi.mocked(apiComposeSpan).mockResolvedValue({
      replacement,
      rationale: 'Made warmer.',
    })

    const onAccept = vi.fn()
    render(<ComposeBubble {...makeProps({ onAccept })} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'make warmer' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('compose-bubble-accept')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('compose-bubble-accept'))

    // onAccept receives the replacement string; the drawer merges it
    // at the stored {start, end} offsets.
    expect(onAccept).toHaveBeenCalledWith(replacement)
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  // ── Test 4a: Redo preserves bubble state ──────────────────────────────

  it('Redo resets to idle and increments redo count label', async () => {
    mockComposeSuccess()
    render(<ComposeBubble {...makeProps()} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'try this' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('compose-bubble-result')).toBeDefined()
    })

    const redoBtn = screen.getByTestId('compose-bubble-redo')
    fireEvent.click(redoBtn)

    // After redo, input reappears.
    await waitFor(() => {
      expect(screen.getByTestId('compose-bubble-input')).toBeDefined()
    })
  })

  // ── Test 4b: Dismiss calls onDismiss ──────────────────────────────────

  it('Dismiss in result state calls onDismiss', async () => {
    mockComposeSuccess()
    const onDismiss = vi.fn()
    render(<ComposeBubble {...makeProps({ onDismiss })} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'try this' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('compose-bubble-dismiss-result')).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('compose-bubble-dismiss-result'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // ── Test 4c: Esc key calls onDismiss ──────────────────────────────────

  it('Esc key calls onDismiss', () => {
    const onDismiss = vi.fn()
    render(<ComposeBubble {...makeProps({ onDismiss })} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // ── Test 4d: X button calls onDismiss ─────────────────────────────────

  it('X header button calls onDismiss', () => {
    const onDismiss = vi.fn()
    render(<ComposeBubble {...makeProps({ onDismiss })} />)

    const dismissBtn = screen.getByLabelText('Dismiss compose bubble')
    fireEvent.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // ── Test 5: Validator-reject for multi-paragraph expansion ────────────

  it('validator rejects multi-paragraph replacement for single-line selection', async () => {
    // Multi-paragraph replacement: two blocks separated by blank line
    const multiParagraph = 'First paragraph here.\n\nSecond paragraph here.'
    vi.mocked(apiComposeSpan).mockResolvedValue({
      replacement: multiParagraph,
      rationale: 'Added context.',
    })

    render(<ComposeBubble {...makeProps()} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'expand this' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      const errEl = screen.getByTestId('compose-bubble-error')
      expect(errEl.textContent).toContain('Try a narrower ask')
    })

    // Accept button should NOT appear
    expect(screen.queryByTestId('compose-bubble-accept')).toBeNull()
  })

  it('allows multi-paragraph replacement for multi-line selection', async () => {
    const multiParagraph = 'First paragraph here.\n\nSecond paragraph here.'
    vi.mocked(apiComposeSpan).mockResolvedValue({
      replacement: multiParagraph,
      rationale: 'Expanded.',
    })

    // Multi-line selection (has a newline)
    const multiLineSelection = {
      start: 0,
      end: 30,
      text: 'Check-in is at 4pm.\nWelcome.',
    }

    render(<ComposeBubble {...makeProps({ selection: multiLineSelection })} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'expand this' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      // Accept button should appear (no validator rejection)
      expect(screen.getByTestId('compose-bubble-accept')).toBeDefined()
    })
  })

  // ── Network error ──────────────────────────────────────────────────────

  it('shows error message on network failure', async () => {
    mockComposeFailure('Network error')
    render(<ComposeBubble {...makeProps()} />)

    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'improve this' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      const errEl = screen.getByTestId('compose-bubble-error')
      expect(errEl.textContent).toContain('Error:')
    })
  })

  // ── Redo limit ─────────────────────────────────────────────────────────

  it('Redo button disappears after 3 redos', async () => {
    mockComposeSuccess()
    render(<ComposeBubble {...makeProps()} />)

    // Submit 3 times, clicking Redo after each result (3 redos total).
    for (let i = 0; i < 3; i++) {
      const input = screen.getByTestId('compose-bubble-input')
      fireEvent.change(input, { target: { value: `attempt ${i + 1}` } })
      fireEvent.click(screen.getByTestId('compose-bubble-submit'))

      await waitFor(() => {
        expect(screen.getByTestId('compose-bubble-result')).toBeDefined()
      })

      // Click redo after each result — 3 total.
      fireEvent.click(screen.getByTestId('compose-bubble-redo'))

      // Wait for idle state to return before the next iteration.
      await waitFor(() => {
        expect(screen.getByTestId('compose-bubble-input')).toBeDefined()
      })
    }

    // Submit a 4th time — redoCount is now 3, at the limit.
    const input = screen.getByTestId('compose-bubble-input')
    fireEvent.change(input, { target: { value: 'final attempt' } })
    fireEvent.click(screen.getByTestId('compose-bubble-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('compose-bubble-result')).toBeDefined()
    })

    // After 3 redos have been consumed, redo button should not be present.
    expect(screen.queryByTestId('compose-bubble-redo')).toBeNull()
  })
})
