'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  apiGetImportProgress,
  apiRunImport,
  apiGetProperties,
  apiUpdateKnowledgeBase,
  apiGetTemplates,
  apiUpdateTemplate,
  apiEnhanceTemplate,
  apiGetKnowledgeSuggestions,
  apiUpdateKnowledgeSuggestion,
  apiCreateKnowledgeSuggestion,
  apiDeleteKnowledgeSuggestion,
  apiDetectKnowledgeGaps,
  apiBulkImportKnowledge,
  apiToggleAIAll,
  apiToggleAIProperty,
  apiGetPropertiesAiStatus,
  apiGetKnowledgeChunks,
  apiResyncProperty,
  type PropertyAiStatus,
  apiDeleteAllData,
  apiChangePassword,
  type ImportProgress,
  type ApiProperty,
  type ApiMessageTemplate,
  type ApiKnowledgeSuggestion,
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncBtnHover = useHover()
  const propBtnHover = useHover()

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
      .catch(() => {})
    return stopPolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSync(listingsOnly: boolean): Promise<void> {
    setProgress((prev) => ({
      phase: 'deleting',
      total: 0,
      completed: 0,
      message: 'Starting…',
      lastSyncedAt: prev?.lastSyncedAt ?? null,
    }))
    try {
      await apiRunImport(listingsOnly)
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
            onClick={() => runSync(false)}
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
        </div>
      </div>
    </div>
  )
}

// ─── Section B: Properties ────────────────────────────────────────────────────

// Key label mapping matching the backend
const KB_LABELS: Record<string, string> = {
  internalListingName: 'Unit Number',
  personCapacity: 'Person Capacity',
  roomType: 'Property Type',
  bedroomsNumber: 'Bedrooms',
  bathroomsNumber: 'Bathrooms',
  doorCode: 'Door Code',
  wifiName: 'WiFi Name',
  wifiPassword: 'WiFi Password',
  checkInTime: 'Check-in Time',
  checkOutTime: 'Check-out Time',
  houseRules: 'House Rules',
  specialInstruction: 'Special Instructions',
  keyPickup: 'Key Pickup',
  amenities: 'Amenities',
  cleaningFee: 'Cleaning Fee',
  squareMeters: 'Size (sqm)',
  bedTypes: 'Bed Types',
}

function PropertyInfoEditor({ prop, onSaved }: { prop: ApiProperty; onSaved: (updated: ApiProperty) => void }): React.ReactElement {
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(() => {
    const kb = prop.customKnowledgeBase ?? {}
    const entries = Object.entries(kb as Record<string, unknown>)
    return entries.length > 0
      ? entries.map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }))
      : [{ key: '', value: '' }]
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveBtnHover = useHover()
  const addBtnHover = useHover()

  function handleRowChange(index: number, field: 'key' | 'value', val: string): void {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, [field]: val } : r))
  }

  function handleAddRow(): void {
    setRows(prev => [...prev, { key: '', value: '' }])
  }

  function handleRemoveRow(index: number): void {
    setRows(prev => prev.length <= 1 ? [{ key: '', value: '' }] : prev.filter((_, i) => i !== index))
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const obj: Record<string, string> = {}
      for (const row of rows) {
        if (row.key.trim()) obj[row.key.trim()] = row.value
      }
      await apiUpdateKnowledgeBase(prop.id, obj)
      onSaved({ ...prop, customKnowledgeBase: obj })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '6px 10px',
    border: `1px solid ${T.border.default}`,
    borderRadius: T.radius.sm,
    background: T.bg.primary,
    color: T.text.primary,
    fontFamily: T.font.sans,
    outline: 'none',
    boxSizing: 'border-box',
    ...focusInputStyle,
  }

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.secondary, marginBottom: 8 }}>
        Property Info
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 6,
            alignItems: 'center',
            padding: '4px 0',
            background: i % 2 === 0 ? 'transparent' : T.bg.secondary,
            borderRadius: T.radius.sm,
          }}
        >
          <input
            placeholder="Key"
            value={KB_LABELS[row.key] || row.key}
            onChange={e => handleRowChange(i, 'key', e.target.value)}
            style={{ ...inputStyle, width: '30%', fontWeight: 600 }}
            title={row.key}
          />
          <input
            placeholder="Value"
            value={row.value}
            onChange={e => handleRowChange(i, 'value', e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => handleRemoveRow(i)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: T.text.tertiary,
              padding: '4px 6px',
              fontSize: 14,
              lineHeight: 1,
              borderRadius: T.radius.sm,
              transition: 'color 0.15s ease',
            }}
          >
            x
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button
          style={{
            ...btnGhost,
            height: 28,
            padding: '0 12px',
            fontSize: 11,
            background: addBtnHover.hovered ? T.bg.secondary : 'transparent',
          }}
          onClick={handleAddRow}
          {...addBtnHover.handlers}
        >
          + Add Row
        </button>
        <button
          style={{
            ...btnPrimary,
            opacity: saving ? 0.5 : saveBtnHover.hovered ? 0.85 : 1,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
          disabled={saving}
          onClick={handleSave}
          {...saveBtnHover.handlers}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <SavedFeedback visible={saved} />
      </div>
    </div>
  )
}

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
    }).catch(() => setLoading(false))
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
          <PropertyInfoEditor prop={prop} onSaved={onUpdate} />
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

  function handlePropertyUpdate(updated: ApiProperty): void {
    setProperties(prev => prev.map(p => p.id === updated.id ? updated : p))
  }

  useEffect(() => {
    apiGetProperties().then(setProperties).catch(() => {})
  }, [])

  function toggleExpand(id: string): void {
    setExpanded((prev) => (prev === id ? null : id))
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.05s' }}>
      <div style={cardHeaderStyle}>Properties</div>
      <div style={cardBodyStyle}>
        {properties.length === 0 ? (
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

// ─── Section C: Message Templates ─────────────────────────────────────────────
function TemplateItem({
  template,
  onUpdate,
}: {
  template: ApiMessageTemplate
  onUpdate: (t: ApiMessageTemplate) => void
}): React.ReactElement {
  const [editBody, setEditBody] = useState(template.body)
  const [enhancing, setEnhancing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const focus = useFocusStyle()
  const saveBtnHover = useHover()
  const enhanceBtnHover = useHover()

  async function handleEnhance(): Promise<void> {
    setEnhancing(true)
    try {
      const updated = await apiEnhanceTemplate(template.id)
      onUpdate(updated)
      setEditBody(updated.enhancedBody ?? updated.body)
    } finally {
      setEnhancing(false)
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const updated = await apiUpdateTemplate(template.id, { body: editBody })
      onUpdate(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        overflow: 'hidden',
        marginBottom: 12,
        boxShadow: T.shadow.sm,
      }}
    >
      {/* Template header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: T.bg.secondary,
          borderBottom: `1px solid ${T.border.default}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text.primary, fontFamily: T.font.sans }}>
            {template.name}
          </span>
          {template.enhancedBody && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: T.status.green,
                background: 'rgba(21,128,61,0.08)',
                padding: '2px 8px',
                borderRadius: 999,
                fontFamily: T.font.sans,
              }}
            >
              Enhanced
            </span>
          )}
        </div>
        <button
          style={{
            ...btnGhost,
            padding: '0 12px',
            height: 28,
            fontSize: 12,
            opacity: enhancing ? 0.5 : 1,
            cursor: enhancing ? 'not-allowed' : 'pointer',
            background: !enhancing && enhanceBtnHover.hovered ? T.bg.secondary : 'transparent',
            color: T.accent,
            borderColor: enhanceBtnHover.hovered ? T.accent : T.border.default,
          }}
          disabled={enhancing}
          onClick={handleEnhance}
          {...enhanceBtnHover.handlers}
        >
          {enhancing ? 'Enhancing...' : 'Enhance with AI'}
        </button>
      </div>

      {/* Textarea */}
      <div style={{ padding: 16 }}>
        <textarea
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          {...focus.handlers}
          style={{
            width: '100%',
            minHeight: 100,
            fontFamily: T.font.sans,
            fontSize: 13,
            padding: '10px 12px',
            border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.sm,
            background: T.bg.primary,
            color: T.text.primary,
            resize: 'vertical',
            boxSizing: 'border-box',
            lineHeight: 1.5,
            outline: 'none',
            ...focusInputStyle,
            ...focus.focusStyles,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <button
            style={{
              ...btnPrimary,
              opacity: saving ? 0.5 : saveBtnHover.hovered ? 0.85 : 1,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
            disabled={saving}
            onClick={handleSave}
            {...saveBtnHover.handlers}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <SavedFeedback visible={saved} />
        </div>
      </div>
    </div>
  )
}

function MessageTemplatesSection(): React.ReactElement {
  const [templates, setTemplates] = useState<ApiMessageTemplate[]>([])

  useEffect(() => {
    apiGetTemplates().then(setTemplates).catch(() => {})
  }, [])

  function handleUpdate(updated: ApiMessageTemplate): void {
    setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  }

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.1s' }}>
      <div style={cardHeaderStyle}>Message Templates</div>
      <div style={cardBodyStyle}>
        {templates.length === 0 ? (
          <div style={{ fontSize: 13, color: T.text.tertiary, fontFamily: T.font.sans }}>
            No templates yet. Run a sync to import automated messages from Hostaway.
          </div>
        ) : (
          templates.map((t) => <TemplateItem key={t.id} template={t} onUpdate={handleUpdate} />)
        )}
      </div>
    </div>
  )
}

// ─── Section D: Knowledge Base ────────────────────────────────────────────────
function KbItem({
  item,
  tab,
  onApprove,
  onDelete,
}: {
  item: ApiKnowledgeSuggestion
  tab: 'pending' | 'approved'
  onApprove?: (updated: ApiKnowledgeSuggestion) => void
  onDelete: (id: string) => void
}): React.ReactElement {
  const [editAnswer, setEditAnswer] = useState(item.answer)
  const [loading, setLoading] = useState(false)
  const focus = useFocusStyle()
  const approveBtnHover = useHover()
  const deleteBtnHover = useHover()

  async function handleApprove(): Promise<void> {
    setLoading(true)
    try {
      const updated = await apiUpdateKnowledgeSuggestion(item.id, { status: 'approved', answer: editAnswer })
      onApprove?.(updated)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!window.confirm('Are you sure? This cannot be undone.')) return
    setLoading(true)
    try {
      await apiDeleteKnowledgeSuggestion(item.id)
      onDelete(item.id)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        padding: '14px 16px',
        marginBottom: 8,
        background: T.bg.primary,
        boxShadow: T.shadow.sm,
        transition: 'box-shadow 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, flex: 1, lineHeight: 1.4 }}>
          {item.question}
        </div>
        {item.category && (
          <span style={{
            fontSize: 10,
            fontWeight: 600,
            color: T.text.secondary,
            background: T.bg.tertiary,
            padding: '2px 10px',
            borderRadius: 999,
            fontFamily: T.font.sans,
            whiteSpace: 'nowrap',
          }}>
            {item.category}
          </span>
        )}
      </div>
      <textarea
        value={editAnswer}
        onChange={(e) => setEditAnswer(e.target.value)}
        {...focus.handlers}
        style={{
          width: '100%',
          minHeight: 72,
          fontFamily: T.font.sans,
          fontSize: 13,
          padding: '10px 12px',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          background: T.bg.secondary,
          color: T.text.primary,
          resize: 'vertical',
          boxSizing: 'border-box',
          lineHeight: 1.5,
          outline: 'none',
          ...focusInputStyle,
          ...focus.focusStyles,
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {tab === 'pending' && (
          <button
            style={{
              ...btnPrimary,
              background: T.status.green,
              opacity: loading ? 0.5 : approveBtnHover.hovered ? 0.85 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
            disabled={loading}
            onClick={handleApprove}
            {...approveBtnHover.handlers}
          >
            Approve
          </button>
        )}
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
          {tab === 'pending' ? 'Reject' : 'Delete'}
        </button>
      </div>
    </div>
  )
}

const KB_CATEGORIES = ['Check-in', 'Amenities', 'House Rules', 'Parking', 'WiFi', 'Maintenance', 'Booking', 'Other'] as const

function AddEntryForm({ onAdded }: { onAdded: () => void }): React.ReactElement {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(false)
  const qFocus = useFocusStyle()
  const aFocus = useFocusStyle()
  const addBtnHover = useHover()

  async function handleAdd(): Promise<void> {
    if (!question.trim() || !answer.trim()) return
    setLoading(true)
    try {
      await apiCreateKnowledgeSuggestion({ question, answer, category: category || undefined })
      setQuestion('')
      setAnswer('')
      setCategory('')
      onAdded()
    } finally {
      setLoading(false)
    }
  }

  const isDisabled = loading || !question.trim() || !answer.trim()

  return (
    <div
      style={{
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        padding: '14px 16px',
        marginTop: 12,
        background: T.bg.secondary,
        animation: 'scaleIn 0.2s ease-out',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, marginBottom: 10, fontFamily: T.font.sans }}>
        New Entry
      </div>
      <input
        type="text"
        placeholder="Question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        {...qFocus.handlers}
        style={{
          width: '100%',
          fontSize: 13,
          padding: '7px 10px',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          background: T.bg.primary,
          color: T.text.primary,
          fontFamily: T.font.sans,
          boxSizing: 'border-box',
          marginBottom: 8,
          outline: 'none',
          ...focusInputStyle,
          ...qFocus.focusStyles,
        }}
      />
      <textarea
        placeholder="Answer"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        {...aFocus.handlers}
        style={{
          width: '100%',
          minHeight: 72,
          fontSize: 13,
          padding: '10px 12px',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          background: T.bg.primary,
          color: T.text.primary,
          fontFamily: T.font.sans,
          boxSizing: 'border-box',
          resize: 'vertical',
          lineHeight: 1.5,
          marginBottom: 8,
          outline: 'none',
          ...focusInputStyle,
          ...aFocus.focusStyles,
        }}
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        style={{
          width: '100%',
          fontSize: 13,
          padding: '7px 10px',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          background: T.bg.primary,
          color: category ? T.text.primary : T.text.tertiary,
          fontFamily: T.font.sans,
          boxSizing: 'border-box',
          marginBottom: 8,
          outline: 'none',
          cursor: 'pointer',
        }}
      >
        <option value="">No category</option>
        {KB_CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <button
        style={{
          ...btnPrimary,
          opacity: isDisabled ? 0.5 : addBtnHover.hovered ? 0.85 : 1,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
        }}
        disabled={isDisabled}
        onClick={handleAdd}
        {...addBtnHover.handlers}
      >
        {loading ? 'Adding...' : 'Add'}
      </button>
    </div>
  )
}

function KnowledgeBaseSection(): React.ReactElement {
  const [pending, setPending] = useState<ApiKnowledgeSuggestion[]>([])
  const [approved, setApproved] = useState<ApiKnowledgeSuggestion[]>([])
  const [activeTab, setActiveTab] = useState<'pending' | 'approved'>('pending')
  const [showAddForm, setShowAddForm] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [detectingGaps, setDetectingGaps] = useState(false)
  const [gaps, setGaps] = useState<Array<{ question: string; suggestedAnswer: string }>>([])
  const [addingGapIdx, setAddingGapIdx] = useState<number | null>(null)
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [bulkImportText, setBulkImportText] = useState('')
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkImportResult, setBulkImportResult] = useState<number | null>(null)
  const addBtnHover = useHover()
  const detectBtnHover = useHover()
  const bulkImportBtnHover = useHover()
  const searchFocus = useFocusStyle()

  const loadAll = useCallback((): void => {
    const opts = {
      category: selectedCategory || undefined,
      search: activeSearch || undefined,
    }
    apiGetKnowledgeSuggestions('pending', opts).then(setPending).catch(() => {})
    apiGetKnowledgeSuggestions('approved', opts).then(setApproved).catch(() => {})
  }, [selectedCategory, activeSearch])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  function handleSearch(): void {
    setActiveSearch(searchQuery)
  }

  async function handleDetectGaps(): Promise<void> {
    setDetectingGaps(true)
    setGaps([])
    try {
      const result = await apiDetectKnowledgeGaps()
      setGaps(result)
    } catch {
      // silent
    } finally {
      setDetectingGaps(false)
    }
  }

  async function handleBulkImport(): Promise<void> {
    if (!bulkImportText.trim() || bulkImporting) return
    setBulkImporting(true)
    setBulkImportResult(null)
    try {
      const result = await apiBulkImportKnowledge(bulkImportText.trim())
      setBulkImportResult(result.length)
      setBulkImportText('')
      loadAll()
    } catch {
      // silent
    } finally {
      setBulkImporting(false)
    }
  }

  async function handleAddGap(idx: number): Promise<void> {
    const gap = gaps[idx]
    if (!gap) return
    setAddingGapIdx(idx)
    try {
      await apiCreateKnowledgeSuggestion({ question: gap.question, answer: gap.suggestedAnswer })
      setGaps((prev) => prev.filter((_, i) => i !== idx))
      loadAll()
    } finally {
      setAddingGapIdx(null)
    }
  }

  function handleApprove(updated: ApiKnowledgeSuggestion): void {
    setPending((prev) => prev.filter((s) => s.id !== updated.id))
    setApproved((prev) => [...prev, updated])
  }

  function handleDeleteFromPending(id: string): void {
    setPending((prev) => prev.filter((s) => s.id !== id))
  }

  function handleDeleteFromApproved(id: string): void {
    setApproved((prev) => prev.filter((s) => s.id !== id))
  }

  const activeItems = activeTab === 'pending' ? pending : approved

  const tabStyle = (tab: 'pending' | 'approved'): React.CSSProperties => ({
    height: 28,
    padding: '0 14px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 999,
    border: 'none',
    background: activeTab === tab ? T.border.strong : 'transparent',
    color: activeTab === tab ? '#FFFFFF' : T.text.secondary,
    fontFamily: T.font.sans,
    transition: 'all 0.2s ease',
  })

  const catPillStyle = (cat: string): React.CSSProperties => ({
    height: 26,
    padding: '0 12px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 999,
    border: selectedCategory === cat ? `1px solid ${T.border.strong}` : `1px solid ${T.border.default}`,
    background: selectedCategory === cat ? T.border.strong : 'transparent',
    color: selectedCategory === cat ? '#FFFFFF' : T.text.secondary,
    fontFamily: T.font.sans,
    transition: 'all 0.2s ease',
  })

  return (
    <div style={{ ...cardStyle, animation: 'fadeInUp 0.4s ease-out both', animationDelay: '0.2s' }}>
      <div style={cardHeaderStyle}>Knowledge Base</div>
      <div style={cardBodyStyle}>
        {/* Search bar */}
        <div style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Search Q&A entries..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            {...searchFocus.handlers}
            style={{
              width: '100%',
              fontSize: 13,
              padding: '8px 12px',
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              background: T.bg.primary,
              color: T.text.primary,
              fontFamily: T.font.sans,
              boxSizing: 'border-box',
              outline: 'none',
              ...focusInputStyle,
              ...searchFocus.focusStyles,
            }}
          />
        </div>

        {/* Category filter pills */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
          <button style={catPillStyle('')} onClick={() => setSelectedCategory('')}>
            All
          </button>
          {KB_CATEGORIES.map((cat) => (
            <button key={cat} style={catPillStyle(cat)} onClick={() => setSelectedCategory(selectedCategory === cat ? '' : cat)}>
              {cat}
            </button>
          ))}
        </div>

        {/* Tab pills + Detect Gaps button */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, alignItems: 'center' }}>
          <button style={tabStyle('pending')} onClick={() => setActiveTab('pending')}>
            Pending {pending.length > 0 ? `(${pending.length})` : ''}
          </button>
          <button style={tabStyle('approved')} onClick={() => setActiveTab('approved')}>
            Approved {approved.length > 0 ? `(${approved.length})` : ''}
          </button>
          <div style={{ flex: 1 }} />
          <button
            style={{
              ...btnGhost,
              height: 26,
              padding: '0 12px',
              fontSize: 11,
              fontWeight: 600,
              background: bulkImportBtnHover.hovered ? T.bg.secondary : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => { setShowBulkImport(true); setBulkImportResult(null) }}
            {...bulkImportBtnHover.handlers}
          >
            Bulk Import
          </button>
          <button
            style={{
              ...btnGhost,
              height: 26,
              padding: '0 12px',
              fontSize: 11,
              fontWeight: 600,
              opacity: detectingGaps ? 0.5 : 1,
              cursor: detectingGaps ? 'not-allowed' : 'pointer',
              background: !detectingGaps && detectBtnHover.hovered ? T.bg.secondary : 'transparent',
            }}
            disabled={detectingGaps}
            onClick={handleDetectGaps}
            {...detectBtnHover.handlers}
          >
            {detectingGaps ? 'Analyzing conversations...' : 'Detect Gaps'}
          </button>
        </div>

        {/* Bulk Import panel */}
        {showBulkImport && (
          <div style={{
            border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.md,
            padding: 16,
            marginBottom: 16,
            background: T.bg.secondary,
            animation: 'scaleIn 0.2s ease-out',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 8 }}>
              Bulk Import
            </div>
            <div style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 10, lineHeight: 1.5 }}>
              Paste text from a Google Doc, house rules, FAQ document, etc. AI will parse it into Q&A pairs.
            </div>
            <textarea
              placeholder="Paste your text here..."
              value={bulkImportText}
              onChange={(e) => setBulkImportText(e.target.value)}
              rows={8}
              style={{
                width: '100%',
                fontSize: 13,
                padding: '10px 12px',
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                background: T.bg.primary,
                color: T.text.primary,
                fontFamily: T.font.mono,
                boxSizing: 'border-box',
                outline: 'none',
                resize: 'vertical',
                lineHeight: 1.6,
                marginBottom: 10,
                ...focusInputStyle,
              }}
              disabled={bulkImporting}
            />
            {bulkImportResult !== null && (
              <div style={{
                fontSize: 12,
                color: T.status.green,
                fontFamily: T.font.sans,
                fontWeight: 600,
                marginBottom: 10,
              }}>
                Successfully imported {bulkImportResult} Q&A {bulkImportResult === 1 ? 'entry' : 'entries'}.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                style={{
                  ...btnGhost,
                  height: 28,
                  padding: '0 14px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
                onClick={() => { setShowBulkImport(false); setBulkImportText(''); setBulkImportResult(null) }}
                disabled={bulkImporting}
              >
                Cancel
              </button>
              <button
                style={{
                  ...btnPrimary,
                  height: 28,
                  padding: '0 14px',
                  fontSize: 12,
                  opacity: !bulkImportText.trim() || bulkImporting ? 0.5 : 1,
                  cursor: !bulkImportText.trim() || bulkImporting ? 'not-allowed' : 'pointer',
                }}
                disabled={!bulkImportText.trim() || bulkImporting}
                onClick={handleBulkImport}
              >
                {bulkImporting ? 'Parsing with AI...' : 'Import'}
              </button>
            </div>
          </div>
        )}

        {/* Gap detection results */}
        {gaps.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginBottom: 8, fontFamily: T.font.sans, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Detected Gaps ({gaps.length})
            </div>
            {gaps.map((gap, idx) => (
              <div
                key={idx}
                style={{
                  border: `1px solid rgba(29,78,216,0.15)`,
                  borderRadius: T.radius.md,
                  padding: '14px 16px',
                  marginBottom: 8,
                  background: 'rgba(29,78,216,0.03)',
                  animation: 'fadeInUp 0.3s ease-out both',
                  animationDelay: `${idx * 0.05}s`,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 6, lineHeight: 1.4 }}>
                  {gap.question}
                </div>
                <div style={{ fontSize: 13, color: T.text.secondary, fontFamily: T.font.sans, lineHeight: 1.5, marginBottom: 10 }}>
                  {gap.suggestedAnswer}
                </div>
                <button
                  style={{
                    ...btnPrimary,
                    height: 28,
                    padding: '0 14px',
                    fontSize: 12,
                    opacity: addingGapIdx === idx ? 0.5 : 1,
                    cursor: addingGapIdx === idx ? 'not-allowed' : 'pointer',
                  }}
                  disabled={addingGapIdx === idx}
                  onClick={() => handleAddGap(idx)}
                >
                  {addingGapIdx === idx ? 'Adding...' : 'Add to KB'}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Items */}
        {activeItems.length === 0 ? (
          <div style={{ fontSize: 13, color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 12 }}>
            {activeTab === 'pending' ? 'No pending suggestions.' : 'No approved entries yet.'}
            {(activeSearch || selectedCategory) && ' Try adjusting your filters.'}
          </div>
        ) : (
          activeItems.map((item) => (
            <KbItem
              key={item.id}
              item={item}
              tab={activeTab}
              onApprove={activeTab === 'pending' ? handleApprove : undefined}
              onDelete={activeTab === 'pending' ? handleDeleteFromPending : handleDeleteFromApproved}
            />
          ))
        )}

        {/* Add Manual Entry */}
        {!showAddForm ? (
          <button
            style={{
              ...btnGhost,
              marginTop: 4,
              background: addBtnHover.hovered ? T.bg.secondary : 'transparent',
            }}
            onClick={() => setShowAddForm(true)}
            {...addBtnHover.handlers}
          >
            + Add Manual Entry
          </button>
        ) : (
          <AddEntryForm
            onAdded={() => {
              setShowAddForm(false)
              loadAll()
            }}
          />
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
    apiGetPropertiesAiStatus().then(setProperties).catch(() => {})
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

// ─── RAG Chunks Viewer ────────────────────────────────────────────────────────
function RagChunksSection(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>('')
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    apiGetProperties().then(props => {
      setProperties(props)
      if (props.length > 0 && !selectedPropertyId) setSelectedPropertyId(props[0].id)
    }).catch(() => {})
  }, [open, selectedPropertyId])

  useEffect(() => {
    if (!selectedPropertyId) return
    setLoading(true)
    apiGetKnowledgeChunks(selectedPropertyId)
      .then(setChunks)
      .catch(() => setChunks([]))
      .finally(() => setLoading(false))
  }, [selectedPropertyId])

  const filtered = search
    ? chunks.filter(c => c.content.toLowerCase().includes(search.toLowerCase()) || c.sourceKey.toLowerCase().includes(search.toLowerCase()))
    : chunks

  const categoryColors: Record<string, string> = {
    checkin: '#1D4ED8', amenities: '#15803D', rules: '#DC2626',
    parking: '#D97706', wifi: '#7C3AED', maintenance: '#0891B2',
    booking: '#DB2777', general: '#57534E',
  }

  return (
    <div style={{ background: T.bg.primary, borderRadius: T.radius.md, border: `1px solid ${T.border.default}`, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text.primary }}>RAG Knowledge Chunks</div>
          <div style={{ fontSize: 12, color: T.text.tertiary, marginTop: 2 }}>View what was indexed from your properties for AI retrieval</div>
        </div>
        {open ? <ChevronDown size={16} color={T.text.tertiary} /> : <ChevronRight size={16} color={T.text.tertiary} />}
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${T.border.default}`, padding: '16px 20px' }}>
          {/* Property selector + search */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <select
              value={selectedPropertyId}
              onChange={e => setSelectedPropertyId(e.target.value)}
              style={{ flex: 1, height: 34, padding: '0 10px', fontSize: 12, border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm, background: T.bg.primary, color: T.text.primary, outline: 'none' }}
            >
              {properties.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              placeholder="Search chunks…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 180, height: 34, padding: '0 10px', fontSize: 12, border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm, background: T.bg.primary, color: T.text.primary, outline: 'none' }}
            />
          </div>

          {/* Stats */}
          <div style={{ fontSize: 11, color: T.text.tertiary, marginBottom: 10 }}>
            {loading ? 'Loading…' : `${filtered.length} of ${chunks.length} chunks`}
          </div>

          {/* Chunk list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 480, overflowY: 'auto' }}>
            {filtered.length === 0 && !loading && (
              <div style={{ fontSize: 12, color: T.text.tertiary, textAlign: 'center', padding: '20px 0' }}>
                No chunks found. Run Import Data or use Reindex Knowledge on a property.
              </div>
            )}
            {filtered.map(chunk => (
              <div
                key={chunk.id}
                style={{ background: T.bg.secondary, border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm, padding: '10px 12px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                    color: '#fff', background: categoryColors[chunk.category] ?? '#57534E',
                    padding: '2px 7px', borderRadius: 99,
                  }}>
                    {chunk.category}
                  </span>
                  <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: 'monospace' }}>
                    {chunk.sourceKey || 'no-key'}
                  </span>
                  <span style={{ fontSize: 10, color: T.text.tertiary, marginLeft: 'auto' }}>
                    {new Date(chunk.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: T.text.primary, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {chunk.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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
            Manage data sync, properties, templates, and knowledge base
          </div>
        </div>

        <DataSyncSection onImportComplete={onImportComplete} />
        <PropertiesSection />
        <MessageTemplatesSection />
        <KnowledgeBaseSection />
        <RagChunksSection />
        <AIToggleSection onImportComplete={onImportComplete} />
        <ChangePasswordSection />
        <DangerZoneSection onImportComplete={onImportComplete} />
      </div>
    </div>
  )
}
