'use client'

// Sprint 046 — Studio design overhaul (plan T011 + FR-020).
//
// 48px top bar: breadcrumb `{tenant} › Reply agent › {session title}`
// and amber-dot Draft environment pill. NO Publish button (spec
// Clarifications Q1). The hamburger toggle for narrow viewports mounts
// here via T044.

import type { ReactNode } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'
import { ChevronRightIcon, MenuIcon } from './icons'
import { useIsNarrow } from './hooks/use-is-narrow'
import { useStudioShell } from './studio-shell-context'

export interface TopBarProps {
  tenantName: string
  sessionTitle: string
  /**
   * Sprint 060-C — optional state-indicator chip slot. When present,
   * renders to the LEFT of the Draft environment pill in the top bar.
   * Kept as a slot rather than a typed prop so non-Studio callers don't
   * need to thread the StateChip dependency.
   */
  rightSlot?: ReactNode
}

export function TopBar({ tenantName, sessionTitle, rightSlot }: TopBarProps) {
  const { isNarrow } = useIsNarrow()
  const shell = useStudioShell()
  const showMenuButton = isNarrow
  const onMenuClick = () => shell.setLeftCollapsed(false)

  return (
    <header
      role="banner"
      style={{
        height: 48,
        minHeight: 48,
        padding: '0 20px',
        borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
        background: STUDIO_TOKENS_V2.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {showMenuButton ? (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open navigation"
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
            <MenuIcon size={16} />
          </button>
        ) : null}
        <nav
          aria-label="Studio breadcrumb"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            fontSize: 12.5,
          }}
        >
          <span style={{ color: STUDIO_TOKENS_V2.muted }}>{tenantName}</span>
          <ChevronRightIcon
            size={12}
            style={{ color: STUDIO_TOKENS_V2.muted2, flexShrink: 0 }}
          />
          <span style={{ color: STUDIO_TOKENS_V2.muted }}>Reply agent</span>
          <ChevronRightIcon
            size={12}
            style={{ color: STUDIO_TOKENS_V2.muted2, flexShrink: 0 }}
          />
          <span
            style={{
              color: STUDIO_TOKENS_V2.ink,
              fontWeight: 500,
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
            title={sessionTitle}
          >
            {sessionTitle}
          </span>
        </nav>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {rightSlot}
        <span
          role="status"
          aria-label="Draft environment"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: 99,
            padding: '4px 9px',
            fontSize: 11.5,
            color: STUDIO_TOKENS_V2.muted,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: STUDIO_TOKENS_V2.amber,
            }}
          />
          Draft
        </span>
      </div>
    </header>
  )
}
