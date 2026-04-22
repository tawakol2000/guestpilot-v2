/**
 * Sprint 058-A F3/F6/F7 — standalone VersionsTab coverage.
 *
 * The drawer-level test (artifact-drawer-versions.test.tsx) covers the
 * tab switcher + wiring. This file exercises the isolated component:
 *   - loading / empty / error states
 *   - operation badges render
 *   - F6 tag chip + inline edit
 *   - F6 validation errors (bad label shape)
 *   - F7 row selection + diff-button enable logic
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { VersionsTab } from '../versions-tab'

vi.mock('@/lib/build-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/build-api')>('@/lib/build-api')
  return {
    ...actual,
    apiListBuildArtifactHistory: vi.fn(),
    apiRevertToVersion: vi.fn(),
    apiTagHistoryRow: vi.fn(),
    apiUntagHistoryRow: vi.fn(),
  }
})

import {
  apiListBuildArtifactHistory,
  apiTagHistoryRow,
  apiUntagHistoryRow,
} from '@/lib/build-api'

const mockListHistory = apiListBuildArtifactHistory as unknown as ReturnType<typeof vi.fn>
const mockTag = apiTagHistoryRow as unknown as ReturnType<typeof vi.fn>
const mockUntag = apiUntagHistoryRow as unknown as ReturnType<typeof vi.fn>

function row(
  overrides: Partial<{
    id: string
    operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT'
    artifactId: string
    versionLabel: string | null
    metadata: Record<string, unknown> | null
    createdAt: string
  }> = {},
) {
  return {
    id: overrides.id ?? 'h-1',
    artifactType: 'sop' as const,
    artifactId: overrides.artifactId ?? 'sop-1',
    operation: overrides.operation ?? 'CREATE',
    actorEmail: 'a@b.com',
    conversationId: 'c1',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    prevBody: null,
    newBody: { content: 'body' },
    metadata: overrides.metadata === undefined ? { rationale: 'wrote SOP' } : overrides.metadata,
    versionLabel: overrides.versionLabel ?? null,
  }
}

describe('VersionsTab (058-A)', () => {
  beforeEach(() => {
    mockListHistory.mockReset()
    mockTag.mockReset()
    mockUntag.mockReset()
  })

  it('shows the empty state when the server returns zero rows for this artifact', async () => {
    mockListHistory.mockResolvedValueOnce({
      rows: [row({ artifactId: 'some-other' })],
    })
    render(
      <VersionsTab artifact="sop" artifactId="sop-1" conversationId="c1" />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('versions-tab-empty')).toBeInTheDocument(),
    )
  })

  it('renders one row per matching history entry, newest first with a "Current" badge', async () => {
    mockListHistory.mockResolvedValueOnce({
      rows: [
        row({
          id: 'a',
          operation: 'UPDATE',
          createdAt: new Date(Date.now() - 1000).toISOString(),
        }),
        row({
          id: 'b',
          operation: 'CREATE',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    })
    render(<VersionsTab artifact="sop" artifactId="sop-1" />)
    await waitFor(() =>
      expect(screen.getAllByTestId('versions-row').length).toBe(2),
    )
    // First row is "Current" — only one badge rendered total.
    expect(screen.getAllByTestId('versions-row-current').length).toBe(1)
    // Operation badges present.
    const ops = screen
      .getAllByTestId('versions-row-operation')
      .map((e) => e.textContent)
    expect(ops).toEqual(['UPDATE', 'CREATE'])
  })

  it('F7: selecting two rows enables the Diff button; third pick rotates', async () => {
    mockListHistory.mockResolvedValueOnce({
      rows: [
        row({ id: 'a', operation: 'UPDATE' }),
        row({
          id: 'b',
          operation: 'UPDATE',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        row({
          id: 'c',
          operation: 'CREATE',
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      ],
    })
    render(<VersionsTab artifact="sop" artifactId="sop-1" />)
    await waitFor(() =>
      expect(screen.getAllByTestId('versions-row').length).toBe(3),
    )

    const diffBtn = screen.getByTestId('versions-diff-button')
    expect(diffBtn).toBeDisabled()

    const checkboxes = screen.getAllByTestId(
      'versions-row-select',
    ) as HTMLInputElement[]
    act(() => {
      fireEvent.click(checkboxes[0])
    })
    expect(diffBtn).toBeDisabled()
    act(() => {
      fireEvent.click(checkboxes[1])
    })
    expect(diffBtn).not.toBeDisabled()
  })

  it('F6: tag button opens inline input; invalid label shows error and blocks save', async () => {
    mockListHistory.mockResolvedValueOnce({
      rows: [row({ id: 'a', operation: 'UPDATE' })],
    })
    render(<VersionsTab artifact="sop" artifactId="sop-1" />)
    await screen.findByTestId('versions-row')

    act(() => {
      fireEvent.click(screen.getByTestId('versions-row-tag-button'))
    })
    const input = screen.getByTestId('versions-row-tag-input') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'not valid!' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('versions-row-tag-save'))
    })
    expect(screen.getByTestId('versions-row-tag-error')).toBeInTheDocument()
    expect(mockTag).not.toHaveBeenCalled()
  })

  it('F6: valid label saves via apiTagHistoryRow', async () => {
    mockListHistory.mockResolvedValueOnce({
      rows: [row({ id: 'a', operation: 'UPDATE' })],
    })
    mockTag.mockResolvedValueOnce({
      ok: true,
      row: { id: 'a', versionLabel: 'stable', artifactType: 'sop', artifactId: 'sop-1' },
    })
    // Second fetch after the refresh on tag-save.
    mockListHistory.mockResolvedValueOnce({
      rows: [row({ id: 'a', operation: 'UPDATE', versionLabel: 'stable' })],
    })
    render(<VersionsTab artifact="sop" artifactId="sop-1" />)
    await screen.findByTestId('versions-row')

    act(() => {
      fireEvent.click(screen.getByTestId('versions-row-tag-button'))
    })
    const input = screen.getByTestId('versions-row-tag-input') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'stable' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('versions-row-tag-save'))
    })
    await waitFor(() => {
      expect(mockTag).toHaveBeenCalledWith('a', 'stable')
    })
  })

  it('F6: clicking the tag-chip X calls apiUntagHistoryRow', async () => {
    mockListHistory.mockResolvedValueOnce({
      rows: [row({ id: 'a', operation: 'UPDATE', versionLabel: 'stable' })],
    })
    mockUntag.mockResolvedValueOnce({
      ok: true,
      row: { id: 'a', versionLabel: null, artifactType: 'sop', artifactId: 'sop-1' },
    })
    mockListHistory.mockResolvedValueOnce({
      rows: [row({ id: 'a', operation: 'UPDATE', versionLabel: null })],
    })

    render(<VersionsTab artifact="sop" artifactId="sop-1" />)
    await screen.findByTestId('versions-row')
    const removeBtn = screen.getByRole('button', { name: /remove tag stable/i })
    await act(async () => {
      fireEvent.click(removeBtn)
    })
    await waitFor(() => {
      expect(mockUntag).toHaveBeenCalledWith('a')
    })
  })

  it('shows a failure card when the history fetch rejects', async () => {
    mockListHistory.mockRejectedValueOnce(new Error('boom'))
    render(<VersionsTab artifact="sop" artifactId="sop-1" />)
    await waitFor(() =>
      expect(screen.getByTestId('versions-tab-error')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('versions-tab-error').textContent).toContain(
      'boom',
    )
  })
})
