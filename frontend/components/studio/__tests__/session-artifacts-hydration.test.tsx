/**
 * Sprint 058-A F9d — StudioSurface seeds the session-artifacts rail from
 * GET /api/build/sessions/:id/artifacts on page reload.
 *
 * Covers:
 *   - the rail renders the hydrated rows (not the empty state) when the
 *     server returns artifacts
 *   - empty server response leaves the rail on the empty-state copy
 *   - a rejected fetch does NOT crash Studio; rail renders empty-state
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

const mockApiListTuningConversations = vi.fn()
const mockApiGetTuningConversation = vi.fn()
const mockApiCreateTuningConversation = vi.fn()
const mockApiGetBuildCapabilities = vi.fn()
const mockApiGetBuildTenantState = vi.fn()
const mockApiGetSessionArtifacts = vi.fn()

vi.mock('@/lib/api', () => ({
  apiPatchTuningConversation: vi.fn().mockResolvedValue({}),
  apiListTuningConversations: (...args: unknown[]) =>
    mockApiListTuningConversations(...args),
  apiGetTuningConversation: (...args: unknown[]) =>
    mockApiGetTuningConversation(...args),
  apiCreateTuningConversation: (...args: unknown[]) =>
    mockApiCreateTuningConversation(...args),
  isAuthenticated: () => true,
  getToken: () => 'tok',
}))

vi.mock('@/lib/build-api', () => ({
  apiGetBuildCapabilities: (...args: unknown[]) =>
    mockApiGetBuildCapabilities(...args),
  apiGetBuildTenantState: (...args: unknown[]) =>
    mockApiGetBuildTenantState(...args),
  apiGetSessionArtifacts: (...args: unknown[]) =>
    mockApiGetSessionArtifacts(...args),
  BuildModeDisabledError: class BuildModeDisabledError extends Error {},
  apiListBuildArtifactHistory: vi.fn().mockResolvedValue({ rows: [] }),
  apiRevertArtifactFromHistory: vi.fn(),
  buildTurnEndpoint: () => '/api/build/chat',
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages: unknown[] }) => ({
    messages: opts.messages ?? [],
    sendMessage: vi.fn(),
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

import { StudioSurface } from '../studio-surface'

function seedDefaults() {
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
  mockApiGetSessionArtifacts.mockReset().mockResolvedValue({ rows: [] })
}

beforeEach(() => {
  seedDefaults()
})

describe('StudioSurface F9d — session-artifacts hydration', () => {
  it('renders hydrated artifacts in the rail on first bootstrap', async () => {
    mockApiGetSessionArtifacts.mockResolvedValue({
      rows: [
        {
          historyId: 'h-1',
          artifactType: 'sop',
          artifactId: 'early-checkin',
          operation: 'CREATE',
          actorEmail: 'a@b.com',
          conversationId: 'conv-1',
          touchedAt: new Date().toISOString(),
        },
        {
          historyId: 'h-2',
          artifactType: 'faq',
          artifactId: 'wifi-password',
          operation: 'UPDATE',
          actorEmail: 'a@b.com',
          conversationId: 'conv-1',
          touchedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    })

    render(
      <StudioSurface conversationId="conv-1" onConversationChange={() => {}} />,
    )

    // Wait for the surface to settle into ready + hydration to finish.
    await waitFor(() =>
      expect(mockApiGetSessionArtifacts).toHaveBeenCalledWith('conv-1'),
    )
    await waitFor(() => {
      // Row 1 — SOP with artifactId suffix.
      expect(screen.getByText(/SOP · early-checkin/)).toBeInTheDocument()
      // Row 2 — FAQ.
      expect(screen.getByText(/FAQ · wifi-password/)).toBeInTheDocument()
    })
    // The empty-state line must NOT be present.
    expect(
      screen.queryByText(/No context consulted in this session yet/),
    ).not.toBeInTheDocument()
  })

  it('keeps the rail on the empty state when the server returns zero rows', async () => {
    mockApiGetSessionArtifacts.mockResolvedValue({ rows: [] })
    render(
      <StudioSurface conversationId="conv-1" onConversationChange={() => {}} />,
    )
    await waitFor(() =>
      expect(mockApiGetSessionArtifacts).toHaveBeenCalled(),
    )
    await waitFor(() => {
      expect(
        screen.getByText(/No context consulted in this session yet/),
      ).toBeInTheDocument()
    })
  })

  it('falls back to the empty state when the hydration fetch rejects', async () => {
    mockApiGetSessionArtifacts.mockRejectedValue(new Error('500 upstream'))
    render(
      <StudioSurface conversationId="conv-1" onConversationChange={() => {}} />,
    )
    await waitFor(() =>
      expect(mockApiGetSessionArtifacts).toHaveBeenCalled(),
    )
    // The whole surface must still render — no crash, rail stays empty.
    await waitFor(() => {
      expect(
        screen.getByText(/No context consulted in this session yet/),
      ).toBeInTheDocument()
    })
  })

  it('folds unknown server artifact types into nothing rather than crashing', async () => {
    mockApiGetSessionArtifacts.mockResolvedValue({
      rows: [
        {
          historyId: 'h-1',
          artifactType: 'bogus' as any,
          artifactId: 'x',
          operation: 'CREATE',
          actorEmail: null,
          conversationId: null,
          touchedAt: new Date().toISOString(),
        },
        {
          historyId: 'h-2',
          artifactType: 'tool_definition',
          artifactId: 'slack',
          operation: 'UPDATE',
          actorEmail: null,
          conversationId: null,
          touchedAt: new Date().toISOString(),
        },
      ],
    })
    render(
      <StudioSurface conversationId="conv-1" onConversationChange={() => {}} />,
    )
    await waitFor(() => {
      expect(screen.getByText(/Tool · slack/)).toBeInTheDocument()
    })
    // Bogus row does not leak into the DOM.
    expect(screen.queryByText(/bogus/)).not.toBeInTheDocument()
  })
})
