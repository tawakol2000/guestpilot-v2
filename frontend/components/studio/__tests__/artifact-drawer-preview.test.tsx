/**
 * Sprint 053-A D3 — ArtifactDrawer Preview/Apply flow.
 *
 * When a `pendingBody` is provided, the drawer renders Preview + Apply
 * buttons. Preview calls the apply endpoint with dryRun:true and renders
 * the diff; Apply calls it with dryRun:false, closes the drawer, and
 * invokes `onApplied`.
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
    apiApplyArtifact: vi.fn(),
  }
})

import {
  apiApplyArtifact,
  apiGetBuildArtifact,
} from '@/lib/build-api'

const mockFetch = apiGetBuildArtifact as unknown as ReturnType<typeof vi.fn>
const mockApply = apiApplyArtifact as unknown as ReturnType<typeof vi.fn>

function makeDetail(
  overrides: Partial<BuildArtifactDetail> & { type: BuildArtifactType },
): BuildArtifactDetail {
  return {
    id: 'x',
    title: 't',
    body: 'current saved body text',
    meta: {},
    ...overrides,
  } as BuildArtifactDetail
}

function sopDetail() {
  return makeDetail({
    type: 'sop',
    id: 'v1',
    title: 'late-checkout · DEFAULT',
    body: 'Original SOP body — this is what the drawer shows by default.',
    meta: { category: 'late-checkout', status: 'DEFAULT', enabled: true },
  })
}

describe('ArtifactDrawer — D3 Preview/Apply', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockApply.mockReset()
  })

  it('does NOT render Preview/Apply buttons when pendingBody is absent', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(screen.queryByLabelText('Preview change')).toBeNull()
    expect(screen.queryByLabelText('Apply change')).toBeNull()
  })

  it('renders Preview button active + Apply disabled when pendingBody provided', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'New proposed body content ≥20 chars.' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const preview = screen.getByLabelText('Preview change')
    const apply = screen.getByLabelText('Apply change')
    expect(preview).not.toBeDisabled()
    expect(apply).toBeDisabled()
  })

  it('Preview click fetches with dryRun:true, shows banner, enables Apply', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    mockApply.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      preview: { content: 'New proposed body content ≥20 chars.' },
      diff: { kind: 'update' },
    })
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'New proposed body content ≥20 chars.' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => expect(mockApply).toHaveBeenCalled())
    expect(mockApply).toHaveBeenCalledWith(
      'sop',
      'v1',
      expect.objectContaining({ dryRun: true }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('preview-banner')).toBeTruthy(),
    )
    expect(screen.getByLabelText('Apply change')).not.toBeDisabled()
  })

  it('Apply click fetches without dryRun, closes drawer, calls onApplied', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    mockApply
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        artifactType: 'sop',
        artifactId: 'v1',
        preview: { content: 'New proposed body content ≥20 chars.' },
      })
      .mockResolvedValueOnce({
        ok: true,
        dryRun: false,
        artifactType: 'sop',
        artifactId: 'v1',
      })
    const onClose = vi.fn()
    const onApplied = vi.fn()
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={onClose}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'New proposed body content ≥20 chars.' }}
        onApplied={onApplied}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => expect(screen.getByTestId('preview-banner')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Apply change'))
    })
    await waitFor(() =>
      expect(mockApply).toHaveBeenLastCalledWith(
        'sop',
        'v1',
        expect.objectContaining({ dryRun: false }),
      ),
    )
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith('sop', 'v1'))
    expect(onClose).toHaveBeenCalled()
  })

  it('Validation error preview keeps Apply disabled + renders inline error', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    mockApply.mockResolvedValueOnce({
      ok: false,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      error: 'body.content must be a non-empty string (≥20 chars)',
    })
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'too short' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('preview-error')).toBeTruthy(),
    )
    expect(screen.queryByTestId('preview-banner')).toBeNull()
    expect(screen.getByLabelText('Apply change')).toBeDisabled()
  })

  it('Clear Preview link dismisses banner + re-enables Preview-first state', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    mockApply.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      preview: { content: 'New proposed body content ≥20 chars.' },
    })
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'New proposed body content ≥20 chars.' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => expect(screen.getByTestId('preview-banner')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Clear preview'))
    })
    expect(screen.queryByTestId('preview-banner')).toBeNull()
    expect(screen.getByLabelText('Apply change')).toBeDisabled()
  })

  it('Preview payload "text" (system_prompt) overlays into the diff view', async () => {
    mockFetch.mockResolvedValueOnce(
      makeDetail({
        type: 'system_prompt',
        id: 'coordinator',
        title: 'System prompt · coordinator',
        body: 'OLD coordinator body.',
      }),
    )
    mockApply.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      artifactType: 'system_prompt',
      artifactId: 'coordinator',
      preview: { text: 'NEW coordinator body.', variant: 'coordinator' },
    })
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'system_prompt', artifactId: 'coordinator' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled
        rawPromptEditorEnabled
        pendingBody={{ text: 'NEW coordinator body.' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => expect(screen.getByTestId('preview-banner')).toBeTruthy())
    // The preview body text should now be present somewhere in the drawer.
    expect(screen.getAllByText(/NEW coordinator body/).length).toBeGreaterThan(0)
  })

  it('threads conversationId into the apply call', async () => {
    mockFetch.mockResolvedValueOnce(sopDetail())
    mockApply.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      preview: { content: 'New body content ≥20 chars okay.' },
    })
    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'New body content ≥20 chars okay.' }}
        conversationId="conv-xyz"
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() =>
      expect(mockApply).toHaveBeenCalledWith(
        'sop',
        'v1',
        expect.objectContaining({ conversationId: 'conv-xyz' }),
      ),
    )
  })

  it('Preview state resets when the drawer target changes', async () => {
    mockFetch
      .mockResolvedValueOnce(sopDetail())
      .mockResolvedValueOnce({ ...sopDetail(), id: 'v2', title: 'different · PENDING' })
    mockApply.mockResolvedValueOnce({
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      preview: { content: 'Proposed content ≥20 chars.' },
    })
    const { rerender } = render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'Proposed content ≥20 chars.' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => expect(screen.getByTestId('preview-banner')).toBeTruthy())
    // Change the target — drawer should drop the preview state.
    rerender(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v2' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'Proposed content ≥20 chars.' }}
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('preview-banner')).toBeNull()
  })
})
