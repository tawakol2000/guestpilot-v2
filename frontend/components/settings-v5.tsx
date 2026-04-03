'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  apiGetImportProgress,
  apiRunImport,
  apiToggleAIAll,
  apiToggleAIProperty,
  apiGetPropertiesAiStatus,
  type PropertyAiStatus,
  apiDeleteAllData,
  apiCleanupOrphanReservations,
  apiChangePassword,
  apiGetTenantAiConfig,
  apiUpdateTenantAiConfig,
  getTenantMeta,
  type ImportProgress,
  apiGetHostawayConnectStatus,
  apiDisconnectHostaway,
  apiHostawayConnectManual,
  type HostawayConnectStatus,
} from '@/lib/api'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706' },
  border: { default: '#E7E5E4', strong: '#1C1917' },
  shadow: {
    sm: '0 1px 2px rgba(12,10,9,0.04)',
    md: '0 4px 6px -1px rgba(12,10,9,0.06), 0 2px 4px -2px rgba(12,10,9,0.04)',
    lg: '0 10px 25px -5px rgba(12,10,9,0.08), 0 4px 10px -5px rgba(12,10,9,0.03)',
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

// ─── Style injection ─────────────────────────────────────────────────────────
const STYLE_ID = 'settings-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=JetBrains+Mono:wght@400;500;600&display=swap');
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes settingsFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `
  document.head.appendChild(style)
}

// ─── Shared style helpers ─────────────────────────────────────────────────────
const cardStyle: React.CSSProperties = {
  background: T.bg.primary,
  border: `1px solid ${T.border.default}`,
  borderRadius: T.radius.md,
  marginBottom: 16,
  boxShadow: T.shadow.sm,
}

const cardHeaderStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: T.text.tertiary,
  borderBottom: `1px solid ${T.border.default}`,
  background: T.bg.secondary,
  borderRadius: `${T.radius.md}px ${T.radius.md}px 0 0`,
  fontFamily: T.font.sans,
}

const cardBodyStyle: React.CSSProperties = {
  padding: 16,
}

const btnPrimary: React.CSSProperties = {
  background: T.border.strong,
  color: '#FFFFFF',
  borderRadius: T.radius.sm,
  height: 34,
  padding: '0 16px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  fontFamily: T.font.sans,
  transition: 'all 0.2s ease',
}

const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: T.text.primary,
  border: `1px solid ${T.border.default}`,
  borderRadius: T.radius.sm,
  height: 34,
  padding: '0 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: T.font.sans,
  transition: 'all 0.2s ease',
}

const btnDanger: React.CSSProperties = {
  background: T.status.red,
  color: '#FFFFFF',
  borderRadius: T.radius.sm,
  height: 34,
  padding: '0 16px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  fontFamily: T.font.sans,
  transition: 'all 0.2s ease',
}

const focusInputStyle: React.CSSProperties = {
  transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
}

// ─── Focus hook for inputs/textareas ──────────────────────────────────────────
function useFocusStyle(): {
  focused: boolean
  handlers: { onFocus: () => void; onBlur: () => void }
  focusStyles: React.CSSProperties
} {
  const [focused, setFocused] = useState(false)
  return {
    focused,
    handlers: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
    focusStyles: focused
      ? { borderColor: T.accent, boxShadow: '0 0 0 2px rgba(29,78,216,0.15)' }
      : {},
  }
}

// ─── Hover hook ───────────────────────────────────────────────────────────────
function useHover(): { hovered: boolean; handlers: { onMouseEnter: () => void; onMouseLeave: () => void } } {
  const [hovered, setHovered] = useState(false)
  return {
    hovered,
    handlers: { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) },
  }
}

// ─── Phase helpers ────────────────────────────────────────────────────────────
const PHASE_PCT: Record<ImportProgress['phase'], number> = {
  idle: 0,
  deleting: 15,
  listings: 35,
  reservations: 60,
  messages: 85,
  done: 100,
  error: 100,
}

const PHASE_LABEL: Record<ImportProgress['phase'], string> = {
  idle: 'Ready',
  deleting: 'Clearing previous data…',
  listings: 'Syncing listings…',
  reservations: 'Syncing reservations…',
  messages: 'Syncing messages…',
  done: 'Sync complete',
  error: 'Error',
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── Saved feedback component ─────────────────────────────────────────────────
function SavedFeedback({ visible }: { visible: boolean }): React.ReactElement | null {
  if (!visible) return null
  return (
    <span
      style={{
        fontSize: 12,
        color: T.status.green,
        fontFamily: T.font.sans,
        fontWeight: 600,
        animation: 'settingsFadeIn 0.2s ease',
      }}
    >
      Saved!
    </span>
  )
}

// ─── Section A: Data Sync ─────────────────────────────────────────────────────
function DataSyncSection({ onImportComplete }: { onImportComplete: () => void }): React.ReactElement {
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [showSyncModal, setShowSyncModal] = useState(false)
  const [preserveLearnedAnswers, setPreserveLearnedAnswers] = useState(true)
  const [preservePropertyChunks, setPreservePropertyChunks] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncBtnHover = useHover()
  const propBtnHover = useHover()
  const convBtnHover = useHover()

  const isSyncing =
    !!progress &&
    progress.phase !== 'idle' &&
    progress.phase !== 'done' &&
    progress.phase !== 'error'

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const p = await apiGetImportProgress()
        setProgress(p)
        if (p.phase === 'done' || p.phase === 'error') {
          stopPolling()
          if (p.phase === 'done') onImportComplete()
        }
      } catch {
        // silent
      }
    }, 800)
  }, [stopPolling, onImportComplete])

  useEffect(() => {
    apiGetImportProgress()
      .then((p) => {
        setProgress(p)
        if (p.phase !== 'idle' && p.phase !== 'done' && p.phase !== 'error') {
          startPolling()
        }
      })
      .catch(err => console.error('[Sync] Failed to get import progress:', err))
    return stopPolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSync(listingsOnly: boolean, opts?: { conversationsOnly?: boolean; preserveLearnedAnswers?: boolean; preservePropertyChunks?: boolean }): Promise<void> {
    setShowSyncModal(false)
    setProgress((prev) => ({
      phase: 'deleting',
      total: 0,
      completed: 0,
      message: 'Starting…',
      lastSyncedAt: prev?.lastSyncedAt ?? null,
    }))
    try {
      await apiRunImport({ listingsOnly, ...opts })
      startPolling()
    } catch (err) {
      setProgress((prev) => ({
        ...(prev ?? { total: 0, completed: 0, message: '' }),
        phase: 'error',
        message: err instanceof Error ? err.message : 'Failed to start',
        lastSyncedAt: prev?.lastSyncedAt ?? null,
      }))
    }
  }

  const phase = progress?.phase ?? 'idle'
  const pct = PHASE_PCT[phase]
  const isError = phase === 'error'

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0s' }}>
      <div style={cardHeaderStyle}>Data Sync</div>
      <div style={cardBodyStyle}>
        {/* Last sync */}
        <div style={{ fontSize: 12, color: T.text.tertiary, marginBottom: 12, fontFamily: T.font.mono }}>
          Last sync: {formatSyncTime(progress?.lastSyncedAt ?? null)}
        </div>

        {/* Progress bar -- only when syncing */}
        {isSyncing && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                height: 4,
                borderRadius: T.radius.sm,
                background: T.bg.tertiary,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: T.radius.sm,
                  background: isError
                    ? T.status.red
                    : T.border.strong,
                  width: `${pct}%`,
                  transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: T.text.secondary, marginTop: 6, fontFamily: T.font.mono }}>
              {PHASE_LABEL[phase]}
              {(progress?.total ?? 0) > 0 && (
                <span style={{ color: T.text.primary, fontWeight: 600, marginLeft: 6 }}>
                  {progress?.completed ?? 0} / {progress?.total}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Error message */}
        {isError && progress?.error && (
          <div style={{ fontSize: 12, color: T.status.red, marginBottom: 12, fontFamily: T.font.sans }}>
            {progress.error}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            style={{
              ...btnPrimary,
              opacity: isSyncing ? 0.5 : syncBtnHover.hovered ? 0.85 : 1,
              cursor: isSyncing ? 'not-allowed' : 'pointer',
            }}
            disabled={isSyncing}
            onClick={() => setShowSyncModal(true)}
            {...syncBtnHover.handlers}
          >
            Sync from Hostaway
          </button>
          <button
            style={{
              ...btnGhost,
              opacity: isSyncing ? 0.5 : 1,
              cursor: isSyncing ? 'not-allowed' : 'pointer',
              background: !isSyncing && propBtnHover.hovered ? T.bg.secondary : 'transparent',
            }}
            disabled={isSyncing}
            onClick={() => runSync(true)}
            {...propBtnHover.handlers}
          >
            Sync Properties Only
          </button>
          <button
            style={{
              ...btnGhost,
              opacity: isSyncing ? 0.5 : 1,
              cursor: isSyncing ? 'not-allowed' : 'pointer',
              background: !isSyncing && convBtnHover.hovered ? T.bg.secondary : 'transparent',
            }}
            disabled={isSyncing}
            onClick={() => runSync(false, { conversationsOnly: true })}
            {...convBtnHover.handlers}
          >
            Sync Conversations Only
          </button>
        </div>
      </div>

      {/* Sync confirmation modal */}
      {showSyncModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowSyncModal(false)}>
          <div
            style={{
              background: T.bg.primary, borderRadius: T.radius.lg, padding: 24, width: 400,
              boxShadow: T.shadow.lg, fontFamily: T.font.sans,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, marginBottom: 4 }}>
              Full Sync from Hostaway
            </div>
            <div style={{ fontSize: 12, color: T.text.secondary, marginBottom: 16 }}>
              This will delete all conversations, reservations, and messages, then re-import everything. Select what to preserve:
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, color: T.text.primary, cursor: 'pointer' }}>
              <input type="checkbox" checked={preserveLearnedAnswers} onChange={e => setPreserveLearnedAnswers(e.target.checked)} />
              Preserve Learned Answers
              <span style={{ fontSize: 11, color: T.text.tertiary }}>(Q&A from manager approvals)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: T.text.primary, cursor: 'pointer' }}>
              <input type="checkbox" checked={preservePropertyChunks} onChange={e => setPreservePropertyChunks(e.target.checked)} />
              Preserve Property RAG Chunks
              <span style={{ fontSize: 11, color: T.text.tertiary }}>(info, description, amenities)</span>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                style={{ ...btnGhost, height: 32, padding: '0 14px', fontSize: 12 }}
                onClick={() => setShowSyncModal(false)}
              >
                Cancel
              </button>
              <button
                style={{ ...btnPrimary, height: 32, padding: '0 14px', fontSize: 12 }}
                onClick={() => runSync(false, { preserveLearnedAnswers, preservePropertyChunks })}
              >
                Start Sync
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── AI Mode helpers ──────────────────────────────────────────────────────────
const AI_MODES = ['autopilot', 'copilot', 'off'] as const
type AiMode = typeof AI_MODES[number]

const modeConfig: Record<AiMode, { label: string; color: string; bg: string; icon: string }> = {
  autopilot: { label: 'Autopilot', color: '#15803D', bg: 'rgba(21,128,61,0.08)', icon: '⚡' },
  copilot:   { label: 'Copilot',   color: '#1D4ED8', bg: 'rgba(29,78,216,0.08)', icon: '👤' },
  off:       { label: 'Off',       color: T.text.tertiary, bg: 'rgba(168,162,158,0.08)', icon: '⏸' },
}

function nextMode(current: AiMode): AiMode {
  const idx = AI_MODES.indexOf(current)
  return AI_MODES[(idx + 1) % AI_MODES.length]
}

// ─── Property AI Card ─────────────────────────────────────────────────────────
function PropertyAiCard({
  property,
  onToggle,
}: {
  property: PropertyAiStatus
  onToggle: (id: string, mode: AiMode) => Promise<void>
}): React.ReactElement {
  const [mode, setMode] = useState<AiMode>(property.aiMode)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const cfg = modeConfig[mode]

  useEffect(() => { setMode(property.aiMode as AiMode) }, [property.aiMode])

  async function handleClick(): Promise<void> {
    const next = nextMode(mode)
    setLoading(true)
    try {
      await onToggle(property.id, next)
      setMode(next)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: T.radius.sm,
        border: `1px solid ${hovered ? cfg.color : T.border.default}`,
        background: hovered ? cfg.bg : T.bg.primary,
        boxShadow: hovered ? T.shadow.sm : 'none',
        cursor: loading ? 'wait' : 'pointer',
        transition: 'all 0.15s ease',
        textAlign: 'left',
        fontFamily: T.font.sans,
        minWidth: 0,
        opacity: loading ? 0.6 : 1,
      }}
    >
      {/* Mode dot */}
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: cfg.color,
        flexShrink: 0,
      }} />

      {/* Name */}
      <span style={{
        fontSize: 12,
        fontWeight: 600,
        color: T.text.primary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {property.name}
      </span>

      {/* Mode label */}
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        color: cfg.color,
        flexShrink: 0,
      }}>
        {cfg.label}
      </span>
    </button>
  )
}

// ─── Section E: AI Toggle ─────────────────────────────────────────────────────
function AIToggleSection({ onImportComplete }: { onImportComplete: () => void }): React.ReactElement {
  const [loading, setLoading] = useState<'enable' | 'disable' | null>(null)
  const [done, setDone] = useState(false)
  const enableBtnHover = useHover()
  const disableBtnHover = useHover()
  const [properties, setProperties] = useState<PropertyAiStatus[]>([])

  function loadProperties(): void {
    apiGetPropertiesAiStatus().then(setProperties).catch(err => console.error('[AI Toggle] Failed to load properties:', err))
  }

  useEffect(() => { loadProperties() }, [])

  async function handleToggle(enable: boolean): Promise<void> {
    setLoading(enable ? 'enable' : 'disable')
    setDone(false)
    try {
      await apiToggleAIAll(enable)
      setDone(true)
      onImportComplete()
      loadProperties()
      setTimeout(() => setDone(false), 2000)
    } finally {
      setLoading(null)
    }
  }

  async function handlePropertyToggle(propertyId: string, mode: AiMode): Promise<void> {
    await apiToggleAIProperty(propertyId, mode)
    onImportComplete()
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.25s' }}>
      <div style={cardHeaderStyle}>AI Toggle</div>
      <div style={cardBodyStyle}>
        {/* Global toggle row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            style={{
              ...btnPrimary,
              opacity: loading ? 0.5 : enableBtnHover.hovered ? 0.85 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
            disabled={!!loading}
            onClick={() => handleToggle(true)}
            {...enableBtnHover.handlers}
          >
            {loading === 'enable' ? 'Enabling...' : 'Enable All'}
          </button>
          <button
            style={{
              ...btnGhost,
              opacity: loading ? 0.5 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
              background: !loading && disableBtnHover.hovered ? T.bg.secondary : 'transparent',
            }}
            disabled={!!loading}
            onClick={() => handleToggle(false)}
            {...disableBtnHover.handlers}
          >
            {loading === 'disable' ? 'Disabling...' : 'Disable All'}
          </button>
          {done && (
            <span style={{ fontSize: 13, color: T.status.green, fontFamily: T.font.sans, fontWeight: 600, animation: 'settingsFadeIn 0.2s ease' }}>
              Done!
            </span>
          )}
        </div>

        {/* Property grid */}
        {properties.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 6,
          }}>
            {properties.map(p => (
              <PropertyAiCard key={p.id} property={p} onToggle={handlePropertyToggle} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Section F: Change Password ───────────────────────────────────────────────
function ChangePasswordSection(): React.ReactElement {
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const mismatch = confirm.length > 0 && newPassword !== confirm
  const tooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmit = newPassword.length >= 8 && newPassword === confirm && !loading

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setLoading(true)
    setMsg(null)
    try {
      await apiChangePassword(newPassword)
      setMsg({ text: 'Password updated successfully', ok: true })
      setNewPassword('')
      setConfirm('')
    } catch (err: any) {
      setMsg({ text: err.message || 'Failed to update password', ok: false })
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = (focused: boolean, error?: boolean): React.CSSProperties => ({
    width: '100%',
    height: 36,
    padding: '0 36px 0 12px',
    fontSize: 13,
    fontFamily: T.font.sans,
    color: T.text.primary,
    background: T.bg.primary,
    border: `1px solid ${error ? T.status.red : focused ? T.accent : T.border.default}`,
    borderRadius: T.radius.sm,
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
    boxShadow: focused && !error ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
  })

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.28s' }}>
      <div style={cardHeaderStyle}>Change Password</div>
      <div style={cardBodyStyle}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 340 }}>
          <PasswordField
            label="New password"
            value={newPassword}
            onChange={setNewPassword}
            show={showNew}
            onToggleShow={() => setShowNew(v => !v)}
            error={tooShort ? 'At least 8 characters' : undefined}
            inputStyle={inputStyle}
          />
          <PasswordField
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            show={showConfirm}
            onToggleShow={() => setShowConfirm(v => !v)}
            error={mismatch ? "Passwords don't match" : undefined}
            inputStyle={inputStyle}
          />
          {msg && (
            <div style={{
              fontSize: 12, fontFamily: T.font.sans, fontWeight: 500,
              color: msg.ok ? T.status.green : T.status.red,
              animation: 'settingsFadeIn 0.2s ease',
            }}>{msg.text}</div>
          )}
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              ...btnPrimary,
              opacity: canSubmit ? 1 : 0.4,
              cursor: canSubmit ? 'pointer' : 'default',
              alignSelf: 'flex-start',
            }}
          >
            {loading ? 'Saving…' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}

function PasswordField({
  label, value, onChange, show, onToggleShow, error, inputStyle,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  show: boolean
  onToggleShow: () => void
  error?: string
  inputStyle: (focused: boolean, error?: boolean) => React.CSSProperties
}): React.ReactElement {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={inputStyle(focused, !!error)}
          autoComplete="new-password"
        />
        <button
          type="button"
          onClick={onToggleShow}
          style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono,
            padding: '2px 4px',
          }}
        >{show ? 'hide' : 'show'}</button>
      </div>
      {error && (
        <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{error}</span>
      )}
    </div>
  )
}

// ─── Section G: Danger Zone ───────────────────────────────────────────────────
function DangerZoneSection({ onImportComplete }: { onImportComplete: () => void }): React.ReactElement {
  const [loading, setLoading] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<string | null>(null)
  const deleteBtnHover = useHover()
  const cleanupBtnHover = useHover()

  async function handleDelete(): Promise<void> {
    if (!window.confirm('Are you sure? This cannot be undone.')) return
    setLoading(true)
    try {
      await apiDeleteAllData()
      onImportComplete()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleCleanupOrphans(): Promise<void> {
    if (!window.confirm('This will check all reservations against Hostaway and delete any that don\'t exist (test/fake data). Continue?')) return
    setCleanupLoading(true)
    setCleanupResult(null)
    try {
      const result = await apiCleanupOrphanReservations()
      setCleanupResult(`Cleaned up ${result.deleted} orphan reservation${result.deleted !== 1 ? 's' : ''} (${result.total - result.deleted} valid)`)
      if (result.deleted > 0) onImportComplete()
    } catch (err) {
      setCleanupResult(err instanceof Error ? err.message : 'Cleanup failed')
    } finally {
      setCleanupLoading(false)
    }
  }

  return (
    <div style={{
      ...cardStyle,
      border: '1px solid rgba(220,38,38,0.2)',
      background: 'rgba(220,38,38,0.05)',
      animation: 'fadeInUp 0.4s ease-out both',
      animationDelay: '0.3s',
    }}>
      <div
        style={{
          ...cardHeaderStyle,
          background: 'rgba(220,38,38,0.06)',
          color: T.status.red,
          borderBottom: '1px solid rgba(220,38,38,0.12)',
        }}
      >
        Danger Zone
      </div>
      <div style={cardBodyStyle}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, marginBottom: 4, fontFamily: T.font.sans }}>
            Clean Up Orphan Reservations
          </div>
          <div style={{ fontSize: 12, color: T.text.secondary, marginBottom: 10, fontFamily: T.font.sans, lineHeight: 1.5 }}>
            Validates all local reservations against Hostaway and removes any that don't exist (test data, deleted bookings).
          </div>
          <button
            style={{
              height: 32, padding: '0 14px', fontSize: 12, fontWeight: 600,
              background: '#FEF2F2', color: '#B91C1C', border: '1px solid #FECACA',
              borderRadius: 6, cursor: cleanupLoading ? 'not-allowed' : 'pointer',
              opacity: cleanupLoading ? 0.5 : cleanupBtnHover.hovered ? 0.85 : 1,
              transition: 'opacity 150ms',
            }}
            disabled={cleanupLoading}
            onClick={handleCleanupOrphans}
            {...cleanupBtnHover.handlers}
          >
            {cleanupLoading ? 'Cleaning up...' : 'Clean Up Orphans'}
          </button>
          {cleanupResult && (
            <div style={{ fontSize: 12, color: T.text.secondary, marginTop: 8, fontFamily: T.font.sans }}>
              {cleanupResult}
            </div>
          )}
        </div>
        <div style={{ borderTop: '1px solid rgba(220,38,38,0.12)', paddingTop: 16 }}>
          <div style={{ fontSize: 13, color: T.text.secondary, marginBottom: 12, fontFamily: T.font.sans, lineHeight: 1.5 }}>
            Permanently delete all conversations, reservations, and messages.
          </div>
          <button
            style={{
              ...btnDanger,
              opacity: loading ? 0.5 : deleteBtnHover.hovered ? 0.85 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
            disabled={loading}
            onClick={handleDelete}
            {...deleteBtnHover.handlers}
          >
            {loading ? 'Deleting...' : 'Delete All Data'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Section: Webhook URL ─────────────────────────────────────────────────────
function WebhookUrlSection(): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const webhookUrl = getTenantMeta()?.webhookUrl ?? ''

  function handleCopy() {
    if (!webhookUrl) return
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.05s' }}>
      <div style={cardHeaderStyle}>Hostaway Integration</div>
      <div style={cardBodyStyle}>
        <div style={{ marginBottom: 4, fontSize: 12, fontWeight: 600, color: T.text.secondary }}>
          Webhook URL
        </div>
        <div style={{ fontSize: 11, color: T.text.tertiary, marginBottom: 10 }}>
          Paste this URL into Hostaway → Account → Webhooks to enable real-time message sync.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            readOnly
            value={webhookUrl || 'Log in to see your webhook URL'}
            style={{
              flex: 1,
              height: 34,
              padding: '0 10px',
              fontSize: 12,
              fontFamily: T.font.mono,
              background: T.bg.secondary,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              color: T.text.primary,
              outline: 'none',
              cursor: 'text',
            }}
            onFocus={e => e.target.select()}
          />
          <button
            onClick={handleCopy}
            style={{
              ...btnGhost,
              minWidth: 72,
              color: copied ? T.status.green : T.text.primary,
              borderColor: copied ? T.status.green : T.border.default,
            }}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Section: Working Hours ───────────────────────────────────────────────────
const COMMON_TIMEZONES = [
  'UTC',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
]

function WorkingHoursSection(): React.ReactElement {
  const [enabled, setEnabled] = useState(false)
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('01:00')
  const [timezone, setTimezone] = useState('UTC')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGetTenantAiConfig()
      .then(cfg => {
        setEnabled(cfg.workingHoursEnabled ?? false)
        setStart(cfg.workingHoursStart ?? '08:00')
        setEnd(cfg.workingHoursEnd ?? '01:00')
        setTimezone(cfg.workingHoursTimezone ?? 'UTC')
      })
      .catch(err => console.error('[Working Hours] Failed to load config:', err))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      await apiUpdateTenantAiConfig({
        workingHoursEnabled: enabled,
        workingHoursStart: start,
        workingHoursEnd: end,
        workingHoursTimezone: timezone,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // silent — user can retry
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 34,
    padding: '0 10px',
    fontSize: 13,
    fontFamily: T.font.sans,
    background: T.bg.secondary,
    border: `1px solid ${T.border.default}`,
    borderRadius: T.radius.sm,
    color: T.text.primary,
    outline: 'none',
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.1s' }}>
      <div style={cardHeaderStyle}>Working Hours</div>
      <div style={cardBodyStyle}>
        {loading ? (
          <div style={{ fontSize: 12, color: T.text.tertiary }}>Loading…</div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: T.text.tertiary, marginBottom: 14 }}>
              When enabled, the AI only auto-replies during these hours. Messages received outside working hours
              are batched and processed as a single reply when the window opens.
            </div>

            {/* Toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <button
                onClick={() => setEnabled(v => !v)}
                style={{
                  width: 40,
                  height: 22,
                  borderRadius: 11,
                  border: 'none',
                  cursor: 'pointer',
                  background: enabled ? T.accent : T.border.default,
                  position: 'relative',
                  transition: 'background 0.2s ease',
                  flexShrink: 0,
                }}
                aria-label="Toggle working hours"
              >
                <span style={{
                  position: 'absolute',
                  top: 3,
                  left: enabled ? 20 : 3,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 0.2s ease',
                }} />
              </button>
              <span style={{ fontSize: 13, color: T.text.primary, fontWeight: 500 }}>
                {enabled ? 'Working hours active' : 'Working hours disabled (AI replies anytime)'}
              </span>
            </div>

            {/* Time pickers + timezone — only shown when enabled */}
            {enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: T.text.secondary, minWidth: 60 }}>Active from</span>
                  <input
                    type="time"
                    value={start}
                    onChange={e => setStart(e.target.value)}
                    style={inputStyle}
                  />
                  <span style={{ fontSize: 13, color: T.text.secondary }}>to</span>
                  <input
                    type="time"
                    value={end}
                    onChange={e => setEnd(e.target.value)}
                    style={inputStyle}
                  />
                  <span style={{ fontSize: 11, color: T.text.tertiary }}>
                    (end time can be next day, e.g. 08:00–01:00)
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, color: T.text.secondary, minWidth: 60 }}>Timezone</span>
                  <select
                    value={timezone}
                    onChange={e => setTimezone(e.target.value)}
                    style={{ ...inputStyle, paddingRight: 28, cursor: 'pointer' }}
                  >
                    {COMMON_TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <SavedFeedback visible={saved} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Section: Hostaway Dashboard Connection ─────────────────────────────────
function HostawayDashboardSection({ onToast }: { onToast: (text: string, ok: boolean) => void }): React.ReactElement {
  const [status, setStatus] = useState<HostawayConnectStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [connectMode, setConnectMode] = useState<'quick' | 'manual'>('quick')
  const [manualToken, setManualToken] = useState('')
  const [manualLoading, setManualLoading] = useState(false)
  const [manualError, setManualError] = useState('')
  const [manualInstructionsOpen, setManualInstructionsOpen] = useState(false)
  const disconnectBtnHover = useHover()
  const manualConnectBtnHover = useHover()

  const callbackUrl =
    (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001') +
    '/api/hostaway-connect/callback'

  const bookmarkletCode = `javascript:void((function(){var t=localStorage.getItem('jwt');if(!t){alert('Please log into Hostaway first');return;}window.location='${callbackUrl}?token='+encodeURIComponent(t);})())`

  function fetchStatus() {
    setLoading(true)
    apiGetHostawayConnectStatus()
      .then(setStatus)
      .catch(err => console.error('[Hostaway Connect] Failed to fetch status:', err))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchStatus() }, [])

  // Handle redirect URL params from bookmarklet callback
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('hostaway') === 'connected') {
      onToast('Hostaway connected successfully!', true)
      fetchStatus()
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('hostaway') === 'error') {
      const reason = params.get('reason') || 'Unknown error'
      onToast(`Hostaway connection failed: ${reason}`, false)
      window.history.replaceState({}, '', window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleDisconnect() {
    if (!window.confirm('Disconnect Hostaway dashboard? You can reconnect at any time.')) return
    setDisconnecting(true)
    try {
      await apiDisconnectHostaway()
      fetchStatus()
    } catch (err) {
      console.error('[Hostaway Connect] Disconnect failed:', err)
    } finally {
      setDisconnecting(false)
    }
  }

  async function handleManualConnect() {
    if (!manualToken.trim()) {
      setManualError('Please paste a token.')
      return
    }
    setManualLoading(true)
    setManualError('')
    try {
      const result = await apiHostawayConnectManual(manualToken.trim())
      if (result.connected) {
        setManualToken('')
        fetchStatus()
      } else {
        setManualError(result.error || 'Connection failed. Please check the token and try again.')
      }
    } catch (err: any) {
      setManualError(err.message || 'Network error. Please try again.')
    } finally {
      setManualLoading(false)
    }
  }

  function getDaysRemaining(): number | null {
    if (!status?.expiresAt) return null
    const now = new Date()
    const exp = new Date(status.expiresAt)
    return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
  }

  const daysRemaining = getDaysRemaining()
  const isWarning = status?.warning ?? false
  const isConnected = status?.connected ?? false

  const loginInputStyle: React.CSSProperties = {
    width: '100%',
    height: 36,
    padding: '0 12px',
    fontSize: 13,
    fontFamily: T.font.sans,
    color: T.text.primary,
    background: T.bg.primary,
    border: `1px solid ${T.border.default}`,
    borderRadius: T.radius.sm,
    outline: 'none',
    transition: 'border-color 0.2s ease',
  }

  const TAB_LABELS: Record<'quick' | 'manual', string> = {
    quick: 'Quick Connect',
    manual: 'Manual',
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.07s' }}>
      <div style={cardHeaderStyle}>Hostaway Dashboard Connection</div>
      <div style={cardBodyStyle}>
        {loading ? (
          <div style={{ fontSize: 12, color: T.text.tertiary, fontFamily: T.font.sans }}>Loading...</div>
        ) : isConnected ? (
          <>
            {/* Connected state */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                fontFamily: T.font.sans,
                background: isWarning ? 'rgba(217,119,6,0.1)' : 'rgba(21,128,61,0.1)',
                color: isWarning ? T.status.amber : T.status.green,
              }}>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: isWarning ? T.status.amber : T.status.green,
                }} />
                Connected
              </span>

              {status?.connectedBy && (
                <span style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans }}>
                  {status.connectedBy}
                </span>
              )}

              {daysRemaining !== null && (
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: T.font.mono,
                  color: isWarning ? T.status.amber : T.text.tertiary,
                }}>
                  {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} remaining
                </span>
              )}
            </div>

            <button
              style={{
                ...btnGhost,
                opacity: disconnecting ? 0.5 : 1,
                cursor: disconnecting ? 'not-allowed' : 'pointer',
                background: !disconnecting && disconnectBtnHover.hovered ? T.bg.secondary : 'transparent',
              }}
              disabled={disconnecting}
              onClick={handleDisconnect}
              {...disconnectBtnHover.handlers}
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </>
        ) : (
          /* Not connected — Quick Connect / Manual tabs */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                fontFamily: T.font.sans,
                background: 'rgba(168,162,158,0.1)',
                color: T.text.tertiary,
              }}>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: T.text.tertiary,
                }} />
                Not Connected
              </span>
            </div>

            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${T.border.default}`, marginBottom: 4 }}>
              {(['quick', 'manual'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setConnectMode(tab)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    borderBottom: connectMode === tab ? `2px solid ${T.border.strong}` : '2px solid transparent',
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: connectMode === tab ? 700 : 500,
                    fontFamily: T.font.sans,
                    color: connectMode === tab ? T.text.primary : T.text.tertiary,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    marginBottom: -1,
                  }}
                >
                  {TAB_LABELS[tab]}
                </button>
              ))}
            </div>

            {connectMode === 'quick' ? (
              /* Quick Connect — bookmarklet-based */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 0' }}>
                {/* Step 1 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: T.border.strong,
                    color: '#FFFFFF',
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: T.font.sans,
                    flexShrink: 0,
                  }}>1</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 8 }}>
                      Drag this button to your bookmarks bar
                    </div>
                    <a
                      href={bookmarkletCode}
                      onClick={e => e.preventDefault()}
                      draggable
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '10px 20px',
                        background: T.border.strong,
                        color: '#FFFFFF',
                        fontSize: 14,
                        fontWeight: 700,
                        fontFamily: T.font.sans,
                        borderRadius: 999,
                        textDecoration: 'none',
                        cursor: 'grab',
                        boxShadow: T.shadow.md,
                        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
                        userSelect: 'none',
                      }}
                      onMouseDown={e => {
                        const el = e.currentTarget
                        el.style.cursor = 'grabbing'
                        el.style.transform = 'scale(1.05)'
                      }}
                      onMouseUp={e => {
                        const el = e.currentTarget
                        el.style.cursor = 'grab'
                        el.style.transform = 'scale(1)'
                      }}
                    >
                      Connect to GuestPilot
                    </a>
                    <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans, marginTop: 6 }}>
                      Drag the button above into your browser's bookmarks bar
                    </div>
                  </div>
                </div>

                {/* Step 2 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: T.border.strong,
                    color: '#FFFFFF',
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: T.font.sans,
                    flexShrink: 0,
                  }}>2</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>
                      Open <strong>dashboard.hostaway.com</strong> and log in
                    </div>
                  </div>
                </div>

                {/* Step 3 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: T.border.strong,
                    color: '#FFFFFF',
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: T.font.sans,
                    flexShrink: 0,
                  }}>3</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 4 }}>
                      Click "Connect to GuestPilot" from your bookmarks bar
                    </div>
                    <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>
                      You'll be redirected back here automatically
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Manual — paste token form */
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans }}>
                    Paste your Hostaway token
                  </label>
                  <textarea
                    placeholder="eyJhbGciOiJI..."
                    value={manualToken}
                    onChange={e => setManualToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleManualConnect() } }}
                    rows={3}
                    style={{
                      ...loginInputStyle,
                      height: 'auto',
                      padding: '8px 12px',
                      resize: 'vertical',
                      minHeight: 60,
                    }}
                  />
                </div>

                {manualError && (
                  <div style={{ fontSize: 12, color: T.status.red, fontFamily: T.font.sans }}>
                    {manualError}
                  </div>
                )}

                <div>
                  <button
                    style={{
                      ...btnPrimary,
                      opacity: manualLoading ? 0.5 : manualConnectBtnHover.hovered ? 0.85 : 1,
                      cursor: manualLoading ? 'not-allowed' : 'pointer',
                    }}
                    disabled={manualLoading}
                    onClick={handleManualConnect}
                    {...manualConnectBtnHover.handlers}
                  >
                    {manualLoading ? 'Connecting...' : 'Connect'}
                  </button>
                </div>

                {/* Collapsible instructions */}
                <div>
                  <button
                    onClick={() => setManualInstructionsOpen(v => !v)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: T.font.sans,
                      color: T.text.tertiary,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <span style={{
                      display: 'inline-block',
                      transition: 'transform 0.15s ease',
                      transform: manualInstructionsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      fontSize: 10,
                    }}>
                      &#9654;
                    </span>
                    How to get the token
                  </button>
                  {manualInstructionsOpen && (
                    <ol style={{
                      margin: '8px 0 0 0',
                      paddingLeft: 18,
                      fontSize: 12,
                      lineHeight: 1.7,
                      color: T.text.secondary,
                      fontFamily: T.font.sans,
                    }}>
                      <li>Open <strong>dashboard.hostaway.com</strong> and log in</li>
                      <li>Press <strong>F12</strong> &rarr; <strong>Console</strong> tab</li>
                      <li>Type: <code style={{ fontFamily: T.font.mono, fontSize: 11, background: T.bg.secondary, padding: '1px 5px', borderRadius: 4 }}>copy(localStorage.jwt)</code> and press Enter</li>
                      <li>Come back here and paste (<strong>Ctrl+V</strong> / <strong>Cmd+V</strong>)</li>
                    </ol>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Root export ──────────────────────────────────────────────────────────────
export function SettingsV5({ onImportComplete }: { onImportComplete: () => void }): React.ReactElement {
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    ensureStyles()
  }, [])

  // Auto-dismiss toast after 5 seconds
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: T.bg.secondary,
        fontFamily: T.font.sans,
      }}
    >
      <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
        {/* Page header */}
        <div style={{ marginBottom: 24, animation: 'fadeInUp 0.3s ease-out both' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.text.primary, letterSpacing: '-0.01em' }}>Settings</div>
          <div style={{ fontSize: 13, color: T.text.tertiary, marginTop: 4 }}>
            Manage data sync, properties, and AI settings
          </div>
        </div>

        <WebhookUrlSection />
        <HostawayDashboardSection onToast={(text, ok) => setToast({ text, ok })} />
        <WorkingHoursSection />
        <DataSyncSection onImportComplete={onImportComplete} />
        <AIToggleSection onImportComplete={onImportComplete} />
        <ChangePasswordSection />
        <DangerZoneSection onImportComplete={onImportComplete} />
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 16px',
            borderRadius: T.radius.md,
            background: T.bg.primary,
            border: `1px solid ${toast.ok ? T.status.green : T.status.red}`,
            boxShadow: T.shadow.lg,
            fontFamily: T.font.sans,
            fontSize: 13,
            fontWeight: 500,
            color: toast.ok ? T.status.green : T.status.red,
            animation: 'fadeInUp 0.3s ease-out both',
            maxWidth: 400,
          }}
        >
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: toast.ok ? T.status.green : T.status.red,
          }} />
          <span style={{ flex: 1 }}>{toast.text}</span>
          <button
            onClick={() => setToast(null)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: T.text.tertiary, fontSize: 16, padding: '0 2px', lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
      )}
    </div>
  )
}
