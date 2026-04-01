'use client'

import { useEffect, useState, useMemo } from 'react'
import { X, Check, Plus, ChevronRight, Calendar, LayoutList, LayoutGrid, ArrowUpDown } from 'lucide-react'
import {
  apiGetAllTasks,
  apiUpdateTask,
  apiDeleteTask,
  apiCreateGlobalTask,
  apiGetProperties,
  type ApiTask,
  type ApiProperty,
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

// ─── Style injection ────────────────────────────────────────────────────────
const STYLE_ID = 'tasks-v5-styles'
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
    @keyframes slideInRight {
      from { opacity: 0; transform: translateX(24px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes skeleton-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  `
  document.head.appendChild(style)
}

// ─── Urgency helpers ──────────────────────────────────────────────────────────
function urgencyColor(urgency: string): string {
  const u = urgency.toLowerCase()
  if (u.includes('immediate')) return T.status.red
  if (u.includes('modification')) return T.status.red
  if (u.includes('scheduled')) return T.status.amber
  if (u.includes('inquiry')) return T.accent
  if (u.includes('info')) return T.accent
  return T.text.tertiary
}

function urgencyBg(urgency: string): string {
  const u = urgency.toLowerCase()
  if (u.includes('immediate')) return 'rgba(220,38,38,0.1)'
  if (u.includes('modification')) return 'rgba(220,38,38,0.1)'
  if (u.includes('scheduled')) return 'rgba(217,119,6,0.12)'
  if (u.includes('inquiry')) return 'rgba(29,78,216,0.1)'
  if (u.includes('info')) return 'rgba(29,78,216,0.1)'
  return 'rgba(168,162,158,0.1)'
}

function urgencyLabel(urgency: string): string {
  const u = urgency.toLowerCase()
  if (u.includes('immediate')) return 'Immediate'
  if (u.includes('modification')) return 'Modification Request'
  if (u.includes('scheduled')) return 'Scheduled'
  if (u.includes('inquiry')) return 'Inquiry Decision'
  if (u.includes('info')) return 'Info Request'
  return urgency
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Filter types ─────────────────────────────────────────────────────────────
type StatusFilter = 'All' | 'Open' | 'In Progress' | 'Completed'
type UrgencyFilter = 'All' | 'Immediate' | 'Scheduled' | 'Info Request'
type ViewMode = 'list' | 'board'
type SortOption = 'newest' | 'oldest' | 'urgency' | 'dueDate'

// ─── Pill component ───────────────────────────────────────────────────────────
function FilterPill({
  label,
  active,
  onClick,
  count,
}: {
  label: string
  active: boolean
  onClick: () => void
  count?: number
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 28,
        padding: '0 14px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.01em',
        cursor: 'pointer',
        borderRadius: 999,
        border: active ? 'none' : `1px solid ${T.border.default}`,
        background: active ? T.border.strong : hover ? T.bg.tertiary : T.bg.primary,
        color: active ? '#FFFFFF' : T.text.secondary,
        fontFamily: T.font.sans,
        lineHeight: '28px',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        transition: 'all 0.15s ease',
      }}
    >
      {label}
      {count != null && count > 0 && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 5px',
            background: active ? 'rgba(255,255,255,0.2)' : T.bg.tertiary,
            color: active ? 'rgba(255,255,255,0.8)' : T.text.tertiary,
            lineHeight: 1,
          }}
        >
          {count}
        </span>
      )}
    </button>
  )
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────
function SkeletonCard(): React.ReactElement {
  return (
    <div
      style={{
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        marginBottom: 8,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        background: T.bg.primary,
        boxShadow: T.shadow.sm,
        animation: 'skeleton-pulse 1.5s ease-in-out infinite',
      }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: T.radius.sm,
          background: T.bg.tertiary,
          flexShrink: 0,
          marginTop: 2,
        }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            height: 14,
            width: '60%',
            background: T.bg.tertiary,
            borderRadius: T.radius.sm,
            marginBottom: 8,
          }}
        />
        <div
          style={{
            height: 12,
            width: '40%',
            background: T.bg.secondary,
            borderRadius: T.radius.sm,
          }}
        />
      </div>
    </div>
  )
}

// ─── Due date pill ───────────────────────────────────────────────────────────
function DueDatePill({ dueDate }: { dueDate: string }): React.ReactElement {
  const now = new Date()
  const due = new Date(dueDate)
  const isOverdue = due < now
  const isToday = due.toDateString() === now.toDateString()
  const isDueSoon = !isOverdue && !isToday && due <= new Date(Date.now() + 86400000)

  let pillBg: string
  let pillColor: string
  let label: string

  if (isOverdue) {
    pillBg = 'rgba(220,38,38,0.1)'
    pillColor = T.status.red
    label = 'Overdue'
  } else if (isToday) {
    pillBg = 'rgba(217,119,6,0.12)'
    pillColor = T.status.amber
    label = 'Due Today'
  } else {
    pillBg = 'rgba(168,162,158,0.1)'
    pillColor = T.text.secondary
    label = formatCreatedAt(dueDate)
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        fontWeight: 600,
        padding: '2px 7px',
        borderRadius: 999,
        background: pillBg,
        color: pillColor,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <Calendar size={9} />
      {label}
    </span>
  )
}

// ─── Task Card ────────────────────────────────────────────────────────────────
function TaskCard({
  task,
  onToggleComplete,
  onDelete,
  index,
}: {
  task: ApiTask
  onToggleComplete: (id: string, currentStatus: string) => void
  onDelete: (id: string, title: string) => void
  index?: number
}): React.ReactElement {
  const [deleteHover, setDeleteHover] = useState(false)
  const [cardHover, setCardHover] = useState(false)
  const [checkHover, setCheckHover] = useState(false)

  const isCompleted = task.status.toLowerCase().includes('completed')
  const color = urgencyColor(task.urgency)
  const truncatedNote =
    task.note && task.note.length > 80
      ? task.note.slice(0, 80) + '...'
      : task.note

  const metaParts: string[] = []
  if (task.propertyName) metaParts.push(task.propertyName)
  if (task.guestName) metaParts.push(task.guestName)
  if (task.assignee) metaParts.push(task.assignee)
  metaParts.push(formatCreatedAt(task.createdAt))

  const delay = typeof index === 'number' ? `${index * 0.04}s` : '0s'

  return (
    <div
      onMouseEnter={() => setCardHover(true)}
      onMouseLeave={() => setCardHover(false)}
      style={{
        borderRadius: T.radius.md,
        border: `1px solid ${cardHover ? T.border.default : 'rgba(231,229,228,0.6)'}`,
        borderLeft: `4px solid ${color}`,
        marginBottom: 8,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        background: T.bg.primary,
        opacity: isCompleted ? 0.6 : 1,
        fontFamily: T.font.sans,
        boxShadow: cardHover ? T.shadow.md : T.shadow.sm,
        transition: 'box-shadow 0.2s ease, border-color 0.2s ease, background 0.15s ease',
        animation: `fadeInUp 0.3s ease-out ${delay} both`,
      }}
    >
      {/* Checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleComplete(task.id, task.status) }}
        onMouseEnter={() => setCheckHover(true)}
        onMouseLeave={() => setCheckHover(false)}
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          border: isCompleted
            ? `2px solid ${T.status.green}`
            : `2px solid ${checkHover ? T.text.secondary : T.border.default}`,
          borderRadius: 5,
          cursor: 'pointer',
          background: isCompleted ? T.status.green : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          marginTop: 2,
          transition: 'all 0.15s ease',
        }}
        aria-label={isCompleted ? 'Mark as open' : 'Mark as completed'}
      >
        {isCompleted && <Check size={11} color="#FFFFFF" strokeWidth={3} />}
      </button>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title row with urgency badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: truncatedNote ? 3 : 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: T.text.primary,
              textDecoration: isCompleted ? 'line-through' : 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.01em',
            }}
          >
            {task.title}
          </div>
          {/* Urgency badge */}
          <span
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 999,
              background: urgencyBg(task.urgency),
              color: urgencyColor(task.urgency),
              lineHeight: 1.3,
              whiteSpace: 'nowrap',
            }}
          >
            {urgencyLabel(task.urgency)}
          </span>
        </div>

        {/* Note */}
        {truncatedNote && (
          <div
            style={{
              fontSize: 12,
              color: T.text.secondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginBottom: 6,
              lineHeight: 1.4,
            }}
          >
            {truncatedNote}
          </div>
        )}

        {/* Metadata row */}
        <div
          style={{
            fontSize: 11,
            color: T.text.tertiary,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {metaParts.map((part, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && (
                <span style={{ color: T.border.default, userSelect: 'none' }}>{'\u00B7'}</span>
              )}
              {part}
            </span>
          ))}
          {task.dueDate && (
            <>
              <span style={{ color: T.border.default, userSelect: 'none' }}>{'\u00B7'}</span>
              <DueDatePill dueDate={task.dueDate} />
            </>
          )}
        </div>
      </div>

      {/* Source badge */}
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: T.font.mono,
          fontWeight: 500,
          borderRadius: 999,
          padding: '2px 8px',
          border: `1px solid ${T.border.default}`,
          color: T.text.tertiary,
          whiteSpace: 'nowrap',
          alignSelf: 'flex-start',
          marginTop: 2,
          background: T.bg.secondary,
        }}
      >
        {task.source}
      </span>

      {/* Delete button */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(task.id, task.title) }}
        onMouseEnter={() => setDeleteHover(true)}
        onMouseLeave={() => setDeleteHover(false)}
        style={{
          flexShrink: 0,
          width: 26,
          height: 26,
          background: deleteHover ? 'rgba(220,38,38,0.08)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: deleteHover ? T.status.red : T.text.tertiary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          borderRadius: T.radius.sm,
          alignSelf: 'flex-start',
          transition: 'background 0.15s ease, color 0.15s ease',
        }}
        aria-label="Delete task"
      >
        <X size={14} />
      </button>
    </div>
  )
}

// ─── Create Task Form ────────────────────────────────────────────────────────
function CreateTaskForm({
  onCancel,
  onCreated,
  properties,
}: {
  onCancel: () => void
  onCreated: (task: ApiTask) => void
  properties: ApiProperty[]
}): React.ReactElement {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [urgency, setUrgency] = useState('info_request')
  const [propertyId, setPropertyId] = useState('')
  const [assignee, setAssignee] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [focusedField, setFocusedField] = useState<string | null>(null)

  const handleSubmit = async (): Promise<void> => {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      const task = await apiCreateGlobalTask({
        title: title.trim(),
        note: note.trim() || undefined,
        urgency,
        propertyId: propertyId || undefined,
        assignee: assignee.trim() || undefined,
        dueDate: dueDate || undefined,
      })
      onCreated(task)
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const fieldStyle = (name: string): React.CSSProperties => ({
    width: '100%',
    padding: '8px 12px',
    border: `1px solid ${focusedField === name ? T.accent : T.border.default}`,
    borderRadius: T.radius.sm,
    fontSize: 13,
    fontFamily: T.font.sans,
    color: T.text.primary,
    background: T.bg.primary,
    boxSizing: 'border-box',
    outline: 'none',
    boxShadow: focusedField === name ? `0 0 0 2px rgba(29,78,216,0.15)` : 'inset 0 1px 2px rgba(12,10,9,0.04)',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  })

  return (
    <div style={{
      padding: 20,
      background: T.bg.primary,
      borderRadius: T.radius.md,
      border: `1px solid ${T.border.default}`,
      marginBottom: 16,
      boxShadow: T.shadow.md,
      animation: 'scaleIn 0.2s ease-out both',
    }}>
      <div style={{
        fontSize: 14,
        fontWeight: 700,
        marginBottom: 16,
        color: T.text.primary,
        fontFamily: T.font.sans,
        letterSpacing: '-0.01em',
      }}>
        New Task
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          placeholder="Title *"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onFocus={() => setFocusedField('title')}
          onBlur={() => setFocusedField(null)}
          style={fieldStyle('title')}
        />
        <textarea
          placeholder="Note (optional)"
          value={note}
          onChange={e => setNote(e.target.value)}
          onFocus={() => setFocusedField('note')}
          onBlur={() => setFocusedField(null)}
          rows={2}
          style={{ ...fieldStyle('note'), resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <select
            value={urgency}
            onChange={e => setUrgency(e.target.value)}
            onFocus={() => setFocusedField('urgency')}
            onBlur={() => setFocusedField(null)}
            style={{ ...fieldStyle('urgency'), flex: 1 }}
          >
            <option value="immediate">Immediate</option>
            <option value="scheduled">Scheduled</option>
            <option value="info_request">Info Request</option>
          </select>
          <select
            value={propertyId}
            onChange={e => setPropertyId(e.target.value)}
            onFocus={() => setFocusedField('property')}
            onBlur={() => setFocusedField(null)}
            style={{ ...fieldStyle('property'), flex: 1 }}
          >
            <option value="">No property</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <input
          placeholder="Assignee (optional)"
          value={assignee}
          onChange={e => setAssignee(e.target.value)}
          onFocus={() => setFocusedField('assignee')}
          onBlur={() => setFocusedField(null)}
          style={fieldStyle('assignee')}
        />
        <input
          type="date"
          value={dueDate}
          onChange={e => setDueDate(e.target.value)}
          onFocus={() => setFocusedField('dueDate')}
          onBlur={() => setFocusedField(null)}
          style={fieldStyle('dueDate')}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '7px 16px',
              fontSize: 12,
              fontWeight: 500,
              borderRadius: T.radius.sm,
              border: `1px solid ${T.border.default}`,
              background: T.bg.primary,
              color: T.text.secondary,
              cursor: 'pointer',
              fontFamily: T.font.sans,
              transition: 'background 0.15s ease',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || saving}
            style={{
              padding: '7px 16px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: T.radius.sm,
              border: 'none',
              background: T.border.strong,
              color: '#FFFFFF',
              cursor: 'pointer',
              fontFamily: T.font.sans,
              opacity: !title.trim() || saving ? 0.5 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            {saving ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Task Detail Panel ───────────────────────────────────────────────────────
function TaskDetailPanel({
  task,
  onClose,
}: {
  task: ApiTask
  onClose: () => void
}): React.ReactElement {
  const color = urgencyColor(task.urgency)
  const isCompleted = task.status.toLowerCase().includes('completed')
  const [closeHover, setCloseHover] = useState(false)

  const detailRows: [string, string | React.ReactElement][] = [
    ['Status', task.status],
    ['Urgency', task.urgency],
    ['Source', task.source],
    ['Property', task.propertyName || '\u2014'],
    ['Guest', task.guestName || '\u2014'],
    ['Assignee', task.assignee || '\u2014'],
    ['Due Date', task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '\u2014'],
    ['Created', formatCreatedAt(task.createdAt)],
    ['Completed', task.completedAt ? formatCreatedAt(task.completedAt) : '\u2014'],
  ]

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, maxWidth: '90vw',
      background: T.bg.primary, borderLeft: `1px solid ${T.border.default}`,
      boxShadow: T.shadow.lg, zIndex: 100,
      display: 'flex', flexDirection: 'column', fontFamily: T.font.sans,
      animation: 'slideInRight 0.25s ease-out both',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '18px 24px',
        borderBottom: `1px solid ${T.border.default}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: T.text.secondary,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontFamily: T.font.sans,
        }}>
          Task Detail
        </span>
        <button
          onClick={onClose}
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          style={{
            background: closeHover ? T.bg.tertiary : 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: T.text.tertiary,
            padding: 6,
            borderRadius: T.radius.sm,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.15s ease',
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Panel body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {/* Title section */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{ width: 4, height: 24, borderRadius: 2, background: color }} />
          <span style={{
            fontSize: 17,
            fontWeight: 700,
            color: T.text.primary,
            textDecoration: isCompleted ? 'line-through' : 'none',
            letterSpacing: '-0.01em',
          }}>
            {task.title}
          </span>
        </div>

        {/* Urgency badge */}
        <div style={{ marginBottom: 20 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 999,
              background: urgencyBg(task.urgency),
              color: urgencyColor(task.urgency),
            }}
          >
            {urgencyLabel(task.urgency)}
          </span>
        </div>

        {/* Note */}
        {task.note && (
          <div style={{
            fontSize: 13,
            color: T.text.secondary,
            lineHeight: 1.7,
            marginBottom: 24,
            whiteSpace: 'pre-wrap',
            padding: 16,
            background: T.bg.secondary,
            borderRadius: T.radius.sm,
            border: `1px solid ${T.border.default}`,
          }}>
            {task.note}
          </div>
        )}

        {/* Divider */}
        <div style={{
          height: 1,
          background: T.border.default,
          marginBottom: 20,
        }} />

        {/* Detail rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {detailRows.map(([label, value]) => (
            <div key={label} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 12,
            }}>
              <span style={{
                color: T.text.tertiary,
                fontWeight: 500,
                textTransform: 'uppercase',
                fontSize: 10,
                letterSpacing: '0.05em',
              }}>
                {label}
              </span>
              <span style={{
                color: T.text.primary,
                fontWeight: 500,
                fontFamily: typeof value === 'string' && (label === 'Source') ? T.font.mono : T.font.sans,
              }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function TasksV5(): React.ReactElement {
  const [tasks, setTasks] = useState<ApiTask[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All')
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>('All')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [selectedTask, setSelectedTask] = useState<ApiTask | null>(null)
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortOption, setSortOption] = useState<SortOption>('newest')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sortHover, setSortHover] = useState(false)
  const [createBtnHover, setCreateBtnHover] = useState(false)

  useEffect(() => {
    ensureStyles()
  }, [])

  useEffect(() => {
    apiGetProperties().then(setProperties).catch(err => console.error('[Tasks] Failed to load properties:', err))
  }, [])

  useEffect(() => {
    setLoading(true)
    setErrorMsg(null)
    apiGetAllTasks()
      .then((data) => setTasks(data))
      .catch(err => { console.error('[Tasks] Failed to load tasks:', err); setErrorMsg(err.message || 'Failed to load tasks') })
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = tasks.filter((task) => {
      if (statusFilter === 'Open' && !task.status.toLowerCase().includes('open')) return false
      if (statusFilter === 'In Progress' && !task.status.toLowerCase().includes('in_progress')) return false
      if (statusFilter === 'Completed' && !task.status.toLowerCase().includes('completed')) return false
      if (urgencyFilter === 'Immediate' && !task.urgency.toLowerCase().includes('immediate')) return false
      if (urgencyFilter === 'Scheduled' && !task.urgency.toLowerCase().includes('scheduled')) return false
      if (urgencyFilter === 'Info Request' && !task.urgency.toLowerCase().includes('info')) return false
      if (q && !task.title.toLowerCase().includes(q) && !(task.note || '').toLowerCase().includes(q)) return false
      return true
    })
    list.sort((a, b) => {
      switch (sortOption) {
        case 'oldest': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        case 'urgency': {
          const urgRank = (u: string): number => u.includes('immediate') ? 0 : u.includes('scheduled') ? 1 : 2
          return urgRank(a.urgency.toLowerCase()) - urgRank(b.urgency.toLowerCase())
        }
        case 'dueDate': {
          if (!a.dueDate && !b.dueDate) return 0
          if (!a.dueDate) return 1
          if (!b.dueDate) return -1
          return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        }
        default: return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
    })
    return list
  }, [tasks, statusFilter, urgencyFilter, searchQuery, sortOption])

  const handleToggleComplete = (id: string, currentStatus: string): void => {
    const newStatus = currentStatus.toLowerCase().includes('completed') ? 'open' : 'completed'
    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: newStatus } : t))
    )
    apiUpdateTask(id, { status: newStatus }).catch((err) => {
      console.error('[Tasks] Failed to update task status:', err)
      setErrorMsg(err.message || 'Failed to update task')
      // Revert on error
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: currentStatus } : t))
      )
    })
  }

  const handleDelete = (id: string, title: string): void => {
    if (!window.confirm(`Delete task "${title}"?`)) return
    // Optimistic update
    setTasks((prev) => prev.filter((t) => t.id !== id))
    apiDeleteTask(id).catch((err) => {
      console.error('[Tasks] Failed to delete task:', err)
      setErrorMsg(err.message || 'Failed to delete task')
      // Revert on error — re-fetch for simplicity
      apiGetAllTasks().then(setTasks).catch(err2 => { console.error('[Tasks] Failed to reload tasks:', err2); setErrorMsg(err2.message || 'Failed to reload tasks') })
    })
  }

  // Compute counts for badges
  const statusCounts: Record<StatusFilter, number> = {
    All: tasks.length,
    Open: tasks.filter(t => t.status.toLowerCase().includes('open')).length,
    'In Progress': tasks.filter(t => t.status.toLowerCase().includes('in_progress')).length,
    Completed: tasks.filter(t => t.status.toLowerCase().includes('completed')).length,
  }
  const urgencyCounts: Record<UrgencyFilter, number> = {
    All: tasks.length,
    Immediate: tasks.filter(t => t.urgency.toLowerCase().includes('immediate')).length,
    Scheduled: tasks.filter(t => t.urgency.toLowerCase().includes('scheduled')).length,
    'Info Request': tasks.filter(t => t.urgency.toLowerCase().includes('info')).length,
  }

  const statusOptions: StatusFilter[] = ['All', 'Open', 'In Progress', 'Completed']
  const urgencyOptions: UrgencyFilter[] = ['All', 'Immediate', 'Scheduled', 'Info Request']

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
        fontFamily: T.font.sans,
        background: T.bg.secondary,
      }}
    >
      {/* Page header with title and filters */}
      <div
        style={{
          padding: '20px 24px',
          borderBottom: `1px solid ${T.border.default}`,
          background: T.bg.primary,
          flexShrink: 0,
          boxShadow: T.shadow.sm,
        }}
      >
        {/* Title row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{
              fontSize: 18,
              fontWeight: 800,
              color: T.text.primary,
              letterSpacing: '-0.02em',
            }}>
              Tasks
            </span>
            <span style={{
              fontSize: 12,
              color: T.text.tertiary,
              fontWeight: 500,
            }}>
              {loading ? '...' : `${filtered.length} task${filtered.length !== 1 ? 's' : ''}`}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* View toggle */}
            <div style={{
              display: 'flex',
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              overflow: 'hidden',
            }}>
              <button
                onClick={() => setViewMode('list')}
                style={{
                  padding: '5px 10px',
                  border: 'none',
                  cursor: 'pointer',
                  background: viewMode === 'list' ? T.border.strong : 'transparent',
                  color: viewMode === 'list' ? '#FFFFFF' : T.text.tertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.15s ease',
                }}
              >
                <LayoutList size={14} />
              </button>
              <button
                onClick={() => setViewMode('board')}
                style={{
                  padding: '5px 10px',
                  border: 'none',
                  borderLeft: `1px solid ${T.border.default}`,
                  cursor: 'pointer',
                  background: viewMode === 'board' ? T.border.strong : 'transparent',
                  color: viewMode === 'board' ? '#FFFFFF' : T.text.tertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.15s ease',
                }}
              >
                <LayoutGrid size={14} />
              </button>
            </div>
            {/* Sort dropdown */}
            <select
              value={sortOption}
              onChange={e => setSortOption(e.target.value as SortOption)}
              onMouseEnter={() => setSortHover(true)}
              onMouseLeave={() => setSortHover(false)}
              style={{
                height: 30,
                padding: '0 10px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: T.radius.sm,
                border: `1px solid ${T.border.default}`,
                background: sortHover ? T.bg.secondary : T.bg.primary,
                color: T.text.secondary,
                cursor: 'pointer',
                fontFamily: T.font.sans,
                outline: 'none',
                transition: 'background 0.15s ease',
              }}
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="urgency">Urgency</option>
              <option value="dueDate">Due Date</option>
            </select>
            <button
              onClick={() => setShowCreateForm(v => !v)}
              onMouseEnter={() => setCreateBtnHover(true)}
              onMouseLeave={() => setCreateBtnHover(false)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 30,
                padding: '0 14px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: T.radius.sm,
                border: 'none',
                background: createBtnHover ? T.text.secondary : T.border.strong,
                color: '#FFFFFF',
                cursor: 'pointer',
                fontFamily: T.font.sans,
                transition: 'background 0.15s ease',
              }}
            >
              <Plus size={13} strokeWidth={2.5} />
              New Task
            </button>
          </div>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search tasks..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          style={{
            width: '100%',
            maxWidth: 300,
            height: 32,
            padding: '0 12px',
            fontSize: 12,
            border: `1px solid ${searchFocused ? T.accent : T.border.default}`,
            borderRadius: T.radius.sm,
            background: T.bg.secondary,
            color: T.text.primary,
            fontFamily: T.font.sans,
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: 16,
            boxShadow: searchFocused
              ? `0 0 0 2px rgba(29,78,216,0.15)`
              : 'inset 0 1px 2px rgba(12,10,9,0.04)',
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          }}
        />

        {/* Filter pills */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
          }}
        >
          {statusOptions.map((s) => (
            <FilterPill
              key={s}
              label={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              count={s !== 'All' ? statusCounts[s] : undefined}
            />
          ))}

          {/* Separator */}
          <span
            style={{
              width: 1,
              height: 16,
              background: T.border.default,
              display: 'inline-block',
              alignSelf: 'center',
              margin: '0 4px',
            }}
          />

          {urgencyOptions.map((u) => (
            <FilterPill
              key={u}
              label={u}
              active={urgencyFilter === u}
              onClick={() => setUrgencyFilter(u)}
              count={u !== 'All' ? urgencyCounts[u] : undefined}
            />
          ))}
        </div>
      </div>

      {/* Task list container */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 20,
        }}
      >
        {/* Create task form */}
        {showCreateForm && (
          <CreateTaskForm
            properties={properties}
            onCancel={() => setShowCreateForm(false)}
            onCreated={(task) => {
              setTasks(prev => [task, ...prev])
              setShowCreateForm(false)
            }}
          />
        )}

        {viewMode === 'board' ? (
          /* Board/Kanban view */
          <div style={{ display: 'flex', gap: 16, minHeight: 300 }}>
            {(['open', 'in_progress', 'completed'] as const).map(col => {
              const colLabel = col === 'open' ? 'Open' : col === 'in_progress' ? 'In Progress' : 'Completed'
              const colColor = col === 'open' ? T.accent : col === 'in_progress' ? T.status.amber : T.status.green
              const colTasks = filtered.filter(t => {
                const s = t.status.toLowerCase()
                if (col === 'open') return s.includes('open')
                if (col === 'in_progress') return s.includes('in_progress')
                return s.includes('completed')
              })
              return (
                <div key={col} style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  animation: 'fadeInUp 0.3s ease-out both',
                }}>
                  {/* Column header */}
                  <div style={{
                    padding: '10px 14px',
                    borderRadius: `${T.radius.md}px ${T.radius.md}px 0 0`,
                    background: T.bg.primary,
                    border: `1px solid ${T.border.default}`,
                    borderBottom: `2px solid ${colColor}`,
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: T.text.secondary,
                    fontFamily: T.font.sans,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}>
                    {colLabel}
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: T.text.tertiary,
                      background: T.bg.tertiary,
                      padding: '1px 6px',
                      borderRadius: 999,
                      minWidth: 18,
                      textAlign: 'center',
                    }}>
                      {colTasks.length}
                    </span>
                  </div>
                  {/* Column body */}
                  <div style={{
                    flex: 1,
                    background: T.bg.secondary,
                    border: `1px solid ${T.border.default}`,
                    borderTop: 'none',
                    borderRadius: `0 0 ${T.radius.md}px ${T.radius.md}px`,
                    padding: 10,
                    overflowY: 'auto',
                  }}>
                    {loading ? (
                      <SkeletonCard />
                    ) : colTasks.length === 0 ? (
                      <div style={{
                        padding: 24,
                        textAlign: 'center',
                        fontSize: 12,
                        color: T.text.tertiary,
                        fontFamily: T.font.sans,
                      }}>
                        No tasks
                      </div>
                    ) : (
                      colTasks.map((task, i) => (
                        <div key={task.id} onClick={() => setSelectedTask(task)} style={{ cursor: 'pointer' }}>
                          <TaskCard task={task} onToggleComplete={handleToggleComplete} onDelete={handleDelete} index={i} />
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          /* List view */
          <div
            style={{
              background: T.bg.primary,
              borderRadius: T.radius.lg,
              border: `1px solid ${T.border.default}`,
              padding: 16,
              minHeight: loading || filtered.length === 0 ? 300 : undefined,
              display: 'flex',
              flexDirection: 'column',
              boxShadow: T.shadow.sm,
            }}
          >
            {errorMsg && (
              <div style={{
                padding: '8px 12px',
                marginBottom: 8,
                background: 'rgba(220,38,38,0.08)',
                border: `1px solid rgba(220,38,38,0.2)`,
                borderRadius: T.radius.sm,
                fontSize: 12,
                color: T.status.red,
                fontFamily: T.font.sans,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span>{errorMsg}</span>
                <button onClick={() => setErrorMsg(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.status.red, fontSize: 14, lineHeight: 1, padding: '0 4px' }} aria-label="Dismiss error">&times;</button>
              </div>
            )}
            {loading ? (
              <>
                {Array.from({ length: 5 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </>
            ) : filtered.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 1,
                  color: T.text.tertiary,
                  fontSize: 13,
                  fontFamily: T.font.sans,
                  fontWeight: 500,
                }}
              >
                No tasks found
              </div>
            ) : (
              filtered.map((task, i) => (
                <div key={task.id} onClick={() => setSelectedTask(task)} style={{ cursor: 'pointer' }}>
                  <TaskCard
                    task={task}
                    onToggleComplete={handleToggleComplete}
                    onDelete={handleDelete}
                    index={i}
                  />
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Task detail slide-out panel */}
      {selectedTask && (
        <>
          <div
            onClick={() => setSelectedTask(null)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(12,10,9,0.25)',
              backdropFilter: 'blur(2px)',
              zIndex: 99,
              animation: 'fadeIn 0.15s ease-out both',
            }}
          />
          <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
        </>
      )}
    </div>
  )
}
