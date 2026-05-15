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
    // 2026-05-16: body now also carries `provider` (anthropic/openai) so
    // use toMatchObject to assert just the conversation + isOpener
    // contract — additional payload fields don't fail the test.
    const first = _capturedBodyFactory!()
    expect(first).toMatchObject({ conversationId: 'c1', isOpener: true })
    const second = _capturedBodyFactory!()
    expect(second).toMatchObject({ conversationId: 'c1' })
    expect(second.isOpener).toBeUndefined()
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
    const payload = _capturedBodyFactory!()
    expect(payload).toMatchObject({ conversationId: 'c1' })
    expect(payload.isOpener).toBeUndefined()
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
    const payload = _capturedBodyFactory!()
    expect(payload).toMatchObject({ conversationId: 'c1' })
    expect(payload.isOpener).toBeUndefined()
  })

  it('after the opener fires, a subsequent user send has isOpener=false in the body', () => {
    // 2026-05-16 regression: a user-initiated send after the auto-opener
    // had `isOpener: true` leak across conversations because openerRef
    // wasn't reset until body() was called once. Verify here: read the
    // body factory twice — the first call (the opener send) carries
    // isOpener: true; the second call (operator's typed reply) does not.
    render(
      <StudioChat
        conversationId="c-after"
        greenfield={false}
        initialMessages={[]}
        anchorMessage={{ id: 'msg-anchor-x' }}
      />,
    )
    expect(_capturedBodyFactory).toBeTruthy()
    const first = _capturedBodyFactory!()
    expect(first.isOpener).toBe(true)
    // Subsequent send (operator typed something) should not be tagged.
    const second = _capturedBodyFactory!()
    expect(second.isOpener).toBeUndefined()
    // And a third send confirms the flag stays off.
    const third = _capturedBodyFactory!()
    expect(third.isOpener).toBeUndefined()
  })

  it('on a non-anchored conversation, no send is ever tagged as opener', () => {
    // 2026-05-16 regression: when the operator clicks "+ New chat" we
    // create a TuningConversation with anchorMessageId=null. The
    // opener-effect must NOT mark any subsequent body() call as
    // isOpener=true. Without the per-conversation remount (key=), refs
    // could leak from a previously-anchored conversation.
    render(
      <StudioChat
        conversationId="c-new"
        greenfield={false}
        initialMessages={[]}
        anchorMessage={null}
      />,
    )
    expect(_capturedBodyFactory).toBeTruthy()
    const payload1 = _capturedBodyFactory!()
    expect(payload1.isOpener).toBeUndefined()
    const payload2 = _capturedBodyFactory!()
    expect(payload2.isOpener).toBeUndefined()
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
