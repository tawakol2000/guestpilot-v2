/**
 * Regression tests for the 2026-04-22 queue-flush silent-error wedge fix.
 *
 * Before the fix: if `sendMessage` failed silently (network blip the
 * transport ate without transitioning status), `isFlushingRef.current`
 * stayed `true` forever and every subsequent queued message was blocked.
 * Operator saw "Queued (N)" pinned with no recourse short of reload.
 *
 * Two safety nets now protect against this:
 *   1. `sendMessage` is wrapped in `Promise.resolve().catch()` so a
 *      rejected send releases the ref + shows a toast.
 *   2. A 5-second safety timeout releases the ref if the transport
 *      hasn't transitioned status by then.
 *
 * These tests pin both nets.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

let _mockStatus: 'streaming' | 'submitted' | 'ready' | 'error' = 'streaming'
let _mockMessages: unknown[] = []
const _sendMessage = vi.fn()

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages: unknown[] }) => ({
    messages: _mockMessages.length > 0 ? _mockMessages : (opts.messages ?? []),
    sendMessage: _sendMessage,
    status: _mockStatus,
    error: null,
  }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

vi.mock('ai', () => ({
  DefaultChatTransport: class {},
}))

import { StudioChat } from '../studio-chat'
import { toast } from 'sonner'

beforeEach(() => {
  _sendMessage.mockReset()
  ;(toast as any).mockReset?.()
  _mockMessages = []
  _mockStatus = 'streaming'
  vi.useRealTimers()
})

function renderChat() {
  return render(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
}

function queueMessage(text: string) {
  const ta = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: 'Enter' })
}

describe('StudioChat queue-flush silent-error wedge (2026-04-22 fix)', () => {
  it('synchronous throw from sendMessage releases the flush guard + toasts', async () => {
    _mockStatus = 'streaming'
    _sendMessage.mockImplementation(() => {
      throw new Error('transport down (sync)')
    })

    const { rerender } = renderChat()

    // Queue a first message.
    queueMessage('first queued')
    expect(_sendMessage).not.toHaveBeenCalled()

    // Status flips to ready → flush effect fires → sendMessage throws
    // synchronously → catch branch releases the ref + toasts.
    _mockStatus = 'ready'
    await act(async () => {
      rerender(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
    })

    expect(_sendMessage).toHaveBeenCalledTimes(1)
    // Toast surfaces the failure to the operator.
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Send failed/i))

    // Verify the guard released by queuing a second message and watching
    // it flush. Without the fix, the second flush would never fire.
    _mockStatus = 'streaming'
    _sendMessage.mockReset()
    _sendMessage.mockImplementation(() => undefined) // succeeds silently
    await act(async () => {
      rerender(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
    })
    queueMessage('second queued')

    _mockStatus = 'ready'
    await act(async () => {
      rerender(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
    })

    expect(_sendMessage).toHaveBeenCalledTimes(1) // post-reset — second flush ran
  })

  it('rejected promise from sendMessage releases the guard + toasts', async () => {
    _mockStatus = 'streaming'
    _sendMessage.mockImplementation(() => Promise.reject(new Error('rejected')))

    const { rerender } = renderChat()
    queueMessage('first queued')

    _mockStatus = 'ready'
    await act(async () => {
      rerender(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
      // Let the microtask queue drain so the .catch handler runs.
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(_sendMessage).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Send failed/i))
  })

  it('safety timeout (5s) releases the guard if status never transitions', async () => {
    vi.useFakeTimers()
    _mockStatus = 'streaming'
    // sendMessage returns an unresolving promise — no transition.
    _sendMessage.mockImplementation(() => new Promise(() => {}))

    const { rerender } = renderChat()
    queueMessage('first queued')

    _mockStatus = 'ready'
    await act(async () => {
      rerender(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
    })
    expect(_sendMessage).toHaveBeenCalledTimes(1)

    // Even though status stays 'ready' the entire time, the 5s safety
    // timeout will fire and release the ref. Advance timers.
    await act(async () => {
      vi.advanceTimersByTime(5_100)
    })

    // Now queue another message — it should flush on the next ready tick.
    queueMessage('second queued')
    await act(async () => {
      // Trigger the effect re-evaluation; queueMessage already updated state.
      rerender(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)
    })
    expect(_sendMessage).toHaveBeenCalledTimes(2)
  })
})
