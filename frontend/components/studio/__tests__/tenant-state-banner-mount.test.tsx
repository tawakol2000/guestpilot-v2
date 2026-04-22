/**
 * Sprint 058-A F5 — the sticky TenantStateBanner is mounted at the top
 * of the chat scroll container when StudioChat receives a tenantState.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'

beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {}
  }
})

const hoisted = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  status: { current: 'ready' as string },
}))

vi.mock('@/lib/api', () => ({
  getToken: () => 'tok',
}))

vi.mock('@/lib/build-api', () => ({
  apiEnhancePrompt: vi.fn(),
  apiAcceptSuggestedFix: vi.fn(),
  apiRejectSuggestedFix: vi.fn(),
  buildTurnEndpoint: () => '/api/build/chat',
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    sendMessage: hoisted.sendMessage,
    status: hoisted.status.current,
    error: null,
  }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

vi.mock('ai', () => ({
  DefaultChatTransport: class {},
}))

import { StudioChat } from '../studio-chat'
import type { BuildTenantState } from '@/lib/build-api'

beforeEach(() => {
  hoisted.status.current = 'ready'
  hoisted.sendMessage.mockReset()
})

function tenantState(overrides: Partial<BuildTenantState> = {}): BuildTenantState {
  return {
    isGreenfield: false,
    mode: 'BROWNFIELD',
    interviewProgress: '',
    sopCount: 0,
    faqCounts: { global: 0, perProperty: 0 },
    customToolCount: 0,
    propertyCount: 0,
    lastBuildTransaction: null,
    ...overrides,
  } as BuildTenantState
}

describe('StudioChat F5 — TenantStateBanner mount', () => {
  it('renders the banner at the top of the chat when tenantState is provided', async () => {
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
        tenantState={tenantState()}
      />,
    )
    const banner = await screen.findByTestId('tenant-state-banner')
    expect(banner).toBeInTheDocument()
    const pill = screen.getByTestId('tenant-state-pill')
    expect(pill.getAttribute('data-mode')).toBe('BROWNFIELD')
  })

  it('greenfield tenantState renders the GREENFIELD pill', async () => {
    render(
      <StudioChat
        conversationId="c1"
        greenfield={true}
        initialMessages={[]}
        tenantState={tenantState({ isGreenfield: true, mode: 'GREENFIELD' })}
      />,
    )
    const pill = await screen.findByTestId('tenant-state-pill')
    expect(pill.getAttribute('data-mode')).toBe('GREENFIELD')
  })

  it('omits the banner when tenantState is not passed', () => {
    render(
      <StudioChat
        conversationId="c1"
        greenfield={false}
        initialMessages={[]}
      />,
    )
    expect(screen.queryByTestId('tenant-state-banner')).not.toBeInTheDocument()
  })
})
