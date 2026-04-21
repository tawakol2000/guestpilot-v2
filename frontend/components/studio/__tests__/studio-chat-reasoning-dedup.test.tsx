/**
 * Sprint 058-A F9b — reasoning-line dedup / merge regression tests.
 *
 * The 057-A F1 tool-chain-summary + the SDK's chunked-reasoning emission
 * caused two adjacent `type: 'reasoning'` parts to render as two
 * separate <ReasoningLine/> buttons whose inline labels ran together:
 *   "Agent reasoning · viewAgent reasoning · view"
 *
 * The fix merges consecutive reasoning parts in the classifier loop
 * (one <ReasoningLine/> per streak, not per chunk) and adds a
 * defensive `gap-1` flex column around whatever ReasoningLines remain.
 *
 * These tests lock both behaviours.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

let _mockMessages: unknown[] = []
const _sendMessage = vi.fn()

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages: unknown[] }) => ({
    messages: _mockMessages.length > 0 ? _mockMessages : (opts.messages ?? []),
    sendMessage: _sendMessage,
    status: 'ready',
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

function makeAgentMsg(id: string, parts: Array<Record<string, any>>) {
  return { id, role: 'assistant' as const, parts }
}

describe('StudioChat reasoning-line dedup (058-A F9b)', () => {
  it('renders one <ReasoningLine> per reasoning streak, merging consecutive chunks', () => {
    _mockMessages = [
      makeAgentMsg('a1', [
        { type: 'reasoning', text: 'first part ' },
        { type: 'reasoning', text: 'second part ' },
        { type: 'reasoning', text: 'third part' },
        { type: 'text', text: 'ok.' },
        { type: 'reasoning', text: 'late follow-up' },
      ]),
    ]
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )

    // Two reasoning streaks → two buttons labelled "Agent reasoning".
    // The merge collapses the first three chunks into one button; the
    // isolated reasoning after text becomes the second.
    const reasoningButtons = screen.getAllByText(/Agent reasoning/)
    expect(reasoningButtons).toHaveLength(2)
  })

  it('wraps the reasoning list in a flex column so labels do not concatenate', () => {
    _mockMessages = [
      makeAgentMsg('a1', [
        { type: 'reasoning', text: 'a' },
        { type: 'text', text: 'stop' },
        { type: 'reasoning', text: 'b' },
      ]),
    ]
    const { container } = render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    // Two streaks here because the text-part breaks the streak. Find
    // the div that contains both <ReasoningLine> buttons and assert it
    // has flex-col + gap-1 in its className.
    const reasoningButtons = screen.getAllByText(/Agent reasoning/)
    expect(reasoningButtons).toHaveLength(2)

    // Walk up to find the shared parent container and verify it uses
    // a flex gap layout (either of the two shared-parent candidates
    // works — this guards against future refactors).
    const shared = reasoningButtons[0].closest('[class*="gap-"]')
    expect(shared).not.toBeNull()
    expect(shared?.className).toMatch(/flex/)
    expect(shared?.className).toMatch(/gap-/)
  })

  it('handles a single reasoning part without duplicating it', () => {
    _mockMessages = [
      makeAgentMsg('a1', [{ type: 'reasoning', text: 'only one' }]),
    ]
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    const reasoningButtons = screen.getAllByText(/Agent reasoning/)
    expect(reasoningButtons).toHaveLength(1)
  })
})

describe('StudioChat SDK-internal lifecycle markers (058-A F9c)', () => {
  it('silently drops step-start without rendering the unsupported-card placeholder', () => {
    _mockMessages = [
      makeAgentMsg('a1', [
        { type: 'text', text: 'hello' },
        { type: 'step-start' },
        { type: 'text', text: 'world' },
      ]),
    ]
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    expect(screen.queryByText(/unsupported card/)).not.toBeInTheDocument()
    expect(screen.queryByText(/step-start/)).not.toBeInTheDocument()
    // And the real content still renders.
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('world')).toBeInTheDocument()
  })

  it('silently drops every known SDK lifecycle marker', () => {
    _mockMessages = [
      makeAgentMsg('a1', [
        { type: 'step-start' },
        { type: 'step-finish' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'start' },
        { type: 'finish' },
        { type: 'step-anything-with-prefix' },
        { type: 'text', text: 'real content' },
      ]),
    ]
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    expect(screen.queryByText(/unsupported card/)).not.toBeInTheDocument()
    expect(screen.getByText('real content')).toBeInTheDocument()
  })

  it('still renders the muted placeholder for genuinely unknown types', () => {
    _mockMessages = [
      makeAgentMsg('a1', [
        { type: 'data-totally-unknown-part-type-12345' },
      ]),
    ]
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    // Unknown non-lifecycle type still falls into the fallback.
    expect(
      screen.getByText(/unsupported card: data-totally-unknown-part-type-12345/),
    ).toBeInTheDocument()
  })
})
