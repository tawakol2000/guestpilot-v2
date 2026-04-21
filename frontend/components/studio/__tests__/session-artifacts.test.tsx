/**
 * Sprint 050 A3 — SessionArtifactsCard unit tests.
 *
 * Covers: empty state, each action state chip (created / modified /
 * reverted), deep-link href on click, and the upsert helper's
 * newer-action-wins behaviour.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  SessionArtifactsCard,
  resolveArtifactDeepLink,
  upsertSessionArtifact,
  type SessionArtifact,
} from '../session-artifacts'

const base: SessionArtifact = {
  id: 'tx:abc:sop:sop-early-checkin',
  artifact: 'sop',
  artifactId: 'sop-early-checkin',
  title: 'SOP: early-checkin · CONFIRMED',
  action: 'created',
  at: new Date().toISOString(),
}

describe('SessionArtifactsCard', () => {
  it('renders the empty-state string when no artifacts have been touched', () => {
    render(<SessionArtifactsCard artifacts={[]} />)
    expect(
      screen.getByText('No artifacts touched in this session yet.'),
    ).toBeInTheDocument()
  })

  it('renders one row per artifact with the correct state chip and deep-link', () => {
    render(
      <SessionArtifactsCard
        artifacts={[
          base,
          { ...base, id: 'tx:abc:faq:faq-wifi', artifact: 'faq', artifactId: 'faq-wifi', title: 'FAQ · WiFi', action: 'modified' },
          {
            ...base,
            id: 'tx:abc:tool:tool-slack',
            artifact: 'tool',
            artifactId: 'tool-slack',
            title: 'Tool · slack-notify',
            action: 'reverted',
          },
        ]}
      />,
    )
    expect(screen.getByText('SOP: early-checkin · CONFIRMED')).toBeInTheDocument()
    expect(screen.getByText('FAQ · WiFi')).toBeInTheDocument()
    expect(screen.getByText('Tool · slack-notify')).toBeInTheDocument()

    // State chips are rendered in lowercase.
    expect(screen.getByText('created')).toBeInTheDocument()
    expect(screen.getByText('modified')).toBeInTheDocument()
    expect(screen.getByText('reverted')).toBeInTheDocument()

    // Deep-link routing
    const link = screen.getByRole('link', {
      name: /Open SOP: early-checkin/i,
    }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(
      '/tuning/sops/sop-early-checkin',
    )
  })
})

describe('resolveArtifactDeepLink', () => {
  it('routes each artifact type to the expected tuning page', () => {
    expect(
      resolveArtifactDeepLink({ ...base, artifact: 'faq', artifactId: 'faq-1' }),
    ).toBe('/tuning/faqs/faq-1')
    expect(
      resolveArtifactDeepLink({
        ...base,
        artifact: 'system_prompt',
        artifactId: 'tone',
      }),
    ).toBe('/configure-ai?section=tone')
    expect(
      resolveArtifactDeepLink({
        ...base,
        artifact: 'tool',
        artifactId: 'tool-x',
      }),
    ).toBe('/tools/tool-x')
    expect(
      resolveArtifactDeepLink({
        ...base,
        artifact: 'property_override',
        artifactId: 'prop-7',
      }),
    ).toBe('/properties/prop-7#overrides')
  })

  it('honours an explicit deepLink override', () => {
    expect(
      resolveArtifactDeepLink({ ...base, deepLink: '/custom/123' }),
    ).toBe('/custom/123')
  })
})

describe('upsertSessionArtifact', () => {
  it('inserts a new artifact at the head', () => {
    const list = upsertSessionArtifact([], base)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(base)
  })
  it('moves an existing artifact to the head with the newer action', () => {
    const first = base
    const second: SessionArtifact = {
      ...base,
      id: 'tx:abc:faq:faq-wifi',
      artifact: 'faq',
      artifactId: 'faq-wifi',
      title: 'FAQ · WiFi',
    }
    const afterInsert = upsertSessionArtifact([first], second)
    expect(afterInsert[0].id).toBe(second.id)

    const reverted: SessionArtifact = {
      ...first,
      action: 'reverted',
      at: new Date(Date.parse(first.at) + 1000).toISOString(),
    }
    const afterRevert = upsertSessionArtifact(afterInsert, reverted)
    expect(afterRevert).toHaveLength(2)
    expect(afterRevert[0].action).toBe('reverted')
    expect(afterRevert[0].id).toBe(first.id)
  })
})
