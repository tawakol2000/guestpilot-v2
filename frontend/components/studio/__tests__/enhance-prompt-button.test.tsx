/**
 * Sprint 058-A F8 — composer ✨ enhance-prompt button.
 *
 * Covers:
 *   - button hidden below 10 chars, visible at ≥10
 *   - click fires apiEnhancePrompt and replaces the draft with the rewrite
 *   - ⌘Z within 15s restores the pre-enhance draft and toasts
 *   - ⌘Z after the 15s window no-ops
 *   - a failed enhance toasts an error and leaves the draft untouched
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

const hoisted = vi.hoisted(() => {
  return {
    mockApiEnhancePrompt: vi.fn(),
    mockApiAcceptSuggestedFix: vi.fn(),
    mockApiRejectSuggestedFix: vi.fn(),
    mockToast: Object.assign(vi.fn(), {
      error: vi.fn(),
      success: vi.fn(),
    }),
    sendMessage: vi.fn(),
    status: { current: 'ready' as string },
  }
})
const mockApiEnhancePrompt = hoisted.mockApiEnhancePrompt
const mockToast = hoisted.mockToast
const _sendMessage = hoisted.sendMessage

vi.mock('@/lib/api', () => ({
  getToken: () => 'tok',
}))

vi.mock('@/lib/build-api', () => ({
  apiEnhancePrompt: (...args: unknown[]) => hoisted.mockApiEnhancePrompt(...args),
  apiAcceptSuggestedFix: (...args: unknown[]) =>
    hoisted.mockApiAcceptSuggestedFix(...args),
  apiRejectSuggestedFix: (...args: unknown[]) =>
    hoisted.mockApiRejectSuggestedFix(...args),
  buildTurnEndpoint: () => '/api/build/chat',
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage: hoisted.sendMessage,
    status: hoisted.status.current,
    error: null,
  }),
}))

vi.mock('sonner', () => ({
  toast: hoisted.mockToast,
}))

vi.mock('ai', () => ({
  DefaultChatTransport: class {},
}))

import { StudioChat } from '../studio-chat'

function mkProps() {
  return {
    conversationId: 'conv-1',
    greenfield: false,
    initialMessages: [] as never[],
  }
}

beforeEach(() => {
  hoisted.status.current = 'ready'
  _sendMessage.mockReset()
  mockApiEnhancePrompt.mockReset()
  mockToast.mockReset()
  mockToast.error.mockReset()
  mockToast.success.mockReset()
})

describe('StudioChat composer F8 — enhance-prompt button', () => {
  it('hides the ✨ button below 10 chars, shows it at 10+', async () => {
    render(<StudioChat {...mkProps()} />)
    const textarea = (await screen.findByLabelText(
      'Message the studio agent',
    )) as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'short' } })
    expect(screen.queryByTestId('composer-enhance-button')).not.toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: 'Please tighten this draft further.' } })
    expect(
      await screen.findByTestId('composer-enhance-button'),
    ).toBeInTheDocument()
  })

  it('clicking ✨ calls apiEnhancePrompt and replaces the draft', async () => {
    mockApiEnhancePrompt.mockResolvedValueOnce({
      ok: true,
      rewrite: 'Rewritten: please tighten this draft further.',
    })
    render(<StudioChat {...mkProps()} />)
    const textarea = (await screen.findByLabelText(
      'Message the studio agent',
    )) as HTMLTextAreaElement

    fireEvent.change(textarea, {
      target: { value: 'Please tighten this draft further.' },
    })
    const btn = await screen.findByTestId('composer-enhance-button')
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => {
      expect(mockApiEnhancePrompt).toHaveBeenCalledWith(
        'Please tighten this draft further.',
        'conv-1',
      )
    })
    await waitFor(() => {
      expect(textarea.value).toBe(
        'Rewritten: please tighten this draft further.',
      )
    })
  })

  it('⌘Z within 15s restores the pre-enhance draft and toasts', async () => {
    mockApiEnhancePrompt.mockResolvedValueOnce({
      ok: true,
      rewrite: 'Rewritten draft.',
    })
    render(<StudioChat {...mkProps()} />)
    const textarea = (await screen.findByLabelText(
      'Message the studio agent',
    )) as HTMLTextAreaElement

    fireEvent.change(textarea, {
      target: { value: 'This is my original draft text.' },
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('composer-enhance-button'))
    })
    await waitFor(() => {
      expect(textarea.value).toBe('Rewritten draft.')
    })

    // ⌘Z — restore.
    fireEvent.keyDown(textarea, { key: 'z', metaKey: true })

    await waitFor(() => {
      expect(textarea.value).toBe('This is my original draft text.')
    })
    expect(mockToast).toHaveBeenCalledWith('Restored your original')
  })

  it('⌘Z after the 15s window does nothing', async () => {
    // Drive the 15s expiry check (Date.now() < slot.until) directly
    // without fake timers so async waitFor still polls. The setTimeout
    // inside the component also clears the slot, but this test only
    // needs the time-check branch to prove the window is respected.
    const realNow = Date.now
    mockApiEnhancePrompt.mockResolvedValueOnce({
      ok: true,
      rewrite: 'Rewritten draft.',
    })
    try {
      render(<StudioChat {...mkProps()} />)
      const textarea = (await screen.findByLabelText(
        'Message the studio agent',
      )) as HTMLTextAreaElement

      fireEvent.change(textarea, {
        target: { value: 'Original draft needing polish.' },
      })
      await act(async () => {
        fireEvent.click(await screen.findByTestId('composer-enhance-button'))
      })
      await waitFor(() => {
        expect(textarea.value).toBe('Rewritten draft.')
      })

      // Advance the Date.now source past the 15s window so the
      // component's `Date.now() < slot.until` check short-circuits the
      // restore. The setTimeout clearing path is exercised separately.
      const t0 = realNow()
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + 15_500)

      fireEvent.keyDown(textarea, { key: 'z', metaKey: true })

      expect(textarea.value).toBe('Rewritten draft.')
      expect(mockToast).not.toHaveBeenCalledWith('Restored your original')
      spy.mockRestore()
    } finally {
      /* no timers to unwind */
    }
  })

  it('failed enhance leaves the draft untouched and toasts an error', async () => {
    mockApiEnhancePrompt.mockRejectedValueOnce(new Error('nano down'))
    render(<StudioChat {...mkProps()} />)
    const textarea = (await screen.findByLabelText(
      'Message the studio agent',
    )) as HTMLTextAreaElement

    fireEvent.change(textarea, {
      target: { value: 'Original draft needing polish.' },
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('composer-enhance-button'))
    })

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith("Couldn't enhance — try again")
    })
    expect(textarea.value).toBe('Original draft needing polish.')
  })

  it('graceful "ok: false" response also toasts and keeps the draft', async () => {
    mockApiEnhancePrompt.mockResolvedValueOnce({
      ok: false,
      reason: 'rate_limited',
      retryAfterMs: 1200,
    })
    render(<StudioChat {...mkProps()} />)
    const textarea = (await screen.findByLabelText(
      'Message the studio agent',
    )) as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'Please expand this.' } })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('composer-enhance-button'))
    })

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith("Couldn't enhance — try again")
    })
    expect(textarea.value).toBe('Please expand this.')
  })
})

afterEach(() => {
  vi.useRealTimers()
})
