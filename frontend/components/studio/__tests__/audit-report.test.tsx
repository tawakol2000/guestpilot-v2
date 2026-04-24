/**
 * Sprint 047 Session B — B1 reference test.
 *
 * Exercises the Session A S5 wiring: `AuditReportCard` renders a View
 * button on every non-top row, and clicking it fires `onViewRow` with
 * the corresponding row.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AuditReportCard, type AuditReportRowData } from '../audit-report'

const rows: AuditReportRowData[] = [
  {
    artifact: 'sop',
    artifactId: 'sop-top',
    label: 'Checkout SOP',
    status: 'danger',
    note: 'Missing escalation on late checkout.',
    findingId: 'finding-1',
  },
  {
    artifact: 'faq',
    artifactId: 'faq-mid',
    label: 'WiFi FAQ',
    status: 'warn',
    note: 'Ambiguous network password wording.',
    findingId: 'finding-2',
  },
  {
    artifact: 'system_prompt',
    label: 'Coordinator prompt',
    status: 'ok',
    note: 'No obvious gaps.',
    findingId: 'finding-3',
  },
]

describe('AuditReportCard', () => {
  it('renders Fix on top finding and View on every other row', () => {
    render(
      <AuditReportCard
        rows={rows}
        topFindingId="finding-1"
        onFixTopFinding={() => {}}
        onViewRow={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Fix' })).toBeInTheDocument()
    const viewButtons = screen.getAllByRole('button', { name: 'View' })
    expect(viewButtons).toHaveLength(2)
  })

  it('invokes onViewRow with the clicked non-top row', async () => {
    const user = userEvent.setup()
    const onViewRow = vi.fn()

    render(
      <AuditReportCard
        rows={rows}
        topFindingId="finding-1"
        onFixTopFinding={() => {}}
        onViewRow={onViewRow}
      />,
    )

    const viewButtons = screen.getAllByRole('button', { name: 'View' })
    await user.click(viewButtons[0])

    expect(onViewRow).toHaveBeenCalledTimes(1)
    expect(onViewRow).toHaveBeenCalledWith(rows[1])
  })

  it('does not render a View button on the top finding row', () => {
    render(
      <AuditReportCard
        rows={rows}
        topFindingId="finding-1"
        onFixTopFinding={() => {}}
        onViewRow={() => {}}
      />,
    )

    // Only two View buttons in total (rows 2 + 3), top row has Fix instead.
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Fix' })).toHaveLength(1)
  })

  // ── Sprint 057-A F2 — typographic attribution ─────────────────────────

  it('057-A F2: row.note renders with AI-attributed readable body color', async () => {
    // Sprint 046 — audit report restyle increased the body-text
    // contrast from inkMuted to ink2 so the notes are legible on the
    // brighter v2 canvas. The test now verifies the note renders in
    // *some* darker-than-ink-subtle color rather than pinning one hex.
    const { STUDIO_TOKENS_V2 } = await import('../tokens')
    render(
      <AuditReportCard
        rows={[{
          artifact: 'sop',
          artifactId: 'sop-1',
          label: 'Checkout SOP',
          status: 'warn',
          note: 'This note is AI-generated text.',
          findingId: 'f1',
        }]}
        topFindingId={null}
        onViewRow={() => {}}
      />,
    )
    const noteEl = screen.getByText('This note is AI-generated text.')
    expect(noteEl).toHaveStyle({ color: STUDIO_TOKENS_V2.ink2 })
  })

  it('057-A F2: row.label (structural heading) renders with ink colour', async () => {
    const { STUDIO_COLORS } = await import('../tokens')
    render(
      <AuditReportCard
        rows={[{
          artifact: 'sop',
          artifactId: 'sop-1',
          label: 'Checkout SOP Heading',
          status: 'ok',
          note: 'Fine.',
          findingId: 'f1',
        }]}
        topFindingId={null}
        onViewRow={() => {}}
      />,
    )
    const labelEl = screen.getByText('Checkout SOP Heading')
    expect(labelEl).toHaveStyle({ color: STUDIO_COLORS.ink })
  })
})
