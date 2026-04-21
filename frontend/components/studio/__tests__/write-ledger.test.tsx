/**
 * Sprint 053-A D4 — WriteLedgerCard tests.
 *
 * Covers: empty state, row rendering, click-to-open, Revert visibility
 * (UPDATE only), refresh-key re-fetch, admin-gate via `visible`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { WriteLedgerCard } from '../write-ledger'
import type { BuildArtifactHistoryRow } from '@/lib/build-api'

vi.mock('@/lib/build-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/build-api')>('@/lib/build-api')
  return {
    ...actual,
    apiListBuildArtifactHistory: vi.fn(),
  }
})

import { apiListBuildArtifactHistory } from '@/lib/build-api'

const mockList = apiListBuildArtifactHistory as unknown as ReturnType<typeof vi.fn>

function row(partial: Partial<BuildArtifactHistoryRow>): BuildArtifactHistoryRow {
  return {
    id: 'h-' + Math.random().toString(36).slice(2, 8),
    artifactType: 'sop',
    artifactId: 'v1',
    operation: 'UPDATE',
    actorEmail: 'manager@tenant.example',
    conversationId: 'c1',
    createdAt: new Date().toISOString(),
    prevBody: { content: 'old' },
    newBody: { content: 'new' },
    metadata: null,
    ...partial,
  }
}

describe('WriteLedgerCard', () => {
  beforeEach(() => {
    mockList.mockReset()
  })

  it('renders nothing when visible=false', async () => {
    mockList.mockResolvedValueOnce({ rows: [] })
    const { container } = render(
      <WriteLedgerCard visible={false} conversationId="c1" />,
    )
    expect(container.textContent).toBe('')
    expect(mockList).not.toHaveBeenCalled()
  })

  it('shows empty state when no rows returned', async () => {
    mockList.mockResolvedValueOnce({ rows: [] })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() =>
      expect(screen.getByTestId('write-ledger-empty')).toBeTruthy(),
    )
  })

  it('renders one row per history entry with type + operation metadata', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({ id: 'h1', artifactType: 'sop', operation: 'CREATE' }),
        row({ id: 'h2', artifactType: 'faq', operation: 'UPDATE' }),
        row({ id: 'h3', artifactType: 'tool_definition', operation: 'UPDATE' }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => {
      const rows = screen.getAllByTestId('write-ledger-row')
      expect(rows.length).toBe(3)
    })
    const rows = screen.getAllByTestId('write-ledger-row')
    expect(rows[0].getAttribute('data-artifact-type')).toBe('sop')
    expect(rows[0].getAttribute('data-operation')).toBe('CREATE')
    expect(rows[2].getAttribute('data-artifact-type')).toBe('tool_definition')
  })

  it('click-to-open calls onOpenRow with the row payload', async () => {
    mockList.mockResolvedValueOnce({
      rows: [row({ id: 'h1', artifactType: 'sop', operation: 'UPDATE' })],
    })
    const onOpen = vi.fn()
    render(
      <WriteLedgerCard visible conversationId="c1" onOpenRow={onOpen} />,
    )
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open SOP UPDATE'))
    })
    expect(onOpen).toHaveBeenCalled()
    expect(onOpen.mock.calls[0][0].id).toBe('h1')
  })

  it('Revert link appears on UPDATE rows and NOT on CREATE rows', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({ id: 'h-upd', operation: 'UPDATE' }),
        row({ id: 'h-cre', operation: 'CREATE' }),
      ],
    })
    const onRevert = vi.fn()
    render(
      <WriteLedgerCard visible conversationId="c1" onRevertRow={onRevert} />,
    )
    await waitFor(() =>
      expect(screen.getAllByTestId('write-ledger-row').length).toBe(2),
    )
    const revertBtns = screen.getAllByRole('button', { name: /^Revert SOP/ })
    expect(revertBtns.length).toBe(1)
    await act(async () => {
      fireEvent.click(revertBtns[0]!)
    })
    expect(onRevert).toHaveBeenCalled()
    expect(onRevert.mock.calls[0][0].id).toBe('h-upd')
  })

  it('refetches when refreshKey bumps', async () => {
    mockList.mockResolvedValue({ rows: [] })
    const { rerender } = render(
      <WriteLedgerCard visible conversationId="c1" refreshKey={1} />,
    )
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
    rerender(<WriteLedgerCard visible conversationId="c1" refreshKey={2} />)
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
  })

  it('passes conversationId + limit to the fetcher', async () => {
    mockList.mockResolvedValueOnce({ rows: [] })
    render(<WriteLedgerCard visible conversationId="conv-abc" />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(mockList).toHaveBeenCalledWith({ conversationId: 'conv-abc', limit: 10 })
  })

  it('surfaces fetch failure inline without crashing', async () => {
    mockList.mockRejectedValueOnce(new Error('network down'))
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() =>
      expect(screen.getByText(/network down/).textContent).toContain('network down'),
    )
  })

  it('REVERT-operation rows do NOT show Revert link', async () => {
    mockList.mockResolvedValueOnce({
      rows: [row({ id: 'h-rev', operation: 'REVERT' })],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    expect(screen.queryAllByRole('button', { name: /^Revert SOP/ })).toHaveLength(0)
  })

  // ── Sprint 054-A F2 — rationale rendering in ledger rail ────────────────

  it('054-A F2: row has a rationale-expand chevron and is collapsed by default', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-r',
          operation: 'UPDATE',
          metadata: { rationale: 'Tightened the late-checkout SOP per manager.' },
        }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    const ledgerRow = screen.getByTestId('write-ledger-row')
    expect(ledgerRow.getAttribute('data-expanded')).toBe('false')
    expect(screen.getByTestId('write-ledger-rationale-chevron')).toBeTruthy()
    // Body/placeholder not in DOM before expand.
    expect(screen.queryByTestId('rationale-card-body')).toBeNull()
  })

  it('054-A F2: clicking chevron expands the row and reveals the rationale literally', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-r',
          operation: 'UPDATE',
          metadata: { rationale: 'Tightened the late-checkout SOP per manager.' },
        }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('write-ledger-rationale-chevron'))
    })
    expect(screen.getByTestId('write-ledger-row').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('rationale-card-body').textContent).toBe(
      'Tightened the late-checkout SOP per manager.',
    )
  })

  it('054-A F2: pre-F1 row (no metadata.rationale) renders "No rationale recorded" when expanded', async () => {
    mockList.mockResolvedValueOnce({
      rows: [row({ id: 'h-legacy', metadata: null })],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('write-ledger-rationale-chevron'))
    })
    expect(screen.getByTestId('rationale-card-placeholder').textContent).toBe(
      'No rationale recorded',
    )
  })

  it('054-A F2: markdown-looking rationale renders as literal text (no <strong>, no <h1>)', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-x',
          metadata: { rationale: '# CRITICAL **bold** _em_ injection attempt' },
        }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('write-ledger-rationale-chevron'))
    })
    const body = screen.getByTestId('rationale-card-body')
    expect(body.textContent).toBe('# CRITICAL **bold** _em_ injection attempt')
    expect(body.querySelector('strong')).toBeNull()
    expect(body.querySelector('h1')).toBeNull()
    expect(body.querySelector('em')).toBeNull()
  })
})
