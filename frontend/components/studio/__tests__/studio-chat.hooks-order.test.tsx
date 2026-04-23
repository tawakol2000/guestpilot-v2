/**
 * Sprint 059-A F9a — React #310 repro for StudioChat hooks order.
 *
 * React invariant #310 ("Rendered more hooks than during the previous
 * render" / "Invalid hook call") fires when the order or COUNT of hook
 * calls changes between renders. The 057 screenshot showed this crash
 * at the moment the agent started streaming — pointing at a conditional
 * hook somewhere in the render path gated on the stream status.
 *
 * This test's job is to REPRO that crash by exercising the exact
 * lifecycle: mount with `status='ready'`, then rerender mid-stream with
 * `status='streaming'` AND a fresh assistant message arriving. If any
 * component on the chat-tree calls a hook conditionally on `status` or
 * on a prop that flips during streaming, React will throw.
 *
 * Expected outcome on the pre-fix tip:
 *   - If a hook is conditional: `console.error` fires with "Rendered more
 *     hooks than during the previous render" (React's wording for #310).
 *   - If no hook is conditional: test passes cleanly — F9a is
 *     "could-not-repro" and we document the defer.
 *
 * The StudioChat component's own six useEffects (lines 237, 305, 349,
 * 371, 385, 433) are all at top-level and unconditional — audited in
 * §F9a step 1. The crash (if reproducible) would live in a nested
 * component (SessionDiffCard portal, TenantStateBanner, a bubble
 * renderer, or ToolCallDrawer's mount-time effect). This test exercises
 * the StudioChat top-level mount path and checks the console-error
 * surface that #310 uses.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

// Mutable mocks so the test can flip status mid-render.
let _mockStatus: 'ready' | 'streaming' | 'submitted' | 'error' = 'ready'
let _mockMessages: unknown[] = []
const _sendMessage = vi.fn()

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages?: unknown[] }) => ({
    messages: _mockMessages.length > 0 ? _mockMessages : (opts?.messages ?? []),
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

function makeAssistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  }
}

describe('StudioChat React #310 hooks-order repro (059-A F9a)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _sendMessage.mockReset()
    _mockMessages = []
    _mockStatus = 'ready'
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('does NOT trigger React #310 when status flips ready→streaming mid-message-arrival', () => {
    // Mount in `ready` with no messages (cold start).
    const { rerender } = render(
      <StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />,
    )

    // A new assistant message arrives AND the status flips to streaming —
    // the exact lifecycle where #310 reportedly fires in the screenshot.
    _mockStatus = 'streaming'
    _mockMessages = [makeAssistantMessage('m1', 'partial stream text')]
    rerender(
      <StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />,
    )

    // Append MORE text to the same message (simulates subsequent deltas).
    _mockMessages = [makeAssistantMessage('m1', 'partial stream text — more')]
    rerender(
      <StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />,
    )

    // Stream completes — status goes back to ready.
    _mockStatus = 'ready'
    _mockMessages = [makeAssistantMessage('m1', 'partial stream text — more — done')]
    rerender(
      <StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />,
    )

    // The test's gate: no React hooks-order error surfaced on the console.
    // React's error messages for #310 include one of these phrases; we
    // match conservatively so a benign unrelated error (e.g. a Next.js
    // router warning) does not false-positive the gate.
    const hooksErrors = consoleErrorSpy.mock.calls
      .map((args: unknown[]) =>
        args.map((a: unknown) => (typeof a === 'string' ? a : '')).join(' '),
      )
      .filter((s: string) =>
        /Rendered more hooks than during the previous render|Invalid hook call|minified React error #310|Rendered fewer hooks than expected/i.test(
          s,
        ),
      )
    expect(hooksErrors).toEqual([])
  })

  it('does NOT trigger React #310 when toggling streaming flag without message changes', () => {
    render(<StudioChat conversationId="c1" greenfield={false} initialMessages={[]} />)

    // Flip through the full status cycle: ready → submitted → streaming → ready.
    const cycle: Array<typeof _mockStatus> = ['submitted', 'streaming', 'ready']
    for (const s of cycle) {
      _mockStatus = s
      // Re-render by poking the textarea (any DOM event triggers a re-render
      // path through the component tree).
      const textarea = screen.getByLabelText('Message the studio agent') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: `s=${s}` } })
    }

    const hooksErrors = consoleErrorSpy.mock.calls
      .map((args: unknown[]) =>
        args.map((a: unknown) => (typeof a === 'string' ? a : '')).join(' '),
      )
      .filter((s: string) =>
        /Rendered more hooks than during the previous render|Invalid hook call|minified React error #310|Rendered fewer hooks than expected/i.test(
          s,
        ),
      )
    expect(hooksErrors).toEqual([])
  })
})
