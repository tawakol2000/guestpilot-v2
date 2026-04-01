'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  apiGetImportProgress,
  apiRunImport,
  apiGetProperties,
  apiToggleAIAll,
  apiToggleAIProperty,
  apiGetPropertiesAiStatus,
  apiGetKnowledgeChunks,
  apiResyncProperty,
  type PropertyAiStatus,
  apiDeleteAllData,
  apiChangePassword,
  apiGetTenantAiConfig,
  apiUpdateTenantAiConfig,
  getTenantMeta,
  type ImportProgress,
  type ApiProperty,
  type KnowledgeChunk,
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

// ─── Section B: Properties ────────────────────────────────────────────────────

/* PropertyInfoEditor removed — moved to Listings page (020-listings-management) */

function PropertyDescriptionEditor({ prop }: { prop: ApiProperty }): React.ReactElement {
  const [desc, setDesc] = useState(prop.listingDescription || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveBtnHover = useHover()

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      // Description is read-only from Hostaway sync — use resync to update
      // This textarea is for viewing; edits would need a custom endpoint
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.secondary, marginBottom: 8 }}>
        Property Description
      </div>
      <textarea
        value={desc}
        onChange={e => setDesc(e.target.value)}
        readOnly
        style={{
          width: '100%',
          minHeight: 80,
          fontSize: 12,
          padding: '8px 10px',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          background: T.bg.secondary,
          color: T.text.primary,
          fontFamily: T.font.sans,
          outline: 'none',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ fontSize: 11, color: T.text.tertiary, marginTop: 4 }}>
        Synced from Hostaway. Use "Re-sync" to update.
      </div>
    </div>
  )
}

function LearnedAnswersViewer({ propertyId }: { propertyId: string }): React.ReactElement {
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGetKnowledgeChunks(propertyId).then(all => {
      setChunks(all.filter(c => c.category === 'learned-answers'))
      setLoading(false)
    }).catch(err => { console.error('[Knowledge] Failed to load learned answers:', err); setLoading(false) })
  }, [propertyId])

  const qaLines = chunks.length > 0
    ? chunks[0].content.split(/\n\n/).filter(l => l.trim())
    : []

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.secondary, marginBottom: 8 }}>
        Learned Answers
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: T.text.tertiary, fontFamily: T.font.sans }}>Loading...</div>
      ) : qaLines.length === 0 ? (
        <div style={{ fontSize: 12, color: T.text.tertiary, fontFamily: T.font.sans }}>
          No learned answers yet. Approve knowledge suggestions to build this up.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {qaLines.map((qa, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                padding: '6px 10px',
                background: T.bg.secondary,
                borderRadius: T.radius.sm,
                fontFamily: T.font.sans,
                color: T.text.primary,
                whiteSpace: 'pre-wrap',
              }}
            >
              {qa}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PropertyCard({ prop, isOpen, onToggle, onUpdate }: { prop: ApiProperty; isOpen: boolean; onToggle: () => void; onUpdate: (p: ApiProperty) => void }): React.ReactElement {
  const hover = useHover()
  const resyncHover = useHover()
  const [resyncing, setResyncing] = useState(false)
  const [resyncMsg, setResyncMsg] = useState('')

  async function handleResync(): Promise<void> {
    setResyncing(true)
    setResyncMsg('')
    try {
      const result = await apiResyncProperty(prop.id)
      onUpdate(result.property)
      setResyncMsg(`Synced (${result.chunks} chunks)`)
      setTimeout(() => setResyncMsg(''), 3000)
    } catch (err) {
      console.error(err)
      setResyncMsg('Sync failed')
      setTimeout(() => setResyncMsg(''), 3000)
    } finally {
      setResyncing(false)
    }
  }

  return (
    <div
      style={{
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        overflow: 'hidden',
        boxShadow: hover.hovered ? T.shadow.md : T.shadow.sm,
        transition: 'box-shadow 0.2s ease',
      }}
    >
      <button
        onClick={onToggle}
        {...hover.handlers}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '12px 16px',
          background: hover.hovered ? T.bg.secondary : T.bg.primary,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: T.font.sans,
          transition: 'background 0.2s ease',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text.primary }}>
            {prop.name}
          </div>
          {prop.address && (
            <div style={{ fontSize: 12, color: T.text.secondary, marginTop: 2 }}>
              {prop.address}
            </div>
          )}
        </div>
        {isOpen ? (
          <ChevronDown size={14} color={T.text.tertiary} />
        ) : (
          <ChevronRight size={14} color={T.text.tertiary} />
        )}
      </button>
      {isOpen && (
        <div style={{ padding: '12px 16px 16px', borderTop: `1px solid ${T.border.default}`, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              style={{
                ...btnGhost,
                height: 28,
                padding: '0 12px',
                fontSize: 11,
                opacity: resyncing ? 0.5 : resyncHover.hovered ? 0.85 : 1,
                cursor: resyncing ? 'not-allowed' : 'pointer',
              }}
              disabled={resyncing}
              onClick={handleResync}
              {...resyncHover.handlers}
            >
              {resyncing ? 'Syncing…' : 'Re-sync from Hostaway'}
            </button>
            {resyncMsg && (
              <span style={{ fontSize: 12, color: resyncMsg.includes('failed') ? T.status.red : T.status.green, fontFamily: T.font.sans }}>
                {resyncMsg}
              </span>
            )}
          </div>
          {/* PropertyInfoEditor removed — use Listings page (020-listings-management) */}
          <PropertyDescriptionEditor prop={prop} />
          <LearnedAnswersViewer propertyId={prop.id} />
        </div>
      )}
    </div>
  )
}

function PropertiesSection(): React.ReactElement {
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  function handlePropertyUpdate(updated: ApiProperty): void {
    setProperties(prev => prev.map(p => p.id === updated.id ? updated : p))
  }

  useEffect(() => {
    apiGetProperties().then(setProperties).catch(err => { console.error('[Properties] Failed to load:', err); setLoadError(err.message || 'Failed to load properties') })
  }, [])

  function toggleExpand(id: string): void {
    setExpanded((prev) => (prev === id ? null : id))
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.05s' }}>
      <div style={cardHeaderStyle}>Properties</div>
      <div style={cardBodyStyle}>
        {loadError ? (
          <div style={{ fontSize: 13, color: T.status.red, fontFamily: T.font.sans }}>
            {loadError}
          </div>
        ) : properties.length === 0 ? (
          <div style={{ fontSize: 13, color: T.text.tertiary, fontFamily: T.font.sans }}>
            No properties found. Run a sync first.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {properties.map((prop) => (
              <PropertyCard
                key={prop.id}
                prop={prop}
                isOpen={expanded === prop.id}
                onToggle={() => toggleExpand(prop.id)}
                onUpdate={handlePropertyUpdate}
              />
            ))}
          </div>
        )}
      </div>
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
  const deleteBtnHover = useHover()

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
        <div style={{ fontSize: 13, color: T.text.secondary, marginBottom: 16, fontFamily: T.font.sans, lineHeight: 1.5 }}>
          This will permanently delete all conversations, reservations, and messages.
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

// ─── Root export ──────────────────────────────────────────────────────────────
export function SettingsV5({ onImportComplete }: { onImportComplete: () => void }): React.ReactElement {
  useEffect(() => {
    ensureStyles()
  }, [])

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
        <WorkingHoursSection />
        <DataSyncSection onImportComplete={onImportComplete} />
        <PropertiesSection />
        <AIToggleSection onImportComplete={onImportComplete} />
        <ChangePasswordSection />
        <DangerZoneSection onImportComplete={onImportComplete} />
      </div>
    </div>
  )
}
