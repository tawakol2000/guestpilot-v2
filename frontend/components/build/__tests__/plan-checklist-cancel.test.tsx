/**
 * Sprint 058-A F2 — PlanChecklist cancel-pending-row tests.
 *
 * Covers:
 *  - × button only shows on hover and only on pending rows
 *  - clicking × optimistically flips the row to `× cancelled`
 *  - done / current / already-cancelled rows get no × button
 *  - server `alreadyExecuting: true` rolls back the optimistic flip + toasts
 *  - network failure rolls back + toasts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { PlanChecklist } from '../plan-checklist'
import type { BuildPlanData } from '@/lib/build-api'

vi.mock('@/lib/build-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/build-api')>()
  return {
    ...actual,
    apiApproveBuildPlan: vi.fn().mockResolvedValue({
      id: 'tx-test-1234abcd',
      status: 'PLANNED',
      approvedAt: new Date().toISOString(),
      approvedByUserId: null,
      alreadyApproved: false,
    }),
    apiRollbackBuildPlan: vi.fn(),
    apiListBuildArtifactHistory: vi.fn(),
    apiCancelPlanItem: vi.fn(),
    withBuildToast: vi.fn(async (_msg: string, fn: () => Promise<unknown>) => fn()),
  }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

import { apiCancelPlanItem } from '@/lib/build-api'
import { toast } from 'sonner'

function makePlan(): BuildPlanData {
  return {
    ok: true,
    transactionId: 'tx-test-1234abcd',
    plannedAt: new Date().toISOString(),
    approvalRequired: true,
    uiHint: '',
    rationale: 'Test rationale.',
    items: [
      { type: 'sop', name: 'Check-in SOP', rationale: 'Needs updating.' },
      { type: 'faq', name: 'WiFi FAQ', rationale: 'Missing wifi details.' },
      { type: 'system_prompt', name: 'Tone', rationale: 'Adjust tone.' },
    ],
  }
}

describe('PlanChecklist — 058-A F2 cancel row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows × button on hover for pending rows only', async () => {
    render(<PlanChecklist data={makePlan()} appliedItems={[]} />)

    // With 0 applied, row 0 = current, row 1/2 = pending.
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)

    // No × button before hover
    expect(screen.queryByTestId('plan-row-cancel-faq-WiFi FAQ')).toBeNull()

    // Hover row 1 (pending FAQ) — × appears
    fireEvent.mouseEnter(rows[1])
    expect(screen.getByTestId('plan-row-cancel-faq-WiFi FAQ')).toBeInTheDocument()

    // Hover row 0 (current SOP) — no × button
    fireEvent.mouseLeave(rows[1])
    fireEvent.mouseEnter(rows[0])
    expect(screen.queryByTestId('plan-row-cancel-sop-Check-in SOP')).toBeNull()
  })

  it('clicking × optimistically flips row to cancelled glyph', async () => {
    vi.mocked(apiCancelPlanItem).mockResolvedValue({
      ok: true,
      index: 1,
      cancelledItemIndexes: [1],
    })

    render(<PlanChecklist data={makePlan()} appliedItems={[]} />)
    const rows = screen.getAllByRole('listitem')
    fireEvent.mouseEnter(rows[1])
    const btn = screen.getByTestId('plan-row-cancel-faq-WiFi FAQ')
    fireEvent.click(btn)

    // Glyph in row 1 should now be ×; aria-label reflects the state.
    await waitFor(() => {
      const glyphs = rows[1].querySelectorAll('[aria-label="cancelled"]')
      expect(glyphs.length).toBeGreaterThan(0)
    })
    expect(apiCancelPlanItem).toHaveBeenCalledWith('tx-test-1234abcd', 1)
  })

  it('rolls back optimistic flip + toasts on alreadyExecuting response', async () => {
    vi.mocked(apiCancelPlanItem).mockResolvedValue({
      ok: true,
      index: 1,
      alreadyExecuting: true,
    })

    render(<PlanChecklist data={makePlan()} appliedItems={[]} />)
    const rows = screen.getAllByRole('listitem')
    fireEvent.mouseEnter(rows[1])
    fireEvent.click(screen.getByTestId('plan-row-cancel-faq-WiFi FAQ'))

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/already past this item/i),
      )
    })
    // The row should NOT be in the cancelled state after rollback.
    const cancelledGlyphs = rows[1].querySelectorAll('[aria-label="cancelled"]')
    expect(cancelledGlyphs.length).toBe(0)
  })

  it('rolls back optimistic flip + error-toasts on network failure', async () => {
    vi.mocked(apiCancelPlanItem).mockRejectedValue(new Error('boom'))

    render(<PlanChecklist data={makePlan()} appliedItems={[]} />)
    const rows = screen.getAllByRole('listitem')
    fireEvent.mouseEnter(rows[1])
    fireEvent.click(screen.getByTestId('plan-row-cancel-faq-WiFi FAQ'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/couldn't cancel/i),
      )
    })
    const cancelledGlyphs = rows[1].querySelectorAll('[aria-label="cancelled"]')
    expect(cancelledGlyphs.length).toBe(0)
  })

  it('does not render the × button when transactionId is absent (legacy plan)', () => {
    const legacyPlan: BuildPlanData = { ...makePlan(), transactionId: '' }
    render(<PlanChecklist data={legacyPlan} appliedItems={[]} />)
    const rows = screen.getAllByRole('listitem')
    fireEvent.mouseEnter(rows[1])
    expect(screen.queryByTestId('plan-row-cancel-faq-WiFi FAQ')).toBeNull()
  })
})
