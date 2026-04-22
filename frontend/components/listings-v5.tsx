'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  apiGetProperties,
  apiUpdateKnowledgeBase,
  apiUpdatePropertyAutoAccept,
  apiResyncProperty,
  apiSummarizeDescription,
  apiSummarizeAll,
  apiGetVariablePreview,
  type ApiProperty,
  type VariablePreview,
} from '@/lib/api'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4', card: '#FFFFFF' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E', inverse: '#FFFFFF' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706', blue: '#2563EB' },
  border: { default: '#E7E5E4', strong: '#D6D3D1' },
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

// ─── Injected Styles ──────────────────────────────────────────────────────────
const injectedStyles = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes listingsSpin { to { transform: rotate(360deg) } }
@keyframes listingsFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes listingsShimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes listingsSavedFade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
.listings-scroll::-webkit-scrollbar { width: 5px; }
.listings-scroll::-webkit-scrollbar-track { background: transparent; }
.listings-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.listings-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
.listings-input:focus { outline: none; border-color: ${T.accent} !important; box-shadow: 0 0 0 2px ${T.accent}20 !important; }
.listings-textarea { resize: vertical; }
.listings-textarea:focus { outline: none; border-color: ${T.accent} !important; box-shadow: 0 0 0 2px ${T.accent}20 !important; }
`

const STYLE_ID = 'listings-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = injectedStyles
  document.head.appendChild(style)
}

// ─── Types ────────────────────────────────────────────────────────────────────
type AmenityClassification = 'default' | 'available' | 'on_request' | 'off'

interface PropertyEditState {
  kb: Record<string, unknown>
  dirty: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function kbStr(kb: Record<string, unknown>, key: string): string {
  const v = kb[key]
  if (v === undefined || v === null) return ''
  return String(v)
}

function parseAmenities(amenitiesStr: string): string[] {
  if (!amenitiesStr) return []
  return amenitiesStr.split(',').map(a => a.trim()).filter(Boolean)
}

// ─── Collapsible Section ──────────────────────────────────────────────────────
function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div style={{ borderTop: `1px solid ${T.border.default}` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '12px 20px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: T.font.sans,
          fontSize: 12,
          fontWeight: 700,
          color: T.text.secondary,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          textAlign: 'left',
        }}
      >
        <span style={{
          display: 'inline-block',
          transition: 'transform 150ms',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          fontSize: 10,
        }}>
          &#9654;
        </span>
        {title}
      </button>
      {open && (
        <div style={{ padding: '0 20px 16px', animation: 'listingsFadeIn 0.15s ease' }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Field Components ─────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: '8px 12px',
  border: `1px solid ${T.border.default}`,
  borderRadius: T.radius.sm,
  background: T.bg.card,
  color: T.text.primary,
  fontFamily: T.font.sans,
  outline: 'none',
  boxSizing: 'border-box',
  width: '100%',
  transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
}

const monoInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: T.font.mono,
  fontSize: 12,
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 80,
  resize: 'vertical' as const,
}

function FieldRow({
  label,
  value,
  onChange,
  mono,
  type,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  type?: string
  placeholder?: string
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{
        display: 'block',
        fontSize: 11,
        fontWeight: 600,
        color: T.text.secondary,
        marginBottom: 4,
        fontFamily: T.font.sans,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        {label}
      </label>
      <input
        className="listings-input"
        type={type || 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={mono ? monoInputStyle : inputStyle}
      />
    </div>
  )
}

function TextAreaRow({
  label,
  value,
  onChange,
  placeholder,
  rows,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{
        display: 'block',
        fontSize: 11,
        fontWeight: 600,
        color: T.text.secondary,
        marginBottom: 4,
        fontFamily: T.font.sans,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        {label}
      </label>
      <textarea
        className="listings-textarea listings-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows || 3}
        style={textareaStyle}
      />
    </div>
  )
}

// ─── Amenity Classification Toggle ────────────────────────────────────────────
function AmenityToggle({
  name,
  classification,
  onChange,
}: {
  name: string
  classification: AmenityClassification
  onChange: (c: AmenityClassification) => void
}): React.ReactElement {
  const options: { value: AmenityClassification; label: string; color: string; bg: string }[] = [
    { value: 'default', label: 'Default', color: T.text.tertiary, bg: T.bg.tertiary },
    { value: 'available', label: 'Available', color: '#FFFFFF', bg: T.status.green },
    { value: 'on_request', label: 'On Request', color: '#FFFFFF', bg: T.status.amber },
    { value: 'off', label: 'Off', color: '#FFFFFF', bg: T.status.red },
  ]

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: `1px solid ${T.border.default}`,
    }}>
      <span style={{
        fontSize: 13,
        fontWeight: 500,
        color: T.text.primary,
        fontFamily: T.font.sans,
      }}>
        {name}
      </span>
      <div style={{
        display: 'flex',
        borderRadius: 6,
        overflow: 'hidden',
        border: `1px solid ${T.border.default}`,
      }}>
        {options.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: T.font.sans,
              border: 'none',
              cursor: 'pointer',
              background: classification === opt.value ? opt.bg : T.bg.card,
              color: classification === opt.value ? opt.color : T.text.tertiary,
              transition: 'all 150ms',
              borderRight: opt.value !== 'off' ? `1px solid ${T.border.default}` : 'none',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Add Amenity Input ────────────────────────────────────────────────────────
function AddAmenityInput({ onAdd, existingAmenities }: { onAdd: (name: string) => void; existingAmenities: string[] }): React.ReactElement {
  const [value, setValue] = useState('')
  const submit = () => {
    const val = value.trim()
    if (!val || existingAmenities.includes(val)) return
    onAdd(val)
    setValue('')
  }
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Add amenity..."
        onKeyDown={e => { if (e.key === 'Enter') submit() }}
        style={{
          flex: 1, padding: '6px 10px', fontSize: 12, fontFamily: T.font.sans,
          border: `1px solid ${T.border.default}`, borderRadius: 6,
          background: T.bg.primary,
        }}
        className="listings-input"
      />
      <button
        onClick={submit}
        disabled={!value.trim() || existingAmenities.includes(value.trim())}
        style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
          border: `1px solid ${T.border.default}`, borderRadius: 6,
          background: !value.trim() ? T.bg.tertiary : T.accent,
          color: !value.trim() ? T.text.tertiary : T.text.inverse,
          cursor: !value.trim() ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        + Add
      </button>
    </div>
  )
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────
function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.4)',
    }}>
      <div style={{
        background: T.bg.card,
        borderRadius: T.radius.lg,
        padding: 24,
        maxWidth: 400,
        width: '90%',
        boxShadow: T.shadow.lg,
        fontFamily: T.font.sans,
        animation: 'listingsFadeIn 0.15s ease',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text.primary, marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: T.text.secondary, marginBottom: 20, lineHeight: 1.5 }}>
          {message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: T.font.sans,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              background: T.bg.card,
              color: T.text.primary,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: T.font.sans,
              border: 'none',
              borderRadius: T.radius.sm,
              background: T.status.red,
              color: '#FFFFFF',
              cursor: 'pointer',
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Skeleton Loader ──────────────────────────────────────────────────────────
function SkeletonCards(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 120,
            background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'listingsShimmer 1.5s ease-in-out infinite',
            animationDelay: `${i * 0.1}s`,
            borderRadius: T.radius.md,
          }}
        />
      ))}
    </div>
  )
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
function Spinner({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      border: '2px solid currentColor',
      borderTopColor: 'transparent',
      borderRadius: '50%',
      animation: 'listingsSpin 0.6s linear infinite',
      verticalAlign: 'middle',
    }} />
  )
}

// ─── Variable Preview ──────────────────────────────────────────────────────
const PREVIEW_VARS = ['RESERVATION_DETAILS', 'ACCESS_CONNECTIVITY', 'PROPERTY_DESCRIPTION', 'AVAILABLE_AMENITIES', 'ON_REQUEST_AMENITIES', 'DOCUMENT_CHECKLIST'] as const
type PreviewVarName = typeof PREVIEW_VARS[number]

const VAR_LABELS: Record<PreviewVarName, string> = {
  RESERVATION_DETAILS: 'Reservation Details',
  ACCESS_CONNECTIVITY: 'Access & Connectivity',
  PROPERTY_DESCRIPTION: 'Property Description',
  AVAILABLE_AMENITIES: 'Available Amenities',
  ON_REQUEST_AMENITIES: 'On-Request Amenities',
  DOCUMENT_CHECKLIST: 'Document Checklist',
}

function VariablePreviewSection({
  propertyId,
  variableOverrides,
  onOverrideChange,
}: {
  propertyId: string
  variableOverrides: Record<string, { customTitle?: string; notes?: string }>
  onOverrideChange: (varName: string, field: 'customTitle' | 'notes', value: string) => void
}): React.ReactElement {
  const [preview, setPreview] = useState<VariablePreview['variables'] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedVars, setExpandedVars] = useState<Set<string>>(new Set())

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiGetVariablePreview(propertyId)
      setPreview(result.variables)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load preview')
    } finally {
      setLoading(false)
    }
  }, [propertyId])

  const toggleVar = (name: string) => {
    setExpandedVars(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button
          onClick={loadPreview}
          disabled={loading}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: T.font.sans,
            border: `1px solid ${T.accent}`,
            borderRadius: T.radius.sm,
            background: 'transparent',
            color: loading ? T.text.tertiary : T.accent,
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 150ms',
          }}
        >
          {loading && <Spinner size={12} />}
          {loading ? 'Loading...' : preview ? 'Refresh Preview' : 'Load Preview'}
        </button>
        {preview && (
          <span style={{
            fontSize: 11,
            color: T.text.tertiary,
            fontFamily: T.font.sans,
          }}>
            Shows what the AI sees for this property
          </span>
        )}
      </div>

      {error && (
        <div style={{
          padding: 10,
          background: '#FEF2F2',
          border: `1px solid ${T.status.red}30`,
          borderRadius: T.radius.sm,
          color: T.status.red,
          fontSize: 12,
          fontFamily: T.font.sans,
          marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {preview && PREVIEW_VARS.map(varName => {
        const value = preview[varName]
        const overrides = variableOverrides[varName] || {}
        const isExpanded = expandedVars.has(varName)
        const isEmpty = !value || !value.trim()

        return (
          <div key={varName} style={{
            marginBottom: 10,
            border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.sm,
            overflow: 'hidden',
          }}>
            {/* Variable header */}
            <button
              onClick={() => toggleVar(varName)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                background: T.bg.secondary,
                border: 'none',
                cursor: 'pointer',
                fontFamily: T.font.sans,
                fontSize: 12,
                fontWeight: 600,
                color: T.text.primary,
                textAlign: 'left',
              }}
            >
              <span style={{
                display: 'inline-block',
                transition: 'transform 150ms',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                fontSize: 9,
                color: T.text.tertiary,
              }}>
                &#9654;
              </span>
              <span>{VAR_LABELS[varName]}</span>
              <span style={{
                fontSize: 10,
                fontFamily: T.font.mono,
                color: T.text.tertiary,
                fontWeight: 400,
              }}>
                {'{' + varName + '}'}
              </span>
              {isEmpty && (
                <span style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: T.text.tertiary,
                  background: T.bg.tertiary,
                  padding: '1px 6px',
                  borderRadius: 3,
                  marginLeft: 'auto',
                }}>
                  Empty
                </span>
              )}
            </button>

            {isExpanded && (
              <div style={{ padding: 12 }}>
                {/* Read-only resolved preview */}
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: T.text.secondary,
                  marginBottom: 4,
                  fontFamily: T.font.sans,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  Resolved Output
                </div>
                <pre style={{
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: T.text.secondary,
                  fontFamily: T.font.mono,
                  padding: 10,
                  background: T.bg.primary,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.sm,
                  marginBottom: 12,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: '0 0 12px 0',
                }}>
                  {isEmpty ? '(empty — this block will be omitted from the AI prompt)' : value}
                </pre>

                {/* Editable override fields */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{
                      display: 'block',
                      fontSize: 11,
                      fontWeight: 600,
                      color: T.text.secondary,
                      marginBottom: 4,
                      fontFamily: T.font.sans,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}>
                      Custom Title
                    </label>
                    <input
                      className="listings-input"
                      type="text"
                      value={overrides.customTitle || ''}
                      onChange={e => onOverrideChange(varName, 'customTitle', e.target.value)}
                      placeholder="Prepended header line..."
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{
                      display: 'block',
                      fontSize: 11,
                      fontWeight: 600,
                      color: T.text.secondary,
                      marginBottom: 4,
                      fontFamily: T.font.sans,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}>
                      Notes
                    </label>
                    <input
                      className="listings-input"
                      type="text"
                      value={overrides.notes || ''}
                      onChange={e => onOverrideChange(varName, 'notes', e.target.value)}
                      placeholder="Appended after content..."
                      style={inputStyle}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Property Card ────────────────────────────────────────────────────────────
function PropertyCard({
  property,
  editState,
  onKbChange,
  onSave,
  onResync,
  onSummarize,
  saving,
  resyncing,
  summarizing,
}: {
  property: ApiProperty
  editState: PropertyEditState
  onKbChange: (key: string, value: unknown) => void
  onSave: () => void
  onResync: () => void
  onSummarize: () => void
  saving: boolean
  resyncing: boolean
  summarizing: boolean
}): React.ReactElement {
  const [resyncConfirm, setResyncConfirm] = useState(false)
  const [savedMsg, setSavedMsg] = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)

  const kb = editState.kb
  const amenitiesStr = kbStr(kb, 'amenities')
  const amenities = parseAmenities(amenitiesStr)
  const amenityClassifications = (kb.amenityClassifications || {}) as Record<string, AmenityClassification>
  const summarizedDescription = kbStr(kb, 'summarizedDescription')
  const originalDescription = kbStr(kb, 'originalDescription') || property.listingDescription || ''

  function updateField(key: string, value: string): void {
    onKbChange(key, value)
  }

  function updateAmenityClassification(name: string, classification: AmenityClassification): void {
    const current = { ...amenityClassifications }
    current[name] = classification
    onKbChange('amenityClassifications', current)
  }

  function handleRestoreOriginal(): void {
    onKbChange('summarizedDescription', '')
  }

  function handleSaveWithFeedback(): void {
    onSave()
    setSavedMsg(true)
    setTimeout(() => setSavedMsg(false), 2500)
  }

  return (
    <>
      {resyncConfirm && (
        <ConfirmDialog
          title="Resync from Hostaway"
          message="This will overwrite local edits with the latest data from Hostaway. Amenity classifications and summarized descriptions will be preserved. Continue?"
          onConfirm={() => { setResyncConfirm(false); onResync() }}
          onCancel={() => setResyncConfirm(false)}
        />
      )}

      <div style={{
        background: T.bg.card,
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        boxShadow: T.shadow.sm,
        marginBottom: 16,
        animation: 'listingsFadeIn 0.2s ease',
      }}>
        {/* ── Header ── */}
        <div style={{
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 16,
              fontWeight: 700,
              color: T.text.primary,
              fontFamily: T.font.sans,
              marginBottom: 4,
            }}>
              {property.name}
            </div>
            <div style={{
              fontSize: 13,
              color: T.text.secondary,
              fontFamily: T.font.sans,
              marginBottom: 4,
            }}>
              {property.address}
            </div>
            <div style={{
              fontSize: 11,
              color: T.text.tertiary,
              fontFamily: T.font.mono,
            }}>
              Hostaway ID: {property.hostawayListingId}
            </div>
          </div>
          <button
            onClick={() => setResyncConfirm(true)}
            disabled={resyncing}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: T.font.sans,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              background: T.bg.card,
              color: resyncing ? T.text.tertiary : T.text.primary,
              cursor: resyncing ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 150ms',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {resyncing && <Spinner size={12} />}
            {resyncing ? 'Syncing...' : 'Resync from Hostaway'}
          </button>
        </div>

        {/* ── Access & Connectivity ── */}
        <Section title="Access & Connectivity">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <FieldRow
              label="Door Code"
              value={kbStr(kb, 'doorCode')}
              onChange={v => updateField('doorCode', v)}
              mono
              placeholder="e.g. 1234#"
            />
            <FieldRow
              label="WiFi Name"
              value={kbStr(kb, 'wifiName')}
              onChange={v => updateField('wifiName', v)}
              mono
              placeholder="Network name"
            />
            <FieldRow
              label="WiFi Password"
              value={kbStr(kb, 'wifiPassword')}
              onChange={v => updateField('wifiPassword', v)}
              mono
              placeholder="Password"
            />
          </div>
        </Section>

        {/* ── Timing ── */}
        <Section title="Timing">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldRow
              label="Check-in Time"
              value={kbStr(kb, 'checkInTime')}
              onChange={v => updateField('checkInTime', v)}
              placeholder="e.g. 15:00"
            />
            <FieldRow
              label="Check-out Time"
              value={kbStr(kb, 'checkOutTime')}
              onChange={v => updateField('checkOutTime', v)}
              placeholder="e.g. 11:00"
            />
          </div>
        </Section>

        {/* ── Feature 043 — Auto-accept thresholds ── */}
        <Section title="Auto-accept (Feature 043)" defaultOpen={false}>
          <div style={{ fontSize: 12, color: T.text.secondary, marginBottom: 10, lineHeight: 1.5 }}>
            When set, guest requests at or within this time are approved automatically (templated reply sent, reservation updated). Outside the threshold, the request is sent to your Actions card. Leave blank to always escalate.
          </div>
          <AutoAcceptThresholdsForm property={property} />
        </Section>

        {/* ── Property Details ── */}
        <Section title="Property Details">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <FieldRow
              label="Capacity"
              value={kbStr(kb, 'personCapacity')}
              onChange={v => updateField('personCapacity', v)}
              type="text"
              placeholder="e.g. 4"
            />
            <FieldRow
              label="Bedrooms"
              value={kbStr(kb, 'bedroomsNumber')}
              onChange={v => updateField('bedroomsNumber', v)}
              type="text"
              placeholder="e.g. 2"
            />
            <FieldRow
              label="Room Type"
              value={kbStr(kb, 'roomType')}
              onChange={v => updateField('roomType', v)}
              placeholder="e.g. Entire apartment"
            />
            <FieldRow
              label="Bed Types"
              value={kbStr(kb, 'bedTypes')}
              onChange={v => updateField('bedTypes', v)}
              placeholder="e.g. 1 Queen, 2 Single"
            />
            <FieldRow
              label="Square Meters"
              value={kbStr(kb, 'squareMeters')}
              onChange={v => updateField('squareMeters', v)}
              placeholder="e.g. 65"
            />
            <FieldRow
              label="Cleaning Fee"
              value={kbStr(kb, 'cleaningFee')}
              onChange={v => updateField('cleaningFee', v)}
              placeholder="e.g. 50 EUR"
            />
          </div>
        </Section>

        {/* ── URLs ── */}
        <Section title="URLs">
          <FieldRow
            label="Airbnb URL"
            value={kbStr(kb, 'airbnbListingUrl')}
            onChange={v => updateField('airbnbListingUrl', v)}
            mono
            placeholder="https://airbnb.com/rooms/..."
          />
          <FieldRow
            label="Vrbo URL"
            value={kbStr(kb, 'vrboListingUrl')}
            onChange={v => updateField('vrboListingUrl', v)}
            mono
            placeholder="https://vrbo.com/..."
          />
          <FieldRow
            label="Booking Engine URL"
            value={kbStr(kb, 'bookingEngineUrl')}
            onChange={v => updateField('bookingEngineUrl', v)}
            mono
            placeholder="https://booking.example.com/..."
          />
        </Section>

        {/* ── Rules ── */}
        <Section title="Rules">
          <TextAreaRow
            label="House Rules"
            value={kbStr(kb, 'houseRules')}
            onChange={v => updateField('houseRules', v)}
            placeholder="No smoking, no parties..."
            rows={3}
          />
          <TextAreaRow
            label="Special Instructions"
            value={kbStr(kb, 'specialInstruction')}
            onChange={v => updateField('specialInstruction', v)}
            placeholder="Any special instructions for guests..."
            rows={3}
          />
          <TextAreaRow
            label="Key Pickup"
            value={kbStr(kb, 'keyPickup')}
            onChange={v => updateField('keyPickup', v)}
            placeholder="Key pickup instructions..."
            rows={2}
          />
        </Section>

        {/* ── Amenities ── */}
        <Section title={`Amenities${amenities.length > 0 ? ` (${amenities.length})` : ''}`}>
          {amenities.map(name => (
            <AmenityToggle
              key={name}
              name={name}
              classification={amenityClassifications[name] || 'default'}
              onChange={c => updateAmenityClassification(name, c)}
            />
          ))}
          {/* Add amenity input */}
          <AddAmenityInput onAdd={val => {
            const newList = [...amenities, val].join(', ')
            onKbChange('amenities', newList)
          }} existingAmenities={amenities} />
        </Section>

        {/* ── Description ── */}
        <Section title="Description" defaultOpen={false}>
          {summarizedDescription ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: T.status.green,
                  background: '#F0FDF4',
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontFamily: T.font.sans,
                }}>
                  Summarized
                </span>
                <button
                  onClick={handleRestoreOriginal}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: T.text.tertiary,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontFamily: T.font.sans,
                  }}
                >
                  Restore Original
                </button>
              </div>
              <div style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: T.text.primary,
                fontFamily: T.font.sans,
                padding: 12,
                background: T.bg.secondary,
                borderRadius: T.radius.sm,
                marginBottom: 12,
              }}>
                {summarizedDescription}
              </div>
              <div>
                <button
                  onClick={() => setDescExpanded(o => !o)}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: T.text.tertiary,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: T.font.sans,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span style={{
                    display: 'inline-block',
                    transition: 'transform 150ms',
                    transform: descExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    fontSize: 9,
                  }}>
                    &#9654;
                  </span>
                  Original Description
                </button>
                {descExpanded && (
                  <div style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: T.text.secondary,
                    fontFamily: T.font.sans,
                    padding: 12,
                    background: T.bg.primary,
                    border: `1px solid ${T.border.default}`,
                    borderRadius: T.radius.sm,
                    marginTop: 8,
                    maxHeight: 200,
                    overflow: 'auto',
                  }}>
                    {originalDescription || 'No original description available.'}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: T.text.primary,
                fontFamily: T.font.sans,
                padding: 12,
                background: T.bg.secondary,
                borderRadius: T.radius.sm,
                marginBottom: 12,
                maxHeight: 200,
                overflow: 'auto',
              }}>
                {property.listingDescription || 'No description available from Hostaway.'}
              </div>
            </div>
          )}
          <button
            onClick={onSummarize}
            disabled={summarizing || !property.listingDescription}
            style={{
              marginTop: 8,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: T.font.sans,
              border: `1px solid ${T.accent}`,
              borderRadius: T.radius.sm,
              background: 'transparent',
              color: summarizing ? T.text.tertiary : T.accent,
              cursor: summarizing || !property.listingDescription ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 150ms',
              opacity: !property.listingDescription ? 0.5 : 1,
            }}
          >
            {summarizing && <Spinner size={12} />}
            {summarizing ? 'Summarizing...' : summarizedDescription ? 'Re-summarize' : 'Summarize Description'}
          </button>
        </Section>

        {/* ── Variable Preview ── */}
        <Section title="Variable Preview">
          <VariablePreviewSection
            propertyId={property.id}
            variableOverrides={(kb.variableOverrides || {}) as Record<string, { customTitle?: string; notes?: string }>}
            onOverrideChange={(varName, field, value) => {
              const currentOverrides = ((kb.variableOverrides || {}) as Record<string, { customTitle?: string; notes?: string }>)
              const currentVar = currentOverrides[varName] || {}
              const updated = {
                ...currentOverrides,
                [varName]: { ...currentVar, [field]: value },
              }
              onKbChange('variableOverrides', updated)
            }}
          />
        </Section>

        {/* ── Save Button ── */}
        <div style={{
          padding: '12px 20px',
          borderTop: `1px solid ${T.border.default}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <button
            onClick={handleSaveWithFeedback}
            disabled={saving}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: T.font.sans,
              border: 'none',
              borderRadius: T.radius.sm,
              background: T.accent,
              color: '#FFFFFF',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
              transition: 'all 150ms',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {saving && <Spinner size={12} />}
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {editState.dirty && !saving && !savedMsg && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.status.amber,
              fontFamily: T.font.sans,
            }}>
              Unsaved changes
            </span>
          )}
          {savedMsg && (
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.status.green,
              fontFamily: T.font.sans,
              animation: 'listingsSavedFade 2.5s ease forwards',
            }}>
              Saved
            </span>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ListingsV5(): React.ReactElement {
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [editStates, setEditStates] = useState<Record<string, PropertyEditState>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [resyncingIds, setResyncingIds] = useState<Set<string>>(new Set())
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(new Set())
  const [summarizingAll, setSummarizingAll] = useState(false)
  const [bulkAmenityOpen, setBulkAmenityOpen] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)

  useEffect(() => { ensureStyles() }, [])

  // Load properties
  const loadProperties = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const props = await apiGetProperties()
      setProperties(props)
      const states: Record<string, PropertyEditState> = {}
      for (const p of props) {
        states[p.id] = { kb: { ...(p.customKnowledgeBase || {}) }, dirty: false }
      }
      setEditStates(states)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load properties')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadProperties() }, [loadProperties])

  // Handle KB field change
  function handleKbChange(propertyId: string, key: string, value: unknown): void {
    setEditStates(prev => {
      const current = prev[propertyId]
      if (!current) return prev
      return {
        ...prev,
        [propertyId]: {
          kb: { ...current.kb, [key]: value },
          dirty: true,
        },
      }
    })
  }

  // Save
  async function handleSave(propertyId: string): Promise<void> {
    const state = editStates[propertyId]
    if (!state) return
    setSavingIds(prev => new Set(prev).add(propertyId))
    try {
      await apiUpdateKnowledgeBase(propertyId, state.kb)
      setEditStates(prev => ({
        ...prev,
        [propertyId]: { ...prev[propertyId], dirty: false },
      }))
    } catch (err) {
      console.error('Failed to save:', err)
    } finally {
      setSavingIds(prev => {
        const next = new Set(prev)
        next.delete(propertyId)
        return next
      })
    }
  }

  // Resync
  async function handleResync(propertyId: string): Promise<void> {
    setResyncingIds(prev => new Set(prev).add(propertyId))
    try {
      const result = await apiResyncProperty(propertyId)
      const updated = result.property
      setProperties(prev => prev.map(p => p.id === propertyId ? updated : p))
      // Preserve amenity classifications and summarized description from current edit state
      const currentState = editStates[propertyId]
      const preserved: Record<string, unknown> = {}
      if (currentState?.kb.amenityClassifications) {
        preserved.amenityClassifications = currentState.kb.amenityClassifications
      }
      if (currentState?.kb.summarizedDescription) {
        preserved.summarizedDescription = currentState.kb.summarizedDescription
      }
      if (currentState?.kb.originalDescription) {
        preserved.originalDescription = currentState.kb.originalDescription
      }
      setEditStates(prev => ({
        ...prev,
        [propertyId]: {
          kb: { ...(updated.customKnowledgeBase || {}), ...preserved },
          dirty: Object.keys(preserved).length > 0,
        },
      }))
    } catch (err) {
      console.error('Resync failed:', err)
    } finally {
      setResyncingIds(prev => {
        const next = new Set(prev)
        next.delete(propertyId)
        return next
      })
    }
  }

  // Summarize single
  async function handleSummarize(propertyId: string): Promise<void> {
    setSummarizingIds(prev => new Set(prev).add(propertyId))
    try {
      const result = await apiSummarizeDescription(propertyId)
      const prop = properties.find(p => p.id === propertyId)
      setEditStates(prev => ({
        ...prev,
        [propertyId]: {
          kb: {
            ...prev[propertyId].kb,
            summarizedDescription: result.summary,
            originalDescription: prop?.listingDescription || '',
          },
          dirty: true,
        },
      }))
    } catch (err: any) {
      const detail = err?.data?.detail || err?.data?.error || err?.message || 'Unknown error'
      console.error('Summarize failed:', err)
      window.alert(`Summarize failed: ${detail}`)
    } finally {
      setSummarizingIds(prev => {
        const next = new Set(prev)
        next.delete(propertyId)
        return next
      })
    }
  }

  // Summarize all
  async function handleSummarizeAll(): Promise<void> {
    setSummarizingAll(true)
    try {
      await apiSummarizeAll()
      // Reload to get updated descriptions
      await loadProperties()
    } catch (err: any) {
      const detail = err?.data?.detail || err?.data?.error || err?.message || 'Unknown error'
      console.error('Summarize all failed:', err)
      window.alert(`Summarize all failed: ${detail}`)
    } finally {
      setSummarizingAll(false)
    }
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: T.font.sans,
      background: T.bg.primary,
    }}>
      {/* ── Top Bar ── */}
      <div style={{
        padding: '16px 24px',
        borderBottom: `1px solid ${T.border.default}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: T.bg.card,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 800,
            color: T.text.primary,
            fontFamily: T.font.sans,
          }}>
            Listings
          </span>
          {!loading && (
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: T.text.tertiary,
              fontFamily: T.font.sans,
            }}>
              {properties.length} {properties.length === 1 ? 'property' : 'properties'}
            </span>
          )}
        </div>
        <button
          onClick={handleSummarizeAll}
          disabled={summarizingAll || loading || properties.length === 0}
          style={{
            padding: '8px 16px',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: T.font.sans,
            border: `1px solid ${T.accent}`,
            borderRadius: T.radius.sm,
            background: 'transparent',
            color: summarizingAll ? T.text.tertiary : T.accent,
            cursor: summarizingAll || loading || properties.length === 0 ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 150ms',
          }}
        >
          {summarizingAll && <Spinner size={12} />}
          {summarizingAll ? 'Summarizing...' : 'Summarize All Descriptions'}
        </button>
        <button
          onClick={() => setBulkAmenityOpen(true)}
          disabled={loading || properties.length === 0}
          style={{
            padding: '8px 16px',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: T.font.sans,
            border: `1px solid ${T.status.amber}`,
            borderRadius: T.radius.sm,
            background: 'transparent',
            color: T.status.amber,
            cursor: loading || properties.length === 0 ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Bulk Edit Amenities
        </button>
      </div>

      {/* ── Content ── */}
      <div
        className="listings-scroll"
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 24,
        }}
      >
        {loading && <SkeletonCards />}

        {error && (
          <div style={{
            padding: 20,
            background: '#FEF2F2',
            border: `1px solid ${T.status.red}30`,
            borderRadius: T.radius.md,
            color: T.status.red,
            fontSize: 13,
            fontFamily: T.font.sans,
            textAlign: 'center',
          }}>
            {error}
            <button
              onClick={loadProperties}
              style={{
                display: 'block',
                margin: '8px auto 0',
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: T.font.sans,
                border: `1px solid ${T.status.red}40`,
                borderRadius: T.radius.sm,
                background: 'transparent',
                color: T.status.red,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && properties.length === 0 && (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: T.text.tertiary,
            fontSize: 14,
            fontFamily: T.font.sans,
          }}>
            No properties found. Import your listings from Hostaway in Settings.
          </div>
        )}

        {!loading && !error && properties.map(prop => (
          <PropertyCard
            key={prop.id}
            property={prop}
            editState={editStates[prop.id] || { kb: {}, dirty: false }}
            onKbChange={(key, value) => handleKbChange(prop.id, key, value)}
            onSave={() => handleSave(prop.id)}
            onResync={() => handleResync(prop.id)}
            onSummarize={() => handleSummarize(prop.id)}
            saving={savingIds.has(prop.id)}
            resyncing={resyncingIds.has(prop.id)}
            summarizing={summarizingIds.has(prop.id)}
          />
        ))}
      </div>
      {bulkAmenityOpen && (() => {
        const allAmenities = new Map<string, AmenityClassification>()
        properties.forEach(prop => {
          const state = editStates[prop.id]
          const kb = state?.kb || (prop.customKnowledgeBase as Record<string, unknown>) || {}
          const cls = (kb.amenityClassifications || {}) as Record<string, AmenityClassification>
          parseAmenities(String(kb.amenities || '')).forEach(n => { if (!allAmenities.has(n)) allAmenities.set(n, cls[n] || 'default') })
        })
        const sorted = [...allAmenities.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setBulkAmenityOpen(false)}>
            <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', background: T.bg.card, borderRadius: T.radius.lg, boxShadow: T.shadow.lg }}>
              {/* Header */}
              <div style={{ padding: '24px 24px 0 24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 700, fontFamily: T.font.sans, margin: 0 }}>Bulk Edit Amenities ({sorted.length})</h3>
                  <button onClick={() => setBulkAmenityOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: T.text.tertiary }}>✕</button>
                </div>
                <p style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 16 }}>Changes apply to ALL listings that have this amenity.</p>
              </div>
              {/* Scrollable amenity list */}
              <div className="listings-scroll" style={{ flex: 1, overflow: 'auto', padding: '0 24px', minHeight: 0 }}>
                {sorted.map(([name, cc]) => (
                  <AmenityToggle key={name} name={name} classification={cc} onChange={nc => {
                    properties.forEach(p => {
                      const s = editStates[p.id]; if (!s) return
                      if (!parseAmenities(String(s.kb.amenities || '')).includes(name)) return
                      const cur = { ...((s.kb.amenityClassifications || {}) as Record<string, AmenityClassification>) }; cur[name] = nc
                      setEditStates(prev => ({ ...prev, [p.id]: { ...prev[p.id], kb: { ...prev[p.id].kb, amenityClassifications: cur }, dirty: true } }))
                    })
                  }} />
                ))}
                <div style={{ marginTop: 12, paddingBottom: 8 }}>
                  <input placeholder="Add amenity to all listings... (press Enter)" onKeyDown={e => {
                    if (e.key !== 'Enter') return; const val = (e.target as HTMLInputElement).value.trim(); if (!val) return
                    properties.forEach(p => {
                      const s = editStates[p.id]; if (!s) return
                      const list = parseAmenities(String(s.kb.amenities || '')); if (list.includes(val)) return
                      setEditStates(prev => ({ ...prev, [p.id]: { ...prev[p.id], kb: { ...prev[p.id].kb, amenities: [...list, val].join(', ') }, dirty: true } }))
                    })
                    ;(e.target as HTMLInputElement).value = ''
                  }} style={{ width: '100%', padding: '8px 12px', fontSize: 12, fontFamily: T.font.sans, border: `1px solid ${T.border.default}`, borderRadius: 6, background: T.bg.primary, boxSizing: 'border-box' as const }} />
                </div>
              </div>
              {/* Sticky footer */}
              {(() => {
                const dirtyIds = properties.filter(p => editStates[p.id]?.dirty).map(p => p.id)
                return (
                  <div style={{ padding: '16px 24px', borderTop: `1px solid ${T.border.default}`, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {dirtyIds.length > 0 && <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans, marginRight: 'auto' }}>{dirtyIds.length} listing{dirtyIds.length > 1 ? 's' : ''} modified</span>}
                    <button
                      disabled={dirtyIds.length === 0}
                      onClick={() => {
                        const states: Record<string, PropertyEditState> = {}
                        for (const p of properties) {
                          states[p.id] = { kb: { ...(p.customKnowledgeBase || {}) }, dirty: false }
                        }
                        setEditStates(states)
                      }}
                      style={{
                        padding: '8px 16px', fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
                        border: `1px solid ${T.border.strong}`, borderRadius: T.radius.sm,
                        background: 'transparent', color: dirtyIds.length === 0 ? T.text.tertiary : T.text.secondary,
                        cursor: dirtyIds.length === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Revert All
                    </button>
                    <button
                      disabled={dirtyIds.length === 0 || bulkSaving}
                      onClick={async () => {
                        setBulkSaving(true)
                        // Bugfix (2026-04-23): capture the dirty kbs
                        // BEFORE the await so the post-success
                        // setProperties closure doesn't depend on
                        // potentially-stale `editStates`. Previously
                        // it worked by accident because both setters
                        // batched, but the ordering was fragile —
                        // any future await between them would skip
                        // updates in `setProperties` after `setEditStates`
                        // had already cleared `dirty`.
                        const snapshot = dirtyIds
                          .map(id => ({ id, kb: editStates[id]?.kb }))
                          .filter((s): s is { id: string; kb: any } => !!s.kb)
                        try {
                          await Promise.all(snapshot.map(s =>
                            apiUpdateKnowledgeBase(s.id, s.kb)
                          ))
                          // Update properties source-of-truth so revert uses saved values.
                          // Done BEFORE setEditStates so the snapshot is the source.
                          setProperties(prev => prev.map(p => {
                            const s = snapshot.find(x => x.id === p.id)
                            if (!s) return p
                            return { ...p, customKnowledgeBase: { ...s.kb } }
                          }))
                          setEditStates(prev => {
                            const next = { ...prev }
                            snapshot.forEach(s => { if (next[s.id]) next[s.id] = { ...next[s.id], dirty: false } })
                            return next
                          })
                        } catch (err) { console.error('Bulk save failed:', err) }
                        finally { setBulkSaving(false) }
                      }}
                      style={{
                        padding: '8px 20px', fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
                        border: 'none', borderRadius: T.radius.sm,
                        background: dirtyIds.length === 0 || bulkSaving ? T.bg.tertiary : T.accent,
                        color: dirtyIds.length === 0 || bulkSaving ? T.text.tertiary : T.text.inverse,
                        cursor: dirtyIds.length === 0 || bulkSaving ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      {bulkSaving && <Spinner size={12} />}
                      {bulkSaving ? 'Saving...' : `Save All${dirtyIds.length > 0 ? ` (${dirtyIds.length})` : ''}`}
                    </button>
                  </div>
                )
              })()}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Feature 043 — Auto-accept thresholds form ────────────────────────────────
function AutoAcceptThresholdsForm({ property }: { property: ApiProperty }): React.ReactElement {
  const [lateUntil, setLateUntil] = useState(property.autoAcceptLateCheckoutUntil || '')
  const [earlyFrom, setEarlyFrom] = useState(property.autoAcceptEarlyCheckinFrom || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const origLate = property.autoAcceptLateCheckoutUntil || ''
  const origEarly = property.autoAcceptEarlyCheckinFrom || ''
  const dirty = lateUntil !== origLate || earlyFrom !== origEarly
  const validHHMM = (v: string) => v === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(v)
  const canSave = dirty && validHHMM(lateUntil) && validHHMM(earlyFrom)

  async function onSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await apiUpdatePropertyAutoAccept(property.id, {
        autoAcceptLateCheckoutUntil: lateUntil || null,
        autoAcceptEarlyCheckinFrom: earlyFrom || null,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err: any) {
      setError(err?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FieldRow
          label="Auto-accept late checkout until"
          value={lateUntil}
          onChange={setLateUntil}
          placeholder="e.g. 13:00 — blank to disable"
        />
        <FieldRow
          label="Auto-accept early check-in from"
          value={earlyFrom}
          onChange={setEarlyFrom}
          placeholder="e.g. 12:00 — blank to disable"
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button
          onClick={onSave}
          disabled={!canSave || saving}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            border: 'none',
            borderRadius: T.radius.sm,
            background: !canSave || saving ? T.bg.tertiary : T.accent,
            color: !canSave || saving ? T.text.tertiary : T.text.inverse,
            cursor: !canSave || saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save thresholds'}
        </button>
        {saved && <span style={{ fontSize: 11, color: T.status.green }}>Saved</span>}
        {error && <span style={{ fontSize: 11, color: T.status.red }}>{error}</span>}
        {!validHHMM(lateUntil) && <span style={{ fontSize: 11, color: T.status.red }}>Late: use HH:MM (24h)</span>}
        {!validHHMM(earlyFrom) && <span style={{ fontSize: 11, color: T.status.red }}>Early: use HH:MM (24h)</span>}
      </div>
    </div>
  )
}
