/**
 * Sprint 057-A F1 — ToolChainSummary component tests.
 *
 * 1. Summary renders correct verbs for each mapped tool.
 * 2. +N more overflow kicks in at >5 distinct calls.
 * 3. Click toggles expansion; chip row becomes visible; drawer-open behavior.
 * 4. Running/errored state styling applied.
 * 5. Message with zero tool calls renders no summary row at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolChainSummary } from '../tool-chain-summary'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePart(
  toolName: string,
  state = 'output-available',
  extra: Record<string, unknown> = {},
  toolCallId?: string,
): Record<string, unknown> {
  return {
    type: `tool-${toolName}`,
    toolName,
    state,
    toolCallId: toolCallId ?? `id:${toolName}`,
    input: {},
    output: {},
    ...extra,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolChainSummary', () => {
  it('renders nothing when there are no tool-call parts', () => {
    const { container } = render(
      <ToolChainSummary
        parts={[
          { type: 'text', text: 'hello' },
          { type: 'data-build-plan', data: {} },
        ]}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders correct verbs for known tool names', () => {
    const parts = [
      makePart('mcp__tuning-agent__get_current_state'),
      makePart('mcp__tuning-agent__get_faq'),
      makePart('mcp__tuning-agent__test_pipeline'),
    ]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByText(/Read state/)).toBeInTheDocument()
    expect(screen.getByText(/Got FAQ/)).toBeInTheDocument()
    expect(screen.getByText(/Ran test/)).toBeInTheDocument()
  })

  it('uses fallback verb (underscore→space) for unknown tool names', () => {
    const parts = [makePart('mcp__tuning-agent__unknown_tool')]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByText(/unknown tool/)).toBeInTheDocument()
  })

  it('renders +N more overflow when more than 5 distinct calls are present', () => {
    const parts = [
      makePart('mcp__tuning-agent__get_current_state', 'output-available', {}, 'id1'),
      makePart('mcp__tuning-agent__get_faq', 'output-available', {}, 'id2'),
      makePart('mcp__tuning-agent__get_sop', 'output-available', {}, 'id3'),
      makePart('mcp__tuning-agent__test_pipeline', 'output-available', {}, 'id4'),
      makePart('mcp__tuning-agent__create_faq', 'output-available', {}, 'id5'),
      makePart('mcp__tuning-agent__create_sop', 'output-available', {}, 'id6'),
    ]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument()
  })

  it('shows exactly the right overflow count at 7 calls', () => {
    const parts = Array.from({ length: 7 }, (_, i) =>
      makePart(`mcp__tuning-agent__get_faq`, 'output-available', {}, `id${i}`),
    )
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument()
  })

  it('deduplicates parts with the same toolCallId', () => {
    const parts = [
      makePart('mcp__tuning-agent__get_faq', 'output-available', {}, 'same-id'),
      makePart('mcp__tuning-agent__get_faq', 'output-available', {}, 'same-id'),
    ]
    render(<ToolChainSummary parts={parts} />)
    // Only one "Got FAQ" should appear in the collapsed summary
    const matches = screen.getAllByText(/Got FAQ/)
    expect(matches.length).toBe(1)
    // No overflow
    expect(screen.queryByText(/more/)).toBeNull()
  })

  it('clicking the toggle expands the chip row and hides the summary line', async () => {
    const user = userEvent.setup()
    const parts = [
      makePart('mcp__tuning-agent__get_current_state'),
      makePart('mcp__tuning-agent__get_faq'),
    ]
    render(<ToolChainSummary parts={parts} />)

    // Before expansion: summary line is visible (aria-hidden=false for toggle btn)
    const toggleBtn = screen.getByRole('button', { name: /expand tool calls/i })
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false')

    // Expand
    await user.click(toggleBtn)
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true')
    expect(toggleBtn).toHaveAttribute('aria-label', 'Collapse tool calls')

    // Chip row list is now visible
    expect(screen.getByRole('list', { name: /tool calls/i })).toBeInTheDocument()
  })

  it('clicking a chip in expanded state calls onOpenToolDrawer', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const parts = [makePart('mcp__tuning-agent__get_current_state')]
    render(<ToolChainSummary parts={parts} onOpenToolDrawer={onOpen} />)

    // Expand first
    await user.click(screen.getByRole('button', { name: /expand tool calls/i }))

    // Click the chip
    const chipBtn = screen.getByRole('button', { name: /tool call details: get current state/i })
    await user.click(chipBtn)
    expect(onOpen).toHaveBeenCalledTimes(1)
    const [calledPart] = onOpen.mock.calls[0]
    expect(calledPart.toolName).toBe('mcp__tuning-agent__get_current_state')
  })

  it('calls onExpandedChange with the new state on toggle', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const parts = [makePart('mcp__tuning-agent__get_faq')]
    render(<ToolChainSummary parts={parts} onExpandedChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /expand tool calls/i }))
    expect(onChange).toHaveBeenLastCalledWith(true)

    await user.click(screen.getByRole('button', { name: /collapse tool calls/i }))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('shows a spinner indicator for running (call) state tools', () => {
    const parts = [makePart('mcp__tuning-agent__test_pipeline', 'call')]
    render(<ToolChainSummary parts={parts} />)
    // The running spinner is rendered as aria-label="running"
    expect(screen.getByLabelText('running')).toBeInTheDocument()
  })

  it('shows a spinner indicator for partial-call state tools', () => {
    const parts = [makePart('mcp__tuning-agent__test_pipeline', 'partial-call')]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByLabelText('running')).toBeInTheDocument()
  })

  it('does NOT show a spinner for completed tools', () => {
    const parts = [makePart('mcp__tuning-agent__test_pipeline', 'output-available')]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.queryByLabelText('running')).toBeNull()
  })

  it('plan_build_changes with items count renders dynamic verb', () => {
    const parts = [
      {
        type: 'tool-mcp__tuning-agent__plan_build_changes',
        toolName: 'mcp__tuning-agent__plan_build_changes',
        state: 'output-available',
        toolCallId: 'plan1',
        input: { items: [{ type: 'sop', name: 'a' }, { type: 'faq', name: 'b' }, { type: 'sop', name: 'c' }] },
        output: {},
      },
    ]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByText(/Planned 3 writes/)).toBeInTheDocument()
  })

  it('ignores non-tool parts when collecting entries', () => {
    const parts = [
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'data-build-plan', data: {} },
      makePart('mcp__tuning-agent__get_faq'),
    ]
    render(<ToolChainSummary parts={parts} />)
    expect(screen.getByText(/Got FAQ/)).toBeInTheDocument()
    // Only 1 entry — no overflow
    expect(screen.queryByText(/more/)).toBeNull()
  })
})
