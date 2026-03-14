'use client'

import React, { useState, useRef, useEffect, useCallback, useId } from 'react'
import {
  Search,
  Send,
  Zap,
  ZapOff,
  Globe,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  Plus,
  Wifi,
  Key,
  Clock,
  Users,
  MapPin,
  Mail,
  Phone,
  Tag,
  ClipboardList,
  ListFilter,
  X,
  Circle,
  CircleDashed,
  CircleDotDashed,
  CircleCheck,
  CircleEllipsis,
  CircleX,
  Lock,
  Paperclip,
  ExternalLink,
  ArrowUp,
  LogOut,
  Star,
  CheckCircle,
  GripVertical,
  Languages,
  Archive,
  ArchiveRestore,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  apiGetConversations,
  apiGetConversation,
  apiSendMessage,
  apiToggleAI,
  apiSetAiMode,
  apiSendThroughAI,
  apiApproveSuggestion,
  apiSendNote,
  apiGetConversationTasks,
  apiUpdateTask,
  apiRateMessage,
  apiToggleStar,
  apiResolveConversation,
  mapChannel,
  mapMessageSender,
  formatTimestamp,
  formatDate,
  clearToken,
  type ApiConversationSummary,
  type ApiConversationDetail,
  type ApiMessage,
  type ApiTask,
} from '@/lib/api'
import { OverviewV5 } from '@/components/overview-v5'
import { AnalyticsV5 } from '@/components/analytics-v5'
import { TasksV5 } from '@/components/tasks-v5'
import { SettingsV5 } from '@/components/settings-v5'
import { ConfigureAiV5 } from '@/components/configure-ai-v5'
import { AiLogsV5 } from '@/components/ai-logs-v5'
import { ClassifierV5 } from '@/components/classifier-v5'

// ─── Design Tokens ────────────────────────────────────────────────────────────

const T = {
  bg: { primary: '#FFFFFF', secondary: '#F2F2F2', tertiary: '#E8E8E8' },
  text: { primary: '#0A0A0A', secondary: '#666666', tertiary: '#999999' },
  accent: '#0070F3',
  status: { green: '#30A46C', red: '#E5484D', amber: '#FFB224' },
  border: { default: '#E5E5E5', strong: '#0A0A0A' },
  font: {
    sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
} as const

// ─── Types ────────────────────────────────────────────────────────────────────

type AiMode = 'autopilot' | 'copilot' | 'off'
type Sender = 'guest' | 'host' | 'ai' | 'private'
type Channel = 'airbnb' | 'booking' | 'direct' | 'vrbo' | 'whatsapp'
type InboxTab = 'All' | 'Unread' | 'Starred' | 'Archive'
type NavTab = 'overview' | 'inbox' | 'analytics' | 'tasks' | 'settings' | 'configure' | 'classifier' | 'logs'
type CheckInStatus = 'upcoming' | 'checked-in' | 'checked-out' | 'inquiry' | 'cancelled' | 'checking-in-today'

interface Message {
  id: string
  sender: Sender
  text: string
  time: string
  channel?: Channel
  fromSelf?: boolean
  imageUrls?: string[]
}

interface Guest {
  name: string
  email: string
  phone: string
  nationality: string
}

interface Booking {
  property: string
  checkIn: string
  checkOut: string
  checkInIso: string
  checkOutIso: string
  guests: number
  source: string
  id: string
  nights: number
}

interface Property {
  address: string
  doorCode: string
  wifiName: string
  wifiPassword: string
  checkInTime: string
  checkOutTime: string
}

interface Conversation {
  id: string
  guestName: string
  unitName: string
  channel: Channel
  lastMessage: string
  lastMessageSender: Sender
  timestamp: string
  aiOn: boolean
  aiMode: AiMode
  unreadCount: number
  starred: boolean
  status: 'OPEN' | 'RESOLVED'
  checkInStatus: CheckInStatus
  messages: Message[]
  guest: Guest
  booking: Booking
  property: Property
}

// ─── Data Mapping ─────────────────────────────────────────────────────────────

const channelColors: Record<Channel, string> = {
  airbnb: '#FF5A5F',
  booking: '#003580',
  direct: T.text.secondary,
  vrbo: '#1EB0FF',
  whatsapp: '#25D366',
}

const statusConfig: Record<CheckInStatus, { label: string; color: string }> = {
  upcoming: { label: 'Upcoming', color: '#6E56CF' },
  'checking-in-today': { label: 'Today', color: T.status.amber },
  'checked-in': { label: 'Checked In', color: T.status.green },
  'checked-out': { label: 'Checked Out', color: T.text.tertiary },
  inquiry: { label: 'Inquiry', color: T.accent },
  cancelled: { label: 'Cancelled', color: T.status.red },
}

function channelFromApi(ch: string): Channel {
  const n = ch.toUpperCase()
  if (n === 'AIRBNB') return 'airbnb'
  if (n === 'BOOKING') return 'booking'
  if (n === 'VRBO') return 'vrbo'
  if (n === 'WHATSAPP') return 'whatsapp'
  return 'direct'
}

function checkInStatusFromApi(status: string, checkIn: string): CheckInStatus {
  if (status === 'INQUIRY') return 'inquiry'
  if (status === 'CANCELLED') return 'cancelled'
  if (status === 'CHECKED_IN') return 'checked-in'
  if (status === 'CHECKED_OUT') return 'checked-out'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const ci = new Date(checkIn)
  ci.setHours(0, 0, 0, 0)
  if (ci.getTime() === today.getTime()) return 'checking-in-today'
  return 'upcoming'
}

function senderFromRole(role: string): Sender {
  const s = mapMessageSender(role)
  if (s === 'autopilot') return 'ai'
  if (s === 'private') return 'private'
  return s as Sender
}

function summaryToConversation(s: ApiConversationSummary): Conversation {
  const lastSender: Sender = s.lastMessageRole ? senderFromRole(s.lastMessageRole) : 'guest'
  return {
    id: s.id,
    guestName: s.guestName,
    unitName: s.propertyName,
    channel: channelFromApi(s.channel),
    lastMessage: s.lastMessage || '',
    lastMessageSender: lastSender,
    timestamp: s.lastMessageAt ? formatTimestamp(s.lastMessageAt) : '',
    aiOn: s.aiEnabled,
    aiMode: (s.aiMode as AiMode) || 'autopilot',
    unreadCount: s.unreadCount,
    starred: s.starred ?? false,
    status: (s.status as 'OPEN' | 'RESOLVED') || 'OPEN',
    checkInStatus: checkInStatusFromApi(s.reservationStatus, s.checkIn),
    messages: [],
    guest: { name: s.guestName, email: '', phone: '', nationality: '' },
    booking: {
      property: s.propertyName,
      checkIn: s.checkIn ? formatDate(s.checkIn) : '',
      checkOut: s.checkOut ? formatDate(s.checkOut) : '',
      checkInIso: s.checkIn || '',
      checkOutIso: s.checkOut || '',
      guests: 0,
      source: mapChannel(s.channel),
      id: s.hostawayConversationId || '',
      nights: 0,
    },
    property: {
      address: '',
      doorCode: '',
      wifiName: '',
      wifiPassword: '',
      checkInTime: '',
      checkOutTime: '',
    },
  }
}

function mergeDetail(conv: Conversation, detail: ApiConversationDetail): Conversation {
  const kb = (detail.property?.customKnowledgeBase || {}) as Record<string, string>
  const res = detail.reservation
  const nights =
    res?.checkIn && res?.checkOut
      ? Math.round(
          (new Date(res.checkOut).getTime() - new Date(res.checkIn).getTime()) / 86400000
        )
      : 0
  return {
    ...conv,
    channel: channelFromApi(res?.channel || detail.channel || conv.channel),
    checkInStatus: checkInStatusFromApi(res?.status || '', res?.checkIn || ''),
    status: (detail.status as 'OPEN' | 'RESOLVED') || conv.status,
    aiOn: res?.aiEnabled ?? conv.aiOn,
    aiMode: (res?.aiMode as AiMode) || conv.aiMode,
    messages: (detail.messages || []).flatMap((m: ApiMessage): Message[] => {
      const sender = senderFromRole(m.role)
      const msgChannel = channelFromApi(m.channel || detail.channel || (conv.channel as string))
      const imgs = m.imageUrls && m.imageUrls.length > 0 ? m.imageUrls : undefined
      // Private notes have no channel; AI_PRIVATE and MANAGER_PRIVATE are outgoing (from host side)
      if (sender === 'private') {
        const fromSelf = m.role === 'AI_PRIVATE' || m.role === 'MANAGER_PRIVATE'
        return [{ id: m.id, sender: 'private', text: m.content, time: m.sentAt ? formatTimestamp(m.sentAt) : '', fromSelf, imageUrls: imgs }]
      }
      return [{ id: m.id, sender, text: m.content, time: m.sentAt ? formatTimestamp(m.sentAt) : '', channel: msgChannel, imageUrls: imgs }]
    }),
    guest: {
      name: detail.guest?.name || conv.guest.name,
      email: detail.guest?.email || '',
      phone: detail.guest?.phone || '',
      nationality: detail.guest?.nationality || '',
    },
    booking: {
      ...conv.booking,
      id: res?.id || '',
      property: detail.property?.name || conv.unitName,
      checkIn: res?.checkIn ? formatDate(res.checkIn) : conv.booking.checkIn,
      checkOut: res?.checkOut ? formatDate(res.checkOut) : conv.booking.checkOut,
      checkInIso: res?.checkIn || conv.booking.checkInIso,
      checkOutIso: res?.checkOut || conv.booking.checkOutIso,
      guests: res?.guestCount || 0,
      source: mapChannel(res?.channel || detail.channel || conv.channel),
      nights,
    },
    property: {
      address: detail.property?.address || '',
      doorCode: ((kb.doorCode || kb.door_code || '') as string),
      wifiName: ((kb.wifiName || kb.wifi_name || '') as string),
      wifiPassword: ((kb.wifiPassword || kb.wifi_password || '') as string),
      checkInTime: ((kb.checkInTime || kb.check_in_time || '') as string),
      checkOutTime: ((kb.checkOutTime || kb.check_out_time || '') as string),
    },
  }
}

// ─── Mini Calendar ────────────────────────────────────────────────────────────

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function parseDate(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return null
  return d
}

function MiniCalendar({ checkIn, checkOut }: { checkIn: string; checkOut: string }) {
  const ciDate = parseDate(checkIn)
  const coDate = parseDate(checkOut)

  const initialYear = ciDate ? ciDate.getFullYear() : new Date().getFullYear()
  const initialMonth = ciDate ? ciDate.getMonth() : new Date().getMonth()

  const [year, setYear] = useState(initialYear)
  const [month, setMonth] = useState(initialMonth)

  useEffect(() => {
    const d = parseDate(checkIn)
    if (d) {
      setYear(d.getFullYear())
      setMonth(d.getMonth())
    }
  }, [checkIn])

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1) }
    else setMonth(m => m - 1)
  }

  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1) }
    else setMonth(m => m + 1)
  }

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const ciMidnight = ciDate ? new Date(ciDate.getFullYear(), ciDate.getMonth(), ciDate.getDate()) : null
  const coMidnight = coDate ? new Date(coDate.getFullYear(), coDate.getMonth(), coDate.getDate()) : null

  function getDayStyle(day: number): React.CSSProperties {
    const d = new Date(year, month, day)
    const isCheckIn = ciMidnight && d.getTime() === ciMidnight.getTime()
    const isCheckOut = coMidnight && d.getTime() === coMidnight.getTime()
    const isStay =
      ciMidnight && coMidnight && d > ciMidnight && d < coMidnight

    const base: React.CSSProperties = {
      height: 26,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      borderRadius: 5,
      cursor: 'default',
      fontFamily: T.font.sans,
    }

    if (isCheckIn || isCheckOut) {
      return {
        ...base,
        background: T.text.primary,
        color: '#FFFFFF',
        fontWeight: 700,
      }
    }
    if (isStay) {
      return {
        ...base,
        background: T.accent + '1A',
        color: T.accent,
      }
    }
    return { ...base, color: T.text.primary }
  }

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div style={{ padding: '12px 12px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button
          onClick={prevMonth}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: T.text.tertiary, display: 'flex', alignItems: 'center' }}
        >
          <ChevronLeft size={13} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: T.font.sans, color: T.text.primary }}>
          {MONTHS[month]} {year}
        </span>
        <button
          onClick={nextMonth}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: T.text.tertiary, display: 'flex', alignItems: 'center' }}
        >
          <ChevronRight size={13} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {DAYS.map(d => (
          <div
            key={d}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: T.text.tertiary,
              fontFamily: T.font.sans,
              fontWeight: 500,
              paddingBottom: 2,
            }}
          >
            {d}
          </div>
        ))}
        {cells.map((day, i) => (
          <div key={i} style={day ? getDayStyle(day) : { height: 26 }}>
            {day ?? ''}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Panel Section ─────────────────────────────────────────────────────────────

function PanelSection({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string
  icon: React.ComponentType<{ size?: number; color?: string }>
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div
      style={{
        background: T.bg.primary,
        border: `1px solid ${T.border.default}`,
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 8,
      }}
    >
      <div
        style={{
          background: T.bg.secondary,
          padding: '6px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon size={12} color={T.text.tertiary} />
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: T.text.secondary,
              fontFamily: T.font.sans,
            }}
          >
            {title}
          </span>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

// ─── Data Row ─────────────────────────────────────────────────────────────────

function DataRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string
  value: string
  mono?: boolean
  last?: boolean
}) {
  if (!value) return null
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '7px 12px',
        gap: 8,
        borderBottom: last ? 'none' : `1px solid ${T.border.default}`,
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: T.text.tertiary,
          fontFamily: T.font.sans,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: T.text.primary,
          fontFamily: mono ? T.font.mono : T.font.sans,
          textAlign: 'right',
          wordBreak: 'break-word',
          minWidth: 0,
          flex: 1,
        }}
      >
        {value}
      </span>
    </div>
  )
}

// ─── Apple Toggle ─────────────────────────────────────────────────────────────

function AppleToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={on ? 'AI enabled' : 'AI disabled'}
      style={{
        width: 42,
        height: 24,
        borderRadius: 12,
        background: on ? T.accent : T.bg.tertiary,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 'calc(100% - 22px)' : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.20)',
          transition: 'left 0.2s',
          display: 'block',
        }}
      />
    </button>
  )
}

// ─── Tasks Box ────────────────────────────────────────────────────────────────

function TasksBox({ conversationId, dragHandle }: { conversationId: string; dragHandle?: React.ReactNode }) {
  const [tasks, setTasks] = useState<ApiTask[]>([])

  useEffect(() => {
    apiGetConversationTasks(conversationId).then(setTasks).catch(() => {})
  }, [conversationId])

  async function markComplete(id: string) {
    try {
      const updated = await apiUpdateTask(id, { status: 'completed' })
      setTasks(prev => prev.map(t => (t.id === id ? updated : t)))
    } catch {
      // ignore
    }
  }

  const openTasks = tasks.filter(t => t.status !== 'completed')

  function urgencyDotColor(urgency: string): string {
    if (urgency === 'immediate') return T.status.red
    if (urgency === 'scheduled') return T.status.amber
    return T.text.tertiary
  }

  return (
    <PanelSection
      title="TASKS"
      icon={ClipboardList}
      action={
        dragHandle || (
          <button
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: T.text.tertiary,
              display: 'flex',
              alignItems: 'center',
              padding: 2,
            }}
            aria-label="Add task"
          >
            <Plus size={13} />
          </button>
        )
      }
    >
      {openTasks.length === 0 ? (
        <div
          style={{
            padding: '12px',
            fontSize: 12,
            color: T.text.tertiary,
            fontFamily: T.font.sans,
            textAlign: 'center',
          }}
        >
          No open tasks
        </div>
      ) : (
        openTasks.map((task, i) => (
          <div
            key={task.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: i < openTasks.length - 1 ? `1px solid ${T.border.default}` : 'none',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: urgencyDotColor(task.urgency),
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  color: T.text.primary,
                  fontFamily: T.font.sans,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {task.title}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: T.text.tertiary,
                  fontFamily: T.font.mono,
                  marginTop: 1,
                }}
              >
                {task.urgency}
              </div>
            </div>
            <button
              onClick={() => markComplete(task.id)}
              aria-label="Mark complete"
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                border: `1px solid ${T.border.default}`,
                background: T.bg.primary,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Check size={12} color={T.text.tertiary} />
            </button>
          </div>
        ))
      )}
    </PanelSection>
  )
}

// ─── AI Typing Indicator ──────────────────────────────────────────────────────

const typingKeyframes = `
@keyframes gpDotPulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes channel-pill-in {
  0%   { opacity: 0; transform: scaleY(0.15) scaleX(0.8); filter: blur(8px); }
  45%  { opacity: 1; filter: blur(0px); }
  72%  { transform: scaleY(1.06) scaleX(1.01); }
  100% { opacity: 1; transform: scaleY(1) scaleX(1); filter: blur(0px); }
}
@keyframes channel-pill-out {
  0%   { opacity: 1; transform: scaleY(1) scaleX(1); filter: blur(0px); }
  100% { opacity: 0; transform: scaleY(0.15) scaleX(0.8); filter: blur(6px); }
}
@keyframes channel-icon-in {
  0%   { opacity: 0; transform: scale(0.4); }
  65%  { transform: scale(1.2); }
  100% { opacity: 1; transform: scale(1); }
}
@property --gp-ga {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}
@keyframes gp-gradient-spin {
  to { --gp-ga: 360deg; }
}
@keyframes gp-intel-pulse {
  0%, 100% { opacity: 0.72; }
  50%       { opacity: 1; }
}
@keyframes gp-text-shimmer {
  0%   { background-position: 100% center; }
  100% { background-position: 0% center; }
}
@keyframes gp-skeleton-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
.gp-shine-btn { position: relative; overflow: hidden; }
.gp-shine-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(105deg, transparent 38%, rgba(255,255,255,0.68) 50%, transparent 62%);
  background-size: 220% 100%;
  background-position: 200% 0;
  background-repeat: no-repeat;
  pointer-events: none;
  transition: background-position 0s;
}
.gp-shine-btn.shining::before {
  background-position: -100% 0;
  transition: background-position 0.9s ease;
}
.gp-compose-textarea::placeholder { color: #999; }
.gp-compose-textarea::-webkit-scrollbar { width: 4px; }
.gp-compose-textarea::-webkit-scrollbar-track { background: transparent; }
.gp-compose-textarea::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }
`

// ─── Messages Skeleton ────────────────────────────────────────────────────────

const SKELETON_ROWS: Array<{ side: 'left' | 'right'; lines: number[]; delay: number }> = [
  { side: 'left',  lines: [72, 55],        delay: 0    },
  { side: 'right', lines: [60],            delay: 0.1  },
  { side: 'left',  lines: [80, 68, 45],    delay: 0.2  },
  { side: 'right', lines: [65, 50],        delay: 0.3  },
  { side: 'left',  lines: [50],            delay: 0.4  },
  { side: 'right', lines: [75, 58, 40],    delay: 0.5  },
]

function MessagesSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '8px 16px' }}>
      {SKELETON_ROWS.map((row, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: row.side === 'left' ? 'flex-start' : 'flex-end',
            gap: 6,
          }}
        >
          {/* sender label */}
          <div style={{
            width: 36,
            height: 8,
            borderRadius: 4,
            background: T.bg.tertiary,
            animation: `gp-skeleton-pulse 1.6s ease-in-out ${row.delay}s infinite`,
          }} />
          {/* bubble */}
          <div style={{
            background: row.side === 'left' ? T.bg.secondary : T.accent + '10',
            borderRadius: row.side === 'left' ? '4px 14px 14px 14px' : '14px 4px 14px 14px',
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            minWidth: 120,
            maxWidth: '65%',
            animation: `gp-skeleton-pulse 1.6s ease-in-out ${row.delay}s infinite`,
          }}>
            {row.lines.map((w, j) => (
              <div key={j} style={{
                height: 10,
                width: `${w}%`,
                borderRadius: 5,
                background: row.side === 'left' ? '#D8D8D8' : T.accent + '30',
              }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Text Shimmer ─────────────────────────────────────────────────────────────

function ShimmerText({ text, duration = 1.8, spread = 2 }: { text: string; duration?: number; spread?: number }) {
  const spreadPx = text.length * spread
  return (
    <span
      style={{
        display: 'inline-block',
        backgroundImage: `linear-gradient(90deg, transparent calc(50% - ${spreadPx}px), #111 50%, transparent calc(50% + ${spreadPx}px)), linear-gradient(#a1a1aa, #a1a1aa)`,
        backgroundSize: '250% 100%, auto',
        backgroundRepeat: 'no-repeat',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        animation: `gp-text-shimmer ${duration}s linear infinite`,
      } as React.CSSProperties}
    >
      {text}
    </span>
  )
}

// ─── Apple Intelligence–style Glow Border ─────────────────────────────────────

const INTEL_COLORS_PURPLE = '#BC82F3, #F5B9EA, #8D9FFF, #FF6778, #FFBA71, #C686FF, #BC82F3'
const INTEL_COLORS_GREEN  = '#30A46C, #4ADE80, #86EFAC, #22C55E, #34D399, #A3E635, #30A46C'

// CSS conic-gradient glow border — matches SwiftUI AngularGradient from reference repo.
// Uses CSS mask (content-box XOR border-box) to punch out the interior — fully transparent
// center so text always shows through. Multiple layers at different rotation speeds +
// directions with increasing blur create the organic soft-glow aura.
function IntelligenceGlowBorder({
  active, borderRadius, colors = INTEL_COLORS_PURPLE, compact = false,
}: {
  active: boolean; borderRadius: number; colors?: string; compact?: boolean
}) {
  if (!active) return null

  const colorList = colors.split(',').map(c => c.trim())
  const gradientStr = colorList.join(', ')

  // Modeled after SwiftUI reference: lineWidths=[6,9,11,15], blurs=[0,4,12,15]
  // Inner layer sharp (no blur), outer layers progressively blurred for soft aura.
  // Alternating rotation direction (forward/reverse) for organic interplay.
  const layers = compact
    ? [
        { w: 1.5, blur: 0,  opacity: 0.75, dur: '2.6s', delay: '0s',    dir: 'normal'  },
        { w: 3,   blur: 2,  opacity: 0.4,  dur: '3.4s', delay: '-1.2s', dir: 'reverse' },
        { w: 4.5, blur: 5,  opacity: 0.2,  dur: '4.4s', delay: '-2.8s', dir: 'normal'  },
        { w: 6,   blur: 10, opacity: 0.08, dur: '5.6s', delay: '-3.5s', dir: 'reverse' },
      ]
    : [
        { w: 1.5, blur: 0, opacity: 0.9,  dur: '2.6s', delay: '0s',    dir: 'normal'  },
        { w: 2.5, blur: 0, opacity: 0.35, dur: '3.4s', delay: '-1.2s', dir: 'reverse' },
        { w: 3.5, blur: 0, opacity: 0.15, dur: '4.4s', delay: '-2.8s', dir: 'normal'  },
      ]

  // Compact (AI button): glow extends outside via negative inset (no overflow clipping).
  // Non-compact (banner): glow stays inside element (inset: 0) to avoid overflow clipping;
  // the parent's boxShadow already provides the outer aura.
  return (
    <>
      {layers.map((layer, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            inset: compact ? -(layer.w / 2) : 0,
            borderRadius: compact ? borderRadius + layer.w / 2 : borderRadius,
            padding: layer.w,
            background: `conic-gradient(from var(--gp-ga, 0deg), ${gradientStr})`,
            mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            maskComposite: 'exclude',
            WebkitMaskComposite: 'xor',
            filter: layer.blur > 0 ? `blur(${layer.blur}px)` : undefined,
            opacity: layer.opacity,
            animation: `gp-gradient-spin ${layer.dur} linear infinite ${layer.dir}`,
            animationDelay: layer.delay,
            pointerEvents: 'none',
          } as React.CSSProperties}
        />
      ))}
    </>
  )
}

function TypingIndicator() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '0 16px',
      }}
    >
      <style>{typingKeyframes}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: T.accent + '0D',
          border: `1px solid ${T.border.default}`,
          borderRadius: 8,
          padding: '8px 12px',
        }}
      >
        {[0, 1, 2].map(i => (
          <span
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: T.accent,
              display: 'inline-block',
              animation: `gpDotPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Panel Order Types ────────────────────────────────────────────────────────

type PanelSectionId = 'stay' | 'ai' | 'booking' | 'guest' | 'property' | 'tasks'

const DEFAULT_PANEL_ORDER: PanelSectionId[] = ['stay', 'ai', 'booking', 'guest', 'property', 'tasks']

const PANEL_WIGGLE_DELAYS: Record<PanelSectionId, string> = {
  stay:     '0ms',
  ai:       '40ms',
  booking:  '80ms',
  guest:    '20ms',
  property: '60ms',
  tasks:    '100ms',
}

// ─── Main Component ───────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'

export default function InboxV5() {
  const router = useRouter()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [activeTab, setActiveTab] = useState<InboxTab>('All')
  const [navTab, setNavTab] = useState<NavTab>('inbox')
  const navRef = useRef<HTMLElement>(null)
  const [lampStyle, setLampStyle] = useState({ left: 0, width: 0, ready: false })
  const [searchQuery, setSearchQuery] = useState('')
  const [replyText, setReplyText] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)
  const [sendingViaAI, setSendingViaAI] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [aiTyping, setAiTyping] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null)
  const [translateActive, setTranslateActive] = useState(false)
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false)
  const [filterStep, setFilterStep] = useState<'root' | 'status' | 'aiMode'>('root')
  const [filterSearch, setFilterSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<CheckInStatus | 'all'>('all')
  const [filterAiMode, setFilterAiMode] = useState<AiMode | 'all'>('all')
  const [sendChannelOpen, setSendChannelOpen] = useState(false)
  const [sendChannelClosing, setSendChannelClosing] = useState(false)
  const [sendChannel, setSendChannel] = useState<string>('channel')

  const [messageRatings, setMessageRatings] = useState<Record<string, 'positive' | 'negative'>>({})
  const [imageModalUrl, setImageModalUrl] = useState<string | null>(null)

  // Panel reorder state
  const [panelOrder, setPanelOrder] = useState<PanelSectionId[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('gp-panel-order')
        if (saved) {
          const parsed = JSON.parse(saved) as PanelSectionId[]
          // Ensure all sections present (in case new ones added)
          const complete = [...parsed, ...DEFAULT_PANEL_ORDER.filter(id => !parsed.includes(id))]
          return complete
        }
      } catch { /* ignore */ }
    }
    return DEFAULT_PANEL_ORDER
  })
  const [wiggleMode, setWiggleMode] = useState(false)
  const [draggedSection, setDraggedSection] = useState<PanelSectionId | null>(null)
  const [dragOverSection, setDragOverSection] = useState<PanelSectionId | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const isInitialMsgLoad = useRef(false)
  const fetchedDetails = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef<string>('')
  selectedIdRef.current = selectedId
  const filterAnchorRef = useRef<HTMLDivElement>(null)
  const filterPopoverRef = useRef<HTMLDivElement>(null)
  const composeTextareaRef = useRef<HTMLTextAreaElement>(null)
  const sendChannelAnchorRef = useRef<HTMLDivElement>(null)
  const sendChannelDropdownRef = useRef<HTMLDivElement>(null)

  const selectedConv = conversations.find(c => c.id === selectedId) ?? conversations[0]

  // Glow banner as soon as last message is from guest + AI is on autopilot
  const isAiWaiting = !!(
    selectedConv?.aiOn &&
    selectedConv?.aiMode === 'autopilot' &&
    selectedConv?.lastMessageSender === 'guest'
  )
  const isGlowing = (selectedConv?.aiOn && selectedConv?.aiMode === 'autopilot') || aiTyping || !!aiSuggestion

  // ── Filtered conversations ──
  const filteredConvs = conversations.filter(c => {
    const matchesSearch =
      !searchQuery ||
      c.guestName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.unitName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.lastMessage.toLowerCase().includes(searchQuery.toLowerCase())
    if (!matchesSearch) return false

    if (activeTab === 'Unread' && c.unreadCount === 0) return false
    if (activeTab === 'Starred' && !c.starred) return false
    if (activeTab === 'Archive' && c.status !== 'RESOLVED') return false
    if (activeTab === 'All' && c.status === 'RESOLVED') return false

    if (filterStatus !== 'all' && c.checkInStatus !== filterStatus) return false
    if (filterAiMode !== 'all' && c.aiMode !== filterAiMode) return false

    return true
  })

  const activeFilterCount =
    (filterStatus !== 'all' ? 1 : 0) + (filterAiMode !== 'all' ? 1 : 0)

  // ── Persist panel order to localStorage ──
  useEffect(() => {
    localStorage.setItem('gp-panel-order', JSON.stringify(panelOrder))
  }, [panelOrder])

  // ── Effect 1: Load conversations + poll 30s ──
  useEffect(() => {
    async function load() {
      try {
        const data = await apiGetConversations()
        const mapped = data.map(summaryToConversation)
        setConversations(prev =>
          mapped.map(newConv => {
            const existing = prev.find(p => p.id === newConv.id)
            if (existing && fetchedDetails.current.has(newConv.id)) {
              return {
                ...existing,
                aiOn: newConv.aiOn,
                aiMode: newConv.aiMode,
                lastMessage: newConv.lastMessage,
                lastMessageSender: newConv.lastMessageSender,
                timestamp: newConv.timestamp,
                unreadCount: newConv.unreadCount,
              }
            }
            return newConv
          })
        )
        setSelectedId(prev => prev || (mapped.length > 0 ? mapped[0].id : ''))
      } catch (err) {
        console.error(err)
      } finally {
        setLoadingList(false)
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  // ── Effect 2: Load detail on selection (deduplicated) ──
  useEffect(() => {
    if (!selectedId || fetchedDetails.current.has(selectedId)) return
    setLoadingDetail(true)
    apiGetConversation(selectedId)
      .then(detail => {
        fetchedDetails.current.add(selectedId)
        setConversations(prev =>
          prev.map(c => (c.id === selectedId ? mergeDetail(c, detail) : c))
        )
      })
      .catch(err => console.error(err))
      .finally(() => setLoadingDetail(false))
  }, [selectedId])

  // ── Effect: lamp indicator position ──
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const btn = nav.querySelector<HTMLButtonElement>(`[data-tab="${navTab}"]`)
    if (!btn) return
    const navRect = nav.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    setLampStyle({ left: btnRect.left - navRect.left, width: btnRect.width, ready: true })
  }, [navTab])

  // ── Effect 3: SSE real-time ──
  useEffect(() => {
    const token =
      typeof window !== 'undefined' ? localStorage.getItem('gp_token') : null
    if (!token) return
    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function connect() {
      if (destroyed) return
      es = new EventSource(
        `${API_URL}/api/events?token=${encodeURIComponent(token!)}`
      )
      es.addEventListener('message', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as {
          conversationId?: string
          message?: { role: string; content: string; sentAt: string; channel?: string }
          lastMessageRole?: string
          lastMessageAt?: string
        }
        const convId = data.conversationId
        if (!convId || !data.message) return
        const msg = data.message
        const sender = senderFromRole(data.lastMessageRole || msg.role)

        // If AI message arrived, stop typing indicator and clear suggestion
        if (sender === 'ai' && selectedIdRef.current === convId) {
          setAiTyping(false)
          setAiSuggestion(null)
        }

        const newSseMsgs: Message[] = []
        if (sender === 'private') {
          const fromSelf = msg.role === 'AI_PRIVATE' || msg.role === 'MANAGER_PRIVATE'
          newSseMsgs.push({ id: `sse-${Date.now()}`, sender: 'private', text: msg.content, time: formatTimestamp(msg.sentAt), fromSelf })
        } else {
          const resolved = msg.channel ? channelFromApi(msg.channel) : undefined
          // 'direct' is the catch-all fallback — treat as no channel so conversation channel is used
          const sseChannel = (resolved && resolved !== 'direct') ? resolved : undefined
          newSseMsgs.push({ id: `sse-${Date.now()}`, sender, text: msg.content, time: formatTimestamp(msg.sentAt), channel: sseChannel })
        }
        // Extract visible text for lastMessage preview
        const previewText = newSseMsgs[0]?.text || msg.content

        setConversations(prev =>
          prev.map(c => {
            if (c.id !== convId) return c
            const isSelected = selectedIdRef.current === convId

            // Guest message on autopilot → show typing indicator
            if (sender === 'guest' && isSelected && c.aiOn && c.aiMode === 'autopilot') {
              setAiTyping(true)
            }

            const msgsWithChannel = newSseMsgs.map(m => m.channel === undefined ? { ...m, channel: c.channel } : m)
            const updatedMsgs = isSelected
              ? [...c.messages, ...msgsWithChannel]
              : c.messages
            return {
              ...c,
              messages: updatedMsgs,
              lastMessage: previewText,
              lastMessageSender: sender,
              timestamp: formatTimestamp(data.lastMessageAt || msg.sentAt),
              unreadCount: isSelected ? 0 : c.unreadCount + 1,
            }
          })
        )
        if (selectedIdRef.current === convId) {
          setTimeout(
            () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
            50
          )
        }
      })
      // Copilot: AI generated a suggestion for host approval
      es.addEventListener('ai_suggestion', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as { conversationId: string; suggestion: string }
        if (data.conversationId === selectedIdRef.current) {
          setAiTyping(false)
          setAiSuggestion(data.suggestion)
        }
      })

      // AI decided not to send (empty message) — clear typing
      es.addEventListener('ai_typing_clear', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as { conversationId: string }
        if (data.conversationId === selectedIdRef.current) {
          setAiTyping(false)
        }
      })

      es.onerror = () => {
        if (destroyed) return
        es?.close()
        es = null
        reconnectTimer = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
    }
  }, [])

  // ── Effect 4: Mark initial load on conversation change ──
  useEffect(() => {
    isInitialMsgLoad.current = true
    // Reset scroll position immediately so the container doesn't flash mid-way
    if (messagesScrollRef.current) messagesScrollRef.current.scrollTop = 0
  }, [selectedId])

  // ── Effect 4b: Sync send channel to conversation's channel ──
  useEffect(() => {
    if (!selectedConv) return
    setSendChannel(selectedConv.channel === 'whatsapp' ? 'whatsapp' : 'channel')
  }, [selectedId])

  // ── Effect 5: Scroll on new messages ──
  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el) return
    if (isInitialMsgLoad.current) {
      // Initial load — jump instantly to bottom with no animation
      el.scrollTop = el.scrollHeight
      isInitialMsgLoad.current = false
    } else {
      // New message arrived — smooth scroll
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [selectedConv?.messages.length])

  // ── Effect 6: Filter popover click-outside ──
  useEffect(() => {
    if (!filterPopoverOpen) return
    function handler(e: MouseEvent) {
      if (filterAnchorRef.current?.contains(e.target as Node)) return
      if (filterPopoverRef.current?.contains(e.target as Node)) return
      setFilterPopoverOpen(false)
      setFilterStep('root')
      setFilterSearch('')
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterPopoverOpen])

  // ── Effect 7: Send channel dropdown click-outside ──
  useEffect(() => {
    if (!sendChannelOpen) return
    function handler(e: MouseEvent) {
      if (sendChannelAnchorRef.current?.contains(e.target as Node)) return
      if (sendChannelDropdownRef.current?.contains(e.target as Node)) return
      closeSendChannel()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sendChannelOpen])

  // ── Auto-resize textarea ──
  function handleComposeChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setReplyText(e.target.value)
    const el = e.currentTarget
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  // ── Actions ──
  const selectConversation = useCallback(async (id: string) => {
    setSelectedId(id)
    setConversations(prev =>
      prev.map(c => (c.id === id ? { ...c, unreadCount: 0 } : c))
    )
  }, [])

  function resetTextarea() {
    setReplyText('')
    if (composeTextareaRef.current) composeTextareaRef.current.style.height = 'auto'
  }

  async function sendReply() {
    if (!replyText.trim() || !selectedConv || sendingMessage) return
    setSendingMessage(true)
    const text = replyText.trim()
    const channelOverride = sendChannel !== 'channel' ? sendChannel : undefined
    resetTextarea()
    try {
      const msg = await apiSendMessage(selectedConv.id, text, channelOverride)
      const newMsg: Message = {
        id: msg.id,
        sender: 'host',
        text,
        time: formatTimestamp(msg.sentAt),
      }
      setConversations(prev =>
        prev.map(c =>
          c.id === selectedConv.id
            ? {
                ...c,
                messages: [...c.messages, newMsg],
                lastMessage: text,
                lastMessageSender: 'host',
                timestamp: formatTimestamp(msg.sentAt),
              }
            : c
        )
      )
      setTimeout(
        () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
        50
      )
    } catch (err) {
      console.error(err)
    } finally {
      setSendingMessage(false)
    }
  }

  async function sendViaAI() {
    if (!replyText.trim() || !selectedConv || sendingViaAI) return
    setSendingViaAI(true)
    const text = replyText.trim()
    resetTextarea()
    setAiTyping(true)
    try {
      const msg = await apiSendThroughAI(selectedConv.id, text)
      setAiTyping(false)
      const newMsg: Message = {
        id: msg.id,
        sender: 'ai',
        text: msg.content || text,
        time: formatTimestamp(msg.sentAt),
      }
      setConversations(prev =>
        prev.map(c =>
          c.id === selectedConv.id
            ? {
                ...c,
                messages: [...c.messages, newMsg],
                lastMessage: newMsg.text,
                lastMessageSender: 'ai',
                timestamp: formatTimestamp(msg.sentAt),
              }
            : c
        )
      )
      setTimeout(
        () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
        50
      )
    } catch (err) {
      console.error(err)
      setAiTyping(false)
    } finally {
      setSendingViaAI(false)
    }
  }

  function closeSendChannel() {
    setSendChannelClosing(true)
    setTimeout(() => { setSendChannelOpen(false); setSendChannelClosing(false) }, 200)
  }

  async function sendPrivate() {
    if (!replyText.trim() || !selectedConv) return
    const text = replyText.trim()
    resetTextarea()
    const tempId = `private-${Date.now()}`
    const newMsg: Message = {
      id: tempId,
      sender: 'private',
      text,
      time: formatTimestamp(new Date().toISOString()),
      fromSelf: true,
    }
    setConversations(prev =>
      prev.map(c =>
        c.id === selectedConv.id ? { ...c, messages: [...c.messages, newMsg] } : c
      )
    )
    setTimeout(
      () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
      50
    )
    try {
      const saved = await apiSendNote(selectedConv.id, text)
      // Replace temp id with real db id
      setConversations(prev =>
        prev.map(c =>
          c.id === selectedConv.id
            ? { ...c, messages: c.messages.map(m => m.id === tempId ? { ...m, id: saved.id } : m) }
            : c
        )
      )
    } catch (e) {
      console.error('[Note] Failed to persist private note:', e)
    }
  }

  async function toggleAI() {
    if (!selectedConv) return
    const newVal = !selectedConv.aiOn
    setConversations(prev =>
      prev.map(c => (c.id === selectedConv.id ? { ...c, aiOn: newVal } : c))
    )
    try {
      await apiToggleAI(selectedConv.id, newVal)
    } catch {
      setConversations(prev =>
        prev.map(c => (c.id === selectedConv.id ? { ...c, aiOn: !newVal } : c))
      )
    }
  }

  async function changeAiMode(mode: AiMode) {
    if (!selectedConv) return
    const prevMode = selectedConv.aiMode
    const prevAiOn = selectedConv.aiOn
    const newAiOn = mode !== 'off'
    setConversations(prev =>
      prev.map(c =>
        c.id === selectedConv.id
          ? { ...c, aiMode: mode, aiOn: newAiOn }
          : c
      )
    )
    try {
      await Promise.all([
        apiSetAiMode(selectedConv.id, mode),
        apiToggleAI(selectedConv.id, newAiOn),
      ])
    } catch {
      setConversations(prev =>
        prev.map(c => (c.id === selectedConv.id ? { ...c, aiMode: prevMode, aiOn: prevAiOn } : c))
      )
    }
  }

  async function toggleStar(convId: string) {
    const conv = conversations.find(c => c.id === convId)
    if (!conv) return
    const newVal = !conv.starred
    setConversations(prev =>
      prev.map(c => (c.id === convId ? { ...c, starred: newVal } : c))
    )
    try {
      await apiToggleStar(convId, newVal)
    } catch {
      setConversations(prev =>
        prev.map(c => (c.id === convId ? { ...c, starred: !newVal } : c))
      )
    }
  }

  async function resolveConversation() {
    if (!selectedConv) return
    const newStatus = selectedConv.status === 'RESOLVED' ? 'OPEN' : 'RESOLVED'
    setConversations(prev =>
      prev.map(c => (c.id === selectedConv.id ? { ...c, status: newStatus } : c))
    )
    try {
      await apiResolveConversation(selectedConv.id, newStatus)
    } catch {
      const revertStatus = newStatus === 'RESOLVED' ? 'OPEN' : 'RESOLVED'
      setConversations(prev =>
        prev.map(c => (c.id === selectedConv.id ? { ...c, status: revertStatus } : c))
      )
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      sendReply()
    }
  }

  function handleLogOut() {
    clearToken()
    router.push('/login')
  }

  // ── Panel reorder drag-and-drop ──────────────────────────────────────────────

  function handlePanelDrop(targetId: PanelSectionId) {
    if (!draggedSection || draggedSection === targetId) return
    setPanelOrder(prev => {
      const next = [...prev]
      const fromIdx = next.indexOf(draggedSection)
      const toIdx = next.indexOf(targetId)
      next.splice(fromIdx, 1)
      next.splice(toIdx, 0, draggedSection)
      return next
    })
    setDraggedSection(null)
    setDragOverSection(null)
  }

  function wrapPanelSection(id: PanelSectionId, content: React.ReactNode) {
    if (!wiggleMode) return <React.Fragment key={id}>{content}</React.Fragment>
    return (
      <div
        key={id}
        className={`gp-wiggle-item${dragOverSection === id ? ' gp-panel-drag-over' : ''}`}
        style={{
          animationDelay: PANEL_WIGGLE_DELAYS[id],
          opacity: draggedSection === id ? 0.45 : 1,
          transition: 'opacity 0.15s',
          position: 'relative',
        }}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDraggedSection(id) }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverSection(id) }}
        onDragLeave={() => setDragOverSection(null)}
        onDrop={(e) => { e.preventDefault(); handlePanelDrop(id) }}
        onDragEnd={() => { setDraggedSection(null); setDragOverSection(null) }}
      >
        {content}
      </div>
    )
  }

  function renderPanelSection(id: PanelSectionId) {
    if (!selectedConv) return null
    const dragHandle = wiggleMode ? (
      <GripVertical size={12} color={T.text.tertiary} style={{ cursor: 'grab', flexShrink: 0 }} />
    ) : null

    switch (id) {
      case 'stay':
        return wrapPanelSection('stay', (
          <div
            style={{
              background: T.bg.primary,
              border: `1px solid ${T.border.default}`,
              borderRadius: 8,
              overflow: 'hidden',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                background: T.bg.secondary,
                padding: '6px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {dragHandle}
              <Tag size={12} color={T.text.tertiary} />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: T.text.secondary,
                  fontFamily: T.font.sans,
                }}
              >
                STAY
              </span>
            </div>
            <MiniCalendar
              checkIn={selectedConv.booking.checkInIso}
              checkOut={selectedConv.booking.checkOutIso}
            />
          </div>
        ))

      case 'ai':
        return wrapPanelSection('ai', (
          <PanelSection title="AI MODE" icon={Zap} action={dragHandle}>
            <div style={{ padding: 12 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500, color: T.text.primary }}>
                  AI Enabled
                </span>
                <AppleToggle on={selectedConv.aiOn} onToggle={wiggleMode ? () => {} : toggleAI} />
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['autopilot', 'copilot', 'off'] as AiMode[]).map(mode => {
                  const isActive = selectedConv.aiMode === mode && selectedConv.aiOn
                  const isOff = mode === 'off' && !selectedConv.aiOn
                  const selected = isActive || isOff
                  return (
                    <button
                      key={mode}
                      onClick={e => {
                        if (wiggleMode) return
                        changeAiMode(mode)
                        const btn = e.currentTarget
                        btn.classList.add('shining')
                        setTimeout(() => btn.classList.remove('shining'), 900)
                      }}
                      className="gp-shine-btn"
                      style={{
                        flex: 1,
                        padding: '5px 0',
                        fontSize: 11,
                        fontFamily: T.font.mono,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        cursor: wiggleMode ? 'grab' : 'pointer',
                        borderRadius: 5,
                        border: selected ? 'none' : `1px solid ${T.border.default}`,
                        background: selected ? T.text.primary : 'transparent',
                        color: selected ? '#FFFFFF' : T.text.secondary,
                        transition: 'all 0.15s',
                      }}
                    >
                      {mode === 'autopilot' ? 'AUTOPILOT' : mode === 'copilot' ? 'COPILOT' : 'OFF'}
                    </button>
                  )
                })}
              </div>
            </div>
          </PanelSection>
        ))

      case 'booking':
        return wrapPanelSection('booking', (
          <PanelSection title="BOOKING" icon={Tag} action={dragHandle}>
            <DataRow label="Check-in" value={selectedConv.booking.checkIn} />
            <DataRow label="Check-out" value={selectedConv.booking.checkOut} />
            <DataRow label="Nights" value={selectedConv.booking.nights ? String(selectedConv.booking.nights) : ''} />
            <DataRow label="Guests" value={selectedConv.booking.guests ? String(selectedConv.booking.guests) : ''} />
            <DataRow label="Source" value={selectedConv.booking.source} />
            <DataRow label="ID" value={selectedConv.booking.id} mono last />
          </PanelSection>
        ))

      case 'guest':
        return wrapPanelSection('guest', (
          <PanelSection title="GUEST" icon={Users} action={dragHandle}>
            <DataRow label="Name" value={selectedConv.guest.name || '—'} />
            <DataRow label="Email" value={selectedConv.guest.email || '—'} />
            <DataRow label="Phone" value={selectedConv.guest.phone || '—'} />
            <DataRow label="Nationality" value={selectedConv.guest.nationality || '—'} last />
          </PanelSection>
        ))

      case 'property':
        return wrapPanelSection('property', (
          <PanelSection title="PROPERTY" icon={MapPin} action={dragHandle}>
            <DataRow label="Address" value={selectedConv.property.address} />
            <DataRow label="Door Code" value={selectedConv.property.doorCode} mono />
            <DataRow label="Wi-Fi Network" value={selectedConv.property.wifiName} mono />
            <DataRow label="Wi-Fi Password" value={selectedConv.property.wifiPassword} mono />
            <DataRow label="Check-in Time" value={selectedConv.property.checkInTime} />
            <DataRow label="Check-out Time" value={selectedConv.property.checkOutTime} last />
          </PanelSection>
        ))

      case 'tasks':
        return wrapPanelSection('tasks', (
          <div style={{ pointerEvents: wiggleMode ? 'none' : 'auto' }}>
            <TasksBox key={selectedConv.id} conversationId={selectedConv.id} dragHandle={dragHandle} />
          </div>
        ))

      default:
        return null
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: T.bg.primary,
        fontFamily: T.font.sans,
        color: T.text.primary,
        overflow: 'hidden',
      }}
    >
      <style>{typingKeyframes}</style>
      {/* ── Top Bar ── */}
      <header
        style={{
          height: 52,
          minHeight: 52,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          borderBottom: `1px solid ${T.border.default}`,
          background: T.bg.primary,
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              background: T.text.primary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#FFFFFF',
                fontFamily: T.font.sans,
                lineHeight: 1,
              }}
            >
              GP
            </span>
          </div>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text.primary }}>
            GuestPilot
          </span>
        </div>

        {/* LogOut */}
        <button
          onClick={handleLogOut}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: 6,
            color: T.text.tertiary,
          }}
          title="Log out"
        >
          <LogOut size={15} />
        </button>

      </header>

      {/* ── Tab Strip ── */}
      <nav
        ref={navRef}
        style={{
          height: 40,
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 12px',
          borderBottom: `1px solid ${T.border.default}`,
          background: T.bg.primary,
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'inbox', label: 'Inbox' },
            { id: 'analytics', label: 'Analytics' },
            { id: 'tasks', label: 'Tasks' },
            { id: 'settings', label: 'Settings' },
            { id: 'configure', label: 'Configure AI' },
            { id: 'classifier', label: 'Classifier' },
            { id: 'logs', label: 'AI Logs' },
          ] as { id: NavTab; label: string }[]
        ).map(tab => (
          <button
            key={tab.id}
            data-tab={tab.id}
            onClick={() => setNavTab(tab.id)}
            style={{
              height: 28,
              padding: '0 14px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 5,
              border: 'none',
              cursor: 'pointer',
              background: navTab === tab.id ? T.border.strong : 'transparent',
              color: navTab === tab.id ? '#FFFFFF' : T.text.secondary,
              transition: 'background 120ms',
              fontFamily: T.font.sans,
              position: 'relative',
              zIndex: 1,
            }}
          >
            {tab.label}
          </button>
        ))}

        {/* Lamp indicator */}
        {lampStyle.ready && (
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: lampStyle.left,
            width: lampStyle.width,
            transition: 'left 0.35s cubic-bezier(0.34,1.56,0.64,1), width 0.35s cubic-bezier(0.34,1.56,0.64,1)',
            pointerEvents: 'none',
          }}>
            {/* Bar */}
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 28,
              height: 2,
              background: T.text.primary,
              borderRadius: '2px 2px 0 0',
            }} />
            {/* Outer glow */}
            <div style={{
              position: 'absolute',
              bottom: -4,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 52,
              height: 18,
              background: T.text.primary + '18',
              borderRadius: '50%',
              filter: 'blur(10px)',
            }} />
            {/* Inner glow */}
            <div style={{
              position: 'absolute',
              bottom: -1,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 32,
              height: 10,
              background: T.text.primary + '22',
              borderRadius: '50%',
              filter: 'blur(5px)',
            }} />
          </div>
        )}
      </nav>

      {/* ── Page Content ── */}
      {navTab === 'inbox' && (
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Conversation List ── */}
        <aside
          style={{
            width: 280,
            minWidth: 280,
            borderRight: `1px solid ${T.border.default}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: T.bg.primary,
          }}
        >
          {/* Search + Filter */}
          <div style={{ padding: '10px 12px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* Search bar */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: T.bg.secondary,
                  borderRadius: 6,
                  padding: '0 10px',
                  height: 36,
                }}
              >
                <Search size={13} color={T.text.tertiary} />
                <input
                  type="text"
                  placeholder="Search conversations"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    fontSize: 13,
                    color: T.text.primary,
                    fontFamily: T.font.sans,
                  }}
                />
              </div>

              {/* Filter button + popover anchor */}
              <div ref={filterAnchorRef} style={{ position: 'relative', flexShrink: 0 }}>
                <button
                  onClick={() => {
                    setFilterPopoverOpen(v => !v)
                    if (!filterPopoverOpen) { setFilterStep('root'); setFilterSearch('') }
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 6,
                    border: `1px solid ${activeFilterCount > 0 ? T.accent : T.border.default}`,
                    background: activeFilterCount > 0 ? T.accent + '0E' : T.bg.secondary,
                    color: activeFilterCount > 0 ? T.accent : T.text.secondary,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    position: 'relative',
                    transition: 'all 0.1s',
                  }}
                  title="Filter"
                >
                  <ListFilter size={14} />
                  {activeFilterCount > 0 && (
                    <span
                      style={{
                        position: 'absolute',
                        top: -4,
                        right: -4,
                        width: 14,
                        height: 14,
                        borderRadius: 999,
                        background: T.accent,
                        color: '#fff',
                        fontSize: 9,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {activeFilterCount}
                    </span>
                  )}
                </button>

                {/* Popover */}
                {filterPopoverOpen && (
                  <div
                    ref={filterPopoverRef}
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 6px)',
                      right: 0,
                      background: '#fff',
                      border: `1px solid ${T.border.default}`,
                      borderRadius: 8,
                      boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
                      width: 220,
                      zIndex: 200,
                      overflow: 'hidden',
                    }}
                  >
                    {/* Search row inside popover */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        borderBottom: `1px solid ${T.border.default}`,
                      }}
                    >
                      {filterStep !== 'root' ? (
                        <button
                          onClick={() => { setFilterStep('root'); setFilterSearch('') }}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center',
                            color: T.text.tertiary,
                            flexShrink: 0,
                          }}
                        >
                          <ChevronLeft size={14} />
                        </button>
                      ) : (
                        <Search size={13} color={T.text.tertiary} style={{ flexShrink: 0 }} />
                      )}
                      <input
                        autoFocus
                        type="text"
                        placeholder={filterStep === 'root' ? 'Filter...' : filterStep === 'status' ? 'Search status...' : 'Search mode...'}
                        value={filterSearch}
                        onChange={e => setFilterSearch(e.target.value)}
                        style={{
                          flex: 1,
                          border: 'none',
                          outline: 'none',
                          fontSize: 13,
                          color: T.text.primary,
                          fontFamily: T.font.sans,
                          background: 'transparent',
                        }}
                      />
                    </div>

                    {/* Root: category list */}
                    {filterStep === 'root' && (
                      <div>
                        {[
                          { key: 'status' as const, label: 'Booking Status', icon: <CircleDashed size={14} color={T.text.secondary} />, active: filterStatus !== 'all' },
                          { key: 'aiMode' as const, label: 'AI Mode', icon: <Zap size={14} color={T.text.secondary} />, active: filterAiMode !== 'all' },
                        ]
                          .filter(c => !filterSearch || c.label.toLowerCase().includes(filterSearch.toLowerCase()))
                          .map((cat, i, arr) => (
                            <button
                              key={cat.key}
                              onClick={() => { setFilterStep(cat.key); setFilterSearch('') }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                width: '100%',
                                padding: '9px 12px',
                                gap: 10,
                                background: 'transparent',
                                border: 'none',
                                borderBottom: i < arr.length - 1 ? `1px solid ${T.border.default}` : 'none',
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => (e.currentTarget.style.background = T.bg.secondary)}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                {cat.icon}
                                <span style={{ fontSize: 13, color: T.text.primary, fontFamily: T.font.sans }}>{cat.label}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {cat.active && (
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.accent, display: 'inline-block' }} />
                                )}
                                <ChevronRight size={13} color={T.text.tertiary} />
                              </div>
                            </button>
                          ))
                        }
                      </div>
                    )}

                    {/* Status options */}
                    {filterStep === 'status' && (
                      <div>
                        {(
                          [
                            { key: 'all' as const,                label: 'All',         icon: <Circle size={13} color={T.text.tertiary} /> },
                            { key: 'upcoming' as const,           label: 'Upcoming',    icon: <Circle size={13} color={T.text.secondary} /> },
                            { key: 'checking-in-today' as const,  label: 'Today',       icon: <CircleDotDashed size={13} color={T.status.amber} /> },
                            { key: 'checked-in' as const,         label: 'Checked In',  icon: <CircleCheck size={13} color={T.status.green} /> },
                            { key: 'checked-out' as const,        label: 'Checked Out', icon: <CircleX size={13} color={T.text.tertiary} /> },
                            { key: 'inquiry' as const,            label: 'Inquiry',     icon: <CircleEllipsis size={13} color={T.accent} /> },
                            { key: 'cancelled' as const,          label: 'Cancelled',   icon: <CircleX size={13} color={T.status.red} /> },
                          ] as { key: CheckInStatus | 'all'; label: string; icon: React.ReactNode }[]
                        )
                          .filter(o => !filterSearch || o.label.toLowerCase().includes(filterSearch.toLowerCase()))
                          .map((opt, i, arr) => (
                            <button
                              key={opt.key}
                              onClick={() => {
                                setFilterStatus(opt.key)
                                setFilterPopoverOpen(false)
                                setFilterStep('root')
                                setFilterSearch('')
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                width: '100%',
                                padding: '9px 12px',
                                gap: 10,
                                background: filterStatus === opt.key ? T.bg.secondary : 'transparent',
                                border: 'none',
                                borderBottom: i < arr.length - 1 ? `1px solid ${T.border.default}` : 'none',
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => (e.currentTarget.style.background = T.bg.secondary)}
                              onMouseLeave={e => (e.currentTarget.style.background = filterStatus === opt.key ? T.bg.secondary : 'transparent')}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                {opt.icon}
                                <span style={{ fontSize: 13, color: T.text.primary, fontFamily: T.font.sans }}>{opt.label}</span>
                              </div>
                              {filterStatus === opt.key && <Check size={13} color={T.accent} />}
                            </button>
                          ))
                        }
                      </div>
                    )}

                    {/* AI mode options */}
                    {filterStep === 'aiMode' && (
                      <div>
                        {(
                          [
                            { key: 'all' as const,        label: 'All',       icon: <Circle size={13} color={T.text.tertiary} /> },
                            { key: 'autopilot' as const,  label: 'Autopilot', icon: <Zap size={13} color={T.accent} /> },
                            { key: 'copilot' as const,    label: 'Copilot',   icon: <Zap size={13} color={T.status.green} /> },
                            { key: 'off' as const,        label: 'Off',       icon: <ZapOff size={13} color={T.text.tertiary} /> },
                          ] as { key: AiMode | 'all'; label: string; icon: React.ReactNode }[]
                        )
                          .filter(o => !filterSearch || o.label.toLowerCase().includes(filterSearch.toLowerCase()))
                          .map((opt, i, arr) => (
                            <button
                              key={opt.key}
                              onClick={() => {
                                setFilterAiMode(opt.key)
                                setFilterPopoverOpen(false)
                                setFilterStep('root')
                                setFilterSearch('')
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                width: '100%',
                                padding: '9px 12px',
                                gap: 10,
                                background: filterAiMode === opt.key ? T.bg.secondary : 'transparent',
                                border: 'none',
                                borderBottom: i < arr.length - 1 ? `1px solid ${T.border.default}` : 'none',
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => (e.currentTarget.style.background = T.bg.secondary)}
                              onMouseLeave={e => (e.currentTarget.style.background = filterAiMode === opt.key ? T.bg.secondary : 'transparent')}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                {opt.icon}
                                <span style={{ fontSize: 13, color: T.text.primary, fontFamily: T.font.sans }}>{opt.label}</span>
                              </div>
                              {filterAiMode === opt.key && <Check size={13} color={T.accent} />}
                            </button>
                          ))
                        }
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Active filter chips */}
            {activeFilterCount > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                {filterStatus !== 'all' && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      background: T.bg.secondary,
                      border: `1px solid ${T.border.default}`,
                      borderRadius: 4,
                      fontSize: 12,
                      overflow: 'hidden',
                      height: 24,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', borderRight: `1px solid ${T.border.default}`, height: '100%', color: T.text.secondary, fontFamily: T.font.sans }}>
                      <CircleDashed size={11} />
                      Status
                    </span>
                    <span style={{ padding: '0 6px', color: T.text.tertiary, borderRight: `1px solid ${T.border.default}`, height: '100%', display: 'flex', alignItems: 'center', fontFamily: T.font.sans, fontSize: 11 }}>is</span>
                    <span style={{ padding: '0 8px', color: T.text.primary, fontWeight: 500, height: '100%', display: 'flex', alignItems: 'center', borderRight: `1px solid ${T.border.default}`, fontFamily: T.font.sans }}>
                      {statusConfig[filterStatus].label}
                    </span>
                    <button onClick={() => setFilterStatus('all')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px', color: T.text.tertiary, height: '100%', display: 'flex', alignItems: 'center' }}>
                      <X size={11} />
                    </button>
                  </div>
                )}
                {filterAiMode !== 'all' && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      background: T.bg.secondary,
                      border: `1px solid ${T.border.default}`,
                      borderRadius: 4,
                      fontSize: 12,
                      overflow: 'hidden',
                      height: 24,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', borderRight: `1px solid ${T.border.default}`, height: '100%', color: T.text.secondary, fontFamily: T.font.sans }}>
                      <Zap size={11} />
                      AI Mode
                    </span>
                    <span style={{ padding: '0 6px', color: T.text.tertiary, borderRight: `1px solid ${T.border.default}`, height: '100%', display: 'flex', alignItems: 'center', fontFamily: T.font.sans, fontSize: 11 }}>is</span>
                    <span style={{ padding: '0 8px', color: T.text.primary, fontWeight: 500, height: '100%', display: 'flex', alignItems: 'center', borderRight: `1px solid ${T.border.default}`, fontFamily: T.font.sans, textTransform: 'capitalize' }}>
                      {filterAiMode}
                    </span>
                    <button onClick={() => setFilterAiMode('all')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px', color: T.text.tertiary, height: '100%', display: 'flex', alignItems: 'center' }}>
                      <X size={11} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tabs */}
          <div
            style={{
              display: 'flex',
              borderBottom: `1px solid ${T.border.default}`,
              padding: '0 12px',
            }}
          >
            {(['All', 'Unread', 'Starred', 'Archive'] as InboxTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '6px 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: T.font.sans,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: activeTab === tab ? T.accent : T.text.secondary,
                  borderBottom:
                    activeTab === tab
                      ? `2px solid ${T.accent}`
                      : '2px solid transparent',
                  marginBottom: -1,
                  transition: 'color 0.15s',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loadingList ? (
              <div
                style={{
                  padding: 20,
                  textAlign: 'center',
                  fontSize: 12,
                  color: T.text.tertiary,
                }}
              >
                Loading…
              </div>
            ) : filteredConvs.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  textAlign: 'center',
                  fontSize: 12,
                  color: T.text.tertiary,
                }}
              >
                No conversations
              </div>
            ) : (
              filteredConvs.map(conv => {
                const isSelected = conv.id === selectedConv?.id
                const sc = statusConfig[conv.checkInStatus]
                const lastPrefix =
                  conv.lastMessageSender === 'host' || conv.lastMessageSender === 'ai'
                    ? 'You: '
                    : ''

                return (
                  <div
                    key={conv.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectConversation(conv.id)}
                    onKeyDown={e => e.key === 'Enter' && selectConversation(conv.id)}
                    style={{
                      padding: '10px 12px',
                      cursor: 'pointer',
                      background: isSelected ? T.bg.secondary : T.bg.primary,
                      borderLeft: isSelected
                        ? `2px solid ${T.accent}`
                        : '2px solid transparent',
                      borderBottom: `1px solid ${T.border.default}`,
                      outline: 'none',
                      transition: 'background 0.1s',
                    }}
                  >
                    {/* Row 1: channel dot + name + timestamp + unread */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginBottom: 2,
                      }}
                    >
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: channelColors[conv.channel],
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          fontSize: 13,
                          fontWeight: conv.unreadCount > 0 ? 700 : 500,
                          color: T.text.primary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {conv.guestName}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: T.text.tertiary,
                          fontFamily: T.font.mono,
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        {conv.timestamp}
                      </span>
                      {conv.unreadCount > 0 && (
                        <span
                          style={{
                            background: T.accent,
                            color: '#fff',
                            borderRadius: 999,
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '1px 5px',
                            flexShrink: 0,
                          }}
                        >
                          {conv.unreadCount}
                        </span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleStar(conv.id) }}
                        aria-label={conv.starred ? 'Unstar conversation' : 'Star conversation'}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 2,
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                          color: conv.starred ? T.status.amber : T.text.tertiary,
                          opacity: conv.starred ? 1 : 0.4,
                          transition: 'color 0.15s, opacity 0.15s',
                        }}
                      >
                        <Star size={13} fill={conv.starred ? T.status.amber : 'none'} />
                      </button>
                    </div>

                    {/* Row 2: unit name */}
                    <div
                      style={{
                        fontSize: 12,
                        color: T.text.tertiary,
                        marginBottom: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {conv.unitName}
                    </div>

                    {/* Row 3: last message */}
                    <div
                      style={{
                        fontSize: 12,
                        color: T.text.secondary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ color: T.text.tertiary }}>{lastPrefix}</span>
                      {conv.lastMessage}
                    </div>

                    {/* Row 4: status pill + AI mode badge */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          color: sc.color,
                          background: sc.color + '14',
                          borderRadius: 999,
                          padding: '1px 6px',
                          fontFamily: T.font.sans,
                        }}
                      >
                        {sc.label}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: T.font.mono,
                          fontWeight: 700,
                          color: conv.aiMode === 'autopilot' ? T.accent : conv.aiMode === 'copilot' ? T.status.green : T.text.tertiary,
                          background: conv.aiMode === 'autopilot' ? T.accent + '14' : conv.aiMode === 'copilot' ? T.status.green + '14' : T.bg.tertiary,
                          borderRadius: 999,
                          padding: '1px 5px',
                        }}
                      >
                        {conv.aiMode === 'autopilot' ? 'AUTOPILOT' : conv.aiMode === 'copilot' ? 'COPILOT' : 'OFF'}
                      </span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </aside>

        {/* ── Chat Thread ── */}
        <main
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRight: `1px solid ${T.border.default}`,
          }}
        >
          {selectedConv ? (
            <>
              {/* Chat header */}
              <div
                style={{
                  height: 52,
                  minHeight: 52,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 16px',
                  borderBottom: `1px solid ${T.border.default}`,
                  flexShrink: 0,
                  background: T.bg.primary,
                }}
              >
                {/* Left: name + unit + booking channel */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, lineHeight: 1.2 }}>
                      {selectedConv.guestName.split(' ')[0]}
                    </div>
                    <div style={{ fontSize: 12, color: T.text.tertiary, lineHeight: 1.2 }}>
                      {selectedConv.unitName}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: statusConfig[selectedConv.checkInStatus].color,
                    background: statusConfig[selectedConv.checkInStatus].color + '18',
                    padding: '3px 8px',
                    borderRadius: 4,
                    letterSpacing: '0.02em',
                  }}>
                    {statusConfig[selectedConv.checkInStatus].label}
                  </span>
                </div>
                {/* Right: Star + Archive + Translate + AI ON */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {/* Star */}
                  <button
                    onClick={() => toggleStar(selectedConv.id)}
                    aria-label={selectedConv.starred ? 'Unstar conversation' : 'Star conversation'}
                    title={selectedConv.starred ? 'Unstar' : 'Star'}
                    style={{
                      width: 30, height: 30,
                      borderRadius: 8,
                      border: selectedConv.starred ? `1px solid ${T.status.amber}44` : `1px solid ${T.border.default}`,
                      cursor: 'pointer',
                      background: selectedConv.starred ? T.status.amber + '18' : 'transparent',
                      color: selectedConv.starred ? T.status.amber : T.text.secondary,
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Star size={13} fill={selectedConv.starred ? T.status.amber : 'none'} />
                  </button>
                  {/* Archive */}
                  <button
                    onClick={resolveConversation}
                    aria-label={selectedConv.status === 'RESOLVED' ? 'Unarchive conversation' : 'Archive conversation'}
                    title={selectedConv.status === 'RESOLVED' ? 'Unarchive' : 'Archive'}
                    style={{
                      width: 30, height: 30,
                      borderRadius: 8,
                      border: selectedConv.status === 'RESOLVED'
                        ? `1px solid ${T.status.green}44`
                        : `1px solid ${T.border.default}`,
                      cursor: 'pointer',
                      background: selectedConv.status === 'RESOLVED' ? T.status.green + '14' : 'transparent',
                      color: selectedConv.status === 'RESOLVED' ? T.status.green : T.text.secondary,
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {selectedConv.status === 'RESOLVED'
                      ? <ArchiveRestore size={13} />
                      : <Archive size={13} />
                    }
                  </button>
                  {/* Translate */}
                  <button
                    onClick={() => setTranslateActive(v => !v)}
                    aria-label={translateActive ? 'Disable translation' : 'Enable translation'}
                    title={translateActive ? 'Translation on' : 'Translate'}
                    style={{
                      width: 30, height: 30,
                      borderRadius: 8,
                      border: translateActive ? `1px solid ${T.accent}` : `1px solid ${T.border.default}`,
                      cursor: 'pointer',
                      background: translateActive ? T.accent + '12' : 'transparent',
                      color: translateActive ? T.accent : T.text.secondary,
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Languages size={13} />
                  </button>
                  {/* AI ON/OFF */}
                  <button
                    onClick={toggleAI}
                    style={{
                      position: 'relative',
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: T.font.sans,
                      padding: '4px 10px',
                      borderRadius: 999,
                      background: selectedConv.aiOn ? 'rgba(48,164,108,0.08)' : T.status.red + '1A',
                      color: selectedConv.aiOn ? T.status.green : T.status.red,
                      border: selectedConv.aiOn ? '1px solid transparent' : `1px solid ${T.status.red}33`,
                      cursor: 'pointer',
                      boxShadow: selectedConv.aiOn
                        ? '0 0 8px 1px rgba(48,164,108,0.28), 0 0 18px 3px rgba(52,211,153,0.14), 0 0 30px 5px rgba(48,164,108,0.06)'
                        : 'none',
                      transition: 'box-shadow 0.3s, background 0.3s',
                      animation: selectedConv.aiOn ? 'gp-intel-pulse 2.5s ease-in-out infinite' : 'none',
                    }}
                  >
                    <IntelligenceGlowBorder
                      active={selectedConv.aiOn}
                      borderRadius={999}
                      colors={INTEL_COLORS_GREEN}
                      compact
                    />
                    {selectedConv.aiOn ? 'AI ON' : 'AI OFF'}
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div
                ref={messagesScrollRef}
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '16px 0 0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                  maskImage: 'linear-gradient(to bottom, black 0%, black calc(100% - 6px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black calc(100% - 6px), transparent 100%)',
                }}
              >
                {loadingDetail && selectedConv.messages.length === 0 ? (
                  <MessagesSkeleton />
                ) : (
                  selectedConv.messages.map(msg => {
                    const isGuest = msg.sender === 'guest'
                    const isAI = msg.sender === 'ai'
                    const isHost = msg.sender === 'host'
                    const isPrivate = msg.sender === 'private'
                    const isLeft = isGuest

                    const bubbleBg = isGuest
                      ? T.bg.secondary
                      : isAI
                      ? T.accent + '0D'
                      : isPrivate
                      ? T.status.amber + '1F'
                      : T.accent + '0D'

                    const bubbleBorder = isPrivate
                      ? T.status.amber + '60'
                      : T.border.default

                    const senderLabel = isGuest
                      ? selectedConv.guestName.split(' ')[0]
                      : isAI
                      ? 'AI'
                      : isPrivate
                      ? 'Private note'
                      : 'You'

                    const logoSrc =
                      msg.channel === 'airbnb'
                        ? '/logos/airbnb.png'
                        : msg.channel === 'booking'
                        ? '/logos/booking.png'
                        : msg.channel === 'whatsapp'
                        ? '/logos/whatsapp.png'
                        : null

                    return (
                      <div
                        key={msg.id}
                        style={{
                          display: 'flex',
                          flexDirection: isLeft ? 'row' : 'row-reverse',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '0 16px',
                        }}
                      >
                        {/* Avatar */}
                        {isGuest && (
                          <div
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: '50%',
                              background: T.bg.tertiary,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              fontSize: 11,
                              fontWeight: 700,
                              color: T.text.secondary,
                            }}
                          >
                            {selectedConv.guestName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {isHost && (
                          <div
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: '50%',
                              background: T.text.primary,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              fontSize: 11,
                              fontWeight: 700,
                              color: '#FFFFFF',
                            }}
                          >
                            H
                          </div>
                        )}
                        {isAI && (
                          <div
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 6,
                              background: T.accent,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <Zap size={14} color="#FFFFFF" />
                          </div>
                        )}
                        {isPrivate && (
                          <div
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 6,
                              background: T.status.amber + '1F',
                              border: `1px solid ${T.status.amber + '60'}`,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <Lock size={13} color={T.status.amber} />
                          </div>
                        )}

                        <div style={{ maxWidth: '70%' }}>
                          {/* Sender label row (no timestamp here) */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              marginBottom: 3,
                              flexDirection: isLeft ? 'row' : 'row-reverse',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: isPrivate ? '#B45309' : T.text.primary,
                              }}
                            >
                              {senderLabel}
                            </span>
                          </div>
                          {/* Image attachments */}
                          {msg.imageUrls && msg.imageUrls.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: msg.text ? 4 : 0 }}>
                              {msg.imageUrls.map((url, idx) => (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  key={idx}
                                  src={url}
                                  alt="attachment"
                                  onClick={() => setImageModalUrl(url)}
                                  style={{
                                    maxWidth: 180,
                                    maxHeight: 140,
                                    borderRadius: 6,
                                    objectFit: 'cover',
                                    cursor: 'pointer',
                                    border: `1px solid ${T.border.default}`,
                                  }}
                                />
                              ))}
                            </div>
                          )}
                          <div
                            style={{
                              background: bubbleBg,
                              border: `1px solid ${bubbleBorder}`,
                              borderRadius: 8,
                              padding: '6px 10px',
                              fontSize: 13,
                              color: T.text.primary,
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {msg.text}
                          </div>
                          {/* Below bubble: logo + timestamp + rating */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              marginTop: 3,
                              flexDirection: isLeft ? 'row' : 'row-reverse',
                            }}
                          >
                            {logoSrc && (isGuest || isAI) && (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={logoSrc}
                                alt={msg.channel}
                                style={{ height: 11, width: 'auto', opacity: 0.55 }}
                              />
                            )}
                            <span
                              style={{
                                fontSize: 10,
                                color: T.text.tertiary,
                                fontFamily: T.font.mono,
                              }}
                            >
                              {msg.time}
                            </span>
                            {/* AI message rating buttons */}
                            {isAI && (
                              <span style={{ display: 'flex', gap: 2, marginLeft: 2 }}>
                                <button
                                  onClick={() => {
                                    const newRating = 'positive' as const
                                    setMessageRatings(r => ({ ...r, [msg.id]: newRating }))
                                    apiRateMessage(msg.id, newRating).catch(() => {})
                                  }}
                                  title="Good response"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '1px 2px',
                                    color: messageRatings[msg.id] === 'positive' ? T.status.green : T.text.tertiary + '88',
                                    lineHeight: 1,
                                    display: 'flex',
                                    fontSize: 11,
                                    transition: 'color 0.12s ease',
                                  }}
                                >
                                  <ArrowUp size={10} strokeWidth={2.5} style={{ transform: 'rotate(0deg)' }} />
                                </button>
                                <button
                                  onClick={() => {
                                    const newRating = 'negative' as const
                                    setMessageRatings(r => ({ ...r, [msg.id]: newRating }))
                                    apiRateMessage(msg.id, newRating).catch(() => {})
                                  }}
                                  title="Poor response"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '1px 2px',
                                    color: messageRatings[msg.id] === 'negative' ? T.status.red : T.text.tertiary + '88',
                                    lineHeight: 1,
                                    display: 'flex',
                                    fontSize: 11,
                                    transition: 'color 0.12s ease',
                                  }}
                                >
                                  <ArrowUp size={10} strokeWidth={2.5} style={{ transform: 'rotate(180deg)' }} />
                                </button>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Compose */}
              <div
                style={{
                  background: T.bg.primary,
                  flexShrink: 0,
                  padding: '6px 12px 12px',
                }}
              >
                {/* AI banner — always in DOM, slides up from behind text box */}
                {(() => {
                  const bannerVisible = selectedConv.aiMode !== 'off' && selectedConv.aiOn
                  return (
                    <div style={{
                      display: 'grid',
                      gridTemplateRows: bannerVisible ? '1fr' : '0fr',
                      transition: 'grid-template-rows 0.42s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}>
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{
                          transform: bannerVisible ? 'translateY(0)' : 'translateY(28px)',
                          transition: 'transform 0.42s cubic-bezier(0.4, 0, 0.2, 1)',
                          padding: '7px 12px 10px 12px',
                        }}>
                          <div style={{
                            position: 'relative',
                            background: isGlowing ? 'rgba(188, 130, 243, 0.07)' : T.accent + '14',
                            border: isGlowing ? '1px solid transparent' : `1px solid ${T.accent}33`,
                            borderRadius: 10,
                            padding: aiSuggestion ? '8px 44px 8px 12px' : '6px 12px',
                            fontSize: 12,
                            color: isGlowing ? T.text.primary : T.accent,
                            fontWeight: aiTyping ? 600 : aiSuggestion ? 400 : 500,
                            lineHeight: 1.5,
                            animation: isGlowing ? 'gp-intel-pulse 2.5s ease-in-out infinite' : 'none',
                            boxShadow: isGlowing
                              ? '0 0 8px 2px rgba(188,130,243,0.25), 0 0 16px 3px rgba(141,159,255,0.12)'
                              : 'none',
                            transition: 'background 0.3s, box-shadow 0.3s',
                          }}>
                            <IntelligenceGlowBorder active={isGlowing} borderRadius={10} />
                            {aiTyping
                              ? <ShimmerText text="Generating response…" />
                              : aiSuggestion ?? 'AI is handling responses automatically'}
                            {aiSuggestion && (
                              <button
                                onClick={async () => {
                                  const s = aiSuggestion
                                  setAiSuggestion(null)
                                  try { await apiApproveSuggestion(selectedConv.id, s) } catch { setAiSuggestion(s) }
                                }}
                                title="Send this response"
                                style={{
                                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                                  width: 28, height: 28, borderRadius: '50%', border: 'none',
                                  background: T.text.primary, cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  flexShrink: 0,
                                }}
                              >
                                <ArrowUp size={13} color="#fff" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* Compose card */}
                <div style={{ position: 'relative' }}>
                <div
                  style={{
                    border: `1px solid ${T.border.default}`,
                    borderRadius: 22,
                    background: T.bg.secondary,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
                    position: 'relative', zIndex: 1,
                  }}
                >
                  {/* Textarea */}
                  <textarea
                    ref={composeTextareaRef}
                    value={replyText}
                    onChange={handleComposeChange}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your message here..."
                    className="gp-compose-textarea"
                    style={{
                      width: '100%',
                      minHeight: 36,
                      maxHeight: 160,
                      resize: 'none',
                      border: 'none',
                      outline: 'none',
                      padding: '16px 16px 6px',
                      fontSize: 14,
                      fontFamily: T.font.sans,
                      color: T.text.primary,
                      background: 'transparent',
                      boxSizing: 'border-box',
                      lineHeight: 1.5,
                      overflowY: 'auto',
                      display: 'block',
                      caretColor: T.text.primary,
                    }}
                  />

                  {/* Bottom action bar — no top border */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '4px 8px 10px',
                      overflow: 'visible',
                    }}
                  >
                    {/* Left icons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>

                      {/* Attach */}
                      <button
                        title="Attach file"
                        style={{
                          width: 32, height: 32, borderRadius: '50%', border: 'none',
                          background: 'transparent', cursor: 'pointer', display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: T.text.tertiary,
                          transition: 'background 0.15s, color 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = T.bg.tertiary; e.currentTarget.style.color = T.text.primary }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.text.tertiary }}
                      >
                        <Paperclip size={16} />
                      </button>

                      {/* Gradient divider */}
                      <div style={{ position: 'relative', height: 24, width: 2, margin: '0 4px', flexShrink: 0 }}>
                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.25), transparent)', borderRadius: 999 }} />
                      </div>

                      {/* Property link */}
                      <button
                        title="Send property link"
                        style={{
                          width: 32, height: 32, borderRadius: '50%', border: 'none',
                          background: 'transparent', cursor: 'pointer', display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: T.text.tertiary,
                          transition: 'background 0.15s, color 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = T.bg.tertiary; e.currentTarget.style.color = T.text.primary }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.text.tertiary }}
                      >
                        <ExternalLink size={16} />
                      </button>

                      {/* Gradient divider */}
                      <div style={{ position: 'relative', height: 24, width: 2, margin: '0 4px', flexShrink: 0 }}>
                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.25), transparent)', borderRadius: 999 }} />
                      </div>

                      {/* Add task */}
                      <button
                        title="Add task"
                        style={{
                          width: 32, height: 32, borderRadius: '50%', border: 'none',
                          background: 'transparent', cursor: 'pointer', display: 'flex',
                          alignItems: 'center', justifyContent: 'center', color: T.text.tertiary,
                          transition: 'background 0.15s, color 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = T.bg.tertiary; e.currentTarget.style.color = T.text.primary }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.text.tertiary }}
                      >
                        <ClipboardList size={16} />
                      </button>

                      {/* Gradient divider */}
                      <div style={{ position: 'relative', height: 24, width: 2, margin: '0 4px', flexShrink: 0 }}>
                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.25), transparent)', borderRadius: 999 }} />
                      </div>

                      {/* Channel selector */}
                      <div ref={sendChannelAnchorRef} style={{ position: 'relative' }}>
                        {/* Channel trigger button */}
                        <button
                          onClick={() => sendChannelOpen ? closeSendChannel() : setSendChannelOpen(true)}
                          title="Choose channel"
                          style={{
                            width: 32, height: 32, borderRadius: '50%', border: 'none',
                            background: sendChannelOpen ? T.bg.tertiary : 'transparent',
                            cursor: 'pointer', display: 'flex',
                            alignItems: 'center', justifyContent: 'center', color: T.text.tertiary,
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = T.bg.tertiary }}
                          onMouseLeave={e => { e.currentTarget.style.background = sendChannelOpen ? T.bg.tertiary : 'transparent' }}
                        >
                          {sendChannel === 'whatsapp' ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src="/logos/whatsapp.png" alt="WhatsApp" style={{ width: 20, height: 20, objectFit: 'contain' }} />
                          ) : sendChannel === 'email' ? (
                            <Mail size={16} />
                          ) : (selectedConv.channel === 'airbnb' || selectedConv.channel === 'booking') ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={`/logos/${selectedConv.channel}.png`} alt={selectedConv.channel} style={{ width: 16, height: 16, objectFit: 'contain' }} />
                          ) : selectedConv.channel === 'whatsapp' ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src="/logos/whatsapp.png" alt="WhatsApp" style={{ width: 20, height: 20, objectFit: 'contain' }} />
                          ) : (
                            <Globe size={16} />
                          )}
                        </button>

                        {/* Vertical sliding pill toggle */}
                        {(sendChannelOpen || sendChannelClosing) && (() => {
                          const opts = [
                            {
                              key: 'channel',
                              icon: (selectedConv.channel === 'airbnb' || selectedConv.channel === 'booking')
                                ? <img src={`/logos/${selectedConv.channel}.png`} alt={selectedConv.channel} style={{ width: 18, height: 18, objectFit: 'contain', display: 'block' }} />
                                : selectedConv.channel === 'whatsapp'
                                ? <img src="/logos/whatsapp.png" alt="WhatsApp" style={{ width: 20, height: 20, objectFit: 'contain', display: 'block' }} />
                                : <Globe size={17} color="currentColor" />,
                            },
                            { key: 'whatsapp', icon: <img src="/logos/whatsapp.png" alt="WhatsApp" style={{ width: 20, height: 20, objectFit: 'contain', display: 'block' }} /> },
                            { key: 'email', icon: <Mail size={17} color="currentColor" /> },
                          ]
                          const slotSize = 38
                          const pad = 5
                          const selectedIdx = Math.max(0, opts.findIndex(o => o.key === sendChannel))
                          return (
                            /* outer: handles centering only */
                            <div style={{
                              position: 'absolute',
                              bottom: 'calc(100% + 10px)',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              zIndex: 300,
                            }}>
                              {/* inner: handles animation only */}
                              <div
                                ref={sendChannelDropdownRef}
                                style={{
                                  background: T.bg.secondary,
                                  border: `1px solid ${T.border.default}`,
                                  borderRadius: slotSize / 2 + pad,
                                  padding: pad,
                                  boxShadow: '0 8px 24px rgba(0,0,0,0.13), 0 2px 6px rgba(0,0,0,0.07)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  width: slotSize + pad * 2,
                                  transformOrigin: 'bottom center',
                                  animation: sendChannelClosing
                                    ? 'channel-pill-out 0.22s cubic-bezier(0.4,0,1,1) forwards'
                                    : 'channel-pill-in 0.42s cubic-bezier(0.22,1,0.36,1) forwards',
                                }}
                              >
                                {/* Sliding indicator */}
                                <div style={{
                                  position: 'absolute',
                                  left: pad,
                                  top: pad + selectedIdx * slotSize,
                                  width: slotSize,
                                  height: slotSize,
                                  borderRadius: '50%',
                                  background: T.bg.primary,
                                  boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                                  transition: 'top 0.3s cubic-bezier(0.34,1.56,0.64,1)',
                                  pointerEvents: 'none',
                                }} />
                                {opts.map((opt, i) => (
                                  <button
                                    key={opt.key}
                                    onClick={() => { setSendChannel(opt.key); closeSendChannel() }}
                                    style={{
                                      width: slotSize, height: slotSize,
                                      border: 'none', background: 'transparent',
                                      cursor: 'pointer', display: 'flex',
                                      alignItems: 'center', justifyContent: 'center',
                                      borderRadius: '50%', flexShrink: 0,
                                      color: sendChannel === opt.key ? T.text.primary : T.text.tertiary,
                                      position: 'relative', zIndex: 1,
                                      transition: 'color 0.2s, transform 0.15s',
                                      animation: sendChannelClosing ? 'none' : `channel-icon-in 0.3s cubic-bezier(0.34,1.56,0.64,1) ${60 + i * 55}ms both`,
                                    }}
                                  >
                                    {opt.icon}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                      </div>
                    </div>

                    {/* Right: Private + Send */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {/* Private — yellow circle */}
                      <button
                        onClick={sendPrivate}
                        disabled={!replyText.trim()}
                        title="Private note"
                        style={{
                          width: 32, height: 32, borderRadius: '50%', border: 'none',
                          background: replyText.trim() ? T.status.amber : '#D8D8D8',
                          cursor: !replyText.trim() ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, transition: 'background 0.15s',
                        }}
                      >
                        <Lock size={14} color={replyText.trim() ? '#7C2D00' : '#555555'} />
                      </button>

                      {/* Send — white circle */}
                      <button
                        onClick={sendReply}
                        disabled={sendingMessage || !replyText.trim()}
                        title="Send (⌘↵)"
                        style={{
                          width: 32, height: 32, borderRadius: '50%', border: 'none',
                          background: replyText.trim() && !sendingMessage ? T.text.primary : '#D8D8D8',
                          cursor: sendingMessage || !replyText.trim() ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, transition: 'background 0.15s',
                        }}
                      >
                        {sendingMessage
                          ? <div style={{ width: 12, height: 12, border: `2px solid ${T.text.tertiary}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                          : <ArrowUp size={15} color={replyText.trim() ? '#FFFFFF' : '#666666'} />
                        }
                      </button>
                    </div>
                  </div>
                </div>
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                color: T.text.tertiary,
              }}
            >
              {loadingList ? 'Loading…' : 'Select a conversation'}
            </div>
          )}
        </main>

        {/* ── Right Panel ── */}
        <aside
          style={{
            width: 320,
            minWidth: 320,
            overflowY: 'auto',
            background: T.bg.primary,
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
          }}
        >
          {/* Right panel header with reorder button */}
          <div
            style={{
              padding: '7px 12px',
              borderBottom: `1px solid ${T.border.default}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
              background: T.bg.primary,
              position: 'sticky',
              top: 0,
              zIndex: 10,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: T.text.tertiary,
                fontFamily: T.font.sans,
              }}
            >
              {wiggleMode ? 'Drag to reorder' : 'Details'}
            </span>
            {selectedConv && (
              wiggleMode ? (
                <button
                  onClick={() => { setWiggleMode(false); setDraggedSection(null); setDragOverSection(null) }}
                  style={{
                    background: T.accent,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '3px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: T.font.sans,
                  }}
                >
                  Done
                </button>
              ) : (
                <button
                  onClick={() => setWiggleMode(true)}
                  title="Reorder sections"
                  style={{
                    background: 'none',
                    border: `1px solid ${T.border.default}`,
                    borderRadius: 6,
                    padding: '3px 6px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    color: T.text.secondary,
                  }}
                >
                  <GripVertical size={13} />
                </button>
              )
            )}
          </div>

          {selectedConv ? (
            <div style={{ padding: 12 }}>
              {panelOrder.map(id => renderPanelSection(id))}
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                color: T.text.tertiary,
                padding: 20,
              }}
            >
              Select a conversation to view details
            </div>
          )}
        </aside>
      </div>
      )}
      {navTab === 'overview' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <OverviewV5
            conversations={conversations}
            onSelectConversation={id => {
              setSelectedId(id)
              setNavTab('inbox')
            }}
          />
        </div>
      )}
      {navTab === 'analytics' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <AnalyticsV5 />
        </div>
      )}
      {navTab === 'tasks' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TasksV5 />
        </div>
      )}
      {navTab === 'settings' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <SettingsV5 onImportComplete={() => {
            apiGetConversations().then(data => setConversations(data.map(summaryToConversation))).catch(() => {})
          }} />
        </div>
      )}
      {navTab === 'configure' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ConfigureAiV5 />
        </div>
      )}
      {navTab === 'classifier' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ClassifierV5 />
        </div>
      )}
      {navTab === 'logs' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <AiLogsV5 />
        </div>
      )}

      {/* Image lightbox modal */}
      {imageModalUrl && (
        <div
          onClick={() => setImageModalUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageModalUrl}
            alt="Full size"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
          />
        </div>
      )}
    </div>
  )
}
