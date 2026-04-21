/**
 * Sprint 051 A B4 — artifact-quote click-through.
 *
 * Renders the `data-artifact-quote` renderer inside StudioChat (via a
 * dedicated test harness that stubs the AI SDK's useChat) and asserts:
 *   - the source chip becomes a clickable button when onOpenArtifact is
 *     wired
 *   - clicking it fires onOpenArtifact with the correct drawer type
 *   - 'tool_definition' from the part payload maps to 'tool' for the
 *     drawer
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// jsdom does not implement Element.scrollTo; StudioChat auto-scrolls
// on mount. Stub before any render.
beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

// Stub @ai-sdk/react's useChat so we can feed in synthetic parts.
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-artifact-quote',
            data: {
              artifact: 'tool_definition',
              artifactId: 'tool-slack',
              sourceLabel: 'Tool · slack-notify',
              body: 'Posts to Slack.',
            },
          },
        ],
      },
    ],
    sendMessage: () => {},
    status: 'ready',
    error: null,
  }),
}))

vi.mock('@/lib/api', () => ({ getToken: () => null }))

import { StudioChat } from '../studio-chat'

describe('data-artifact-quote click-through', () => {
  it('renders the source chip as a clickable button when onOpenArtifact is wired', () => {
    const onOpen = vi.fn()
    render(
      <StudioChat
        conversationId="conv1"
        greenfield={false}
        initialMessages={[]}
        onOpenArtifact={onOpen}
      />,
    )
    const btn = screen.getByRole('button', { name: /Open Tool · slack-notify/ })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledWith('tool', 'tool-slack', null)
  })

  it('renders a non-interactive span when onOpenArtifact is not wired', () => {
    render(
      <StudioChat
        conversationId="conv1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    // The label text still shows, but there is no button role for it.
    expect(screen.getByText('Tool · slack-notify')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Open Tool · slack-notify/ }),
    ).not.toBeInTheDocument()
  })
})
