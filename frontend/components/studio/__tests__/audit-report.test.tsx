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
})
