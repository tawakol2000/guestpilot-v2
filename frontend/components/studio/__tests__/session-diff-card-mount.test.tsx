/**
 * Sprint 058-A F4 — <SessionDiffCard> renders inline in an assistant
 * message when StudioChat observes a `data-session-diff-summary` SSE
 * part.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

const hoisted = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  status: { current: 'ready' as string },
  messages: { current: [] as unknown[] },
}))

vi.mock('@/lib/api', () => ({
  getToken: () => 'tok',
}))

vi.mock('@/lib/build-api', () => ({
  apiEnhancePrompt: vi.fn(),
  apiAcceptSuggestedFix: vi.fn(),
  apiRejectSuggestedFix: vi.fn(),
  buildTurnEndpoint: () => '/api/build/chat',
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: hoisted.messages.current,
    sendMessage: hoisted.sendMessage,
    status: hoisted.status.current,
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
  hoisted.status.current = 'ready'
  hoisted.sendMessage.mockReset()
  hoisted.messages.current = []
})

describe('StudioChat F4 — SessionDiffCard inline render', () => {
  it('renders <SessionDiffCard> when the assistant turn carries data-session-diff-summary', async () => {
    hoisted.messages.current = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Done — here is what I changed this turn:' },
          {
            type: 'data-session-diff-summary',
            id: 'msg-1:summary',
            data: {
              written: { created: 2, edited: 1, reverted: 0 },
              tested: { runs: 1, totalVariants: 4, passed: 4 },
              plans: { cancelled: 0 },
              note: 'Tuned the late check-in SOP plus its two overrides.',
            },
          },
        ],
      },
    ]

    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )

    const card = await screen.findByTestId('session-diff-card')
    expect(card).toBeInTheDocument()
    expect(screen.getByTestId('session-diff-written').textContent).toContain(
      'Wrote 2',
    )
    expect(screen.getByTestId('session-diff-edited').textContent).toContain(
      'Edited 1',
    )
    expect(screen.getByTestId('session-diff-tested').textContent).toContain(
      'Tested 1 (4/4)',
    )
    expect(screen.getByTestId('session-diff-note').textContent).toContain(
      'Tuned the late check-in SOP',
    )
  })

  it('omits the card when no data-session-diff-summary part is present', async () => {
    hoisted.messages.current = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Nothing to summarise this turn.' },
        ],
      },
    ]

    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    expect(screen.queryByTestId('session-diff-card')).not.toBeInTheDocument()
  })

  it('graceful degradation: partial diff data still renders the card', async () => {
    hoisted.messages.current = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'data-session-diff-summary',
            id: 'msg-1:summary',
            data: { written: { created: 1 } },
          },
        ],
      },
    ]
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    expect(await screen.findByTestId('session-diff-card')).toBeInTheDocument()
    expect(screen.getByTestId('session-diff-written').textContent).toContain(
      'Wrote 1',
    )
  })
})
