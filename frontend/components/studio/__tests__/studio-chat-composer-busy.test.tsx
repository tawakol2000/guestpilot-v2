/**
 * Sprint 058-A F9e — composer-while-busy regression tests.
 *
 * 057-A F3b shipped the queue-while-busy behaviour: typing stays
 * unblocked during streaming, Send appends to a local queue, queue
 * flushes one message at a time when the agent returns to ready.
 *
 * The 057 screenshot regression showed "Agent is replying…" as a
 * DISABLED placeholder — contradicting F3b. These tests lock in:
 *
 *   1. The textarea is never disabled regardless of stream status.
 *   2. Typing updates the draft during streaming.
 *   3. The placeholder tells the operator the queue affordance
 *      exists ("Type to queue — will send when the agent finishes").
 *   4. Sending while busy enqueues instead of firing sendMessage.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

let _mockStatus = 'streaming'
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

beforeEach(() => {
  _sendMessage.mockReset()
  _mockMessages = []
  _mockStatus = 'streaming'
})

describe('StudioChat composer while agent is busy (058-A F9e)', () => {
  it('textarea is not disabled during streaming', () => {
    _mockStatus = 'streaming'
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    const textarea = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })

  it('textarea is not disabled while submitted', () => {
    _mockStatus = 'submitted'
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    const textarea = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })

  it('textarea placeholder tells the operator typing queues the message', () => {
    _mockStatus = 'streaming'
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    const textarea = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
    expect(textarea.placeholder).toMatch(/Type to queue/)
    expect(textarea.placeholder).toMatch(/will send when the agent finishes/)
  })

  it('typing while streaming updates the draft', () => {
    _mockStatus = 'streaming'
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    const textarea = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'queued note' } })
    expect(textarea.value).toBe('queued note')
  })

  it('pressing Enter while busy enqueues and shows the Queued badge', () => {
    _mockStatus = 'streaming'
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    const textarea = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'follow-up' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // sendMessage does NOT fire while busy — the message is queued.
    expect(_sendMessage).not.toHaveBeenCalled()
    // The Queued (N) badge appears.
    const badge = screen.getByTestId('queue-badge')
    expect(badge.textContent ?? '').toMatch(/Queued \(1\)/)
    // Placeholder flips to the count-aware variant.
    expect(textarea.placeholder).toMatch(/1\/3 queued/)
  })
})
