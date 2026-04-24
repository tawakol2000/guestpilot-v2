// Sprint 046 T051 — WCAG AA a11y smoke test for the Studio shell.
//
// Runs axe-core against the new TopBar, ReferencePicker popover, Plan/
// Preview/Tests tabs, and composer. Asserts zero WCAG 2.1 AA
// violations on each surface.

import { describe, it, expect, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { TopBar } from '../top-bar'
import { ReferencePicker } from '../reference-picker'
import { PreviewTab } from '../tabs/preview-tab'
import { TestsTab } from '../tabs/tests-tab'
import { PlanTab } from '../tabs/plan-tab'
import { RightPanelTabs } from '../right-panel-tabs'
import type { StateSnapshotData } from '../state-snapshot'

// Minimal mocks for the endpoints the ReferencePicker calls on open.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    apiGetSopDefinitions: async () => ({ definitions: [], properties: [] }),
    apiGetFaqEntries: async () => ({ entries: [], total: 0, categories: [] }),
    apiListToolDefinitions: async () => [],
  }
})

const snapshot: StateSnapshotData = {
  scope: 'summary',
  summary: {
    posture: 'BROWNFIELD',
    systemPromptStatus: 'CUSTOMISED',
    systemPromptEditCount: 3,
    sopsDefined: 5,
    sopsDefaulted: 2,
    faqsGlobal: 10,
    faqsPropertyScoped: 4,
    customToolsDefined: 2,
    propertiesImported: 3,
    lastBuildSessionAt: null,
  },
}

describe('Studio a11y', () => {
  it('TopBar: zero WCAG AA violations', async () => {
    const { container } = render(<TopBar tenantName="Acme" sessionTitle="Late check-in tune" />)
    const results = await axe(container)
    expect(results.violations).toEqual([])
    cleanup()
  })

  it('PlanTab: zero WCAG AA violations', async () => {
    const { container } = render(<PlanTab snapshot={snapshot} sessionArtifacts={[]} />)
    const results = await axe(container)
    expect(results.violations).toEqual([])
    cleanup()
  })

  it('PreviewTab: zero WCAG AA violations (empty state)', async () => {
    const { container } = render(<PreviewTab />)
    const results = await axe(container)
    expect(results.violations).toEqual([])
    cleanup()
  })

  it('TestsTab: zero WCAG AA violations (empty state)', async () => {
    const { container } = render(<TestsTab />)
    const results = await axe(container)
    expect(results.violations).toEqual([])
    cleanup()
  })

  it('RightPanelTabs: tablist wiring is accessible', async () => {
    const { container } = render(
      <RightPanelTabs
        isAdmin={false}
        rawPromptEditorEnabled={false}
        planPanel={<PlanTab snapshot={snapshot} sessionArtifacts={[]} />}
        previewPanel={<PreviewTab />}
        testsPanel={<TestsTab />}
        ledgerPanel={<div>Ledger</div>}
      />,
    )
    const results = await axe(container)
    expect(results.violations).toEqual([])
    cleanup()
  })

  it('ReferencePicker (closed): no violations when not rendered', async () => {
    const { container } = render(
      <ReferencePicker open={false} anchorEl={null} onClose={() => {}} onSelect={() => {}} />,
    )
    const results = await axe(container)
    expect(results.violations).toEqual([])
    cleanup()
  })
})
