'use client'

import { useState, useEffect, useCallback } from 'react'
import { Wrench, Activity, RefreshCw, Clock, ChevronDown, ChevronUp, Globe, ToggleLeft, ToggleRight, Plus, Trash2, X, Check, RotateCcw, Edit3, AlertTriangle } from 'lucide-react'
import {
  apiGetTools,
  apiUpdateTool,
  apiCreateTool,
  apiDeleteTool,
  apiResetToolDescription,
  apiGetToolInvocations,
  type ApiToolDefinition,
  type ToolInvocation,
} from '@/lib/api'

// ─── Design Tokens ──────────────────────────────────────────────────────────
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

// ─── Styles ──────────────────────────────────────────────────────────────────
const STYLE_ID = 'tools-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.tools-scroll::-webkit-scrollbar { width: 5px; }
.tools-scroll::-webkit-scrollbar-track { background: transparent; }
.tools-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.tools-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`
  document.head.appendChild(style)
}

// ─── Badge colors ───────────────────────────────────────────────────────────
function typeBadgeStyle(type: string): React.CSSProperties {
  if (type === 'custom') {
    return {
      background: `${T.accent}0A`,
      color: T.accent,
      border: `1px solid ${T.accent}20`,
    }
  }
  // system
  return {
    background: T.bg.tertiary,
    color: T.text.secondary,
    border: `1px solid ${T.border.default}`,
  }
}

function scopeBadgeStyle(scope: string): React.CSSProperties {
  if (scope === 'screening') {
    return {
      background: `${T.status.green}0A`,
      color: T.status.green,
      border: `1px solid ${T.status.green}20`,
    }
  }
  if (scope === 'coordinator') {
    return {
      background: `${T.accent}0A`,
      color: T.accent,
      border: `1px solid ${T.accent}20`,
    }
  }
  // both
  return {
    background: '#7C3AED0A',
    color: '#7C3AED',
    border: '1px solid #7C3AED20',
  }
}

// ─── Primitives ─────────────────────────────────────────────────────────────
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: T.bg.primary, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.lg, boxShadow: T.shadow.sm,
      overflow: 'hidden',
      animation: 'scaleIn 0.3s ease-out both',
      ...style,
    }}>{children}</div>
  )
}

function CardHeader({ icon, title, sub, right }: {
  icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode
}) {
  return (
    <div style={{
      padding: '13px 20px', borderBottom: `1px solid ${T.border.default}`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono }}>{sub}</span>}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>}
    </div>
  )
}

function RefreshBtn({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      height: 28, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 11, fontWeight: 600, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.sm, background: T.bg.primary, color: T.text.secondary,
      cursor: loading ? 'default' : 'pointer', fontFamily: T.font.sans,
      opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s',
    }}>
      <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
      Refresh
    </button>
  )
}

function Badge({ label, style }: { label: string; style?: React.CSSProperties }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, fontFamily: T.font.mono,
      padding: '2px 8px', borderRadius: 999,
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {label}
    </span>
  )
}

function SmallBtn({ children, onClick, disabled, variant = 'default', style: extraStyle }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean
  variant?: 'default' | 'primary' | 'danger'
  style?: React.CSSProperties
}) {
  const base: React.CSSProperties = {
    height: 26, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 11, fontWeight: 600, borderRadius: T.radius.sm,
    cursor: disabled ? 'default' : 'pointer', fontFamily: T.font.sans,
    opacity: disabled ? 0.5 : 1, transition: 'opacity 0.15s, background 0.15s',
    border: 'none',
  }
  const variants: Record<string, React.CSSProperties> = {
    default: { background: T.bg.tertiary, color: T.text.secondary },
    primary: { background: T.accent, color: '#fff' },
    danger: { background: `${T.status.red}12`, color: T.status.red, border: `1px solid ${T.status.red}25` },
  }
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...extraStyle }}>
      {children}
    </button>
  )
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ─── Confirm Dialog ─────────────────────────────────────────────────────────
function ConfirmDialog({ open, title, message, confirmLabel, confirmVariant, onConfirm, onCancel }: {
  open: boolean; title: string; message: string; confirmLabel: string
  confirmVariant?: 'primary' | 'danger'
  onConfirm: () => void; onCancel: () => void
}) {
  if (!open) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.15s ease-out',
    }} onClick={onCancel}>
      <div
        style={{
          background: T.bg.primary, borderRadius: T.radius.lg, boxShadow: T.shadow.lg,
          padding: 24, width: 380, maxWidth: '90vw',
          animation: 'scaleIn 0.2s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <AlertTriangle size={18} color={T.status.amber} />
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>{title}</span>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 20 }}>
          {message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <SmallBtn onClick={onCancel}>Cancel</SmallBtn>
          <SmallBtn onClick={onConfirm} variant={confirmVariant || 'primary'}>{confirmLabel}</SmallBtn>
        </div>
      </div>
    </div>
  )
}

// ─── Tool Card ──────────────────────────────────────────────────────────────
function ToolCard({ tool, index, onUpdate, onDelete }: {
  tool: ApiToolDefinition; index: number
  onUpdate: (updated: ApiToolDefinition) => void
  onDelete: (id: string) => void
}) {
  const [paramsExpanded, setParamsExpanded] = useState(false)

  // T009: Inline description editing
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(tool.description)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // T010: Toggle state
  const [toggling, setToggling] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState(false)

  // T014: Delete confirmation
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isModified = tool.description !== tool.defaultDescription
  const hasParams = tool.parameters && Object.keys(tool.parameters).length > 0
  const paramJson = hasParams ? JSON.stringify(tool.parameters, null, 2) : null

  // T009: Start editing
  const startEdit = () => {
    setEditValue(tool.description)
    setEditError(null)
    setEditing(true)
  }
  const cancelEdit = () => {
    setEditValue(tool.description)
    setEditError(null)
    setEditing(false)
  }
  const saveDescription = async () => {
    if (editValue.trim().length < 10) {
      setEditError('Description must be at least 10 characters')
      return
    }
    setSaving(true)
    setEditError(null)
    try {
      const updated = await apiUpdateTool(tool.id, { description: editValue.trim() })
      onUpdate(updated)
      setEditing(false)
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // T009: Reset to default
  const resetDescription = async () => {
    setSaving(true)
    setEditError(null)
    try {
      const updated = await apiResetToolDescription(tool.id)
      onUpdate(updated)
      setEditValue(updated.description)
      setEditing(false)
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
  }

  // T010: Toggle enable/disable
  const handleToggleClick = () => {
    // Show warning for get_sop tool
    if (tool.name === 'get_sop') {
      setConfirmToggle(true)
      return
    }
    doToggle()
  }
  const doToggle = async () => {
    setConfirmToggle(false)
    setToggling(true)
    // Optimistic update
    const optimistic = { ...tool, enabled: !tool.enabled }
    onUpdate(optimistic)
    try {
      const updated = await apiUpdateTool(tool.id, { enabled: !tool.enabled })
      onUpdate(updated)
    } catch {
      // Revert on error
      onUpdate(tool)
    } finally {
      setToggling(false)
    }
  }

  // T014: Delete custom tool
  const doDelete = async () => {
    setConfirmDeleteOpen(false)
    setDeleting(true)
    try {
      await apiDeleteTool(tool.id)
      onDelete(tool.id)
    } catch {
      setDeleting(false)
    }
  }

  return (
    <>
      <ConfirmDialog
        open={confirmToggle}
        title="Disable Core Tool?"
        message="get_sop is the core SOP classification tool. Disabling it will prevent the AI from classifying guest messages into Standard Operating Procedures. This may significantly degrade response quality. Are you sure?"
        confirmLabel={tool.enabled ? 'Disable' : 'Enable'}
        confirmVariant="danger"
        onConfirm={doToggle}
        onCancel={() => setConfirmToggle(false)}
      />
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete Custom Tool?"
        message={`This will permanently delete the "${tool.displayName}" tool. Any webhook integrations using this tool will stop working.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={doDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
      <div
        style={{
          background: T.bg.primary,
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.lg,
          boxShadow: T.shadow.sm,
          overflow: 'hidden',
          animation: 'fadeInUp 0.3s ease-out both',
          animationDelay: `${index * 0.04}s`,
          transition: 'box-shadow 0.2s ease',
          opacity: deleting ? 0.4 : 1,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = T.shadow.md }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = T.shadow.sm }}
      >
        {/* Header row */}
        <div style={{
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          {/* Icon */}
          <div style={{
            width: 34, height: 34, borderRadius: T.radius.sm,
            background: tool.enabled ? `${T.accent}08` : T.bg.tertiary,
            border: `1px solid ${tool.enabled ? `${T.accent}15` : T.border.default}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Wrench size={15} color={tool.enabled ? T.accent : T.text.tertiary} />
          </div>

          {/* Name + monospace identifier */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 14, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans,
                letterSpacing: '-0.01em',
              }}>
                {tool.displayName}
              </span>
              <span style={{
                fontSize: 10, fontFamily: T.font.mono, fontWeight: 500,
                color: T.text.tertiary, background: T.bg.tertiary,
                padding: '2px 7px', borderRadius: 4,
              }}>
                {tool.name}
              </span>
              {isModified && (
                <Badge label="modified" style={{
                  background: `${T.status.amber}10`,
                  color: T.status.amber,
                  border: `1px solid ${T.status.amber}25`,
                }} />
              )}
            </div>
          </div>

          {/* Badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
            <Badge label={tool.type} style={typeBadgeStyle(tool.type)} />
            {/* Booking status toggles */}
            {['INQUIRY', 'CONFIRMED', 'CHECKED_IN'].map(status => {
              const statuses = tool.agentScope.split(',').map(s => s.trim())
              const active = statuses.includes(status)
              return (
                <button
                  key={status}
                  onClick={async () => {
                    const newStatuses = active
                      ? statuses.filter(s => s !== status && s !== (status === 'INQUIRY' ? 'PENDING' : ''))
                      : [...statuses, status, ...(status === 'INQUIRY' ? ['PENDING'] : [])]
                    const cleaned = [...new Set(newStatuses.filter(Boolean))]
                    if (cleaned.length === 0) return // can't have zero statuses
                    const newScope = cleaned.join(',')
                    // Sprint 047 Session C — tsc cleanup. Prior shape
                    // referenced a non-existent `setTools` in the
                    // ToolCard child scope; the parent exposes an
                    // `onUpdate(updated)` callback for exactly this.
                    // Optimistic update via onUpdate, rollback to
                    // the original tool object on error.
                    onUpdate({ ...tool, agentScope: newScope })
                    try {
                      await apiUpdateTool(tool.id, { agentScope: newScope })
                    } catch {
                      onUpdate(tool)
                    }
                  }}
                  style={{
                    fontSize: 9, fontWeight: 600, fontFamily: T.font.mono,
                    padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${active ? '#15803D40' : T.border.default}`,
                    background: active ? '#15803D14' : 'transparent',
                    color: active ? '#15803D' : T.text.tertiary,
                    transition: 'all 0.15s',
                  }}
                >
                  {status === 'CHECKED_IN' ? 'Checked In' : status === 'INQUIRY' ? 'Inquiry' : 'Confirmed'}
                </button>
              )
            })}
          </div>

          {/* T010: Enabled toggle — clickable */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
              cursor: toggling ? 'default' : 'pointer',
              opacity: toggling ? 0.6 : 1,
              transition: 'opacity 0.15s',
            }}
            onClick={toggling ? undefined : handleToggleClick}
          >
            {tool.enabled ? (
              <ToggleRight size={22} color={T.status.green} />
            ) : (
              <ToggleLeft size={22} color={T.text.tertiary} />
            )}
            <span style={{
              fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
              color: tool.enabled ? T.status.green : T.text.tertiary,
            }}>
              {tool.enabled ? 'On' : 'Off'}
            </span>
          </div>

          {/* T014: Delete button for custom tools */}
          {tool.type === 'custom' && (
            <SmallBtn onClick={() => setConfirmDeleteOpen(true)} variant="danger" disabled={deleting}>
              <Trash2 size={11} />
            </SmallBtn>
          )}
        </div>

        {/* T009: Description — inline editable */}
        <div style={{ padding: '0 20px 14px 20px' }}>
          {editing ? (
            <div>
              <textarea
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                rows={4}
                style={{
                  width: '100%', resize: 'vertical',
                  fontSize: 12, lineHeight: 1.6, color: T.text.primary, fontFamily: T.font.sans,
                  padding: 10, borderRadius: T.radius.sm,
                  border: `1px solid ${editError ? T.status.red : T.accent}40`,
                  background: T.bg.secondary, outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {editError && (
                <div style={{ fontSize: 11, color: T.status.red, marginTop: 4, fontFamily: T.font.sans }}>
                  {editError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                <SmallBtn onClick={saveDescription} variant="primary" disabled={saving}>
                  <Check size={11} /> Save
                </SmallBtn>
                <SmallBtn onClick={cancelEdit} disabled={saving}>
                  <X size={11} /> Cancel
                </SmallBtn>
                {isModified && (
                  <SmallBtn onClick={resetDescription} disabled={saving} style={{ marginLeft: 'auto' }}>
                    <RotateCcw size={11} /> Reset to Default
                  </SmallBtn>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  fontSize: 12, lineHeight: 1.6, color: T.text.secondary, fontFamily: T.font.sans,
                  cursor: 'pointer',
                  padding: '4px 8px', borderRadius: T.radius.sm,
                  transition: 'background 0.15s',
                }}
                onClick={startEdit}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = T.bg.secondary }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                title="Click to edit description"
              >
                {tool.description}
              </div>
              <div
                style={{
                  flexShrink: 0, cursor: 'pointer', padding: 4, borderRadius: 4,
                  color: T.text.tertiary, transition: 'color 0.15s',
                }}
                onClick={startEdit}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.color = T.accent }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.color = T.text.tertiary }}
              >
                <Edit3 size={13} />
              </div>
            </div>
          )}
          {/* Reset link when modified and not editing */}
          {isModified && !editing && (
            <div style={{ marginTop: 4, paddingLeft: 8 }}>
              <span
                style={{
                  fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans,
                  cursor: 'pointer', textDecoration: 'underline', transition: 'color 0.15s',
                }}
                onClick={resetDescription}
                onMouseEnter={e => { (e.currentTarget as HTMLSpanElement).style.color = T.accent }}
                onMouseLeave={e => { (e.currentTarget as HTMLSpanElement).style.color = T.text.tertiary }}
              >
                Reset to Default
              </span>
            </div>
          )}
        </div>

        {/* Webhook URL for custom tools */}
        {tool.type === 'custom' && tool.webhookUrl && (
          <div style={{
            padding: '0 20px 14px 20px',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Globe size={12} color={T.text.tertiary} />
            <span style={{
              fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {tool.webhookUrl}
            </span>
            <span style={{
              fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary,
              flexShrink: 0,
            }}>
              ({tool.webhookTimeout}ms timeout)
            </span>
          </div>
        )}

        {/* Collapsible parameter schema */}
        {hasParams && (
          <div style={{ borderTop: `1px solid ${T.border.default}` }}>
            <button
              onClick={() => setParamsExpanded(v => !v)}
              style={{
                width: '100%', padding: '10px 20px',
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: T.font.sans, fontSize: 11, fontWeight: 600,
                color: T.text.secondary, textAlign: 'left',
                transition: 'background 0.1s ease',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = T.bg.secondary }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              {paramsExpanded
                ? <ChevronUp size={13} color={T.text.tertiary} />
                : <ChevronDown size={13} color={T.text.tertiary} />
              }
              Parameter Schema
              <span style={{
                fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, fontWeight: 400,
              }}>
                {Object.keys((tool.parameters as Record<string, unknown>)?.properties ?? tool.parameters).length} fields
              </span>
            </button>
            {paramsExpanded && (
              <div style={{
                padding: '0 20px 16px 20px',
                animation: 'fadeInUp 0.2s ease-out',
              }}>
                <pre style={{
                  margin: 0,
                  padding: 14,
                  background: T.bg.secondary,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.sm,
                  fontSize: 11,
                  fontFamily: T.font.mono,
                  color: T.text.primary,
                  lineHeight: 1.6,
                  overflow: 'auto',
                  maxHeight: 400,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {paramJson}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ─── T013: Create Custom Tool Modal ─────────────────────────────────────────
const INITIAL_PARAMS = `{
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "description": "The input value"
    }
  },
  "required": ["input"],
  "additionalProperties": false
}`

function CreateToolModal({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: (tool: ApiToolDefinition) => void
}) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [agentScope, setAgentScope] = useState('INQUIRY,PENDING,CONFIRMED,CHECKED_IN')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [parametersJson, setParametersJson] = useState(INITIAL_PARAMS)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const resetForm = () => {
    setName('')
    setDisplayName('')
    setDescription('')
    setAgentScope('both')
    setWebhookUrl('')
    setParametersJson(INITIAL_PARAMS)
    setErrors({})
    setSaving(false)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
      e.name = 'Must start with lowercase letter, only lowercase letters, numbers, underscores'
    }
    if (!displayName.trim()) {
      e.displayName = 'Required'
    }
    if (!description || description.length < 10) {
      e.description = 'Must be at least 10 characters'
    }
    const scopeStatuses = agentScope.split(',').filter(Boolean)
    if (scopeStatuses.length === 0) {
      e.agentScope = 'Select at least one booking status'
    }
    try {
      const parsed = JSON.parse(parametersJson)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        e.parameters = 'Must be a JSON object'
      }
    } catch {
      e.parameters = 'Invalid JSON syntax'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSave = async () => {
    if (!validate()) return
    setSaving(true)
    setErrors({})
    try {
      const params = JSON.parse(parametersJson)
      const created = await apiCreateTool({
        name: name.trim(),
        displayName: displayName.trim(),
        description: description.trim(),
        agentScope,
        webhookUrl: webhookUrl.trim(),
        parameters: params,
      })
      onCreated(created)
      handleClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create tool'
      setErrors({ _global: msg })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const fieldLabelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans,
    marginBottom: 4, display: 'block',
  }
  const fieldInputStyle: React.CSSProperties = {
    width: '100%', fontSize: 12, fontFamily: T.font.sans,
    padding: '8px 10px', borderRadius: T.radius.sm,
    border: `1px solid ${T.border.default}`,
    background: T.bg.secondary, outline: 'none',
    boxSizing: 'border-box',
    color: T.text.primary,
  }
  const fieldErrorStyle: React.CSSProperties = {
    fontSize: 10, color: T.status.red, marginTop: 3, fontFamily: T.font.sans,
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.15s ease-out',
    }} onClick={handleClose}>
      <div
        style={{
          background: T.bg.primary, borderRadius: T.radius.lg, boxShadow: T.shadow.lg,
          width: 520, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto',
          animation: 'scaleIn 0.2s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${T.border.default}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Plus size={16} color={T.accent} />
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, flex: 1 }}>
            Add Custom Tool
          </span>
          <div style={{ cursor: 'pointer', color: T.text.tertiary }} onClick={handleClose}>
            <X size={16} />
          </div>
        </div>

        {/* Form body */}
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {errors._global && (
            <div style={{
              fontSize: 12, color: T.status.red, background: `${T.status.red}08`,
              padding: '8px 12px', borderRadius: T.radius.sm, fontFamily: T.font.sans,
              border: `1px solid ${T.status.red}20`,
            }}>
              {errors._global}
            </div>
          )}

          {/* Name */}
          <div>
            <label style={fieldLabelStyle}>Tool Name (slug)</label>
            <input
              value={name}
              onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="my_custom_tool"
              style={{ ...fieldInputStyle, fontFamily: T.font.mono, ...(errors.name ? { borderColor: T.status.red } : {}) }}
            />
            {errors.name && <div style={fieldErrorStyle}>{errors.name}</div>}
          </div>

          {/* Display Name */}
          <div>
            <label style={fieldLabelStyle}>Display Name</label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="My Custom Tool"
              style={{ ...fieldInputStyle, ...(errors.displayName ? { borderColor: T.status.red } : {}) }}
            />
            {errors.displayName && <div style={fieldErrorStyle}>{errors.displayName}</div>}
          </div>

          {/* Description */}
          <div>
            <label style={fieldLabelStyle}>Description (AI-facing)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              placeholder="Describe what this tool does and when the AI should use it..."
              style={{ ...fieldInputStyle, resize: 'vertical', ...(errors.description ? { borderColor: T.status.red } : {}) }}
            />
            {errors.description && <div style={fieldErrorStyle}>{errors.description}</div>}
          </div>

          {/* Booking Statuses */}
          <div>
            <label style={fieldLabelStyle}>Available for Booking Statuses</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['INQUIRY', 'CONFIRMED', 'CHECKED_IN'].map(status => {
                const statuses = agentScope.split(',').map(s => s.trim())
                const active = statuses.includes(status)
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => {
                      let newStatuses: string[]
                      if (active) {
                        newStatuses = statuses.filter(s => s !== status && s !== (status === 'INQUIRY' ? 'PENDING' : ''))
                      } else {
                        newStatuses = [...statuses, status, ...(status === 'INQUIRY' ? ['PENDING'] : [])]
                      }
                      const cleaned = [...new Set(newStatuses.filter(Boolean))]
                      setAgentScope(cleaned.join(','))
                    }}
                    style={{
                      padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                      fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
                      border: `1px solid ${active ? T.accent + '40' : T.border.default}`,
                      background: active ? T.accent + '14' : T.bg.primary,
                      color: active ? T.accent : T.text.tertiary,
                    }}
                  >
                    {status === 'CHECKED_IN' ? 'Checked In' : status === 'INQUIRY' ? 'Inquiry' : 'Confirmed'}
                  </button>
                )
              })}
            </div>
            {errors.agentScope && <div style={fieldErrorStyle}>{errors.agentScope}</div>}
          </div>

          {/* Webhook URL */}
          <div>
            <label style={fieldLabelStyle}>Webhook URL</label>
            <input
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
              placeholder="https://your-server.com/api/tool-handler"
              style={{ ...fieldInputStyle, fontFamily: T.font.mono }}
            />
            <div style={{ fontSize: 10, color: T.text.tertiary, marginTop: 3, fontFamily: T.font.sans }}>
              Tool input will be POSTed as JSON to this URL. Response body returned to the AI.
            </div>
          </div>

          {/* Parameters JSON */}
          <div>
            <label style={fieldLabelStyle}>Parameter Schema (JSON)</label>
            <textarea
              value={parametersJson}
              onChange={e => setParametersJson(e.target.value)}
              rows={8}
              style={{
                ...fieldInputStyle,
                fontFamily: T.font.mono, fontSize: 11, lineHeight: 1.5,
                resize: 'vertical',
                ...(errors.parameters ? { borderColor: T.status.red } : {}),
              }}
            />
            {errors.parameters && <div style={fieldErrorStyle}>{errors.parameters}</div>}
          </div>
        </div>

        {/* Modal footer */}
        <div style={{
          padding: '12px 20px', borderTop: `1px solid ${T.border.default}`,
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <SmallBtn onClick={handleClose} disabled={saving}>Cancel</SmallBtn>
          <SmallBtn onClick={handleSave} variant="primary" disabled={saving}>
            {saving ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={11} />}
            Create Tool
          </SmallBtn>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function ToolsV5() {
  const [tools, setTools] = useState<ApiToolDefinition[]>([])
  const [toolsLoading, setToolsLoading] = useState(true)
  const [toolsError, setToolsError] = useState<string | null>(null)

  const [invocations, setInvocations] = useState<ToolInvocation[]>([])
  const [invLoading, setInvLoading] = useState(false)
  const [invError, setInvError] = useState<string | null>(null)

  // T013: Create modal
  const [createModalOpen, setCreateModalOpen] = useState(false)

  useEffect(() => { ensureStyles() }, [])

  const loadTools = useCallback(async () => {
    setToolsLoading(true)
    setToolsError(null)
    try {
      const data = await apiGetTools()
      setTools(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load tools'
      setToolsError(message)
    } finally {
      setToolsLoading(false)
    }
  }, [])

  const loadInvocations = useCallback(async () => {
    setInvLoading(true)
    setInvError(null)
    try {
      const data = await apiGetToolInvocations()
      setInvocations(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load tool invocations'
      setInvError(message)
    } finally {
      setInvLoading(false)
    }
  }, [])

  useEffect(() => { loadTools() }, [loadTools])
  useEffect(() => { loadInvocations() }, [loadInvocations])

  // Tool update handler — replaces tool in state
  const handleToolUpdate = useCallback((updated: ApiToolDefinition) => {
    setTools(prev => prev.map(t => t.id === updated.id ? updated : t))
  }, [])

  // Tool delete handler — removes tool from state
  const handleToolDelete = useCallback((id: string) => {
    setTools(prev => prev.filter(t => t.id !== id))
  }, [])

  // Tool created handler — adds to list
  const handleToolCreated = useCallback((created: ApiToolDefinition) => {
    setTools(prev => [...prev, created])
  }, [])

  // Separate tools by type for display
  const systemTools = tools.filter(t => t.type === 'system')
  const customTools = tools.filter(t => t.type === 'custom')

  return (
    <div
      className="tools-scroll"
      style={{
        height: '100%',
        overflow: 'auto',
        background: T.bg.secondary,
        padding: 24,
        fontFamily: T.font.sans,
      }}
    >
      {/* T013: Create tool modal */}
      <CreateToolModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={handleToolCreated}
      />

      <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{
            width: 36, height: 36, borderRadius: T.radius.sm, background: T.bg.primary,
            border: `1px solid ${T.border.default}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Wrench size={18} color={T.text.primary} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text.primary, letterSpacing: '-0.02em' }}>
              Tools
            </div>
            <div style={{ fontSize: 12, color: T.text.tertiary }}>
              AI agent tool definitions, parameter schemas, and recent invocations
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <SmallBtn onClick={() => setCreateModalOpen(true)} variant="primary">
              <Plus size={12} /> Add Custom Tool
            </SmallBtn>
            <RefreshBtn loading={toolsLoading} onClick={loadTools} />
          </div>
        </div>

        {/* Loading state */}
        {toolsLoading && tools.length === 0 && (
          <div style={{
            padding: '48px 20px', textAlign: 'center',
            fontSize: 12, color: T.text.tertiary,
          }}>
            <RefreshCw size={18} color={T.text.tertiary} style={{ animation: 'spin 1s linear infinite', marginBottom: 10 }} />
            <div>Loading tool definitions...</div>
          </div>
        )}

        {/* Error state */}
        {toolsError && (
          <Card>
            <div style={{
              padding: '16px 20px', fontSize: 12, color: T.status.red,
              fontFamily: T.font.sans, background: `${T.status.red}06`,
            }}>
              {toolsError}
            </div>
          </Card>
        )}

        {/* Empty state */}
        {!toolsLoading && !toolsError && tools.length === 0 && (
          <Card>
            <div style={{ padding: '48px 20px', textAlign: 'center' }}>
              <div style={{
                width: 48, height: 48, borderRadius: T.radius.md,
                background: T.bg.tertiary, margin: '0 auto 12px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Wrench size={20} color={T.text.tertiary} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text.secondary, marginBottom: 4 }}>
                No tools registered
              </div>
              <div style={{ fontSize: 11, color: T.text.tertiary }}>
                Tool definitions will appear here once the backend seeds system tools for this tenant.
              </div>
            </div>
          </Card>
        )}

        {/* Section: System Tools */}
        {systemTools.length > 0 && (
          <Card>
            <CardHeader
              icon={<Wrench size={14} color={T.accent} />}
              title="System Tools"
              sub={`${systemTools.length} registered`}
            />
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {systemTools.map((tool, i) => (
                <ToolCard key={tool.id} tool={tool} index={i} onUpdate={handleToolUpdate} onDelete={handleToolDelete} />
              ))}
            </div>
          </Card>
        )}

        {/* Section: Custom Tools */}
        {customTools.length > 0 && (
          <Card>
            <CardHeader
              icon={<Globe size={14} color={T.accent} />}
              title="Custom Tools"
              sub={`${customTools.length} registered`}
            />
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {customTools.map((tool, i) => (
                <ToolCard key={tool.id} tool={tool} index={i} onUpdate={handleToolUpdate} onDelete={handleToolDelete} />
              ))}
            </div>
          </Card>
        )}

        {/* T015: Section: Recent Invocations — shows ALL tool invocations */}
        <Card>
          <CardHeader
            icon={<Activity size={14} color={T.accent} />}
            title="Recent Invocations"
            sub={invocations.length > 0 ? `${invocations.length} entries` : undefined}
            right={<RefreshBtn loading={invLoading} onClick={loadInvocations} />}
          />

          {invError && (
            <div style={{
              padding: '12px 20px', fontSize: 12, color: T.status.red,
              fontFamily: T.font.sans, background: `${T.status.red}08`,
              borderBottom: `1px solid ${T.border.default}`,
            }}>
              {invError}
            </div>
          )}

          {!invLoading && !invError && invocations.length === 0 && (
            <div style={{
              padding: '40px 20px', textAlign: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: T.radius.md,
                background: T.bg.tertiary, margin: '0 auto 12px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Activity size={20} color={T.text.tertiary} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text.secondary, marginBottom: 4 }}>
                No tool invocations yet
              </div>
              <div style={{ fontSize: 11, color: T.text.tertiary }}>
                Tool calls will appear here when the AI agent uses registered tools during conversations.
              </div>
            </div>
          )}

          {invLoading && invocations.length === 0 && (
            <div style={{
              padding: '40px 20px', textAlign: 'center',
              fontSize: 12, color: T.text.tertiary,
            }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
              <div>Loading invocations...</div>
            </div>
          )}

          {invocations.length > 0 && (
            <div style={{ overflow: 'auto' }}>
              {/* Table header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '140px 130px 1fr 80px 80px',
                padding: '8px 20px',
                borderBottom: `1px solid ${T.border.default}`,
                background: T.bg.secondary,
                gap: 12,
              }}>
                {['Timestamp', 'Tool', 'Input', 'Results', 'Duration'].map((h) => (
                  <div key={h} style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.07em', color: T.text.tertiary, fontFamily: T.font.sans,
                  }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* Table rows */}
              {invocations.map((inv, i) => {
                const input = inv.toolInput as Record<string, unknown> | null
                const results = inv.toolResults as Record<string, unknown> | unknown[] | null

                // Format input summary — generic for all tools
                let inputSummary = ''
                if (input) {
                  const parts: string[] = []
                  for (const [key, val] of Object.entries(input)) {
                    if (val === null || val === undefined) continue
                    if (Array.isArray(val)) {
                      parts.push(`${key}: ${(val as string[]).join(', ')}`)
                    } else if (typeof val === 'object') {
                      parts.push(`${key}: ${JSON.stringify(val)}`)
                    } else {
                      parts.push(`${key}: ${String(val)}`)
                    }
                  }
                  inputSummary = parts.join(' | ')
                }

                // Extract results count
                let resultCount = '--'
                if (results) {
                  if (Array.isArray(results)) {
                    resultCount = String(results.length)
                  } else if (typeof results === 'object' && results !== null) {
                    if ('count' in results && results.count != null) {
                      resultCount = String(results.count)
                    } else if ('properties' in results && Array.isArray(results.properties)) {
                      resultCount = String(results.properties.length)
                    } else if ('created' in results) {
                      resultCount = results.created ? 'OK' : 'ERR'
                    } else if ('error' in results) {
                      resultCount = 'ERR'
                    } else if ('allComplete' in results) {
                      resultCount = (results as Record<string, unknown>).allComplete ? 'Done' : 'Partial'
                    } else {
                      // Generic: count top-level keys
                      resultCount = `${Object.keys(results).length} keys`
                    }
                  }
                }

                return (
                  <div
                    key={inv.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '140px 130px 1fr 80px 80px',
                      padding: '10px 20px',
                      borderBottom: i < invocations.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      gap: 12,
                      alignItems: 'center',
                      animation: `fadeInUp 0.2s ease-out ${i * 0.03}s both`,
                    }}
                  >
                    {/* Timestamp */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={11} color={T.text.tertiary} />
                      <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary }}>
                        {fmtTime(inv.createdAt)}
                      </span>
                    </div>

                    {/* Tool name */}
                    <div>
                      <span style={{
                        fontSize: 11, fontFamily: T.font.mono, fontWeight: 600,
                        color: T.accent, background: `${T.accent}0A`,
                        border: `1px solid ${T.accent}20`,
                        padding: '2px 8px', borderRadius: 4,
                      }}>
                        {inv.toolName || 'unknown'}
                      </span>
                    </div>

                    {/* Input summary */}
                    <div style={{
                      fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {inputSummary || '--'}
                    </div>

                    {/* Results count */}
                    <div style={{
                      fontSize: 12, fontWeight: 700, fontFamily: T.font.sans,
                      color: resultCount !== '--' ? T.text.primary : T.text.tertiary,
                    }}>
                      {resultCount}
                    </div>

                    {/* Duration */}
                    <div style={{
                      fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
                    }}>
                      {inv.toolDurationMs != null ? `${inv.toolDurationMs}ms` : '--'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
