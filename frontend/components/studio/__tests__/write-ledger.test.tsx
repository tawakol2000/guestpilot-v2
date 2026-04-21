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

  // ── Sprint 054-A F4 — verdict chip inline on ledger rows ───────────────

  it('054-A F4: ledger row renders a passed chip when metadata.testResult.aggregateVerdict is all_passed', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-pass',
          metadata: {
            rationale: 'Added late-checkout SOP.',
            testResult: {
              variants: [
                { triggerMessage: 'a', pipelineOutput: 'b', verdict: 'passed', judgeReasoning: 'ok', judgePromptVersion: 'v1', ranAt: new Date().toISOString() },
              ],
              aggregateVerdict: 'all_passed',
              ritualVersion: '054-a.1',
            },
          },
        }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-verdict-chip'))
    const chip = screen.getByTestId('write-ledger-verdict-chip')
    expect(chip.getAttribute('data-verdict')).toBe('all_passed')
    expect(chip.textContent).toBe('Passed')
  })

  it('054-A F4: partial verdict renders an amber "Partial" chip, all_failed renders red "Failed"', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-partial',
          metadata: {
            testResult: {
              variants: [],
              aggregateVerdict: 'partial',
              ritualVersion: '054-a.1',
            },
          },
        }),
        row({
          id: 'h-fail',
          metadata: {
            testResult: {
              variants: [],
              aggregateVerdict: 'all_failed',
              ritualVersion: '054-a.1',
            },
          },
        }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() =>
      expect(screen.getAllByTestId('write-ledger-verdict-chip').length).toBe(2),
    )
    const chips = screen.getAllByTestId('write-ledger-verdict-chip')
    expect(chips[0].getAttribute('data-verdict')).toBe('partial')
    expect(chips[0].textContent).toBe('Partial')
    expect(chips[1].getAttribute('data-verdict')).toBe('all_failed')
    expect(chips[1].textContent).toBe('Failed')
  })

  it('054-A F4: row without testResult renders NO verdict chip', async () => {
    mockList.mockResolvedValueOnce({
      rows: [row({ id: 'h-none', metadata: { rationale: 'Just a write, no test yet.' } })],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    expect(screen.queryByTestId('write-ledger-verdict-chip')).toBeNull()
  })

  it('054-A F4: clicking verdict chip triggers onOpenRow (dispatches to drawer)', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-chip',
          metadata: {
            testResult: {
              variants: [],
              aggregateVerdict: 'all_passed',
              ritualVersion: '054-a.1',
            },
          },
        }),
      ],
    })
    const onOpen = vi.fn()
    render(
      <WriteLedgerCard visible conversationId="c1" onOpenRow={onOpen} />,
    )
    await waitFor(() => screen.getByTestId('write-ledger-verdict-chip'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('write-ledger-verdict-chip'))
    })
    expect(onOpen).toHaveBeenCalled()
    expect(onOpen.mock.calls[0][0].id).toBe('h-chip')
  })

  it('055-A F4: renders ✏️ Edited chip when metadata.rationalePrefix is edited-by-operator', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-edited',
          metadata: { rationalePrefix: 'edited-by-operator', rationale: 'Agent text', operatorRationale: 'Fixed typo' },
        }),
      ],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-edited-chip'))
    expect(screen.getByTestId('write-ledger-edited-chip').textContent).toContain('Edited')
  })

  it('055-A F4: does NOT render edited chip when metadata absent', async () => {
    mockList.mockResolvedValueOnce({
      rows: [row({ id: 'h-plain', metadata: null })],
    })
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    expect(screen.queryByTestId('write-ledger-edited-chip')).toBeNull()
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

  // ── Sprint 057-A F2 — typographic attribution ──────────────────────────

  it('057-A F2: entry title (operation + typeLabel) renders with human (ink) colour', async () => {
    mockList.mockResolvedValueOnce({
      rows: [row({ id: 'h-attr', artifactType: 'sop', operation: 'UPDATE' })],
    })
    const { STUDIO_COLORS } = await import('../tokens')
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    // The "UPDATE SOP" span carries the human colour.
    const titleSpan = screen.getByText(/UPDATE SOP/)
    expect(titleSpan).toHaveStyle({ color: STUDIO_COLORS.ink })
  })

  it('057-A F2: rationale body renders with AI (inkMuted) colour after expansion', async () => {
    mockList.mockResolvedValueOnce({
      rows: [
        row({
          id: 'h-rat',
          metadata: { rationale: 'Agent tightened the SOP wording.' },
        }),
      ],
    })
    const { STUDIO_COLORS } = await import('../tokens')
    render(<WriteLedgerCard visible conversationId="c1" />)
    await waitFor(() => screen.getByTestId('write-ledger-row'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('write-ledger-rationale-chevron'))
    })
    const body = screen.getByTestId('rationale-card-body')
    expect(body).toHaveStyle({ color: STUDIO_COLORS.inkMuted })
  })
})
