'use client'

/**
 * Sprint 058-A F5 — sticky tenant-state banner.
 *
 * A 32-px-tall row pinned to the top of the Studio chat scroll area.
 * Left: state pill (GREENFIELD / BROWNFIELD, color-coded).
 * Middle: prompt-status caption ("System prompt — v7, edited 2h ago" or
 *   "No system prompt yet" for greenfield tenants with no prompt).
 * Right: chevron that opens the system-prompt drawer in read mode.
 *
 * Graceful degradation — returns null when `state` is nullish so the
 * surface never crashes on boot. Clicking the caption or chevron fires
 * `onOpenPrompt`; the parent owns the drawer.
 */
import { ChevronRight } from 'lucide-react'
import { STUDIO_COLORS } from './tokens'
import type { BuildTenantState } from '@/lib/build-api'

export interface TenantStateBannerProps {
  state: BuildTenantState | null
  /** Caption sub-text: the active prompt's label + last-edited hint. */
  promptCaption?: string | null
  /** Wire to the existing raw-prompt drawer opener in studio-surface. */
  onOpenPrompt?: () => void
  /** Wire for greenfield "seed a prompt" affordance. Composer-seed helper. */
  onSeedPromptInterview?: () => void
}

export function TenantStateBanner({
  state,
  promptCaption,
  onOpenPrompt,
  onSeedPromptInterview,
}: TenantStateBannerProps) {
  if (!state) return null

  // `mode` is the internal enum — stable for `data-mode` hooks, tests,
  // and styling selectors. `modeLabel` is the operator-facing text:
  // "GREENFIELD/BROWNFIELD" is engineering jargon, so the visible pill
  // reads "Setup" (no existing config) vs "Live" (running).
  const mode = state.isGreenfield ? 'GREENFIELD' : 'BROWNFIELD'
  const modeLabel = state.isGreenfield ? 'SETUP' : 'LIVE'
  const pillStyle = state.isGreenfield
    ? { bg: STUDIO_COLORS.warnBg, fg: STUDIO_COLORS.warnFg }
    : { bg: STUDIO_COLORS.accentSoft, fg: STUDIO_COLORS.accent }

  const hasPrompt = Boolean(promptCaption)
  const caption = hasPrompt
    ? promptCaption
    : state.isGreenfield
    ? 'No system prompt yet — ask the agent to write one'
    : 'System prompt — unedited since seed'

  const canOpen = hasPrompt && !!onOpenPrompt
  const showSeed =
    !hasPrompt && state.isGreenfield && typeof onSeedPromptInterview === 'function'

  return (
    <div
      data-testid="tenant-state-banner"
      role="region"
      aria-label="Tenant state banner"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 32,
        padding: '0 12px',
        background: STUDIO_COLORS.surfaceSunken,
        borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        fontSize: 11.5,
        lineHeight: 1.2,
      }}
    >
      <span
        data-testid="tenant-state-pill"
        data-mode={mode}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.3,
          background: pillStyle.bg,
          color: pillStyle.fg,
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        {modeLabel}
      </span>

      {canOpen ? (
        <button
          type="button"
          data-testid="tenant-state-caption-button"
          onClick={onOpenPrompt}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: STUDIO_COLORS.ink,
            fontSize: 11.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {caption}
        </button>
      ) : (
        <span
          data-testid="tenant-state-caption"
          style={{
            flex: 1,
            minWidth: 0,
            color: STUDIO_COLORS.inkMuted,
            fontSize: 11.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {caption}
        </span>
      )}

      {showSeed ? (
        <button
          type="button"
          data-testid="tenant-state-seed-button"
          onClick={onSeedPromptInterview}
          style={{
            background: 'transparent',
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            borderRadius: 5,
            padding: '2px 8px',
            fontSize: 11,
            color: STUDIO_COLORS.accent,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Seed prompt
        </button>
      ) : null}

      {canOpen ? (
        <button
          type="button"
          data-testid="tenant-state-open-prompt-chevron"
          aria-label="Open system prompt drawer"
          onClick={onOpenPrompt}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            padding: 2,
            cursor: 'pointer',
            color: STUDIO_COLORS.inkMuted,
            flexShrink: 0,
          }}
        >
          <ChevronRight size={14} />
        </button>
      ) : null}
    </div>
  )
}
