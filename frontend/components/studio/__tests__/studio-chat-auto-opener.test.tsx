/**
 * Auto-opener for anchored Studio conversations.
 *
 * When the inbox "Discuss in Tuning" button creates a TuningConversation
 * with anchorMessageId set and navigates to Studio, the chat surface is
 * expected to fire a single opener `sendMessage` so the operator doesn't
 * land on a blank pane. This test asserts:
 *   1. Opener fires when anchorMessage is provided + transcript is empty.
 *   2. Opener does NOT fire when anchorMessage is null ("New session").
 *   3. Opener does NOT fire when initialMessages already has content
 *      (rehydrating a conversation that's mid-thread).
 *   4. `openerRef` flips `isOpener: true` into the transport payload for
 *      the opener send, and only that send.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

let _mockStatus = 'ready'
let _mockMessages: unknown[] = []
const _sendMessage = vi.fn()
let _capturedBodyFactory: (() => Record<string, unknown>) | null = null

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
  DefaultChatTransport: class {
    constructor(opts: { body: () => Record<string, unknown> }) {
      _capturedBodyFactory = opts.body
    }
  },
}))

import { StudioChat } from '../studio-chat'

beforeEach(() => {
  _mockStatus = 'ready'
  _mockMessages = []
  _sendMessage.mockReset()
  _capturedBodyFactory = null
})

describe('StudioChat auto-opener (anchor-driven)', () => {
  it('fires one opener sendMessage on fresh anchored sessions and marks the payload isOpener: true', () => {
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
        anchorMessage={{ id: 'msg-guest-42', content: 'please send passport' }}
      />,
    )

    expect(_sendMessage).toHaveBeenCalledTimes(1)
    const call = _sendMessage.mock.calls[0][0]
    expect(call.text).toContain('msg-guest-42')
    expect(call.text).toMatch(/get_context/)

    // The transport body factory should mark the NEXT request as an
    // opener — and only the next request. Reading once flips the ref.
    expect(_capturedBodyFactory).not.toBeNull()
    const first = _capturedBodyFactory!()
    expect(first).toEqual({ conversationId: 'c1', isOpener: true })
    const second = _capturedBodyFactory!()
    expect(second).toEqual({ conversationId: 'c1' })
  })

  it('does not fire when anchorMessage is null (operator-initiated New session)', () => {
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
        anchorMessage={null}
      />,
    )

    expect(_sendMessage).not.toHaveBeenCalled()
    expect(_capturedBodyFactory).not.toBeNull()
    expect(_capturedBodyFactory!()).toEqual({ conversationId: 'c1' })
  })

  it('does not fire when the transcript already has messages (rehydrated mid-thread)', () => {
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[
          {
            id: 'u0',
            role: 'user',
            parts: [{ type: 'text', text: 'earlier turn' }],
          } as never,
        ]}
        anchorMessage={{ id: 'msg-guest-42' }}
      />,
    )

    expect(_sendMessage).not.toHaveBeenCalled()
    expect(_capturedBodyFactory!()).toEqual({ conversationId: 'c1' })
  })

  it('does not fire twice even if the component re-renders before the agent replies', () => {
    const { rerender } = render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
        anchorMessage={{ id: 'msg-guest-42' }}
      />,
    )

    // Re-render with the same props — guarded by proactiveRequestedRef.
    act(() => {
      rerender(
        <StudioChat
          conversationId="c1"
          greenfield={false}
          initialMessages={[]}
          anchorMessage={{ id: 'msg-guest-42' }}
        />,
      )
    })

    expect(_sendMessage).toHaveBeenCalledTimes(1)
  })
})
