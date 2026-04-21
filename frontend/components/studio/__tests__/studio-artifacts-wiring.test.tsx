/**
 * Sprint 050 A3 — integration-ish test: approving a plan inside
 * StudioChat emits `onArtifactTouched` for each plan item, which the
 * StudioSurface wires into the right-rail artifacts card.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UIMessage } from 'ai'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages: unknown[] }) => ({
    messages: opts.messages ?? [],
    sendMessage: () => {},
    status: 'idle',
    error: null,
  }),
}))
vi.mock('ai', () => ({
  DefaultChatTransport: class {},
}))

// Stub the approve endpoint so the PlanChecklist state machine
// transitions to `approved` without hitting the network.
const approveSpy = vi.fn(async (_transactionId: string) => ({
  ok: true,
  approvedAt: new Date().toISOString(),
  alreadyApproved: false,
}))
vi.mock('@/lib/build-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/build-api')
  return {
    ...actual,
    apiApproveBuildPlan: (tx: string) => approveSpy(tx),
    // `withBuildToast` wraps callbacks in a toast wrapper; reuse the
    // passthrough so the real callback runs and the state machine flips.
    withBuildToast: async (_label: string, fn: () => Promise<unknown>) => fn(),
  }
})

import { StudioChat } from '../studio-chat'
import type { BuildPlanData } from '@/lib/build-api'

const planData: BuildPlanData = {
  ok: true,
  transactionId: 'tx-deadbeef1234',
  plannedAt: '2026-04-21T10:00:00.000Z',
  approvalRequired: true,
  uiHint: 'proposed',
  rationale: 'Tighten early-checkin handling.',
  items: [
    {
      type: 'sop',
      name: 'early-checkin · CONFIRMED',
      rationale: 'Weekend turnover.',
      target: { artifactId: 'sop-early-checkin' },
    },
    {
      type: 'faq',
      name: 'FAQ: Can I check in early?',
      rationale: 'Matches the new SOP.',
      target: { artifactId: 'faq-early' },
    },
  ],
}

const planMessage = {
  id: 'm-plan',
  role: 'assistant',
  parts: [{ type: 'data-build-plan', id: 'bp1', data: planData }],
} satisfies Partial<UIMessage> as unknown as UIMessage

describe('StudioChat · plan approval → onArtifactTouched', () => {
  it('fires onArtifactTouched once per plan item when the operator approves', async () => {
    const onArtifactTouched = vi.fn()
    const onPlanApproved = vi.fn()

    render(
      <StudioChat
        conversationId="c-1"
        greenfield={false}
        initialMessages={[planMessage]}
        onArtifactTouched={onArtifactTouched}
        onPlanApproved={onPlanApproved}
      />,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Approve plan/i }))

    // The approve spy is called once with the transactionId.
    expect(approveSpy).toHaveBeenCalledWith('tx-deadbeef1234')
    // Both items became session artifacts.
    expect(onArtifactTouched).toHaveBeenCalledTimes(2)
    const called = onArtifactTouched.mock.calls.map((c) => c[0])
    expect(called[0].artifact).toBe('sop')
    expect(called[0].artifactId).toBe('sop-early-checkin')
    expect(called[0].action).toBe('created')
    expect(called[1].artifact).toBe('faq')
    expect(called[1].artifactId).toBe('faq-early')
    // Legacy callback still fires.
    expect(onPlanApproved).toHaveBeenCalledWith('tx-deadbeef1234')
  })
})
