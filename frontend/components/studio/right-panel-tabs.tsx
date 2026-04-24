'use client'

// Sprint 046 — Studio design overhaul (plan T026 + FR-030).
//
// The right panel's tab controller: Plan / Preview / Tests (+ Ledger
// for admins). Hosts the tab bar + collapse chevron + the active tab
// panel. Consumes `useStudioShell()` for activeRightTab +
// rightCollapsed; calls back into the shell to toggle state.

import type { ReactNode } from 'react'
import type { KeyboardEvent } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'
import { useStudioShell } from './studio-shell-context'
import type { RightPanelTab } from './studio-shell-context'
import {
  PanelLeftIcon,
  PanelRightIcon,
  BookIcon,
  FlaskIcon,
} from './icons'

export interface RightPanelTabsProps {
  isAdmin: boolean
  rawPromptEditorEnabled: boolean

  planPanel: ReactNode
  previewPanel: ReactNode
  testsPanel: ReactNode
  ledgerPanel: ReactNode

  /** Utility strip pinned to the bottom of the panel (admin buttons). */
  utilityFooter?: ReactNode
}

interface TabDef {
  id: RightPanelTab
  label: string
  icon: (props: { size?: number }) => ReactNode
}

const BASE_TABS: TabDef[] = [
  { id: 'plan', label: 'Plan', icon: (p) => <PlanIcon {...p} /> },
  { id: 'preview', label: 'Preview', icon: (p) => <PreviewIcon {...p} /> },
  { id: 'tests', label: 'Tests', icon: (p) => <FlaskIcon size={p.size ?? 13} /> },
]

export function RightPanelTabs({
  isAdmin,
  rawPromptEditorEnabled,
  planPanel,
  previewPanel,
  testsPanel,
  ledgerPanel,
  utilityFooter,
}: RightPanelTabsProps) {
  const shell = useStudioShell()
  const { activeRightTab, setActiveRightTab, rightCollapsed, setRightCollapsed } = shell

  const ledgerVisible = isAdmin && rawPromptEditorEnabled
  const tabs: TabDef[] = ledgerVisible
    ? [...BASE_TABS, { id: 'ledger', label: 'Ledger', icon: (p) => <BookIcon size={p.size ?? 13} /> }]
    : BASE_TABS

  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeRightTab))

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(activeIndex + delta + tabs.length) % tabs.length]
    setActiveRightTab(next.id)
  }

  if (rightCollapsed) {
    return (
      <div
        className="flex h-full flex-col items-center"
        style={{
          borderLeft: 'none',
          padding: '8px 0',
        }}
      >
        <button
          type="button"
          aria-label="Expand right panel"
          onClick={() => setRightCollapsed(false)}
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: STUDIO_TOKENS_V2.muted,
            cursor: 'pointer',
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
          }}
        >
          <PanelLeftIcon size={16} />
        </button>
      </div>
    )
  }

  let body: ReactNode = null
  if (activeRightTab === 'plan') body = planPanel
  else if (activeRightTab === 'preview') body = previewPanel
  else if (activeRightTab === 'tests') body = testsPanel
  else if (activeRightTab === 'ledger' && ledgerVisible) body = ledgerPanel

  return (
    <div className="flex h-full flex-col min-h-0">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
          padding: '8px 8px 8px 10px',
          gap: 4,
        }}
      >
        <div
          role="tablist"
          aria-label="Studio right panel"
          style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, overflow: 'hidden' }}
        >
          {tabs.map((t) => {
            const active = t.id === activeRightTab
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                aria-controls={`right-panel-${t.id}`}
                id={`right-tab-${t.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setActiveRightTab(t.id)}
                onKeyDown={onTabKeyDown}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: active ? STUDIO_TOKENS_V2.ink : STUDIO_TOKENS_V2.muted,
                  background: active ? STUDIO_TOKENS_V2.surface2 : 'transparent',
                  border: 'none',
                  borderRadius: STUDIO_TOKENS_V2.radiusSm,
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {t.icon({ size: 13 })}
                </span>
                {t.label}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          aria-label="Collapse right panel"
          onClick={() => setRightCollapsed(true)}
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: STUDIO_TOKENS_V2.muted,
            cursor: 'pointer',
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            flexShrink: 0,
          }}
        >
          <PanelRightIcon size={16} />
        </button>
      </div>

      <section
        role="tabpanel"
        id={`right-panel-${activeRightTab}`}
        aria-labelledby={`right-tab-${activeRightTab}`}
        className="flex-1 min-h-0 overflow-auto"
      >
        {body}
      </section>

      {utilityFooter ? (
        <footer
          style={{
            borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {utilityFooter}
        </footer>
      ) : null}
    </div>
  )
}

// ─── Inline icons kept small and specific to the tab row ───────────────

function PlanIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      <circle cx="4" cy="6" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="4" cy="18" r="1.5" />
    </svg>
  )
}

function PreviewIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}
