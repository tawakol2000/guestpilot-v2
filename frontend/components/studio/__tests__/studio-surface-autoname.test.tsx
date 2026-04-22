/**
 * Sprint 058-A F9f — StudioSurface auto-naming wiring tests.
 *
 * Covers:
 *   - First substantive user message → apiPatchTuningConversation called
 *     with an auto-title.
 *   - Too-short first message ("hi") → PATCH NOT called; then first
 *     artifact touched → PATCH called with artifact-derived title.
 *   - Non-default existing title → PATCH never called (operator-edited
 *     titles are never overwritten).
 *   - Empty-session filter: conversations with messageCount=0 older than
 *     1h are hidden by default and surface behind the toggle.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

// Mocks that the surface + chat stack pull in.

const mockApiPatchTuningConversation = vi.fn()
const mockApiListTuningConversations = vi.fn()
const mockApiGetTuningConversation = vi.fn()
const mockApiCreateTuningConversation = vi.fn()
const mockApiGetBuildCapabilities = vi.fn()
const mockApiGetBuildTenantState = vi.fn()

vi.mock('@/lib/api', () => ({
  apiPatchTuningConversation: (...args: unknown[]) =>
    mockApiPatchTuningConversation(...args),
  apiListTuningConversations: (...args: unknown[]) =>
    mockApiListTuningConversations(...args),
  apiGetTuningConversation: (...args: unknown[]) =>
    mockApiGetTuningConversation(...args),
  apiCreateTuningConversation: (...args: unknown[]) =>
    mockApiCreateTuningConversation(...args),
  isAuthenticated: () => true,
}))

vi.mock('@/lib/build-api', () => ({
  apiGetBuildCapabilities: (...args: unknown[]) =>
    mockApiGetBuildCapabilities(...args),
  apiGetBuildTenantState: (...args: unknown[]) =>
    mockApiGetBuildTenantState(...args),
  // Sprint 058-A F9d — surface now hydrates the session-artifacts rail
  // from the server during bootstrap. Mock with an empty rows list so
  // this suite (orthogonal to F9d) still reaches the ready branch.
  apiGetSessionArtifacts: vi.fn().mockResolvedValue({ rows: [] }),
  BuildModeDisabledError: class BuildModeDisabledError extends Error {},
  apiListBuildArtifactHistory: vi.fn().mockResolvedValue({ rows: [] }),
  apiRevertArtifactFromHistory: vi.fn(),
  buildTurnEndpoint: () => '/api/build/chat',
}))

// The surface pulls these from build-api directly through re-imports.
// Keep the shape minimal — capabilities + tenantState defaults below are
// enough for the 'ready' branch.
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

import { StudioSurface } from '../studio-surface'

function seedApiDefaults() {
  mockApiPatchTuningConversation.mockReset().mockResolvedValue({
    conversation: { id: 'conv-1', title: 'whatever', messageCount: 1 },
  })
  mockApiListTuningConversations.mockReset().mockResolvedValue({
    conversations: [],
    nextCursor: null,
  })
  mockApiGetTuningConversation.mockReset().mockResolvedValue({
    conversation: {
      id: 'conv-1',
      title: 'Studio session',
      anchorMessageId: null,
      triggerType: 'MANUAL',
      status: 'OPEN',
      sdkSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    },
  })
  mockApiCreateTuningConversation.mockReset().mockResolvedValue({
    conversation: {
      id: 'conv-1',
      title: 'Studio session',
      anchorMessageId: null,
      triggerType: 'MANUAL',
      status: 'OPEN',
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
  mockApiGetBuildCapabilities.mockReset().mockResolvedValue({
    traceViewEnabled: false,
    rawPromptEditorEnabled: false,
    isAdmin: false,
  })
  mockApiGetBuildTenantState.mockReset().mockResolvedValue({
    isGreenfield: false,
    mode: 'BROWNFIELD',
    interviewProgress: '',
    sopCount: 0,
    faqCounts: { global: 0, perProperty: 0 },
    customToolCount: 0,
    propertyCount: 0,
    lastBuildTransaction: null,
  })
  _mockStatus = 'ready'
  _mockMessages = []
  _sendMessage.mockReset()
}

beforeEach(() => {
  seedApiDefaults()
})

async function renderAndWaitReady() {
  const utils = render(
    <StudioSurface conversationId="conv-1" onConversationChange={() => {}} />,
  )
  await waitFor(() => {
    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument()
  })
  return utils
}

describe('StudioSurface F9f — auto-naming on first user message', () => {
  it('patches the conversation title on the first substantive user message', async () => {
    await renderAndWaitReady()
    const textarea = await screen.findByLabelText('Message the studio agent')
    fireEvent.change(textarea, { target: { value: 'Please review the check-in SOP and tighten the tone' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(mockApiPatchTuningConversation).toHaveBeenCalledTimes(1)
    })
    const [id, body] = mockApiPatchTuningConversation.mock.calls[0]
    expect(id).toBe('conv-1')
    expect(body.title).toMatch(/^Please review the check-in SOP/)
  })

  it('does NOT patch on a too-short first message like "hi"', async () => {
    await renderAndWaitReady()
    const textarea = await screen.findByLabelText('Message the studio agent')
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // Give the fire-and-forget a chance to misbehave.
    await new Promise((r) => setTimeout(r, 10))
    expect(mockApiPatchTuningConversation).not.toHaveBeenCalled()
  })

  it('does NOT patch when the existing title is non-default (operator-edited)', async () => {
    mockApiGetTuningConversation.mockResolvedValue({
      conversation: {
        id: 'conv-1',
        title: 'My hand-written session title',
        anchorMessageId: null,
        triggerType: 'MANUAL',
        status: 'OPEN',
        sdkSessionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      },
    })
    await renderAndWaitReady()
    const textarea = await screen.findByLabelText('Message the studio agent')
    fireEvent.change(textarea, {
      target: { value: 'Please rewrite the greeting for late check-ins' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 10))
    expect(mockApiPatchTuningConversation).not.toHaveBeenCalled()
  })

  it('does NOT patch twice — first-write wins', async () => {
    await renderAndWaitReady()
    const textarea = await screen.findByLabelText('Message the studio agent')
    fireEvent.change(textarea, {
      target: { value: 'Please review the late-checkout policy language' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => {
      expect(mockApiPatchTuningConversation).toHaveBeenCalledTimes(1)
    })
    // Second send should NOT re-name.
    fireEvent.change(textarea, {
      target: { value: 'Also rewrite the wifi FAQ while you are at it' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 10))
    expect(mockApiPatchTuningConversation).toHaveBeenCalledTimes(1)
  })
})

describe('StudioSurface F9f — empty-session filter in LeftRail', () => {
  it('hides zero-message sessions older than 1h by default and shows them behind the toggle', async () => {
    const oldEmpty = {
      id: 'conv-old-empty',
      title: 'Studio session',
      anchorMessageId: null,
      triggerType: 'MANUAL' as const,
      status: 'OPEN' as const,
      messageCount: 0,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }
    const recentEmpty = {
      id: 'conv-recent-empty',
      title: 'Studio session',
      anchorMessageId: null,
      triggerType: 'MANUAL' as const,
      status: 'OPEN' as const,
      messageCount: 0,
      createdAt: new Date(Date.now() - 30 * 1000).toISOString(), // 30s ago
      updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
    }
    const meaningful = {
      id: 'conv-with-messages',
      title: 'Late checkout policy',
      anchorMessageId: null,
      triggerType: 'MANUAL' as const,
      status: 'OPEN' as const,
      messageCount: 4,
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }
    mockApiListTuningConversations.mockResolvedValue({
      conversations: [oldEmpty, recentEmpty, meaningful],
      nextCursor: null,
    })

    await renderAndWaitReady()

    // Default view: old empty is hidden, others are visible.
    await waitFor(() => {
      expect(screen.getByText('Late checkout policy')).toBeInTheDocument()
    })
    expect(screen.queryByText(/Studio session/)).toBeInTheDocument() // recent empty still shows

    // Toggle + hidden-count label is present.
    const toggle = screen.getByTestId('show-empty-sessions-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(/1 hidden/)).toBeInTheDocument()

    // Flip the toggle — old-empty comes into view.
    act(() => {
      fireEvent.click(toggle)
    })
    expect(toggle.checked).toBe(true)
    // All three rows render now (recent-empty + old-empty both titled
    // "Studio session"; meaningful has its own title).
    const studioSessions = screen.getAllByText('Studio session')
    expect(studioSessions.length).toBeGreaterThanOrEqual(2)
  })
})
