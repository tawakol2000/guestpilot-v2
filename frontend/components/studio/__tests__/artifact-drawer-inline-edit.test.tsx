/**
 * Sprint 055-A F2+F3 — ArtifactDrawer inline edit + rationale prompt.
 *
 * Tests:
 *  1. Pencil toggles edit mode (on/off).
 *  2. Reset restores agent draft.
 *  3. Debounced re-preview fires once per burst.
 *  4. Apply submits the edited body.
 *  5. Read-only behavior when no pendingBody (no pencil, no edit).
 *  6. F3 threshold: material edit shows rationale prompt; trivial edit does not.
 *  7. Empty rationale still allows Apply.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ArtifactDrawer } from '../artifact-drawer'
import type { BuildArtifactDetail, BuildArtifactType } from '@/lib/build-api'

vi.mock('@/lib/build-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/build-api')>('@/lib/build-api')
  return {
    ...actual,
    apiGetBuildArtifact: vi.fn(),
    apiApplyArtifact: vi.fn(),
  }
})

import { apiApplyArtifact, apiGetBuildArtifact } from '@/lib/build-api'

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

// ─────────────────────────────────────────────────────────────────────────────
// F2 — Inline edit
// ─────────────────────────────────────────────────────────────────────────────

describe('ArtifactDrawer — F2 inline edit', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockApply.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Test 1: Pencil toggles edit mode ──────────────────────────────────────
  it('pencil toggle switches edit mode on and off', async () => {
    mockFetch.mockResolvedValue(sopDetail())
    mockApply.mockResolvedValue({
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
    await waitFor(() => screen.getByTestId('preview-banner'))

    // Pencil should now be visible (preview loaded).
    const pencil = screen.getByLabelText('Toggle inline edit')
    expect(pencil.getAttribute('aria-pressed')).toBe('false')

    // Click → edit mode ON.
    await act(async () => { fireEvent.click(pencil) })
    expect(pencil.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('sop-editor-textarea')).toBeTruthy()

    // Click again → edit mode OFF.
    await act(async () => { fireEvent.click(pencil) })
    expect(pencil.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('sop-editor-textarea')).toBeNull()
  })

  // ── Test 2: Reset restores agent draft ────────────────────────────────────
  it('Reset to agent draft clears editedBody and closes edit mode', async () => {
    mockFetch.mockResolvedValue(sopDetail())
    mockApply.mockResolvedValue({
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
    await waitFor(() => screen.getByTestId('preview-banner'))

    // Enter edit mode.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Toggle inline edit'))
    })
    expect(screen.getByTestId('sop-editor-textarea')).toBeTruthy()

    // Make a change.
    await act(async () => {
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: 'A different body text that is long enough.' },
      })
    })

    // Reset.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Reset to agent draft'))
    })

    expect(screen.queryByTestId('sop-editor-textarea')).toBeNull()
    expect(screen.getByLabelText('Toggle inline edit').getAttribute('aria-pressed')).toBe('false')
  })

  // ── Test 3: Debounced re-preview fires once per burst ─────────────────────
  //
  // Uses real timers. We type 3 edits in quick succession (synchronously,
  // no await between them) and then wait for exactly 1 total extra call
  // within 1s. This verifies debounce consolidation without fake-timer
  // complexity.
  it('debounced re-preview fires once after 400ms burst', async () => {
    mockFetch.mockResolvedValue(sopDetail())
    mockApply.mockResolvedValue({
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

    // Click Preview.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => screen.getByTestId('preview-banner'))

    // Enter edit mode.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Toggle inline edit'))
    })

    const callCountAfterPreview = mockApply.mock.calls.length

    // Rapidly fire 3 edits synchronously inside a single act.
    await act(async () => {
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: 'A' },
      })
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: 'AB' },
      })
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: 'ABC' },
      })
    })

    // Immediately after — the debounce should NOT have fired yet.
    expect(mockApply.mock.calls.length).toBe(callCountAfterPreview)

    // Wait for the debounce to settle (400ms + some slack).
    await waitFor(
      () =>
        expect(mockApply.mock.calls.length).toBe(callCountAfterPreview + 1),
      { timeout: 2000 },
    )
  }, 10000)

  // ── Test 4: Apply submits the edited body ──────────────────────────────────
  it('Apply submits the edited body, not the original pendingBody', async () => {
    const pendingBody = { content: 'Original pending body content ≥20 chars.' }
    mockFetch.mockResolvedValue(sopDetail())
    mockApply
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        artifactType: 'sop',
        artifactId: 'v1',
        preview: { content: 'Original pending body content ≥20 chars.' },
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
        pendingBody={pendingBody}
        onApplied={onApplied}
      />,
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => screen.getByTestId('preview-banner'))

    // Enter edit mode, change body.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Toggle inline edit'))
    })
    const editedContent = 'Operator-edited body — this is the changed content here!'
    await act(async () => {
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: editedContent },
      })
    })

    // Apply.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Apply change'))
    })
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith('sop', 'v1'))

    // Capture the Apply call (dryRun:false).
    const applyCall = mockApply.mock.calls.find(
      (c: any[]) => c[2]?.dryRun === false,
    )
    expect(applyCall).toBeTruthy()
    expect((applyCall![2].body as any).content).toBe(editedContent)
    expect((applyCall![2].body as any).content).not.toBe(pendingBody.content)
  })

  // ── Test 5: Read-only when no pendingBody ──────────────────────────────────
  it('shows no pencil icon and no edit affordance when pendingBody is absent', async () => {
    mockFetch.mockResolvedValue(sopDetail())

    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        // No pendingBody
      />,
    )
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    // Give it a moment to render.
    await act(async () => {})

    expect(screen.queryByLabelText('Toggle inline edit')).toBeNull()
    expect(screen.queryByTestId('sop-editor-textarea')).toBeNull()
    expect(screen.queryByLabelText('Reset to agent draft')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F3 — Rationale prompt
// ─────────────────────────────────────────────────────────────────────────────

describe('ArtifactDrawer — F3 rationale prompt', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockApply.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Test 6a: Material edit shows rationale ────────────────────────────────
  it('shows rationale textarea for material edit (>10 char diff)', async () => {
    mockFetch.mockResolvedValue(sopDetail())
    mockApply.mockResolvedValue({
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      preview: { content: 'Short pending body that is twenty plus chars.' },
    })

    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'Short pending body that is twenty plus chars.' }}
      />,
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => screen.getByTestId('preview-banner'))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Toggle inline edit'))
    })

    const materialContent =
      'Completely different content that is way more than ten characters different from the original.'
    await act(async () => {
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: materialContent },
      })
    })

    expect(screen.getByTestId('operator-rationale-input')).toBeTruthy()
  })

  // ── Test 6b: Trivial edit does NOT show rationale ─────────────────────────
  it('does NOT show rationale textarea for trivial edit (≤10 char diff)', async () => {
    mockFetch.mockResolvedValue(sopDetail())
    mockApply.mockResolvedValue({
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: 'v1',
      preview: { content: 'Short pending body that is twenty plus chars.' },
    })

    render(
      <ArtifactDrawer
        open
        target={{ artifact: 'sop', artifactId: 'v1' }}
        onClose={() => {}}
        isAdmin
        traceViewEnabled={false}
        rawPromptEditorEnabled={false}
        pendingBody={{ content: 'Short pending body that is twenty plus chars.' }}
      />,
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => screen.getByTestId('preview-banner'))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Toggle inline edit'))
    })

    // Change only 1 character — trivial edit.
    const trivialContent = 'Short pending body that is twenty plus char!'
    await act(async () => {
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: trivialContent },
      })
    })

    expect(screen.queryByTestId('operator-rationale-input')).toBeNull()
  })

  // ── Test 7: Empty rationale still allows Apply ────────────────────────────
  it('empty rationale does not block Apply', async () => {
    mockFetch.mockResolvedValue(sopDetail())
    mockApply
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        artifactType: 'sop',
        artifactId: 'v1',
        preview: { content: 'Short pending body that is twenty plus chars.' },
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
        pendingBody={{ content: 'Short pending body that is twenty plus chars.' }}
        onApplied={onApplied}
      />,
    )

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Preview change'))
    })
    await waitFor(() => screen.getByTestId('preview-banner'))

    // Enter edit mode + material edit.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Toggle inline edit'))
    })
    const materialContent =
      'Completely different content that is way more than ten characters different from the original.'
    await act(async () => {
      fireEvent.change(screen.getByTestId('sop-editor-textarea'), {
        target: { value: materialContent },
      })
    })

    // Rationale appears; leave it EMPTY.
    expect(screen.getByTestId('operator-rationale-input')).toBeTruthy()

    // Apply should not be blocked.
    const applyBtn = screen.getByLabelText('Apply change')
    expect(applyBtn).not.toBeDisabled()
    await act(async () => { fireEvent.click(applyBtn) })
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith('sop', 'v1'))
    expect(onClose).toHaveBeenCalled()

    // Metadata includes rationalePrefix, operatorRationale absent.
    const applyCall = mockApply.mock.calls.find(
      (c: any[]) => c[2]?.dryRun === false,
    )
    expect(applyCall![2].metadata?.rationalePrefix).toBe('edited-by-operator')
    expect(applyCall![2].metadata?.operatorRationale).toBeUndefined()
  })
})
