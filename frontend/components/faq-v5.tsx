'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Plus, X, Check, ChevronDown, ChevronRight, Edit3, Trash2, Archive, Globe, Building2,
  Search, RefreshCw, HelpCircle, Sparkles, Hash,
} from 'lucide-react'
import {
  apiGetFaqEntries,
  apiCreateFaqEntry,
  apiUpdateFaqEntry,
  apiDeleteFaqEntry,
  apiGetFaqCategories,
  apiGetProperties,
  type FaqEntry,
  type FaqCategoryStat,
  type ApiProperty,
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

// ─── Styles ─────────────────────────────────────────────────────────────────
const STYLE_ID = 'faq-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes faqSpin { to { transform: rotate(360deg) } }
@keyframes faqFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes faqScaleIn {
  from { opacity: 0; transform: scale(0.97); }
  to { opacity: 1; transform: scale(1); }
}
.faq-scroll::-webkit-scrollbar { width: 5px; }
.faq-scroll::-webkit-scrollbar-track { background: transparent; }
.faq-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.faq-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`
  document.head.appendChild(style)
}

// ─── Constants ──────────────────────────────────────────────────────────────
const FAQ_CATEGORIES: { id: string; label: string }[] = [
  { id: 'check-in-access', label: 'Check-in & Access' },
  { id: 'check-out-departure', label: 'Check-out & Departure' },
  { id: 'wifi-technology', label: 'WiFi & Technology' },
  { id: 'kitchen-cooking', label: 'Kitchen & Cooking' },
  { id: 'appliances-equipment', label: 'Appliances & Equipment' },
  { id: 'house-rules', label: 'House Rules & Policies' },
  { id: 'parking-transportation', label: 'Parking & Transportation' },
  { id: 'local-recommendations', label: 'Local Recommendations' },
  { id: 'attractions-activities', label: 'Attractions & Activities' },
  { id: 'cleaning-housekeeping', label: 'Cleaning & Housekeeping' },
  { id: 'safety-emergencies', label: 'Safety & Emergencies' },
  { id: 'booking-reservation', label: 'Booking & Reservation' },
  { id: 'payment-billing', label: 'Payment & Billing' },
  { id: 'amenities-supplies', label: 'Amenities & Supplies' },
  { id: 'property-neighborhood', label: 'Property & Neighborhood' },
]

const CATEGORY_LABEL_MAP: Record<string, string> = Object.fromEntries(
  FAQ_CATEGORIES.map(c => [c.id, c.label])
)

type StatusFilter = 'All' | 'SUGGESTED' | 'ACTIVE' | 'STALE' | 'ARCHIVED'
type ScopeFilter = 'All' | 'GLOBAL' | 'PROPERTY'

// ─── Primitives ─────────────────────────────────────────────────────────────
function FilterPill({ label, active, onClick, count }: {
  label: string; active: boolean; onClick: () => void; count?: number
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 28, padding: '0 14px', fontSize: 11, fontWeight: 600,
        letterSpacing: '0.01em', cursor: 'pointer', borderRadius: 999,
        border: active ? 'none' : `1px solid ${T.border.default}`,
        background: active ? T.border.strong : hover ? T.bg.tertiary : T.bg.primary,
        color: active ? '#FFFFFF' : T.text.secondary,
        fontFamily: T.font.sans, lineHeight: '28px', whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        transition: 'all 0.15s ease',
      }}
    >
      {label}
      {count != null && count > 0 && (
        <span style={{
          fontSize: 10, fontWeight: 700,
          background: active ? 'rgba(255,255,255,0.2)' : T.bg.tertiary,
          color: active ? '#FFFFFF' : T.text.tertiary,
          borderRadius: 999, padding: '0 6px', lineHeight: '18px',
        }}>{count}</span>
      )}
    </button>
  )
}

function Badge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, fontFamily: T.font.mono,
      padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      color, background: bg, border: `1px solid ${color}20`,
    }}>{label}</span>
  )
}

function StatusBadge({ status }: { status: FaqEntry['status'] }) {
  const map: Record<FaqEntry['status'], { label: string; color: string; bg: string }> = {
    SUGGESTED: { label: 'Suggested', color: T.status.amber, bg: `${T.status.amber}14` },
    ACTIVE: { label: 'Active', color: T.status.green, bg: `${T.status.green}14` },
    STALE: { label: 'Stale', color: '#EA580C', bg: '#EA580C14' },
    ARCHIVED: { label: 'Archived', color: T.text.tertiary, bg: T.bg.tertiary },
  }
  const s = map[status] || map.ACTIVE
  return <Badge label={s.label} color={s.color} bg={s.bg} />
}

function SmallBtn({ children, onClick, disabled, variant = 'default', style: extra }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean
  variant?: 'default' | 'primary' | 'danger' | 'success' | 'warning'
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
    success: { background: `${T.status.green}12`, color: T.status.green, border: `1px solid ${T.status.green}25` },
    warning: { background: `${T.status.amber}12`, color: T.status.amber, border: `1px solid ${T.status.amber}25` },
  }
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...extra }}>
      {children}
    </button>
  )
}

function DropdownSelect({ value, onChange, options, placeholder, style: extra }: {
  value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string; style?: React.CSSProperties
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        height: 28, fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
        padding: '0 28px 0 10px', borderRadius: 999, border: `1px solid ${T.border.default}`,
        background: T.bg.primary, color: T.text.secondary, cursor: 'pointer',
        appearance: 'none', WebkitAppearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23A8A29E' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center',
        ...extra,
      }}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ─── Add/Edit Modal ─────────────────────────────────────────────────────────
function FaqModal({ entry, properties, onSave, onClose }: {
  entry: FaqEntry | null
  properties: ApiProperty[]
  onSave: (data: {
    question: string; answer: string; category: string
    scope: 'GLOBAL' | 'PROPERTY'; propertyId?: string
  }) => Promise<void>
  onClose: () => void
}) {
  const [question, setQuestion] = useState(entry?.question || '')
  const [answer, setAnswer] = useState(entry?.answer || '')
  const [category, setCategory] = useState(entry?.category || FAQ_CATEGORIES[0].id)
  const [scope, setScope] = useState<'GLOBAL' | 'PROPERTY'>(entry?.scope || 'GLOBAL')
  const [propertyId, setPropertyId] = useState(entry?.propertyId || '')
  const [saving, setSaving] = useState(false)

  const canSave = question.trim().length > 0 && answer.trim().length > 0 &&
    (scope === 'GLOBAL' || propertyId.length > 0)

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      await onSave({
        question: question.trim(),
        answer: answer.trim(),
        category,
        scope,
        ...(scope === 'PROPERTY' && propertyId ? { propertyId } : {}),
      })
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: T.font.sans,
    border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm,
    background: T.bg.primary, color: T.text.primary, resize: 'vertical',
    outline: 'none', transition: 'border-color 0.15s, box-shadow 0.15s',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9990,
      background: 'rgba(0,0,0,0.4)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      animation: 'faqFadeIn 0.15s ease-out',
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, maxWidth: '90vw', maxHeight: '90vh',
          background: T.bg.primary, borderRadius: T.radius.lg,
          boxShadow: T.shadow.lg, overflow: 'auto',
          animation: 'faqScaleIn 0.2s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: `1px solid ${T.border.default}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>
            {entry ? 'Edit FAQ Entry' : 'Add FAQ Entry'}
          </span>
          <button onClick={onClose} style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: T.radius.sm,
            color: T.text.tertiary,
          }}><X size={16} /></button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Question */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 6 }}>
              Question
            </label>
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="e.g. How do I connect to the WiFi?"
              rows={2}
              style={inputStyle}
              onFocus={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = `0 0 0 2px ${T.accent}20` }}
              onBlur={e => { e.currentTarget.style.borderColor = T.border.default; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>

          {/* Answer */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 6 }}>
              Answer
            </label>
            <textarea
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              placeholder="The WiFi network name is..."
              rows={4}
              style={inputStyle}
              onFocus={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = `0 0 0 2px ${T.accent}20` }}
              onBlur={e => { e.currentTarget.style.borderColor = T.border.default; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>

          {/* Category */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 6 }}>
              Category
            </label>
            <DropdownSelect
              value={category}
              onChange={setCategory}
              options={FAQ_CATEGORIES.map(c => ({ value: c.id, label: c.label }))}
              style={{ width: '100%', borderRadius: T.radius.sm, height: 36, fontSize: 13 }}
            />
          </div>

          {/* Scope */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 6 }}>
              Scope
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['GLOBAL', 'PROPERTY'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  style={{
                    height: 34, padding: '0 16px', fontSize: 12, fontWeight: 600,
                    borderRadius: T.radius.sm, cursor: 'pointer', fontFamily: T.font.sans,
                    border: scope === s ? `2px solid ${T.accent}` : `1px solid ${T.border.default}`,
                    background: scope === s ? `${T.accent}08` : T.bg.primary,
                    color: scope === s ? T.accent : T.text.secondary,
                    display: 'flex', alignItems: 'center', gap: 6,
                    transition: 'all 0.15s ease',
                  }}
                >
                  {s === 'GLOBAL' ? <Globe size={13} /> : <Building2 size={13} />}
                  {s === 'GLOBAL' ? 'Global' : 'Property-specific'}
                </button>
              ))}
            </div>
          </div>

          {/* Property selector (when PROPERTY scope) */}
          {scope === 'PROPERTY' && (
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans, marginBottom: 6 }}>
                Property
              </label>
              <DropdownSelect
                value={propertyId}
                onChange={setPropertyId}
                options={properties.map(p => ({ value: p.id, label: p.name }))}
                placeholder="Select property..."
                style={{ width: '100%', borderRadius: T.radius.sm, height: 36, fontSize: 13 }}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 20px', borderTop: `1px solid ${T.border.default}`,
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <SmallBtn onClick={onClose} disabled={saving}>Cancel</SmallBtn>
          <SmallBtn onClick={handleSave} variant="primary" disabled={!canSave || saving}>
            {saving ? <RefreshCw size={11} style={{ animation: 'faqSpin 1s linear infinite' }} /> : <Check size={11} />}
            {entry ? 'Save Changes' : 'Create FAQ'}
          </SmallBtn>
        </div>
      </div>
    </div>
  )
}

// ─── Suggested Entry Card ───────────────────────────────────────────────────
function SuggestedCard({ entry, properties, onApprove, onEdit, onReject }: {
  entry: FaqEntry
  properties: ApiProperty[]
  onApprove: (id: string, scope: 'GLOBAL' | 'PROPERTY') => void
  onEdit: (entry: FaqEntry) => void
  onReject: (id: string) => void
}) {
  const [scope, setScope] = useState<'GLOBAL' | 'PROPERTY'>(entry.scope)
  const propName = entry.propertyId
    ? properties.find(p => p.id === entry.propertyId)?.name || 'Unknown'
    : null

  return (
    <div style={{
      padding: '14px 18px', borderRadius: T.radius.md,
      border: `1px solid ${T.status.amber}30`,
      background: `${T.status.amber}06`,
      animation: 'faqFadeIn 0.3s ease-out both',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Sparkles size={13} color={T.status.amber} />
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>
              {entry.question}
            </span>
          </div>
          <p style={{
            fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans,
            margin: 0, lineHeight: 1.5,
            overflow: 'hidden', textOverflow: 'ellipsis',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          } as React.CSSProperties}>
            {entry.answer}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <Badge
            label={CATEGORY_LABEL_MAP[entry.category] || entry.category}
            color={T.accent}
            bg={`${T.accent}0A`}
          />
          {propName && (
            <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>
              from: {propName}
            </span>
          )}
        </div>
      </div>

      {/* Actions row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Scope toggle */}
        <div style={{ display: 'flex', gap: 4, marginRight: 4 }}>
          <button
            onClick={() => setScope('GLOBAL')}
            style={{
              height: 24, padding: '0 8px', fontSize: 10, fontWeight: 600,
              borderRadius: 999, cursor: 'pointer', fontFamily: T.font.sans,
              border: scope === 'GLOBAL' ? `1px solid ${T.accent}40` : `1px solid ${T.border.default}`,
              background: scope === 'GLOBAL' ? `${T.accent}10` : 'transparent',
              color: scope === 'GLOBAL' ? T.accent : T.text.tertiary,
              display: 'flex', alignItems: 'center', gap: 4,
              transition: 'all 0.15s ease',
            }}
          >
            <Globe size={10} /> Global
          </button>
          <button
            onClick={() => setScope('PROPERTY')}
            style={{
              height: 24, padding: '0 8px', fontSize: 10, fontWeight: 600,
              borderRadius: 999, cursor: 'pointer', fontFamily: T.font.sans,
              border: scope === 'PROPERTY' ? `1px solid ${T.accent}40` : `1px solid ${T.border.default}`,
              background: scope === 'PROPERTY' ? `${T.accent}10` : 'transparent',
              color: scope === 'PROPERTY' ? T.accent : T.text.tertiary,
              display: 'flex', alignItems: 'center', gap: 4,
              transition: 'all 0.15s ease',
            }}
          >
            <Building2 size={10} /> Property
          </button>
        </div>

        <div style={{ flex: 1 }} />

        <SmallBtn onClick={() => onReject(entry.id)} variant="danger">
          <X size={11} /> Reject
        </SmallBtn>
        <SmallBtn onClick={() => onEdit(entry)} variant="default">
          <Edit3 size={11} /> Edit
        </SmallBtn>
        <SmallBtn onClick={() => onApprove(entry.id, scope)} variant="success">
          <Check size={11} /> Approve
        </SmallBtn>
      </div>
    </div>
  )
}

// ─── FAQ Entry Row ──────────────────────────────────────────────────────────
function FaqRow({ entry, properties, onEdit, onArchive, onDelete, onToggleScope }: {
  entry: FaqEntry
  properties: ApiProperty[]
  onEdit: (entry: FaqEntry) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onToggleScope: (id: string, newScope: 'GLOBAL' | 'PROPERTY') => void
}) {
  const [hover, setHover] = useState(false)
  const propName = entry.propertyId
    ? properties.find(p => p.id === entry.propertyId)?.name || 'Unknown property'
    : null

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '12px 18px',
        background: hover ? T.bg.secondary : 'transparent',
        transition: 'background 0.1s ease',
        display: 'flex', alignItems: 'flex-start', gap: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 3 }}>
          {entry.question}
        </div>
        <div style={{
          fontSize: 12, color: T.text.secondary, fontFamily: T.font.sans,
          lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        } as React.CSSProperties}>
          {entry.answer}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {/* Scope badge */}
          {entry.scope === 'GLOBAL' ? (
            <Badge label="Global" color={T.accent} bg={`${T.accent}0A`} />
          ) : (
            <Badge label={propName || 'Property'} color={T.status.green} bg={`${T.status.green}0A`} />
          )}
          <StatusBadge status={entry.status} />
          {entry.usageCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 600, fontFamily: T.font.mono,
              color: T.text.tertiary, display: 'flex', alignItems: 'center', gap: 3,
            }}>
              <Hash size={10} /> {entry.usageCount} uses
            </span>
          )}
          {entry.source === 'AUTO_SUGGESTED' && (
            <span style={{
              fontSize: 10, fontWeight: 500, fontFamily: T.font.mono,
              color: T.status.amber, display: 'flex', alignItems: 'center', gap: 3,
            }}>
              <Sparkles size={9} /> auto-suggested
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
        opacity: hover ? 1 : 0, transition: 'opacity 0.15s ease',
      }}>
        <SmallBtn onClick={() => onToggleScope(entry.id, entry.scope === 'GLOBAL' ? 'PROPERTY' : 'GLOBAL')}>
          {entry.scope === 'GLOBAL' ? <Building2 size={11} /> : <Globe size={11} />}
        </SmallBtn>
        <SmallBtn onClick={() => onEdit(entry)}>
          <Edit3 size={11} />
        </SmallBtn>
        {entry.status !== 'ARCHIVED' ? (
          <SmallBtn onClick={() => onArchive(entry.id)} variant="warning">
            <Archive size={11} />
          </SmallBtn>
        ) : null}
        <SmallBtn onClick={() => onDelete(entry.id)} variant="danger">
          <Trash2 size={11} />
        </SmallBtn>
      </div>
    </div>
  )
}

// ─── Category Section ───────────────────────────────────────────────────────
function CategorySection({ category, entries, properties, onEdit, onArchive, onDelete, onToggleScope }: {
  category: string
  entries: FaqEntry[]
  properties: ApiProperty[]
  onEdit: (entry: FaqEntry) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onToggleScope: (id: string, newScope: 'GLOBAL' | 'PROPERTY') => void
}) {
  const [open, setOpen] = useState(true)
  const label = CATEGORY_LABEL_MAP[category] || category

  return (
    <div style={{
      background: T.bg.primary, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.lg, boxShadow: T.shadow.sm, overflow: 'hidden',
      animation: 'faqScaleIn 0.3s ease-out both',
    }}>
      {/* Category header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8,
          background: T.bg.secondary, border: 'none', cursor: 'pointer',
          borderBottom: open ? `1px solid ${T.border.default}` : 'none',
        }}
      >
        {open ? <ChevronDown size={14} color={T.text.tertiary} /> : <ChevronRight size={14} color={T.text.tertiary} />}
        <span style={{ fontSize: 12, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>
          {label}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, fontFamily: T.font.mono,
          color: T.text.tertiary, background: T.bg.tertiary,
          padding: '1px 7px', borderRadius: 999,
        }}>
          {entries.length}
        </span>
      </button>

      {/* Entries */}
      {open && (
        <div>
          {entries.map((e, i) => (
            <div key={e.id} style={{
              borderBottom: i < entries.length - 1 ? `1px solid ${T.border.default}` : 'none',
            }}>
              <FaqRow
                entry={e}
                properties={properties}
                onEdit={onEdit}
                onArchive={onArchive}
                onDelete={onDelete}
                onToggleScope={onToggleScope}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function FaqV5(): React.ReactElement {
  const [entries, setEntries] = useState<FaqEntry[]>([])
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [categoryStats, setCategoryStats] = useState<FaqCategoryStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [filterProperty, setFilterProperty] = useState('')
  const [filterScope, setFilterScope] = useState<ScopeFilter>('All')
  const [filterStatus, setFilterStatus] = useState<StatusFilter>('All')
  const [filterCategory, setFilterCategory] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<FaqEntry | null>(null)

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => { ensureStyles() }, [])

  // Load data
  const loadEntries = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const filters: Record<string, string> = {}
      if (filterProperty) filters.propertyId = filterProperty
      if (filterScope !== 'All') filters.scope = filterScope
      if (filterStatus !== 'All') filters.status = filterStatus
      if (filterCategory) filters.category = filterCategory
      const data = await apiGetFaqEntries(filters)
      setEntries(data.entries)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load FAQ entries'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [filterProperty, filterScope, filterStatus, filterCategory])

  const loadProperties = useCallback(async () => {
    try {
      const data = await apiGetProperties()
      setProperties(data)
    } catch { /* silent */ }
  }, [])

  const loadCategories = useCallback(async () => {
    try {
      const data = await apiGetFaqCategories()
      setCategoryStats(data.categories)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { loadEntries() }, [loadEntries])
  useEffect(() => { loadProperties() }, [loadProperties])
  useEffect(() => { loadCategories() }, [loadCategories])

  // Filtered entries (client-side search on top of server filters)
  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries
    const q = searchQuery.toLowerCase()
    return entries.filter(e =>
      e.question.toLowerCase().includes(q) || e.answer.toLowerCase().includes(q)
    )
  }, [entries, searchQuery])

  // Separate suggested from rest
  const suggestedEntries = useMemo(
    () => filteredEntries.filter(e => e.status === 'SUGGESTED'),
    [filteredEntries]
  )
  const mainEntries = useMemo(
    () => filteredEntries.filter(e => e.status !== 'SUGGESTED'),
    [filteredEntries]
  )

  // Group main entries by category
  const groupedByCategory = useMemo(() => {
    const map = new Map<string, FaqEntry[]>()
    for (const e of mainEntries) {
      const cat = e.category || 'uncategorized'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(e)
    }
    // Sort by FAQ_CATEGORIES order
    const order = FAQ_CATEGORIES.map(c => c.id)
    return [...map.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0])
      const bi = order.indexOf(b[0])
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
  }, [mainEntries])

  // Status counts for filter pills
  const statusCounts = useMemo(() => {
    const c = { SUGGESTED: 0, ACTIVE: 0, STALE: 0, ARCHIVED: 0 }
    for (const e of entries) {
      if (e.status in c) c[e.status as keyof typeof c]++
    }
    return c
  }, [entries])

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const handleCreate = async (data: {
    question: string; answer: string; category: string
    scope: 'GLOBAL' | 'PROPERTY'; propertyId?: string
  }) => {
    await apiCreateFaqEntry(data)
    setModalOpen(false)
    setEditingEntry(null)
    loadEntries()
    loadCategories()
  }

  const handleUpdate = async (data: {
    question: string; answer: string; category: string
    scope: 'GLOBAL' | 'PROPERTY'; propertyId?: string
  }) => {
    if (!editingEntry) return
    await apiUpdateFaqEntry(editingEntry.id, {
      ...data,
      propertyId: data.scope === 'PROPERTY' ? data.propertyId || null : null,
    })
    setModalOpen(false)
    setEditingEntry(null)
    loadEntries()
    loadCategories()
  }

  const handleArchive = async (id: string) => {
    await apiUpdateFaqEntry(id, { status: 'ARCHIVED' })
    loadEntries()
  }

  const handleDelete = async (id: string) => {
    if (deletingId !== id) {
      setDeletingId(id)
      setTimeout(() => setDeletingId(null), 3000) // reset after 3s
      return
    }
    await apiDeleteFaqEntry(id)
    setDeletingId(null)
    loadEntries()
    loadCategories()
  }

  const handleToggleScope = async (id: string, newScope: 'GLOBAL' | 'PROPERTY') => {
    await apiUpdateFaqEntry(id, {
      scope: newScope,
      ...(newScope === 'GLOBAL' ? { propertyId: null } : {}),
    })
    loadEntries()
  }

  const handleApprove = async (id: string, scope: 'GLOBAL' | 'PROPERTY') => {
    await apiUpdateFaqEntry(id, { status: 'ACTIVE', scope })
    loadEntries()
    loadCategories()
  }

  const handleReject = async (id: string) => {
    await apiDeleteFaqEntry(id)
    loadEntries()
    loadCategories()
  }

  const openEdit = (entry: FaqEntry) => {
    setEditingEntry(entry)
    setModalOpen(true)
  }

  const openCreate = () => {
    setEditingEntry(null)
    setModalOpen(true)
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="faq-scroll"
      style={{
        height: '100%', overflow: 'auto',
        background: T.bg.secondary, fontFamily: T.font.sans,
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '28px 24px 48px' }}>

        {/* ─── Header ─────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          marginBottom: 24, animation: 'faqFadeIn 0.3s ease-out',
        }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: T.text.primary, fontFamily: T.font.sans, margin: 0 }}>
              FAQs
            </h1>
            <p style={{ fontSize: 13, color: T.text.secondary, fontFamily: T.font.sans, margin: '4px 0 0' }}>
              Manage frequently asked questions for your properties
            </p>
          </div>
          <button
            onClick={openCreate}
            style={{
              height: 34, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 13, fontWeight: 600, borderRadius: T.radius.sm,
              background: T.border.strong, color: '#FFFFFF',
              border: 'none', cursor: 'pointer', fontFamily: T.font.sans,
              transition: 'opacity 0.15s',
            }}
          >
            <Plus size={14} /> Add FAQ
          </button>
        </div>

        {/* ─── Filters Bar ───────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          marginBottom: 20, animation: 'faqFadeIn 0.3s ease-out 0.05s both',
        }}>
          {/* Property filter */}
          <DropdownSelect
            value={filterProperty}
            onChange={setFilterProperty}
            placeholder="All Properties"
            options={properties.map(p => ({ value: p.id, label: p.name }))}
          />

          {/* Scope pills */}
          {(['All', 'GLOBAL', 'PROPERTY'] as ScopeFilter[]).map(s => (
            <FilterPill
              key={s}
              label={s === 'All' ? 'All Scopes' : s === 'GLOBAL' ? 'Global' : 'Property'}
              active={filterScope === s}
              onClick={() => setFilterScope(s)}
            />
          ))}

          <div style={{ width: 1, height: 20, background: T.border.default, margin: '0 4px' }} />

          {/* Status pills */}
          {(['All', 'SUGGESTED', 'ACTIVE', 'STALE', 'ARCHIVED'] as StatusFilter[]).map(s => (
            <FilterPill
              key={s}
              label={s === 'All' ? 'All Status' : s.charAt(0) + s.slice(1).toLowerCase()}
              active={filterStatus === s}
              onClick={() => setFilterStatus(s)}
              count={s !== 'All' ? statusCounts[s as keyof typeof statusCounts] : undefined}
            />
          ))}

          <div style={{ width: 1, height: 20, background: T.border.default, margin: '0 4px' }} />

          {/* Category filter */}
          <DropdownSelect
            value={filterCategory}
            onChange={setFilterCategory}
            placeholder="All Categories"
            options={FAQ_CATEGORIES.map(c => ({
              value: c.id,
              label: `${c.label}${categoryStats.find(cs => cs.id === c.id)?.count ? ` (${categoryStats.find(cs => cs.id === c.id)!.count})` : ''}`,
            }))}
          />

          {/* Search */}
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <Search size={13} color={T.text.tertiary} style={{ position: 'absolute', left: 10, top: 7.5 }} />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search FAQs..."
              style={{
                height: 28, width: 180, padding: '0 10px 0 30px',
                fontSize: 11, fontWeight: 500, fontFamily: T.font.sans,
                border: `1px solid ${T.border.default}`, borderRadius: 999,
                background: T.bg.primary, color: T.text.primary,
                outline: 'none', transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = `0 0 0 2px ${T.accent}20` }}
              onBlur={e => { e.currentTarget.style.borderColor = T.border.default; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>

          {/* Refresh */}
          <button
            onClick={() => { loadEntries(); loadCategories() }}
            disabled={loading}
            style={{
              height: 28, width: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px solid ${T.border.default}`, borderRadius: 999,
              background: T.bg.primary, cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s',
            }}
          >
            <RefreshCw size={12} color={T.text.tertiary} style={loading ? { animation: 'faqSpin 1s linear infinite' } : undefined} />
          </button>
        </div>

        {/* ─── Loading ───────────────────────────────────────────────── */}
        {loading && entries.length === 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            animation: 'faqFadeIn 0.3s ease-out',
          }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{
                height: 72, borderRadius: T.radius.lg, background: T.bg.primary,
                border: `1px solid ${T.border.default}`,
              }} />
            ))}
          </div>
        )}

        {/* ─── Error ─────────────────────────────────────────────────── */}
        {error && (
          <div style={{
            padding: '14px 18px', borderRadius: T.radius.md,
            background: `${T.status.red}08`, border: `1px solid ${T.status.red}20`,
            color: T.status.red, fontSize: 13, fontFamily: T.font.sans,
            marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {/* ─── Suggested Entries Section ──────────────────────────────── */}
        {suggestedEntries.length > 0 && (
          <div style={{
            marginBottom: 24, animation: 'faqFadeIn 0.3s ease-out 0.1s both',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
            }}>
              <Sparkles size={14} color={T.status.amber} />
              <span style={{ fontSize: 12, fontWeight: 700, color: T.status.amber, fontFamily: T.font.sans, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Pending Suggestions
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, fontFamily: T.font.mono,
                color: T.status.amber, background: `${T.status.amber}14`,
                padding: '1px 7px', borderRadius: 999,
              }}>
                {suggestedEntries.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {suggestedEntries.map(e => (
                <SuggestedCard
                  key={e.id}
                  entry={e}
                  properties={properties}
                  onApprove={handleApprove}
                  onEdit={openEdit}
                  onReject={handleReject}
                />
              ))}
            </div>
          </div>
        )}

        {/* ─── Main Entries (grouped by category) ─────────────────────── */}
        {!loading && groupedByCategory.length > 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            animation: 'faqFadeIn 0.3s ease-out 0.15s both',
          }}>
            {groupedByCategory.map(([cat, catEntries]) => (
              <CategorySection
                key={cat}
                category={cat}
                entries={catEntries}
                properties={properties}
                onEdit={openEdit}
                onArchive={handleArchive}
                onDelete={handleDelete}
                onToggleScope={handleToggleScope}
              />
            ))}
          </div>
        )}

        {/* ─── Empty State ───────────────────────────────────────────── */}
        {!loading && filteredEntries.length === 0 && !error && (
          <div style={{
            padding: '60px 24px', textAlign: 'center',
            background: T.bg.primary, border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.lg, animation: 'faqFadeIn 0.3s ease-out',
          }}>
            <HelpCircle size={36} color={T.text.tertiary} style={{ marginBottom: 12 }} />
            <h3 style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, margin: '0 0 6px' }}>
              No FAQ entries yet
            </h3>
            <p style={{ fontSize: 13, color: T.text.secondary, fontFamily: T.font.sans, margin: '0 0 20px', maxWidth: 400, marginLeft: 'auto', marginRight: 'auto' }}>
              Create your first FAQ or reply to guest questions to auto-generate suggestions.
            </p>
            <button
              onClick={openCreate}
              style={{
                height: 34, padding: '0 18px', display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 13, fontWeight: 600, borderRadius: T.radius.sm,
                background: T.border.strong, color: '#FFFFFF',
                border: 'none', cursor: 'pointer', fontFamily: T.font.sans,
              }}
            >
              <Plus size={14} /> Add FAQ
            </button>
          </div>
        )}
      </div>

      {/* ─── Delete Confirmation Toast ────────────────────────────────── */}
      {deletingId && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9980, padding: '10px 18px', borderRadius: T.radius.md,
          background: T.border.strong, color: '#FFFFFF', fontSize: 12,
          fontWeight: 600, fontFamily: T.font.sans, boxShadow: T.shadow.lg,
          display: 'flex', alignItems: 'center', gap: 10,
          animation: 'faqFadeIn 0.2s ease-out',
        }}>
          Click delete again to confirm
          <button
            onClick={() => setDeletingId(null)}
            style={{
              height: 22, padding: '0 8px', fontSize: 10, fontWeight: 600,
              borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent', color: '#FFFFFF', cursor: 'pointer',
              fontFamily: T.font.sans,
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ─── Modal ───────────────────────────────────────────────────── */}
      {modalOpen && (
        <FaqModal
          entry={editingEntry}
          properties={properties}
          onSave={editingEntry ? handleUpdate : handleCreate}
          onClose={() => { setModalOpen(false); setEditingEntry(null) }}
        />
      )}
    </div>
  )
}
