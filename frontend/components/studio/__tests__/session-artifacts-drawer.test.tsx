/**
 * Sprint 051 A B1 — SessionArtifactsCard drawer-open wiring.
 *
 * Covers: when `onOpen` is wired, clicking a row fires the handler
 * (primary path) instead of following the deep-link anchor.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  SessionArtifactsCard,
  type SessionArtifact,
} from '../session-artifacts'

const base: SessionArtifact = {
  id: 'tx:xyz:sop:sop-x',
  artifact: 'sop',
  artifactId: 'sop-x',
  title: 'SOP · Early check-in',
  action: 'modified',
  at: new Date().toISOString(),
}

describe('SessionArtifactsCard — drawer wiring', () => {
  it('invokes onOpen with the artifact on row click', () => {
    const onOpen = vi.fn()
    render(<SessionArtifactsCard artifacts={[base]} onOpen={onOpen} />)
    const btn = screen.getByRole('button', {
      name: /Open SOP · Early check-in/i,
    })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: base.id }))
  })

  it('still falls back to the deep-link anchor when onOpen is not wired', () => {
    render(<SessionArtifactsCard artifacts={[base]} />)
    const link = screen.getByRole('link', {
      name: /Open SOP · Early check-in/i,
    }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/tuning/sops/sop-x')
    // No button on the primary row when onOpen is absent.
    expect(
      screen.queryByRole('button', {
        name: /Open SOP · Early check-in/i,
      }),
    ).not.toBeInTheDocument()
  })
})
