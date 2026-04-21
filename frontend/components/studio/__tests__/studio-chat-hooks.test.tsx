/**
 * Sprint 058-A F9a — Hook-count stability guard rail.
 *
 * React minified error #310 fires when the number of hooks called in a
 * component changes between renders. This test drives <StudioChat/>
 * through a representative sequence of prop/state changes (empty →
 * streaming with reasoning parts → streaming with tool parts → ready)
 * and asserts:
 *
 *   1. No "Rendered more hooks than during the previous render" error
 *      is logged to the console during the sequence.
 *   2. No error boundary trips — the surface stays alive end-to-end.
 *
 * If future refactors accidentally introduce a conditional hook (hook
 * inside an `if` branch, hook call ordered differently on subsequent
 * renders), this test fails before the minified #310 ever reaches
 * production.
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

function makeUserMsg(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    parts: [{ type: 'text', text }],
  }
}

function makeAgentMsg(id: string, parts: Array<Record<string, any>>) {
  return {
    id,
    role: 'assistant' as const,
    parts,
  }
}

describe('StudioChat hook-count stability (058-A F9a guard rail)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _mockStatus = 'ready'
    _mockMessages = []
    _sendMessage.mockReset()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('does not log a hook-count error across a reasoning → tool → text sequence', () => {
    // Start: empty conversation, ready.
    const { rerender } = render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )

    // Turn 1 fires: user message appears, status becomes submitted.
    _mockStatus = 'submitted'
    _mockMessages = [makeUserMsg('u1', 'hello')]
    act(() => {
      rerender(
        <StudioChat
          conversationId="c1"
          greenfield={false}
          initialMessages={[]}
        />,
      )
    })

    // Agent starts streaming with a reasoning part.
    _mockStatus = 'streaming'
    _mockMessages = [
      makeUserMsg('u1', 'hello'),
      makeAgentMsg('a1', [{ type: 'reasoning', text: 'thinking…' }]),
    ]
    act(() => {
      rerender(
        <StudioChat
          conversationId="c1"
          greenfield={false}
          initialMessages={[]}
        />,
      )
    })

    // A tool call is emitted mid-stream — common boundary where #310
    // hook mismatches surface (057 F1 ToolChainSummary mount).
    _mockMessages = [
      makeUserMsg('u1', 'hello'),
      makeAgentMsg('a1', [
        { type: 'reasoning', text: 'thinking…' },
        { type: 'tool-get_sop', state: 'input-available', toolCallId: 'x' },
      ]),
    ]
    act(() => {
      rerender(
        <StudioChat
          conversationId="c1"
          greenfield={false}
          initialMessages={[]}
        />,
      )
    })

    // Another reasoning streak after the tool completes.
    _mockMessages = [
      makeUserMsg('u1', 'hello'),
      makeAgentMsg('a1', [
        { type: 'reasoning', text: 'thinking…' },
        { type: 'tool-get_sop', state: 'output-available', toolCallId: 'x' },
        { type: 'reasoning', text: 'more thinking…' },
        { type: 'text', text: 'Here is the answer.' },
      ]),
    ]
    act(() => {
      rerender(
        <StudioChat
          conversationId="c1"
          greenfield={false}
          initialMessages={[]}
        />,
      )
    })

    // Agent returns to ready.
    _mockStatus = 'ready'
    act(() => {
      rerender(
        <StudioChat
          conversationId="c1"
          greenfield={false}
          initialMessages={[]}
        />,
      )
    })

    // No hook-order / #310 error should have been logged.
    const allErrors = consoleErrorSpy.mock.calls.flat().join(' ')
    expect(allErrors).not.toMatch(/Rendered more hooks/i)
    expect(allErrors).not.toMatch(/Rendered fewer hooks/i)
    expect(allErrors).not.toMatch(/Minified React error #310/i)
  })

  it('handles rapid part additions (reasoning chunks) without a hook mismatch', () => {
    // Drive a sequence that specifically mirrors the SDK chunk boundary
    // issue: multiple consecutive reasoning parts appearing one at a time.
    _mockStatus = 'streaming'
    const agentParts: Array<Record<string, any>> = []
    _mockMessages = [
      makeUserMsg('u1', 'explain'),
      makeAgentMsg('a1', agentParts),
    ]
    const { rerender } = render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )

    for (let i = 0; i < 5; i++) {
      agentParts.push({ type: 'reasoning', text: `chunk ${i}` })
      _mockMessages = [
        makeUserMsg('u1', 'explain'),
        makeAgentMsg('a1', [...agentParts]),
      ]
      act(() => {
        rerender(
          <StudioChat
            conversationId="c1"
            greenfield={false}
            initialMessages={[]}
          />,
        )
      })
    }

    const allErrors = consoleErrorSpy.mock.calls.flat().join(' ')
    expect(allErrors).not.toMatch(/Rendered more hooks/i)
    expect(allErrors).not.toMatch(/Rendered fewer hooks/i)
  })
})
