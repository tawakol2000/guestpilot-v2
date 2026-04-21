/**
 * Sprint 047 Session B — TraceDrawer component test.
 *
 * Covers: row rendering (turn, tool, duration, success dot), expand-on-
 * click for params/timestamp, "Load older" button visibility follows
 * nextCursor, and empty-state copy.
 *
 * The apiListBuildTraces call is mocked at module load so the component
 * never hits the network in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { BuildTraceRow, BuildTracePage } from '@/lib/build-api'

// Vitest 4's `vi.fn` returns a strictly-typed `Mock<Procedure>`; providing
// an initial impl keeps call signatures inferable from use. Overridden per
// test via `mockResolvedValueOnce`.
const listSpy = vi.fn(async (_opts?: unknown): Promise<BuildTracePage> => ({
  rows: [],
  nextCursor: null,
}))

vi.mock('@/lib/build-api', () => ({
  apiListBuildTraces: (opts: unknown) => listSpy(opts),
}))

import { TraceDrawer } from '../trace-drawer'

const row = (id: string, overrides: Partial<BuildTraceRow> = {}): BuildTraceRow => ({
  id,
  conversationId: 'conv-1',
  turn: 1,
  tool: 'get_current_state',
  paramsHash: 'abc123',
  durationMs: 42,
  success: true,
  errorMessage: null,
  createdAt: '2026-04-20T10:00:00.000Z',
  ...overrides,
})

const page = (rows: BuildTraceRow[], nextCursor: string | null = null): BuildTracePage => ({
  rows,
  nextCursor,
})

describe('TraceDrawer', () => {
  beforeEach(() => {
    listSpy.mockReset()
  })
  afterEach(() => {
    listSpy.mockReset()
  })

  it('renders rows returned from the API, newest-first as-received', async () => {
    listSpy.mockResolvedValueOnce(
      page([
        row('r-3', { turn: 3, tool: 'propose_suggestion', durationMs: 120 }),
        row('r-2', { turn: 2, tool: 'get_current_state', durationMs: 80 }),
        row('r-1', { turn: 1, tool: 'plan_build_changes', durationMs: 30 }),
      ]),
    )

    render(<TraceDrawer open={true} onClose={() => {}} conversationId="conv-1" />)

    await waitFor(() => expect(screen.getByText('propose_suggestion')).toBeInTheDocument())
    expect(screen.getByText('get_current_state')).toBeInTheDocument()
    expect(screen.getByText('plan_build_changes')).toBeInTheDocument()
    expect(screen.getByText('120ms')).toBeInTheDocument()
    // nextCursor=null → no Load older button.
    expect(screen.queryByRole('button', { name: /Load older/i })).toBeNull()
  })

  it('shows Load older when nextCursor is set and fetches next page on click', async () => {
    listSpy.mockResolvedValueOnce(page([row('r-2', { turn: 2, tool: 'tool_A' })], 'cursor-abc'))
    listSpy.mockResolvedValueOnce(page([row('r-1', { turn: 1, tool: 'tool_B' })]))

    const user = userEvent.setup()
    render(<TraceDrawer open={true} onClose={() => {}} conversationId="conv-1" />)

    await waitFor(() => expect(screen.getByText('tool_A')).toBeInTheDocument())
    const loadOlder = screen.getByRole('button', { name: /Load older/i })
    await user.click(loadOlder)

    await waitFor(() => expect(screen.getByText('tool_B')).toBeInTheDocument())
    expect(listSpy).toHaveBeenCalledTimes(2)
    expect(listSpy).toHaveBeenLastCalledWith({
      conversationId: 'conv-1',
      cursor: 'cursor-abc',
      limit: 50,
    })
  })

  it('expands row details on click', async () => {
    listSpy.mockResolvedValueOnce(
      page([row('r-1', { paramsHash: 'deadbeef', tool: 'tool_X' })]),
    )
    const user = userEvent.setup()
    render(<TraceDrawer open={true} onClose={() => {}} conversationId="conv-1" />)

    await waitFor(() => expect(screen.getByText('tool_X')).toBeInTheDocument())
    expect(screen.queryByText(/paramsHash deadbeef/)).toBeNull()

    await user.click(screen.getByText('tool_X'))
    await waitFor(() =>
      expect(screen.getByText(/paramsHash deadbeef/)).toBeInTheDocument(),
    )
  })

  it('renders the empty-state copy when the API returns zero rows', async () => {
    listSpy.mockResolvedValueOnce(page([]))
    render(<TraceDrawer open={true} onClose={() => {}} conversationId="conv-1" />)
    await waitFor(() =>
      expect(screen.getByText(/No tool calls recorded/i)).toBeInTheDocument(),
    )
  })

  it('renders nothing when open=false', () => {
    const { container } = render(
      <TraceDrawer open={false} onClose={() => {}} conversationId="conv-1" />,
    )
    expect(container.firstChild).toBeNull()
    expect(listSpy).not.toHaveBeenCalled()
  })
})
