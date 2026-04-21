'use client'

/**
 * Sprint 047 Session C — admin-only raw-prompt editor drawer.
 *
 * Read-through only in this session. The three system-prompt regions
 * (shared / mode addendum / dynamic suffix) render in separate
 * scrollable panes so an admin can inspect what the agent actually
 * received without trawling through a single 20KB blob.
 *
 * Gating: the gear button that opens this drawer only renders when
 * all three of `traceViewEnabled` (kept for parity), `rawPromptEditorEnabled`
 * (dedicated env flag — `ENABLE_RAW_PROMPT_EDITOR`), and `isAdmin`
 * (tenant role) are true. The server enforces the same gates on the
 * data endpoint; this component assumes they've been checked upstream.
 *
 * Edit path is deliberately out of scope — per NEXT.md §7 the edit
 * round-trip lands in a later session if the read-through proves
 * useful.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  apiGetBuildSystemPrompt,
  type BuildAgentMode,
  type BuildSystemPromptResponse,
} from '@/lib/build-api'
import { STUDIO_COLORS } from './tokens'

export interface RawPromptDrawerProps {
  open: boolean
  onClose: () => void
  conversationId: string
}

type Region = 'shared' | 'modeAddendum' | 'dynamic'

const REGION_LABELS: Record<Region, string> = {
  shared: 'Shared prefix',
  modeAddendum: 'Mode addendum',
  dynamic: 'Dynamic suffix',
}

const REGION_SUBLABELS: Record<Region, string> = {
  shared: 'cached, mode-agnostic',
  modeAddendum: 'cached, mode-specific',
  dynamic: 'uncached, per-turn',
}

export function RawPromptDrawer(props: RawPromptDrawerProps) {
  const { open, onClose, conversationId } = props
  const [mode, setMode] = useState<BuildAgentMode>('BUILD')
  const [data, setData] = useState<BuildSystemPromptResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRegion, setActiveRegion] = useState<Region>('shared')

  const load = useCallback(
    async (nextMode: BuildAgentMode) => {
      setLoading(true)
      setError(null)
      try {
        const res = await apiGetBuildSystemPrompt(conversationId, nextMode)
        setData(res)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [conversationId],
  )

  useEffect(() => {
    if (!open) return
    setData(null)
    setActiveRegion('shared')
    load(mode)
  }, [open, mode, load])

  const regionText = useMemo(() => {
    if (!data) return ''
    return data.regions[activeRegion] ?? ''
  }, [data, activeRegion])

  if (!open) return null

  return (
    <>
      <button
        type="button"
        aria-label="Close raw-prompt drawer"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10, 10, 10, 0.25)',
          zIndex: 90,
          border: 'none',
          padding: 0,
          cursor: 'default',
        }}
      />
      <aside
        role="dialog"
        aria-label="Raw prompt editor (admin)"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 640,
          maxWidth: '100vw',
          background: STUDIO_COLORS.canvas,
          borderLeft: `1px solid ${STUDIO_COLORS.hairline}`,
          boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.08)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${STUDIO_COLORS.hairline}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: 'uppercase',
                color: STUDIO_COLORS.inkMuted,
              }}
            >
              Admin · read-only
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: STUDIO_COLORS.ink,
                marginTop: 2,
              }}
            >
              Raw system prompt
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ModeToggle mode={mode} onChange={setMode} />
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                borderRadius: 5,
                padding: '4px 10px',
                fontSize: 11,
                color: STUDIO_COLORS.inkMuted,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        </header>

        <nav
          aria-label="Prompt region"
          style={{
            display: 'flex',
            gap: 4,
            padding: '8px 16px',
            borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
            background: STUDIO_COLORS.surfaceRaised,
          }}
        >
          {(['shared', 'modeAddendum', 'dynamic'] as Region[]).map((r) => {
            const active = r === activeRegion
            const bytes = data?.bytes
              ? r === 'shared'
                ? data.bytes.shared
                : r === 'modeAddendum'
                  ? data.bytes.modeAddendum
                  : data.bytes.dynamic
              : null
            return (
              <button
                key={r}
                type="button"
                onClick={() => setActiveRegion(r)}
                style={{
                  flex: 1,
                  background: active
                    ? STUDIO_COLORS.accentSoft
                    : 'transparent',
                  border: `1px solid ${
                    active ? STUDIO_COLORS.accent : STUDIO_COLORS.hairline
                  }`,
                  borderRadius: 5,
                  padding: '6px 8px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: STUDIO_COLORS.ink,
                  }}
                >
                  {REGION_LABELS[r]}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: STUDIO_COLORS.inkSubtle,
                  }}
                >
                  {REGION_SUBLABELS[r]}
                  {bytes != null ? ` · ${formatBytes(bytes)}` : ''}
                </span>
              </button>
            )
          })}
        </nav>

        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 16px 16px',
          }}
        >
          {loading && !data ? (
            <div
              style={{ fontSize: 12, color: STUDIO_COLORS.inkSubtle }}
            >
              Loading…
            </div>
          ) : null}
          {error ? (
            <div
              style={{ fontSize: 12, color: STUDIO_COLORS.dangerFg }}
            >
              {error}
            </div>
          ) : null}
          {data ? (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: STUDIO_COLORS.inkSubtle,
                  marginBottom: 8,
                }}
              >
                {data.mode} · total {formatBytes(data.bytes.total)}
              </div>
              <pre
                style={{
                  flex: 1,
                  margin: 0,
                  padding: 12,
                  overflow: 'auto',
                  background: STUDIO_COLORS.surfaceSunken,
                  border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                  borderRadius: 5,
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: STUDIO_COLORS.ink,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                }}
              >
                {regionText}
              </pre>
            </>
          ) : null}
        </div>
      </aside>
    </>
  )
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: BuildAgentMode
  onChange: (next: BuildAgentMode) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Agent mode"
      style={{
        display: 'flex',
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 5,
        overflow: 'hidden',
      }}
    >
      {(['BUILD', 'TUNE'] as BuildAgentMode[]).map((m) => {
        const active = m === mode
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m)}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 500,
              background: active
                ? STUDIO_COLORS.accentSoft
                : 'transparent',
              color: active ? STUDIO_COLORS.ink : STUDIO_COLORS.inkMuted,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {m}
          </button>
        )
      })}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 100) return `${kb.toFixed(1)} KB`
  return `${Math.round(kb)} KB`
}
