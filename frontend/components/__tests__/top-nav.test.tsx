/**
 * Sprint 049 Session A — A4.
 *
 * The discovery report (§audit-verification.#4) flagged two dead hrefs in
 * the tuning top-nav: `/tuning` (the Suggestions entry — 404 because
 * `app/tuning/` has no root page.tsx) and `/tuning/agent` (404 because
 * there's no `agent/` subdirectory). A manager clicking either landed on
 * a Next.js 404 on every tuning page.
 *
 * This spec locks the fix: the rendered nav must never carry either href.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  usePathname: () => '/tuning/sessions',
}))

import { TuningTopNav } from '../tuning/top-nav'

describe('TuningTopNav', () => {
  it('does not render a link to /tuning or /tuning/agent (both 404)', () => {
    render(<TuningTopNav />)
    const links = screen.getAllByRole('link')
    const hrefs = links.map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain('/tuning')
    expect(hrefs).not.toContain('/tuning/agent')
  })

  it('renders only hrefs under /tuning/<known-page> plus the Inbox breadcrumb', () => {
    render(<TuningTopNav />)
    const hrefs = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
      .filter((h): h is string => Boolean(h))
    const tuningHrefs = hrefs.filter((h) => h.startsWith('/tuning'))
    const known = new Set([
      '/tuning/sessions',
      '/tuning/playground',
      '/tuning/history',
      '/tuning/pairs',
      '/tuning/capability-requests',
    ])
    for (const h of tuningHrefs) {
      expect(known.has(h)).toBe(true)
    }
    expect(tuningHrefs).toHaveLength(5)
    expect(hrefs).toContain('/')
  })
})
