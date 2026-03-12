'use client'

import { useState, useEffect } from 'react'
import { ExternalLink, ChevronLeft, ChevronRight, Mail, Phone, Globe, Wifi, KeyRound, MapPin, Clock, Info, BookOpen, LogIn, CheckCircle, XCircle, Check, Trash2, ChevronDown as ChevDown, AlertTriangle, ClipboardList } from 'lucide-react'
import type { Conversation } from '@/lib/inbox-data'
import { apiInquiryAction, apiGetConversationTasks, apiUpdateTask, apiDeleteTask, type ApiTask } from '@/lib/api'

interface BookingPanelProps {
  conversation: Conversation
  aiEnabled: boolean
  onToggleAI: () => void
  aiMode?: string
  onAiModeChange?: (mode: 'autopilot' | 'copilot' | 'off') => void
  onInquiryActioned?: (action: 'accept' | 'reject') => void
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function parseDate(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  // Ignore epoch (invalid/null dates stored as 1970-01-01)
  if (d.getFullYear() < 2000) return null
  return d
}

function MiniCalendar({ checkIn, checkOut, property }: { checkIn: string; checkOut: string; property: string }) {
  const ci = parseDate(checkIn)
  const co = parseDate(checkOut)
  const today = new Date()
  const initDate = ci ?? today
  const [month, setMonth] = useState(initDate.getMonth())
  const [year, setYear] = useState(initDate.getFullYear())
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (number | null)[] = Array(firstDay).fill(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  // Compare using date-only (strip time) to avoid timezone-of-day issues
  const sameDay = (d: number | null, ref: Date | null) =>
    d !== null && ref !== null &&
    ref.getFullYear() === year && ref.getMonth() === month && ref.getDate() === d
  const isCI = (d: number | null) => sameDay(d, ci)
  const isCO = (d: number | null) => sameDay(d, co)
  const inRange = (d: number | null) => {
    if (!d || !ci || !co) return false
    const dt = new Date(year, month, d).getTime()
    return dt > new Date(ci.getFullYear(), ci.getMonth(), ci.getDate()).getTime() &&
           dt < new Date(co.getFullYear(), co.getMonth(), co.getDate()).getTime()
  }

  function prev() { month === 0 ? (setMonth(11), setYear(y => y - 1)) : setMonth(m => m - 1) }
  function next() { month === 11 ? (setMonth(0), setYear(y => y + 1)) : setMonth(m => m + 1) }

  return (
    <div>
      <h4
        className="text-xs font-semibold mb-3 leading-snug text-balance"
        style={{ color: 'var(--brown-dark)' }}
      >
        {property}
      </h4>
      <div className="flex items-center justify-between mb-2">
        <button onClick={prev} className="w-6 h-6 flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--muted)]">
          <ChevronLeft size={13} style={{ color: 'var(--muted-foreground)' }} />
        </button>
        <span className="text-xs font-semibold" style={{ color: 'var(--brown-dark)' }}>
          {MONTHS[month]} {year}
        </span>
        <button onClick={next} className="w-6 h-6 flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--muted)]">
          <ChevronRight size={13} style={{ color: 'var(--muted-foreground)' }} />
        </button>
      </div>
      <div className="grid grid-cols-7">
        {DAYS.map(d => (
          <div key={d} className="text-center text-[10px] font-medium pb-1" style={{ color: 'var(--muted-foreground)' }}>{d}</div>
        ))}
        {cells.map((d, i) => (
          <div key={i} className="text-center py-0.5">
            {d && (
              <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium"
                style={
                  isCI(d) || isCO(d)
                    ? { background: 'var(--terracotta)', color: '#fff', fontWeight: 700 }
                    : inRange(d)
                    ? { background: '#FEF3C7', color: '#92400E' }
                    : { color: 'var(--brown-dark)' }
                }
              >
                {d}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 mt-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--terracotta)' }} />
          <span className="text-[9px]" style={{ color: 'var(--muted-foreground)' }}>Check-in / out</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: '#FEF3C7', border: '1px solid #D97B4F' }} />
          <span className="text-[9px]" style={{ color: 'var(--muted-foreground)' }}>Stay</span>
        </div>
      </div>
    </div>
  )
}

const channelBadge: Record<string, { bg: string; text: string }> = {
  'Airbnb':      { bg: '#FFF0EE', text: '#E24B3B' },
  'Booking.com': { bg: '#EEF4FF', text: '#2563EB' },
  'Direct':      { bg: '#ECFDF5', text: '#059669' },
}

// ── Apple-style toggle switch ─────────────────────────────────────────────────
function AppleToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="relative shrink-0 transition-colors duration-200 focus:outline-none"
      style={{
        width: 42,
        height: 24,
        borderRadius: 12,
        background: on ? '#34C759' : '#E5E5EA',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
      }}
      aria-checked={on}
      role="switch"
    >
      <span
        className="absolute top-0.5 transition-transform duration-200"
        style={{
          left: on ? 'calc(100% - 22px)' : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.20)',
          display: 'block',
        }}
      />
    </button>
  )
}

// ── Urgency badge colors ─────────────────────────────────────────────────────
const urgencyStyle: Record<string, { background: string; color: string }> = {
  immediate:    { background: '#FEE2E2', color: '#DC2626' },
  scheduled:    { background: '#FEF3C7', color: '#D97706' },
  info_request: { background: '#DBEAFE', color: '#2563EB' },
}

// ── Tasks section ────────────────────────────────────────────────────────────
function TasksBox({ conversationId }: { conversationId: string }) {
  const [tasks, setTasks] = useState<ApiTask[]>([])
  const [showCompleted, setShowCompleted] = useState(false)

  useEffect(() => {
    apiGetConversationTasks(conversationId).then(setTasks).catch(() => {})
  }, [conversationId])

  // Listen for SSE new_task events
  useEffect(() => {
    function handler(e: Event) {
      const ce = e as CustomEvent<{ conversationId: string; task: ApiTask }>
      if (ce.detail?.conversationId === conversationId && ce.detail?.task) {
        setTasks(prev => [ce.detail.task, ...prev])
      }
    }
    window.addEventListener('sse:new_task', handler)
    return () => window.removeEventListener('sse:new_task', handler)
  }, [conversationId])

  async function markComplete(id: string) {
    try {
      const updated = await apiUpdateTask(id, { status: 'completed' })
      setTasks(prev => prev.map(t => t.id === id ? updated : t))
    } catch { /* silent */ }
  }

  async function removeTask(id: string) {
    try {
      await apiDeleteTask(id)
      setTasks(prev => prev.filter(t => t.id !== id))
    } catch { /* silent */ }
  }

  const openTasks = tasks.filter(t => t.status !== 'completed')
  const completedTasks = tasks.filter(t => t.status === 'completed')

  if (tasks.length === 0) return null

  return (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid var(--border)', padding: '0.875rem' }}>
      <div className="flex items-center gap-1.5 mb-2.5">
        <ClipboardList size={11} style={{ color: 'var(--muted-foreground)' }} />
        <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--muted-foreground)' }}>
          Tasks ({openTasks.length})
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {openTasks.map(task => (
          <div key={task.id} className="flex items-start gap-2 p-2 rounded-lg" style={{ background: '#FAFAFA', border: '1px solid var(--border)' }}>
            <button
              onClick={() => markComplete(task.id)}
              className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5 transition-colors hover:bg-[#DCFCE7]"
              style={{ border: '1.5px solid var(--border)', background: '#fff' }}
              title="Mark complete"
            >
              <Check size={10} style={{ color: 'var(--muted-foreground)' }} />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--brown-dark)' }}>
                  {task.title}
                </span>
                {task.urgency && (
                  <span
                    className="text-[8px] px-1.5 py-0.5 rounded font-bold uppercase shrink-0"
                    style={urgencyStyle[task.urgency] ?? { background: '#F5F5F5', color: '#555' }}
                  >
                    {task.urgency === 'info_request' ? 'info' : task.urgency}
                  </span>
                )}
              </div>
              {task.note && (
                <p className="text-[10px] leading-snug" style={{ color: 'var(--muted-foreground)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {task.note}
                </p>
              )}
            </div>
            <button
              onClick={() => removeTask(task.id)}
              className="w-5 h-5 flex items-center justify-center shrink-0 rounded-md transition-colors hover:bg-[#FEE2E2]"
              title="Delete task"
            >
              <Trash2 size={10} style={{ color: '#DC2626', opacity: 0.5 }} />
            </button>
          </div>
        ))}

        {completedTasks.length > 0 && (
          <button
            onClick={() => setShowCompleted(v => !v)}
            className="flex items-center gap-1 text-[10px] font-medium py-1"
            style={{ color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <ChevDown size={10} style={{ transform: showCompleted ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
            {showCompleted ? 'Hide' : 'View'} {completedTasks.length} completed task{completedTasks.length > 1 ? 's' : ''}
          </button>
        )}

        {showCompleted && completedTasks.map(task => (
          <div key={task.id} className="flex items-start gap-2 p-2 rounded-lg" style={{ background: '#F9FAFB', border: '1px solid var(--border)', opacity: 0.6 }}>
            <div
              className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5"
              style={{ background: '#DCFCE7', border: '1.5px solid #BBF7D0' }}
            >
              <Check size={10} style={{ color: '#16A34A' }} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[11px] font-medium line-through" style={{ color: 'var(--muted-foreground)' }}>
                {task.title}
              </span>
            </div>
            <button
              onClick={() => removeTask(task.id)}
              className="w-5 h-5 flex items-center justify-center shrink-0 rounded-md transition-colors hover:bg-[#FEE2E2]"
              title="Delete task"
            >
              <Trash2 size={10} style={{ color: '#DC2626', opacity: 0.3 }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BookingPanel({ conversation, aiEnabled, onToggleAI, aiMode, onAiModeChange, onInquiryActioned }: BookingPanelProps) {
  const { booking, guest, aiSummary } = conversation
  const isInquiry = conversation.bookingType === 'Inquiry'
  const [inquiryLoading, setInquiryLoading] = useState<'accept' | 'reject' | null>(null)
  const [inquiryDone, setInquiryDone] = useState<'accept' | 'reject' | null>(null)

  async function handleInquiryAction(action: 'accept' | 'reject') {
    setInquiryLoading(action)
    try {
      await apiInquiryAction(conversation.id, action)
      setInquiryDone(action)
      onInquiryActioned?.(action)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed')
    } finally {
      setInquiryLoading(null)
    }
  }

  const cardStyle = {
    background: '#fff',
    borderRadius: 8,
    border: '1px solid var(--border)',
    padding: '0.875rem',
  }

  const sectionLabel = (text: string) => (
    <p className="text-[9px] font-bold uppercase tracking-widest mb-2.5" style={{ color: 'var(--muted-foreground)' }}>
      {text}
    </p>
  )

  return (
    <aside
      className="flex flex-col gap-2.5 h-full overflow-y-auto p-3"
      style={{ width: 284, minWidth: 284, background: '#F8F8FA', borderLeft: '1px solid var(--border)' }}
    >
      {/* Inquiry Accept/Reject card — only for inquiry reservations */}
      {isInquiry && !inquiryDone && (
        <div style={{ ...cardStyle, border: '1px solid #FDE68A', background: '#FFFBEB' }}>
          {sectionLabel('Inquiry')}
          <p className="text-xs mb-3 leading-relaxed" style={{ color: '#92400E' }}>
            This is a pending inquiry. Accept to confirm the booking or decline to reject it.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleInquiryAction('accept')}
              disabled={!!inquiryLoading}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-opacity"
              style={{ background: '#16A34A', color: '#fff', opacity: inquiryLoading ? 0.6 : 1 }}
            >
              <CheckCircle size={13} />
              {inquiryLoading === 'accept' ? 'Accepting…' : 'Accept'}
            </button>
            <button
              onClick={() => handleInquiryAction('reject')}
              disabled={!!inquiryLoading}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-opacity"
              style={{ background: '#E11D48', color: '#fff', opacity: inquiryLoading ? 0.6 : 1 }}
            >
              <XCircle size={13} />
              {inquiryLoading === 'reject' ? 'Declining…' : 'Decline'}
            </button>
          </div>
        </div>
      )}
      {isInquiry && inquiryDone && (
        <div style={{ ...cardStyle, border: inquiryDone === 'accept' ? '1px solid #BBF7D0' : '1px solid #FECACA', background: inquiryDone === 'accept' ? '#F0FDF4' : '#FEF2F2' }}>
          <p className="text-sm font-semibold text-center" style={{ color: inquiryDone === 'accept' ? '#16A34A' : '#E11D48' }}>
            {inquiryDone === 'accept' ? '✓ Booking Confirmed' : '✗ Inquiry Declined'}
          </p>
        </div>
      )}

      {/* AI Mode Selector */}
      <div style={cardStyle}>
        <div style={{ marginBottom: 8 }}>
          {sectionLabel('AI Mode')}
        </div>
        <div style={{
          display: 'flex',
          background: 'var(--muted)',
          borderRadius: 8,
          padding: 3,
          gap: 2,
        }}>
          {(['off', 'copilot', 'autopilot'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => onAiModeChange?.(mode)}
              style={{
                flex: 1,
                padding: '5px 4px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                background: (aiMode ?? 'autopilot') === mode ? 'var(--terracotta)' : 'transparent',
                color: (aiMode ?? 'autopilot') === mode ? '#fff' : 'var(--muted-foreground)',
                transition: 'all 0.15s ease',
                textTransform: 'capitalize',
              }}
            >
              {mode === 'off' ? 'Off' : mode === 'copilot' ? '✋ Copilot' : '🤖 Auto'}
            </button>
          ))}
        </div>
      </div>

      {/* AI Summary */}
      <div style={{ ...cardStyle, background: '#FFFBEB', border: '1px solid #FDE68A' }}>
        {sectionLabel('AI Summary')}
        <p className="text-xs leading-relaxed" style={{ color: '#78350F' }}>
          {aiSummary}
        </p>
      </div>

      {/* Tasks */}
      <TasksBox conversationId={conversation.id} />

      {/* Guest Details */}
      <div style={cardStyle}>
        {sectionLabel('Guest')}
        <div className="flex items-center gap-2.5 mb-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-bold select-none"
            style={{ background: 'var(--terracotta)' }}
          >
            {guest.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold leading-snug truncate" style={{ color: 'var(--brown-dark)' }}>
              {guest.name}
            </h3>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {guest.email && (
            <a href={`mailto:${guest.email}`} className="flex items-center gap-2 text-xs group" style={{ color: 'var(--brown-dark)' }}>
              <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--muted)' }}>
                <Mail size={10} style={{ color: 'var(--muted-foreground)' }} />
              </span>
              <span className="truncate group-hover:underline">{guest.email}</span>
            </a>
          )}
          {guest.phone && (
            <a href={`tel:${guest.phone}`} className="flex items-center gap-2 text-xs group" style={{ color: 'var(--brown-dark)' }}>
              <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--muted)' }}>
                <Phone size={10} style={{ color: 'var(--muted-foreground)' }} />
              </span>
              <span className="group-hover:underline">{guest.phone}</span>
            </a>
          )}
          {guest.nationality && (
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--brown-dark)' }}>
              <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--muted)' }}>
                <Globe size={10} style={{ color: 'var(--muted-foreground)' }} />
              </span>
              <span>{guest.nationality}</span>
            </div>
          )}
          {!guest.email && !guest.phone && !guest.nationality && (
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>No contact details available</p>
          )}
        </div>
      </div>

      {/* Booking Details */}
      <div style={cardStyle}>
        {sectionLabel('Booking')}
        <div className="flex flex-col gap-2">
          {[
            { label: 'Property', value: booking.property },
            { label: 'Check-in', value: booking.checkIn },
            { label: 'Check-out', value: booking.checkOut },
            { label: 'Guests', value: String(booking.guests) },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between items-center">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
              <span className="text-[11px] font-medium text-right" style={{ color: 'var(--brown-dark)', maxWidth: '55%' }}>{value}</span>
            </div>
          ))}
          <div className="flex justify-between items-center">
            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>Source</span>
            <span
              className="text-[9px] px-2 py-0.5 rounded font-semibold"
              style={{
                background: (channelBadge[booking.source] ?? { bg: '#F5F5F5', text: '#555' }).bg,
                color: (channelBadge[booking.source] ?? { bg: '#F5F5F5', text: '#555' }).text,
              }}
            >
              {booking.source}
            </span>
          </div>
          <a
            href={booking.hostawayUrl}
            className="flex items-center gap-1 text-xs font-medium mt-0.5"
            style={{ color: 'var(--terracotta)' }}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={10} />
            View in Hostaway
          </a>
        </div>
      </div>

      {/* Calendar */}
      <div style={cardStyle}>
        {sectionLabel('Availability')}
        {booking.checkIn && booking.checkOut && parseDate(booking.checkIn) && parseDate(booking.checkOut) ? (
          <MiniCalendar checkIn={booking.checkIn} checkOut={booking.checkOut} property={booking.property} />
        ) : (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>Dates not confirmed yet</p>
        )}
      </div>

      {/* Property Info */}
      <div style={cardStyle}>
        {sectionLabel('Property Info')}
        <div className="flex flex-col gap-2.5">
          {[
            { icon: <MapPin size={10} />, label: 'Address', value: conversation.property.address },
            { icon: <MapPin size={10} />, label: 'Floor', value: conversation.property.floor },
            { icon: <KeyRound size={10} />, label: 'Door Code', value: conversation.property.doorCode, mono: true },
            { icon: <Wifi size={10} />, label: 'Wi-Fi Name', value: conversation.property.wifiName },
            { icon: <Wifi size={10} />, label: 'Wi-Fi Password', value: conversation.property.wifiPassword, mono: true },
            { icon: <Clock size={10} />, label: 'Check-in Time', value: conversation.property.checkInTime },
            { icon: <Clock size={10} />, label: 'Check-out Time', value: conversation.property.checkOutTime },
          { icon: <LogIn size={10} />, label: 'Key Pickup', value: conversation.property.keyPickup },
            { icon: <BookOpen size={10} />, label: 'House Rules', value: conversation.property.houseRules },
            { icon: <Info size={10} />, label: 'Special Instructions', value: conversation.property.specialInstruction },
          ].filter(({ value }) => value && value.trim())
          .map(({ icon, label, value, mono }) => (
            <div key={label} className="flex items-start gap-2">
              <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                {icon}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-[9px] font-semibold uppercase tracking-wider block mb-0.5" style={{ color: 'var(--muted-foreground)' }}>
                  {label}
                </span>
                <span
                  className={`text-[11px] leading-snug break-words ${mono ? 'font-mono' : 'font-medium'}`}
                  style={{ color: 'var(--brown-dark)' }}
                >
                  {value}
                </span>
              </div>
            </div>
          ))}
          {conversation.property.notes && (
            <div className="flex items-start gap-2 pt-1.5" style={{ borderTop: '1px solid var(--border)' }}>
              <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5" style={{ background: '#FEF3C7', color: '#92400E' }}>
                <Info size={10} />
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-[9px] font-semibold uppercase tracking-wider block mb-0.5" style={{ color: '#92400E' }}>
                  Host Note
                </span>
                <span className="text-[11px] leading-snug" style={{ color: 'var(--brown-dark)' }}>
                  {conversation.property.notes}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
