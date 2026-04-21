/**
 * Sprint 051 A B1 — artifact drawer component tests.
 *
 * Covers: render once per artifact type (5 views), loading + missing
 * states, Esc closes, sanitisation on tool webhook config (operator
 * tier redacts; admin toggle reveals), and the View-changes toggle
 * appearing only when `prevBody` is available and differs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ArtifactDrawer } from '../artifact-drawer'
import type {
  BuildArtifactDetail,
  BuildArtifactType,
} from '@/lib/build-api'

vi.mock('@/lib/build-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/build-api')>('@/lib/build-api')
  return {
    ...actual,
    apiGetBuildArtifact: vi.fn(),
  }
})

import { apiGetBuildArtifact, BuildArtifactNotFoundError } from '@/lib/build-api'

const mockFetch = apiGetBuildArtifact as unknown as ReturnType<typeof vi.fn>

function makeDetail(
  overrides: Partial<BuildArtifactDetail> & { type: BuildArtifactType },
): BuildArtifactDetail {
  return {
    id: 'x',
    title: 't',
    body: 'b',
    meta: {},
    ...overrides,
  } as BuildArtifactDetail
}

describe('ArtifactDrawer', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <ArtifactDrawer
        open={false}
        target={null}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('renders a SOP view with the category + status + body', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'sop',
        id: 'v1',
        title: 'early-checkin · CONFIRMED',
        body: 'Arrival window 14:00–22:00.',
        meta: {
          category: 'early-checkin',
          status: 'CONFIRMED',
          enabled: true,
          updatedAt: new Date().toISOString(),
        },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(await screen.findByText(/Arrival window/)).toBeInTheDocument()
    expect(screen.getByText('early-checkin')).toBeInTheDocument()
    expect(screen.getAllByText('CONFIRMED').length).toBeGreaterThan(0)
  })

  it('renders a FAQ view with question + answer', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'faq',
        id: 'f1',
        title: 'WiFi password?',
        body: 'Network: Guest, password: hostaway123',
        meta: {
          question: 'What is the WiFi password?',
          category: 'amenity',
          scope: 'GLOBAL',
          status: 'ACTIVE',
          source: 'MANUAL',
          usageCount: 3,
          propertyName: null,
          updatedAt: new Date().toISOString(),
        },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'faq', artifactId: 'f1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(
      await screen.findByText('What is the WiFi password?'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Network: Guest/)).toBeInTheDocument()
    // Usage count rendered
    expect(screen.getByText(/3 hits/)).toBeInTheDocument()
  })

  it('gates system_prompt body behind admin + rawPromptEditor flag', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'system_prompt',
        id: 'coordinator',
        title: 'System prompt · coordinator',
        body: 'You are Omar…',
        meta: {
          variant: 'coordinator',
          version: 12,
          updatedAt: new Date().toISOString(),
        },
      }),
    )
    const { rerender } = render(
      <ArtifactDrawer
        open
        target={{ artifact: 'system_prompt', artifactId: 'coordinator' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    // Operator tier: notice, no body.
    expect(
      await screen.findByText(/Full system-prompt body is admin-only/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/You are Omar/)).not.toBeInTheDocument()
    // Flip to admin with the right flag.
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'system_prompt',
        id: 'coordinator',
        title: 'System prompt · coordinator',
        body: 'You are Omar…',
        meta: { variant: 'coordinator', version: 12 },
      }),
    )
    rerender(
      <ArtifactDrawer
        open
        target={{ artifact: 'system_prompt', artifactId: 'coordinator' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled
      />,
    )
    await waitFor(() =>
      expect(screen.getByText(/You are Omar/)).toBeInTheDocument(),
    )
  })

  it('sanitises webhook config on the tool view at operator tier (regression)', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'tool',
        id: 'tool-1',
        title: 'slack-notify',
        body: 'Posts to Slack.',
        meta: {
          name: 'slack-notify',
          displayName: 'slack-notify',
          agentScope: 'coordinator',
          toolType: 'custom',
          enabled: true,
          parameters: { apiKey: 'sk-live-should-not-render' },
          updatedAt: new Date().toISOString(),
        },
        webhookConfig: {
          webhookUrl: 'https://example.com/hook',
          apiKey: 'sk-live-deadbeefcafe',
        },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'tool', artifactId: 'tool-1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    // The JSON block contains the redacted marker rather than the raw key.
    await waitFor(() =>
      expect(screen.getAllByText(/\[redacted\]/).length).toBeGreaterThan(0),
    )
    expect(
      screen.queryByText(/sk-live-should-not-render/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/sk-live-deadbeefcafe/),
    ).not.toBeInTheDocument()
  })

  it('renders a property-override view with property name + status', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'property_override',
        id: 'po-1',
        title: 'early-checkin · Sunset Villa · CONFIRMED',
        body: 'Sunset Villa uses 15:00 check-in.',
        meta: {
          category: 'early-checkin',
          status: 'CONFIRMED',
          propertyId: 'prop-1',
          propertyName: 'Sunset Villa',
          enabled: true,
          updatedAt: new Date().toISOString(),
        },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'property_override', artifactId: 'po-1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(
      await screen.findByText('Sunset Villa uses 15:00 check-in.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Sunset Villa')).toBeInTheDocument()
  })

  it('renders a missing-artifact banner on 404', async () => {
    mockFetch.mockRejectedValueOnce(
      new BuildArtifactNotFoundError('sop', 'gone'),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'gone' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(
      await screen.findByText(/couldn't be found|couldn’t be found/i),
    ).toBeInTheDocument()
  })

  it('Esc key calls onClose', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({ type: 'sop', body: 'x', meta: {} }),
    )
    const onClose = vi.fn()
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'x' }}
        onClose={onClose}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    await screen.findByRole('dialog')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows "View changes" toggle when prevBody differs', async () => {
    mockFetch.mockResolvedValueOnce({
      type: 'sop',
      id: 'v1',
      title: 'early-checkin · CONFIRMED',
      body: 'New body',
      meta: { category: 'early-checkin', status: 'CONFIRMED' },
      prevBody: 'Old body',
      prevReason: null,
    } as BuildArtifactDetail)
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        sessionStartIso={new Date().toISOString()}
      />,
    )
    const toggle = (await screen.findByRole('checkbox', {
      name: /show changes this session/i,
    })) as HTMLInputElement
    expect(toggle).toBeInTheDocument()
    expect(toggle.checked).toBe(false)
  })

  it('hides "View changes" toggle when prevBody is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({ type: 'sop', body: 'only', meta: {} }),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    await screen.findByRole('dialog')
    expect(
      screen.queryByRole('checkbox', { name: /show changes this session/i }),
    ).not.toBeInTheDocument()
  })

  // 052-C2 — SystemPromptView diff toggle.
  it('shows "View changes" on system_prompt only when admin + raw-editor flag + prevBody differs', async () => {
    mockFetch.mockResolvedValueOnce({
      type: 'system_prompt',
      id: 'coordinator',
      title: 'System prompt · coordinator',
      body: 'You are Omar v2',
      meta: { variant: 'coordinator', version: 13 },
      prevBody: 'You are Omar v1',
      prevReason: null,
    } as BuildArtifactDetail)
    const { rerender } = render(
      <ArtifactDrawer
        open
        target={{ artifact: 'system_prompt', artifactId: 'coordinator' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        sessionStartIso={new Date().toISOString()}
      />,
    )
    // Operator tier: body hidden, so toggle MUST be hidden too.
    await screen.findByText(/Full system-prompt body is admin-only/)
    expect(
      screen.queryByRole('checkbox', { name: /show changes this session/i }),
    ).not.toBeInTheDocument()

    mockFetch.mockResolvedValueOnce({
      type: 'system_prompt',
      id: 'coordinator',
      title: 'System prompt · coordinator',
      body: 'You are Omar v2',
      meta: { variant: 'coordinator', version: 13 },
      prevBody: 'You are Omar v1',
      prevReason: null,
    } as BuildArtifactDetail)
    rerender(
      <ArtifactDrawer
        open
        target={{ artifact: 'system_prompt', artifactId: 'coordinator' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled
        sessionStartIso={new Date().toISOString()}
      />,
    )
    const toggle = (await screen.findByRole('checkbox', {
      name: /show changes this session/i,
    })) as HTMLInputElement
    expect(toggle).toBeInTheDocument()
  })

  // 052-C3 — tool JSON diff toggle appears when prevParameters present.
  it('shows "View changes" on tool when prevParameters is set', async () => {
    mockFetch.mockResolvedValueOnce({
      type: 'tool',
      id: 'tool-1',
      title: 'slack-notify',
      body: 'Posts to Slack.',
      meta: {
        name: 'slack-notify',
        displayName: 'slack-notify',
        agentScope: 'coordinator',
        toolType: 'custom',
        enabled: true,
        parameters: { timeout: 10000, message: 'hello' },
      },
      prevParameters: { timeout: 5000, message: 'hello' },
    } as BuildArtifactDetail)
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'tool', artifactId: 'tool-1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        sessionStartIso={new Date().toISOString()}
      />,
    )
    const toggle = (await screen.findByRole('checkbox', {
      name: /show changes this session/i,
    })) as HTMLInputElement
    expect(toggle).toBeInTheDocument()
  })

  // 052-C3 — load-bearing regression: a removed apiKey must NOT leak
  // through the JSON diff "removed value" path.
  it('redacts removed apiKey on the tool JSON diff (load-bearing)', async () => {
    mockFetch.mockResolvedValueOnce({
      type: 'tool',
      id: 'tool-1',
      title: 'slack-notify',
      body: 'Posts to Slack.',
      meta: {
        name: 'slack-notify',
        displayName: 'slack-notify',
        agentScope: 'coordinator',
        toolType: 'custom',
        enabled: true,
        parameters: { message: 'hello' },
      },
      prevParameters: { message: 'hello', apiKey: 'sk-live-deadbeefcafe' },
    } as BuildArtifactDetail)
    const { container } = render(
      <ArtifactDrawer
        open
        target={{ artifact: 'tool', artifactId: 'tool-1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        sessionStartIso={new Date().toISOString()}
      />,
    )
    const toggle = (await screen.findByRole('checkbox', {
      name: /show changes this session/i,
    })) as HTMLInputElement
    act(() => {
      fireEvent.click(toggle)
    })
    await waitFor(() => {
      expect(container.textContent).toContain('[redacted]')
    })
    expect(container.textContent).not.toContain('sk-live-deadbeefcafe')
  })

  // ── Sprint 054-A F2 — rationale card in drawer history view ───────────

  it('054-A F2: drawer renders rationale card above diff when opened with historyRow', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'faq',
        id: 'f1',
        title: 'wifi',
        body: 'Password: in the welcome card.',
        meta: { category: 'wifi-technology', scope: 'GLOBAL' },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{
          artifact: 'faq',
          artifactId: 'f1',
          historyRow: {
            id: 'h-1',
            artifactType: 'faq',
            artifactId: 'f1',
            operation: 'UPDATE',
            actorEmail: 'mgr@x',
            conversationId: 'c1',
            createdAt: new Date().toISOString(),
            prevBody: null,
            newBody: null,
            metadata: { rationale: 'Clarified the wifi handoff per incident last week.' },
          },
        }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(await screen.findByTestId('artifact-drawer-rationale-slot')).toBeTruthy()
    expect(screen.getByTestId('rationale-card-body').textContent).toBe(
      'Clarified the wifi handoff per incident last week.',
    )
  })

  it('054-A F2: drawer omits rationale card when opened WITHOUT historyRow (non-history view)', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'faq',
        id: 'f1',
        title: 'wifi',
        body: 'Password: in the welcome card.',
        meta: { category: 'wifi-technology', scope: 'GLOBAL' },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'faq', artifactId: 'f1' }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    await screen.findByText(/Password:/)
    expect(screen.queryByTestId('artifact-drawer-rationale-slot')).toBeNull()
    expect(screen.queryByTestId('rationale-card')).toBeNull()
  })

  it('054-A F2: drawer history view with missing rationale shows "No rationale recorded"', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'faq',
        id: 'f1',
        title: 'wifi',
        body: 'body',
        meta: { category: 'wifi-technology', scope: 'GLOBAL' },
      }),
    )
    render(
      <ArtifactDrawer
        open
        target={{
          artifact: 'faq',
          artifactId: 'f1',
          historyRow: {
            id: 'h-legacy',
            artifactType: 'faq',
            artifactId: 'f1',
            operation: 'CREATE',
            actorEmail: null,
            conversationId: null,
            createdAt: new Date().toISOString(),
            prevBody: null,
            newBody: null,
            metadata: null,
          },
        }}
        onClose={() => {}}
        isAdmin={false}
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    expect(await screen.findByTestId('artifact-drawer-rationale-slot')).toBeTruthy()
    expect(screen.getByTestId('rationale-card-placeholder').textContent).toBe(
      'No rationale recorded',
    )
  })
})
