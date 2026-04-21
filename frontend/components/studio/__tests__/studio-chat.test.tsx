/**
 * Sprint 050 A1 — typographic attribution tests.
 *
 * The studio-chat renderer must visually distinguish four origins:
 *   - user-typed    → `data-origin="user"`, ink black
 *   - agent-written → `data-origin="agent"`, inkMuted grey
 *   - quoted        → monospace block with a left-rule + source chip
 *   - pending       → italic grey with an "Unsaved" badge (lives inside
 *                     PlanChecklist + SuggestedFixCard, exercised there)
 *
 * These tests exercise the studio-chat branch; PlanChecklist +
 * SuggestedFixCard have their own assertions below.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'

// jsdom does not implement Element.scrollTo; StudioChat auto-scrolls on
// every message change. Stub before any render so the effect is a no-op.
beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

// Minimal @ai-sdk/react stub — StudioChat imports `useChat` only.
vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { messages: unknown[] }) => ({
    messages: opts.messages ?? [],
    sendMessage: () => {},
    status: 'idle',
    error: null,
  }),
}))

// `ai` is imported for its `DefaultChatTransport` + UIMessage type only.
// The `DefaultChatTransport` is instantiated in useMemo but never called
// because our useChat stub ignores the transport.
vi.mock('ai', () => ({
  DefaultChatTransport: class {},
}))

import { StudioChat } from '../studio-chat'
import { STUDIO_COLORS } from '../tokens'
import { SuggestedFixCard } from '../suggested-fix'
import { PlanChecklist } from '../../build/plan-checklist'
import type { BuildPlanData } from '@/lib/build-api'

const userMessage = {
  id: 'm1',
  role: 'user' as const,
  parts: [{ type: 'text', text: 'Tighten up the early-checkin SOP.' }],
}
const agentMessage = {
  id: 'm2',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'Here is the current SOP body.' }],
}
const quoteMessage = {
  id: 'm3',
  role: 'assistant' as const,
  parts: [
    {
      type: 'data-artifact-quote',
      id: 'q1',
      data: {
        artifact: 'sop',
        artifactId: 'sop-early-checkin',
        sourceLabel: 'SOP: early-checkin · CONFIRMED',
        body: 'Check in after 14:00. Earlier on request.',
      },
    },
  ],
}

function renderStudio(messages: any[]) {
  return render(
    <StudioChat
      conversationId="c1"
      greenfield={false}
      initialMessages={messages as any}
    />,
  )
}

describe('StudioChat · typographic attribution', () => {
  it('renders user-typed text with origin=user and ink colour', () => {
    renderStudio([userMessage])
    const p = screen.getByText(/Tighten up the early-checkin SOP\./)
    expect(p.dataset.origin).toBe('user')
    expect(p).toHaveStyle({ color: STUDIO_COLORS.ink })
  })

  it('renders agent text with origin=agent and inkMuted colour', () => {
    renderStudio([agentMessage])
    const p = screen.getByText(/Here is the current SOP body\./)
    expect(p.dataset.origin).toBe('agent')
    expect(p).toHaveStyle({ color: STUDIO_COLORS.inkMuted })
  })

  it('renders data-artifact-quote as monospace with a source-chip label', () => {
    renderStudio([quoteMessage])
    // Source label chip
    expect(
      screen.getByText('SOP: early-checkin · CONFIRMED'),
    ).toBeInTheDocument()
    // Body renders inside a <pre> with the origin marker set
    const body = screen.getByText(/Check in after 14:00\./)
    expect(body.tagName).toBe('PRE')
    const wrapper = body.closest('[data-origin]') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    expect(wrapper?.dataset.origin).toBe('quoted')
  })
})

describe('SuggestedFixCard · pending origin grammar', () => {
  it('tags the after-block as pending and shows an Unsaved badge by default', () => {
    render(
      <SuggestedFixCard
        id="fix-1"
        target={{ artifact: 'sop', artifactId: 'sop-1' }}
        before="Old"
        after="New"
        rationale="Tighter wording."
        category="SOP_CONTENT"
        onAccept={async () => {}}
        onReject={async () => {}}
      />,
    )
    expect(screen.getByLabelText('Unsaved')).toBeInTheDocument()
    const after = screen.getByLabelText('After')
    const wrapper = after.closest('[data-origin]') as HTMLElement | null
    expect(wrapper?.dataset.origin).toBe('pending')
    // Italic on pending diff text
    expect(after).toHaveStyle({ fontStyle: 'italic' })
  })
})

describe('SuggestedFixCard · 057-A F2 typographic attribution', () => {
  it('rationale text renders with AI (inkMuted) colour', async () => {
    const { STUDIO_COLORS } = await import('../tokens')
    render(
      <SuggestedFixCard
        id="fix-attr"
        target={{ artifact: 'sop', artifactId: 'sop-1' }}
        before="Old text."
        after="New text."
        rationale="AI-authored rationale explaining the fix."
        onAccept={async () => {}}
        onReject={async () => {}}
      />,
    )
    const rationaleEl = screen.getByText('AI-authored rationale explaining the fix.')
    expect(rationaleEl).toHaveStyle({ color: STUDIO_COLORS.inkMuted })
  })

  it('impact text renders with AI (inkMuted) colour', async () => {
    const { STUDIO_COLORS } = await import('../tokens')
    render(
      <SuggestedFixCard
        id="fix-impact"
        target={{ artifact: 'sop', artifactId: 'sop-1' }}
        before="Old."
        after="New."
        rationale="rationale."
        impact="AI-generated impact statement."
        onAccept={async () => {}}
        onReject={async () => {}}
      />,
    )
    const impactEl = screen.getByText('AI-generated impact statement.')
    expect(impactEl).toHaveStyle({ color: STUDIO_COLORS.inkMuted })
  })
})

describe('PlanChecklist · diff preview', () => {
  // Sprint 055-A F1 — PlanChecklist no longer has "Unsaved" attribution or
  // italic/pending diff styles. The preview diff still renders; this test
  // verifies the disclosure + after-block are present in the new design.
  const plan: BuildPlanData = {
    ok: true,
    transactionId: 'tx-12345678',
    plannedAt: '2026-04-21T10:00:00.000Z',
    approvalRequired: true,
    uiHint: 'proposed',
    rationale: 'Add a CONFIRMED variant for early-checkin.',
    items: [
      {
        type: 'sop',
        name: 'early-checkin · CONFIRMED',
        rationale: 'Weekend turnover tightening.',
        previewDiff: {
          before: '',
          after: 'Check in after 14:00.',
        },
      },
    ],
  }

  it('renders the after-block inside a PRE tag when the diff disclosure is opened', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<PlanChecklist data={plan} />)
    // Open the preview disclosure to reveal the diff block.
    await user.click(screen.getByText('Preview diff'))
    const after = screen.getByText('Check in after 14:00.')
    expect(after.tagName).toBe('PRE')
    // Unsaved badge and italic style were removed in Sprint 055-A F1.
    expect(screen.queryByText('Unsaved')).toBeNull()
  })
})
