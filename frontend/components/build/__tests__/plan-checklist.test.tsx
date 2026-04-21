/**
 * Sprint 055-A F1 — PlanChecklist (progress tracker) tests.
 *
 * 1. Auto-approve fires exactly once on mount (StrictMode double-invoke safe).
 * 2. Row state derivation from appliedItems.
 * 3. Hover + seed-composer affordance.
 * 4. Legacy plan (no transactionId) renders without crashing.
 * 5. Auto-approve failure shows retry pill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PlanChecklist } from '../plan-checklist'
import type { BuildPlanData, BuildPlanItem } from '@/lib/build-api'

// ─── Mock build-api ────────────────────────────────────────────────────────

vi.mock('@/lib/build-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/build-api')>()
  return {
    ...actual,
    apiApproveBuildPlan: vi.fn(),
    apiRollbackBuildPlan: vi.fn(),
    apiListBuildArtifactHistory: vi.fn(),
    withBuildToast: vi.fn(async (_msg: string, fn: () => Promise<unknown>) => fn()),
  }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

import { apiApproveBuildPlan, apiListBuildArtifactHistory } from '@/lib/build-api'
import { toast } from 'sonner'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<BuildPlanData> = {}): BuildPlanData {
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
      { type: 'system_prompt', name: 'Main prompt', rationale: 'Tone adjustment.' },
    ],
    ...overrides,
  }
}

function mockApproveSuccess() {
  vi.mocked(apiApproveBuildPlan).mockResolvedValue({
    id: 'tx-test-1234abcd',
    status: 'PLANNED',
    approvedAt: new Date().toISOString(),
    approvedByUserId: null,
    alreadyApproved: false,
  })
}

function mockApproveFailure() {
  vi.mocked(apiApproveBuildPlan).mockRejectedValue(new Error('Network error'))
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PlanChecklist — 055-A F1', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Test 1: Auto-approve fires exactly once on mount ───────────────────

  it('auto-approve fires exactly once on mount (StrictMode double-invoke safe)', async () => {
    mockApproveSuccess()
    const data = makePlan()

    // Render normally first — should fire once.
    const { unmount, rerender } = render(<PlanChecklist data={data} />)
    await waitFor(() => {
      expect(apiApproveBuildPlan).toHaveBeenCalledTimes(1)
    })
    expect(apiApproveBuildPlan).toHaveBeenCalledWith('tx-test-1234abcd')

    // Re-render (simulates React StrictMode re-invoke or parent re-render) —
    // must NOT fire a second request. The useRef guard makes it idempotent.
    rerender(<PlanChecklist data={data} />)
    await waitFor(() => {
      // Still exactly once — no second call.
      expect(apiApproveBuildPlan).toHaveBeenCalledTimes(1)
    })

    unmount()
  })

  // ── Test 2: Row state derivation from appliedItems ─────────────────────

  it('row state: 2 applied items → rows 1+2 show ✓, row 3 shows ● (current)', async () => {
    mockApproveSuccess()
    const data = makePlan()
    const appliedItems = [
      { type: 'sop' as const, name: 'Check-in SOP' },
      { type: 'faq' as const, name: 'WiFi FAQ' },
    ]

    render(<PlanChecklist data={data} appliedItems={appliedItems} />)

    await waitFor(() => {
      // Rows 0 and 1 (indexes 0 and 1) are done.
      const glyphs = screen.getAllByLabelText(/done|current|pending|cancelled/)
      expect(glyphs[0].textContent).toBe('✓') // done
      expect(glyphs[1].textContent).toBe('✓') // done
      // Row 2 (index 2) — first undone item = 'current', shown as ●
      expect(glyphs[2].textContent).toBe('●')
    })
  })

  it('row state: no applied items → row 0 is ● (current), rows 1-2 are ○ (pending)', async () => {
    mockApproveSuccess()
    const data = makePlan()

    render(<PlanChecklist data={data} appliedItems={[]} />)

    await waitFor(() => {
      const glyphs = screen.getAllByLabelText(/done|current|pending|cancelled/)
      expect(glyphs[0].textContent).toBe('●') // current
      expect(glyphs[1].textContent).toBe('○') // pending
      expect(glyphs[2].textContent).toBe('○') // pending
    })
  })

  // ── Test 3: Hover + seed-composer affordance ───────────────────────────

  it('hover over row → + button appears → click → onSeedComposer called with @item:sop:My SOP', async () => {
    mockApproveSuccess()
    const data = makePlan({
      items: [{ type: 'sop', name: 'My SOP', rationale: 'Needs updating.' }],
    })
    const onSeedComposer = vi.fn()

    render(<PlanChecklist data={data} onSeedComposer={onSeedComposer} />)

    // Find the row li element
    const row = screen.getAllByRole('listitem')[0]

    // Hover over the row to reveal the + button
    fireEvent.mouseEnter(row)

    // The + button should now be visible
    const seedBtn = screen.getByLabelText('Seed composer with My SOP')
    expect(seedBtn).toBeDefined()

    // Click it
    fireEvent.click(seedBtn)

    expect(onSeedComposer).toHaveBeenCalledWith('@item:sop:My SOP')
  })

  // ── Test 4: Legacy plan renders without crashing ───────────────────────

  it('legacy plan (transactionId present, no appliedItems) renders without crashing', async () => {
    mockApproveSuccess()
    const data = makePlan()

    // Should not crash — just renders
    expect(() =>
      render(<PlanChecklist data={data} />),
    ).not.toThrow()

    // Some headline text renders
    await waitFor(() => {
      expect(screen.getByText('Build plan')).toBeDefined()
    })
  })

  it('plan with no transactionId renders as legacy "Plan proposed" headline', () => {
    // No apiApproveBuildPlan should be called for legacy plans.
    const data = makePlan({ transactionId: '' as any })

    render(<PlanChecklist data={data} />)

    // Headline should be "Plan proposed" for legacy plans
    expect(screen.getByText('Plan proposed')).toBeDefined()
    // Should not call apiApproveBuildPlan since transactionId is falsy
    expect(apiApproveBuildPlan).not.toHaveBeenCalled()
  })

  // ── Test 5: Auto-approve failure shows retry pill ──────────────────────

  it('auto-approve failure shows "Couldn\'t confirm plan" inline pill', async () => {
    mockApproveFailure()
    const data = makePlan()

    render(<PlanChecklist data={data} />)

    // The retry error pill should appear after the failed approval
    await waitFor(() => {
      expect(screen.getByText(/Couldn't confirm plan/)).toBeDefined()
    })

    // The Retry button should also be present
    expect(screen.getByText('Retry')).toBeDefined()

    // Row rendering should still work — not blocked
    expect(screen.getAllByRole('listitem').length).toBe(3)
  })

  // ── F4: Plan-row click opens the artifact drawer ───────────────────────

  it('056-A F4: click on a done row with direct artifactId calls onOpenArtifact', async () => {
    mockApproveSuccess()
    const data = makePlan({
      items: [
        { type: 'sop', name: 'Check-in SOP', rationale: 'Test.', target: { artifactId: 'sop-abc-123' } },
      ],
    })
    const onOpenArtifact = vi.fn()
    const appliedItems = [{ type: 'sop' as const, name: 'Check-in SOP' }]

    render(
      <PlanChecklist data={data} appliedItems={appliedItems} onOpenArtifact={onOpenArtifact} />,
    )

    await waitFor(() => screen.getByLabelText('done'))
    fireEvent.click(screen.getAllByRole('listitem')[0])

    expect(onOpenArtifact).toHaveBeenCalledWith('sop', 'sop-abc-123')
  })

  it('056-A F4: tool_definition type maps to "tool" artifact type', async () => {
    mockApproveSuccess()
    const data = makePlan({
      items: [
        { type: 'tool_definition', name: 'My Tool', rationale: 'Test.', target: { artifactId: 'tool-xyz' } },
      ],
    })
    const onOpenArtifact = vi.fn()
    const appliedItems = [{ type: 'tool_definition' as const, name: 'My Tool' }]

    render(
      <PlanChecklist data={data} appliedItems={appliedItems} onOpenArtifact={onOpenArtifact} />,
    )

    await waitFor(() => screen.getByLabelText('done'))
    fireEvent.click(screen.getAllByRole('listitem')[0])

    expect(onOpenArtifact).toHaveBeenCalledWith('tool', 'tool-xyz')
  })

  it('056-A F4: click on a pending row shows "not written yet" toast, no onOpenArtifact', async () => {
    mockApproveSuccess()
    // 3-item plan with 0 appliedItems → row 0 is current, rows 1+2 are pending
    const data = makePlan()
    const onOpenArtifact = vi.fn()

    render(
      <PlanChecklist
        data={data}
        appliedItems={[]}
        onOpenArtifact={onOpenArtifact}
        conversationId="conv-test"
      />,
    )

    await waitFor(() => screen.getByLabelText('current'))

    // Click the second row (index 1) which is 'pending'
    fireEvent.click(screen.getAllByRole('listitem')[1])

    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      "This artifact hasn't been written yet — it'll open here when the agent writes it.",
    )
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })

  it('056-A F4: click on + seed button does NOT trigger onOpenArtifact', async () => {
    mockApproveSuccess()
    const data = makePlan({
      items: [
        { type: 'sop', name: 'Check-in SOP', rationale: 'Test.', target: { artifactId: 'sop-abc' } },
      ],
    })
    const onOpenArtifact = vi.fn()
    const onSeedComposer = vi.fn()
    const appliedItems = [{ type: 'sop' as const, name: 'Check-in SOP' }]

    render(
      <PlanChecklist
        data={data}
        appliedItems={appliedItems}
        onOpenArtifact={onOpenArtifact}
        onSeedComposer={onSeedComposer}
      />,
    )

    await waitFor(() => screen.getByLabelText('done'))

    // Hover to reveal the + button
    const row = screen.getAllByRole('listitem')[0]
    fireEvent.mouseEnter(row)

    const seedBtn = screen.getByLabelText('Seed composer with Check-in SOP')
    fireEvent.click(seedBtn)

    // + button should seed composer
    expect(onSeedComposer).toHaveBeenCalledWith('@item:sop:Check-in SOP')
    // onOpenArtifact must NOT have been called (stopPropagation worked)
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })

  it('056-A F4: history lookup resolves artifactId for a done row without direct target', async () => {
    mockApproveSuccess()
    vi.mocked(apiListBuildArtifactHistory).mockResolvedValue({
      rows: [
        {
          id: 'hist-1',
          artifactType: 'sop',
          artifactId: 'sop-from-history',
          operation: 'CREATE',
          actorEmail: null,
          conversationId: 'conv-1',
          createdAt: new Date().toISOString(),
          prevBody: null,
          newBody: {},
        },
      ],
    })
    const data = makePlan({
      items: [{ type: 'sop', name: 'Check-in SOP', rationale: 'Test.' }], // no target.artifactId
    })
    const onOpenArtifact = vi.fn()
    const appliedItems = [{ type: 'sop' as const, name: 'Check-in SOP' }]

    render(
      <PlanChecklist
        data={data}
        appliedItems={appliedItems}
        onOpenArtifact={onOpenArtifact}
        conversationId="conv-1"
      />,
    )

    await waitFor(() => screen.getByLabelText('done'))
    fireEvent.click(screen.getAllByRole('listitem')[0])

    await waitFor(() => {
      expect(onOpenArtifact).toHaveBeenCalledWith('sop', 'sop-from-history')
    })
  })
})
