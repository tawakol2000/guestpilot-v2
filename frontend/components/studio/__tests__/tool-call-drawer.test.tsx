/**
 * Sprint 050 A2 — ToolCallDrawer component tests.
 *
 * Covers: input/output surfacing with operator-tier redaction,
 * admin-only "Show full output" gate, Esc-to-close, closed-state =
 * renders nothing, and the waiting-for-output placeholder on a part
 * that has input but no output yet (streaming).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ToolCallDrawer, type ToolCallDrawerPart } from '../tool-call-drawer'

const samplePart: ToolCallDrawerPart = {
  type: 'tool-mcp__tune__get_current_state',
  toolName: 'mcp__tune__get_current_state',
  state: 'output-available',
  input: { scope: 'summary', apiKey: 'sk-live-1234' },
  output: { sops: 14, faqs: 8 },
}

describe('ToolCallDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ToolCallDrawer
        open={false}
        onClose={() => {}}
        part={samplePart}
        isAdmin={false}
        traceViewEnabled={false}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows input + output sections and redacts sensitive keys for operator-tier viewers', () => {
    render(
      <ToolCallDrawer
        open={true}
        onClose={() => {}}
        part={samplePart}
        isAdmin={false}
        traceViewEnabled={false}
      />,
    )
    // Short tool name in header
    expect(screen.getByText(/get current state/i)).toBeInTheDocument()
    // Input section redacts the apiKey
    const input = screen.getByText(/"apiKey": "\[redacted\]"/)
    expect(input).toBeInTheDocument()
    // Output section rendered
    expect(screen.getByText(/"sops": 14/)).toBeInTheDocument()
  })

  it('does not render the admin "Show full output" toggle for non-admin tenants', () => {
    render(
      <ToolCallDrawer
        open={true}
        onClose={() => {}}
        part={samplePart}
        isAdmin={false}
        traceViewEnabled={false}
      />,
    )
    expect(
      screen.queryByLabelText(/Show full output/i),
    ).not.toBeInTheDocument()
  })

  it('renders the admin toggle only when both flags are set', () => {
    render(
      <ToolCallDrawer
        open={true}
        onClose={() => {}}
        part={samplePart}
        isAdmin={true}
        traceViewEnabled={true}
      />,
    )
    expect(screen.getByLabelText(/Show full output/i)).toBeInTheDocument()
  })

  it('Esc closes the drawer', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <ToolCallDrawer
        open={true}
        onClose={onClose}
        part={samplePart}
        isAdmin={false}
        traceViewEnabled={false}
      />,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a Waiting-for-output placeholder on an in-flight tool call', () => {
    render(
      <ToolCallDrawer
        open={true}
        onClose={() => {}}
        part={{
          type: 'tool-get_sop',
          toolName: 'get_sop',
          state: 'input-available',
          input: { category: 'early-checkin' },
          output: undefined,
        }}
        isAdmin={false}
        traceViewEnabled={false}
      />,
    )
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument()
  })

  it('renders the error text and danger styling on an output-error state', () => {
    render(
      <ToolCallDrawer
        open={true}
        onClose={() => {}}
        part={{
          type: 'tool-get_sop',
          toolName: 'get_sop',
          state: 'output-error',
          input: {},
          output: undefined,
          errorText: 'SOP not found',
        }}
        isAdmin={false}
        traceViewEnabled={false}
      />,
    )
    expect(screen.getByText('SOP not found')).toBeInTheDocument()
  })
})
