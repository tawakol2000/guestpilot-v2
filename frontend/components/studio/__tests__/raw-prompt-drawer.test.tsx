/**
 * Sprint 047 Session C — RawPromptDrawer component test.
 *
 * Covers: the three-region tab layout, mode toggle re-fetches, the
 * byte-count labels on each tab, and that open=false does not fire a
 * network call.
 *
 * `apiGetBuildSystemPrompt` is mocked at module load so the component
 * never hits the network in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type {
  BuildAgentMode,
  BuildSystemPromptResponse,
} from '@/lib/build-api'

const fetchSpy = vi.fn(
  async (
    _conversationId: string,
    _mode: BuildAgentMode = 'BUILD',
  ): Promise<BuildSystemPromptResponse> => ({
    mode: 'BUILD',
    conversationId: 'conv-1',
    regions: { shared: '', modeAddendum: '', dynamic: '' },
    assembled: '',
    bytes: { shared: 0, modeAddendum: 0, dynamic: 0, total: 0 },
  }),
)

vi.mock('@/lib/build-api', () => ({
  apiGetBuildSystemPrompt: (conversationId: string, mode?: BuildAgentMode) =>
    fetchSpy(conversationId, mode ?? 'BUILD'),
}))

import { RawPromptDrawer } from '../raw-prompt-drawer'

const resp = (
  overrides: Partial<BuildSystemPromptResponse> = {},
): BuildSystemPromptResponse => ({
  mode: 'BUILD',
  conversationId: 'conv-1',
  regions: {
    shared: '<principles>BUILD principles</principles>',
    modeAddendum: '<build_mode>BUILD addendum</build_mode>',
    dynamic: '<tenant_state>snapshot</tenant_state>',
  },
  assembled: '… assembled …',
  bytes: { shared: 2048, modeAddendum: 512, dynamic: 1024, total: 3584 },
  ...overrides,
})

describe('RawPromptDrawer', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })
  afterEach(() => {
    fetchSpy.mockReset()
  })

  it('renders three region tabs with byte-count labels and shows the shared region by default', async () => {
    fetchSpy.mockResolvedValueOnce(resp())

    render(
      <RawPromptDrawer
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
      />,
    )

    await waitFor(() =>
      expect(screen.getByText(/BUILD principles/)).toBeInTheDocument(),
    )
    // Tab labels visible
    expect(screen.getByText('Shared prefix')).toBeInTheDocument()
    expect(screen.getByText('Mode addendum')).toBeInTheDocument()
    expect(screen.getByText('Dynamic suffix')).toBeInTheDocument()
    // Byte count formatted (2048 B → "2.0 KB")
    expect(screen.getByText(/cached, mode-agnostic · 2\.0 KB/)).toBeInTheDocument()
  })

  it('swaps the visible region when a tab is clicked', async () => {
    fetchSpy.mockResolvedValueOnce(resp())
    const user = userEvent.setup()

    render(
      <RawPromptDrawer
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
      />,
    )

    await waitFor(() =>
      expect(screen.getByText(/BUILD principles/)).toBeInTheDocument(),
    )

    await user.click(screen.getByText('Dynamic suffix'))
    await waitFor(() =>
      expect(screen.getByText(/<tenant_state>snapshot/)).toBeInTheDocument(),
    )
  })

  it('re-fetches with mode=TUNE when the mode toggle flips', async () => {
    fetchSpy.mockResolvedValueOnce(resp())
    fetchSpy.mockResolvedValueOnce(
      resp({
        mode: 'TUNE',
        regions: {
          shared: '<principles>BUILD principles</principles>',
          modeAddendum: '<tune_mode>TUNE addendum</tune_mode>',
          dynamic: '<pending_suggestions>pending</pending_suggestions>',
        },
      }),
    )
    const user = userEvent.setup()

    render(
      <RawPromptDrawer
        open={true}
        onClose={() => {}}
        conversationId="conv-1"
      />,
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(fetchSpy).toHaveBeenLastCalledWith('conv-1', 'BUILD')

    await user.click(screen.getByRole('tab', { name: 'TUNE' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(fetchSpy).toHaveBeenLastCalledWith('conv-1', 'TUNE')

    // After the TUNE fetch resolves, clicking the mode addendum tab
    // should show the TUNE addendum.
    await user.click(screen.getByText('Mode addendum'))
    await waitFor(() =>
      expect(screen.getByText(/TUNE addendum/)).toBeInTheDocument(),
    )
  })

  it('does not fetch when open=false', () => {
    const { container } = render(
      <RawPromptDrawer
        open={false}
        onClose={() => {}}
        conversationId="conv-1"
      />,
    )
    expect(container.firstChild).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
