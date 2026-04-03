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
  apiHostawayLogin,
  apiHostawayVerify2fa,
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
function HostawayDashboardSection(): React.ReactElement {
  const [status, setStatus] = useState<HostawayConnectStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [pending2faSessionId, setPending2faSessionId] = useState<string | null>(null)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const connectBtnHover = useHover()
  const disconnectBtnHover = useHover()
  const verifyBtnHover = useHover()

  function fetchStatus() {
    setLoading(true)
    apiGetHostawayConnectStatus()
      .then(setStatus)
      .catch(err => console.error('[Hostaway Connect] Failed to fetch status:', err))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchStatus() }, [])

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

  async function handleLogin() {
    if (!loginEmail.trim() || !loginPassword.trim()) {
      setLoginError('Please enter both email and password.')
      return
    }
    setLoginLoading(true)
    setLoginError(null)
    try {
      const result = await apiHostawayLogin(loginEmail.trim(), loginPassword)
      if (result.connected) {
        setLoginEmail('')
        setLoginPassword('')
        setPending2faSessionId(null)
        fetchStatus()
      } else if (result.pending2fa && result.sessionId) {
        setPending2faSessionId(result.sessionId)
      } else {
        setLoginError(result.error || 'Connection failed. Please check your credentials.')
      }
    } catch (err: any) {
      setLoginError(err.message || 'Network error. Please try again.')
    } finally {
      setLoginLoading(false)
    }
  }

  async function handleVerify2fa() {
    if (!pending2faSessionId) return
    setVerifyLoading(true)
    setLoginError(null)
    try {
      const result = await apiHostawayVerify2fa(pending2faSessionId)
      if (result.connected) {
        setLoginEmail('')
        setLoginPassword('')
        setPending2faSessionId(null)
        fetchStatus()
      } else {
        setLoginError(result.error || 'Verification not yet complete. Please click the link in your email first.')
      }
    } catch (err: any) {
      setLoginError(err.message || 'Verification failed. Please try again.')
    } finally {
      setVerifyLoading(false)
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
        ) : loginLoading ? (
          /* Loading / connecting state */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 0' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <circle cx="12" cy="12" r="10" stroke={T.border.default} strokeWidth="2.5" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke={T.accent} strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>
              Connecting to Hostaway...
            </div>
            <div style={{ fontSize: 12, color: T.text.tertiary, fontFamily: T.font.sans }}>
              This may take 15-30 seconds. Please wait.
            </div>
          </div>
        ) : pending2faSessionId ? (
          /* 2FA verification state */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{
              padding: '12px 14px',
              background: 'rgba(29,78,216,0.06)',
              borderRadius: T.radius.sm,
              border: `1px solid rgba(29,78,216,0.15)`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 4 }}>
                Email verification required
              </div>
              <div style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, lineHeight: 1.5 }}>
                Check your email and click the verification link from Hostaway, then click the button below.
              </div>
            </div>

            {loginError && (
              <div style={{ fontSize: 12, color: T.status.red, fontFamily: T.font.sans }}>
                {loginError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={{
                  ...btnPrimary,
                  opacity: verifyLoading ? 0.6 : verifyBtnHover.hovered ? 0.85 : 1,
                  cursor: verifyLoading ? 'not-allowed' : 'pointer',
                }}
                disabled={verifyLoading}
                onClick={handleVerify2fa}
                {...verifyBtnHover.handlers}
              >
                {verifyLoading ? 'Verifying...' : "I've verified, continue"}
              </button>
              <button
                style={btnGhost}
                onClick={() => { setPending2faSessionId(null); setLoginError(null) }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          /* Not connected — login form */
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans }}>
                  Hostaway Email
                </label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={loginEmail}
                  onChange={e => setLoginEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()}
                  style={loginInputStyle}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans }}>
                  Hostaway Password
                </label>
                <input
                  type="password"
                  placeholder="Password"
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()}
                  style={loginInputStyle}
                />
              </div>
            </div>

            {loginError && (
              <div style={{ fontSize: 12, color: T.status.red, fontFamily: T.font.sans }}>
                {loginError}
              </div>
            )}

            <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>
              Connection takes about 15-30 seconds. Your credentials are not stored.
            </div>

            <div>
              <button
                style={{
                  ...btnPrimary,
                  opacity: connectBtnHover.hovered ? 0.85 : 1,
                }}
                onClick={handleLogin}
                {...connectBtnHover.handlers}
              >
                Connect
              </button>
            </div>
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
        <HostawayDashboardSection />
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
