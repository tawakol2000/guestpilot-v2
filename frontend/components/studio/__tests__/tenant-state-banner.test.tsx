/**
 * Sprint 058-A F5 — tenant-state banner tests.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { TenantStateBanner } from '../tenant-state-banner'
import type { BuildTenantState } from '@/lib/build-api'

function makeState(overrides: Partial<BuildTenantState> = {}): BuildTenantState {
  return {
    sopCount: 5,
    faqCounts: { global: 10, perProperty: 2 },
    customToolCount: 1,
    propertyCount: 3,
    isGreenfield: false,
    ...overrides,
  }
}

describe('TenantStateBanner', () => {
  it('renders null when state is null (graceful degradation)', () => {
    const { container } = render(<TenantStateBanner state={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders LIVE pill for non-greenfield tenant (BROWNFIELD enum)', () => {
    render(
      <TenantStateBanner
        state={makeState({ isGreenfield: false })}
        promptCaption="System prompt — v7, edited 2h ago"
      />,
    )
    const pill = screen.getByTestId('tenant-state-pill')
    // data-mode preserves the internal enum for styling + automation
    // stability; the visible text is the operator-facing label.
    expect(pill).toHaveAttribute('data-mode', 'BROWNFIELD')
    expect(pill.textContent).toBe('LIVE')
  })

  it('renders SETUP pill for greenfield tenant (GREENFIELD enum)', () => {
    render(
      <TenantStateBanner
        state={makeState({ isGreenfield: true })}
        promptCaption={null}
      />,
    )
    const pill = screen.getByTestId('tenant-state-pill')
    expect(pill).toHaveAttribute('data-mode', 'GREENFIELD')
    expect(pill.textContent).toBe('SETUP')
  })

  it('renders the prompt caption when present', () => {
    render(
      <TenantStateBanner
        state={makeState()}
        promptCaption="System prompt — v3, edited 5m ago"
      />,
    )
    expect(screen.getByText(/System prompt — v3/)).toBeInTheDocument()
  })

  it('renders a "no prompt yet" greenfield caption when promptCaption is absent', () => {
    render(
      <TenantStateBanner
        state={makeState({ isGreenfield: true })}
        promptCaption={null}
      />,
    )
    expect(
      screen.getByText(/No system prompt yet/),
    ).toBeInTheDocument()
  })

  it('renders a "unedited since seed" caption for brownfield with no prompt info', () => {
    render(<TenantStateBanner state={makeState({ isGreenfield: false })} />)
    expect(
      screen.getByText(/unedited since seed/),
    ).toBeInTheDocument()
  })

  it('calls onOpenPrompt when the caption button is clicked', () => {
    const onOpen = vi.fn()
    render(
      <TenantStateBanner
        state={makeState()}
        promptCaption="System prompt — v2"
        onOpenPrompt={onOpen}
      />,
    )
    fireEvent.click(screen.getByTestId('tenant-state-caption-button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenPrompt when the chevron is clicked', () => {
    const onOpen = vi.fn()
    render(
      <TenantStateBanner
        state={makeState()}
        promptCaption="System prompt — v2"
        onOpenPrompt={onOpen}
      />,
    )
    fireEvent.click(screen.getByTestId('tenant-state-open-prompt-chevron'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders a Seed prompt button for greenfield+no-prompt when handler is provided', () => {
    const onSeed = vi.fn()
    render(
      <TenantStateBanner
        state={makeState({ isGreenfield: true })}
        promptCaption={null}
        onSeedPromptInterview={onSeed}
      />,
    )
    const seedBtn = screen.getByTestId('tenant-state-seed-button')
    fireEvent.click(seedBtn)
    expect(onSeed).toHaveBeenCalledTimes(1)
  })

  it('does not render Seed prompt button when tenant is not greenfield', () => {
    const onSeed = vi.fn()
    render(
      <TenantStateBanner
        state={makeState({ isGreenfield: false })}
        promptCaption={null}
        onSeedPromptInterview={onSeed}
      />,
    )
    expect(screen.queryByTestId('tenant-state-seed-button')).toBeNull()
  })

  it('has sticky positioning for scroll-area pinning', () => {
    render(
      <TenantStateBanner
        state={makeState()}
        promptCaption="System prompt — v1"
      />,
    )
    const banner = screen.getByTestId('tenant-state-banner')
    // Inline style from the component
    expect(banner.style.position).toBe('sticky')
    expect(banner.style.top).toBe('0px')
  })
})
