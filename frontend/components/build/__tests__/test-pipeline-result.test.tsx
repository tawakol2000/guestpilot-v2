/**
 * Sprint 054-A F4 — TestPipelineResult (verdict-forward) component tests.
 * Sprint 056-A F5 — Inline rollback CTA on failed rituals.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/lib/build-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/build-api')>()
  return {
    ...actual,
    apiRevertArtifactFromHistory: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

import { TestPipelineResult } from '../test-pipeline-result'
import { apiRevertArtifactFromHistory } from '@/lib/build-api'
import { toast } from 'sonner'
import type {
  TestPipelineResultData,
  TestPipelineVariant,
} from '@/lib/build-api'

function variant(
  overrides: Partial<TestPipelineVariant> = {},
): TestPipelineVariant {
  return {
    triggerMessage: 'Can I check out at 2pm?',
    pipelineOutput: 'Yes — 2pm late checkout is complimentary.',
    verdict: 'passed',
    judgeReasoning: 'Reply correctly cites the late-checkout SOP.',
    judgeScore: 0.86,
    judgePromptVersion: 'test-judge/v1',
    judgeModel: 'claude-sonnet-4-6',
    replyModel: 'gpt-5.4-mini-2026-03-17',
    latencyMs: 210,
    ranAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeData(
  partial: Partial<TestPipelineResultData> = {},
): TestPipelineResultData {
  return {
    ok: true,
    variants: [variant()],
    aggregateVerdict: 'all_passed',
    ritualVersion: '054-a.1',
    sourceWriteHistoryId: null,
    sourceWriteLabel: null,
    ritualCallsRemaining: 2,
    ...partial,
  }
}

describe('TestPipelineResult', () => {
  it('054-A F4: all-passed headline reads "N/N passed" with the total', () => {
    render(<TestPipelineResult data={makeData({
      variants: [variant(), variant(), variant()],
      aggregateVerdict: 'all_passed',
    })} />)
    expect(
      screen.getByTestId('test-pipeline-result-headline').textContent,
    ).toBe('3/3 passed')
  })

  it('054-A F4: partial headline reads "N/M passed — X failed"', () => {
    render(<TestPipelineResult data={makeData({
      variants: [
        variant({ verdict: 'passed' }),
        variant({ verdict: 'passed' }),
        variant({ verdict: 'failed', judgeScore: 0.4, judgeReasoning: 'Missed SOP.' }),
      ],
      aggregateVerdict: 'partial',
    })} />)
    expect(
      screen.getByTestId('test-pipeline-result-headline').textContent,
    ).toBe('2/3 passed — 1 failed')
  })

  it('054-A F4: single-variant passed reads honestly as "1/1 passed" (not "1/3")', () => {
    render(<TestPipelineResult data={makeData({
      variants: [variant({ verdict: 'passed' })],
      aggregateVerdict: 'all_passed',
    })} />)
    expect(
      screen.getByTestId('test-pipeline-result-headline').textContent,
    ).toBe('1/1 passed')
  })

  it('054-A F4: all-failed headline reads "0/N passed"', () => {
    render(<TestPipelineResult data={makeData({
      variants: [
        variant({ verdict: 'failed', judgeScore: 0.3, judgeReasoning: 'off-topic' }),
        variant({ verdict: 'failed', judgeScore: 0.2, judgeReasoning: 'hallucination' }),
      ],
      aggregateVerdict: 'all_failed',
    })} />)
    expect(
      screen.getByTestId('test-pipeline-result-headline').textContent,
    ).toBe('0/2 passed')
  })

  it('054-A F4: failed variant gets amber edge accent, passed does not', () => {
    render(<TestPipelineResult data={makeData({
      variants: [
        variant({ verdict: 'passed' }),
        variant({ verdict: 'failed', judgeScore: 0.4, judgeReasoning: 'x' }),
      ],
      aggregateVerdict: 'partial',
    })} />)
    const rows = screen.getAllByTestId('test-pipeline-result-variant-row')
    expect(rows[0].getAttribute('data-verdict')).toBe('passed')
    expect(rows[1].getAttribute('data-verdict')).toBe('failed')
  })

  it('054-A F4: judge reasoning is prominent (appears directly in the header block)', () => {
    render(<TestPipelineResult data={makeData({
      variants: [variant({ judgeReasoning: 'VERY SPECIFIC judge reason here.' })],
      aggregateVerdict: 'all_passed',
    })} />)
    const list = screen.getByTestId('test-pipeline-result-reasoning-list')
    expect(list.textContent).toContain('VERY SPECIFIC judge reason here.')
  })

  it('054-A F4: source-write chip renders when sourceWriteHistoryId + label are present', () => {
    const onOpen = vi.fn()
    render(
      <TestPipelineResult
        data={makeData({
          sourceWriteHistoryId: 'h-42',
          sourceWriteLabel: {
            artifactType: 'sop',
            artifactId: 'late-checkout',
            operation: 'CREATE',
          },
        })}
        onOpenSourceWrite={onOpen}
        sourceWriteLabel={{
          artifactType: 'sop',
          artifactId: 'late-checkout',
          operation: 'CREATE',
        }}
      />,
    )
    const chip = screen.getByTestId('test-pipeline-result-source-chip')
    expect(chip.textContent).toContain('CREATE')
    expect(chip.textContent).toContain('sop')
    expect(chip.textContent).toContain('late-checkout')
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledWith('h-42')
  })

  it('054-A F4: source-write chip absent when sourceWriteHistoryId is null (user-initiated test)', () => {
    render(
      <TestPipelineResult
        data={makeData({ sourceWriteHistoryId: null })}
      />,
    )
    expect(screen.queryByTestId('test-pipeline-result-source-chip')).toBeNull()
  })

  // ── 056-A F5: Inline rollback CTA ────────────────────────────────────────

  it('056-A F5: rollback footer absent when all_passed', () => {
    render(
      <TestPipelineResult
        data={makeData({ aggregateVerdict: 'all_passed', sourceWriteHistoryId: 'h-1' })}
      />,
    )
    expect(screen.queryByTestId('test-pipeline-result-rollback-footer')).toBeNull()
  })

  it('056-A F5: rollback footer absent when failing but no sourceWriteHistoryId', () => {
    render(
      <TestPipelineResult
        data={makeData({
          variants: [variant({ verdict: 'failed', judgeScore: 0.2, judgeReasoning: 'off' })],
          aggregateVerdict: 'all_failed',
          sourceWriteHistoryId: null,
        })}
      />,
    )
    expect(screen.queryByTestId('test-pipeline-result-rollback-footer')).toBeNull()
  })

  it('056-A F5: rollback footer renders when failing AND sourceWriteHistoryId present', () => {
    render(
      <TestPipelineResult
        data={makeData({
          variants: [variant({ verdict: 'failed', judgeScore: 0.2, judgeReasoning: 'off' })],
          aggregateVerdict: 'all_failed',
          sourceWriteHistoryId: 'h-99',
        })}
      />,
    )
    expect(screen.getByTestId('test-pipeline-result-rollback-footer')).toBeDefined()
    expect(screen.getByTestId('test-pipeline-result-rollback-btn')).toBeDefined()
  })

  it('056-A F5: confirm → revert API called → button disables → success toast', async () => {
    vi.mocked(apiRevertArtifactFromHistory).mockResolvedValue({} as any)
    render(
      <TestPipelineResult
        data={makeData({
          variants: [variant({ verdict: 'failed', judgeScore: 0.2, judgeReasoning: 'off' })],
          aggregateVerdict: 'all_failed',
          sourceWriteHistoryId: 'h-55',
        })}
      />,
    )

    // Click the rollback button to open dialog
    fireEvent.click(screen.getByTestId('test-pipeline-result-rollback-btn'))

    // Dialog should appear — click the confirm "Roll back" button
    const confirmBtn = await screen.findByText('Roll back')
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(apiRevertArtifactFromHistory).toHaveBeenCalledWith('h-55')
      expect(vi.mocked(toast).success).toHaveBeenCalledWith('Write rolled back successfully.')
    })

    // Button should now be disabled
    expect(screen.getByTestId('test-pipeline-result-rollback-btn')).toBeDisabled()
  })

  // ── Sprint 057-A F2 — typographic attribution ────────────────────────────

  it('057-A F2: judge reasoning list items render with AI (inkMuted) colour', async () => {
    const { TUNING_COLORS } = await import('../../studio/tokens')
    render(<TestPipelineResult data={makeData({
      variants: [variant({ judgeReasoning: 'Correct late-checkout handling.' })],
    })} />)
    const reasoningList = screen.getByTestId('test-pipeline-result-reasoning-list')
    const li = reasoningList.querySelector('li')!
    expect(li).toHaveStyle({ color: TUNING_COLORS.inkMuted })
  })

  it('057-A F2: variant trigger message renders with AI (inkMuted) colour when row is expanded', async () => {
    const { TUNING_COLORS } = await import('../../studio/tokens')
    render(<TestPipelineResult data={makeData({
      variants: [variant({ triggerMessage: 'Can I check out late?' })],
    })} />)
    // Open the per-variant details section
    const rows = screen.getAllByTestId('test-pipeline-result-variant-row')
    fireEvent.click(rows[0].querySelector('button')!)
    const triggerSpan = screen.getByText('Can I check out late?')
    expect(triggerSpan).toHaveStyle({ color: TUNING_COLORS.inkMuted })
  })

  it('057-A F2: pipeline reply renders with AI (inkMuted) colour when row is expanded', async () => {
    const { TUNING_COLORS } = await import('../../studio/tokens')
    render(<TestPipelineResult data={makeData({
      variants: [variant({ pipelineOutput: 'Late checkout is complimentary.' })],
    })} />)
    const rows = screen.getAllByTestId('test-pipeline-result-variant-row')
    fireEvent.click(rows[0].querySelector('button')!)
    const replyEl = screen.getByText('Late checkout is complimentary.')
    expect(replyEl).toHaveStyle({ color: TUNING_COLORS.inkMuted })
  })
})
