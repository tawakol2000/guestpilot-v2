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
  AlertTriangle,
  CalendarClock,
  Loader2,
  ArrowRight,
  FileText,
  Wrench,
  Ban,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  apiGetConversations,
  apiGetConversation,
  apiSendMessage,
  apiToggleAI,
  apiSetAiMode,
  apiSendThroughAI,
  apiTranslateMessage,
  apiListConversationTasks,
  apiApproveSuggestion,
  apiGetConversationSuggestion,
  apiSendNote,
  apiGetConversationTasks,
  apiUpdateConversationChecklist,
  apiUpdateTask,
  apiRateMessage,
  apiCreateTuningConversation,
  apiToggleStar,
  apiResolveConversation,
  apiSyncConversation,
  apiUpdateFaqEntry,
  apiApproveReservation,
  apiRejectReservation,
  apiCancelReservation,
  apiGetLastAction,
  apiGetHostawayConnectStatus,
  apiGetAlteration,
  apiAcceptAlteration,
  apiRejectAlteration,
  apiSendShadowPreview,
  type BookingAlteration,
  ApiError,
  mapChannel,
  mapMessageSender,
  formatTimestamp,
  formatDate,
  clearToken,
  type ApiConversationSummary,
  type ApiConversationDetail,
  type ApiMessage,
  type ApiTask,
  type ReservationActionResult,
  type LastActionResult,
  type HostawayConnectStatus,
} from '@/lib/api'
import { socket, connectSocket, disconnectSocket } from '../lib/socket'
import { ConnectionStatus } from './ui/connection-status'
import { OverviewV5 } from '@/components/overview-v5'
import { AnalyticsV5 } from '@/components/analytics-v5'
import { TasksV5 } from '@/components/tasks-v5'
import { SettingsV5 } from '@/components/settings-v5'
import { ConfigureAiV5 } from '@/components/configure-ai-v5'
import { AiLogsV5 } from '@/components/ai-logs-v5'
import SopEditorV5 from '@/components/sop-editor-v5'
import ToolsV5 from '@/components/tools-v5'
import SandboxChatV5 from '@/components/sandbox-chat-v5'
import ListingsV5 from '@/components/listings-v5'
import CalendarV5 from '@/components/calendar-v5'
import FaqV5 from '@/components/faq-v5'
// Feature 041 sprint 01 teardown: the v5 Tuning Review UI has been removed.
// The new /tuning surface ships in sprint 03. Until then the tab renders a
// placeholder below.
import WebhookLogsV5 from '@/components/webhook-logs-v5'
import { ErrorBoundary } from '@/components/error-boundary'
import { StudioSurface } from '@/components/studio'
import { getActionCardFor } from '@/components/actions/action-card-registry'

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

// ─── SOP Labels (for correction popover) ──────────────────────────────────────

const SOP_LABELS = [
  'sop-cleaning', 'sop-amenity-request', 'sop-maintenance', 'sop-wifi-doorcode',
  'sop-visitor-policy', 'sop-early-checkin', 'sop-late-checkout', 'sop-escalation-info',
  'sop-booking-inquiry', 'pricing-negotiation', 'pre-arrival-logistics',
  'sop-booking-modification', 'sop-booking-confirmation', 'payment-issues',
  'post-stay-issues', 'sop-long-term-rental', 'sop-booking-cancellation',
  'sop-property-viewing', 'non-actionable',
] as const

// ─── Types ────────────────────────────────────────────────────────────────────

type AiMode = 'autopilot' | 'copilot' | 'off'
type Sender = 'guest' | 'host' | 'ai' | 'private'
type Channel = 'airbnb' | 'booking' | 'direct' | 'vrbo' | 'whatsapp'
type InboxTab = 'All' | 'Unread' | 'Starred' | 'Archive'
type NavTab = 'overview' | 'inbox' | 'calendar' | 'analytics' | 'tasks' | 'settings' | 'configure' | 'logs' | 'webhooks' | 'sops' | 'tools' | 'sandbox' | 'listings' | 'faqs' | 'tuning' | 'build' | 'studio'
type CheckInStatus = 'upcoming' | 'checked-in' | 'checked-out' | 'inquiry' | 'pending' | 'cancelled' | 'checking-in-today' | 'checking-out-today' | 'expired'

interface Message {
  id: string
  sender: Sender
  text: string
  time: string
  channel?: Channel
  fromSelf?: boolean
  imageUrls?: string[]
  aiMeta?: { sopCategories?: string[]; toolName?: string; toolNames?: string[]; confidence?: number; autopilotDowngraded?: boolean }
  // Feature 040: Copilot Shadow Mode preview fields (nullable — only present on shadow-mode previews)
  previewState?: 'PREVIEW_PENDING' | 'PREVIEW_LOCKED' | 'PREVIEW_SENDING'
  originalAiText?: string
  editedByUserId?: string
  // Feature 042: server-persisted English translation (inbound guest messages only).
  // Null/undefined = not yet translated. Hydrated from the API response and
  // from successful translate-endpoint calls while the Translate toggle is on.
  contentTranslationEn?: string | null
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
  // Feature 043 — per-reservation scheduled overrides surfaced onto the
  // Property card with a visually-distinct "Modified" treatment. Null/empty
  // = no override, render default checkInTime/checkOutTime.
  scheduledCheckInAt?: string | null
  scheduledCheckOutAt?: string | null
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
  reservationId: string
  reservationCreatedAt: string
  messages: Message[]
  guest: Guest
  booking: Booking
  property: Property
  documentChecklist?: { passportsNeeded: number; passportsReceived: number; marriageCertNeeded: boolean; marriageCertReceived: boolean } | null
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
  'checking-in-today': { label: 'Check-in Today', color: T.status.amber },
  'checked-in': { label: 'Checked In', color: T.status.green },
  'checking-out-today': { label: 'Checkout Today', color: T.status.amber },
  'checked-out': { label: 'Checked Out', color: T.text.tertiary },
  inquiry: { label: 'Inquiry', color: T.accent },
  pending: { label: 'Pending', color: '#D97706' },
  cancelled: { label: 'Cancelled', color: T.status.red },
  expired: { label: 'Expired', color: T.text.tertiary },
}

function channelFromApi(ch: string): Channel {
  const n = ch.toUpperCase()
  if (n === 'AIRBNB') return 'airbnb'
  if (n === 'BOOKING') return 'booking'
  if (n === 'VRBO') return 'vrbo'
  if (n === 'WHATSAPP') return 'whatsapp'
  return 'direct'
}

function checkInStatusFromApi(status: string, checkIn: string, checkOut?: string, createdAt?: string): CheckInStatus {
  if (status === 'CANCELLED') return 'cancelled'
  if (status === 'CHECKED_OUT') return 'checked-out'
  if (status === 'PENDING') return 'pending'

  // Check if inquiry/pending has expired (24h after creation)
  if ((status === 'INQUIRY' || status === 'PENDING') && createdAt) {
    const created = new Date(createdAt).getTime()
    const now = Date.now()
    if (now - created > 24 * 60 * 60 * 1000) return 'expired'
  }

  // Compute from dates for CONFIRMED/CHECKED_IN/INQUIRY
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (checkIn) {
    const ci = new Date(checkIn)
    ci.setHours(0, 0, 0, 0)
    if (checkOut) {
      const co = new Date(checkOut)
      co.setHours(0, 0, 0, 0)
      if (co.getTime() === today.getTime()) return status === 'INQUIRY' ? 'inquiry' : 'checking-out-today'
      if (today >= co) return 'checked-out'
    }
    // Only show check-in/checked-in for confirmed+ guests
    if (status !== 'INQUIRY') {
      if (ci.getTime() === today.getTime()) return 'checking-in-today'
      if (today > ci) return 'checked-in'
      return 'upcoming'
    }
  }

  if (status === 'INQUIRY') return 'inquiry'
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
    guestName: s.guestName && s.guestName !== 'Unknown Guest' ? s.guestName : 'Guest',
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
    checkInStatus: checkInStatusFromApi(s.reservationStatus, s.checkIn, s.checkOut, s.reservationCreatedAt),
    reservationId: s.reservationId || '',
    reservationCreatedAt: s.reservationCreatedAt || '',
    messages: [],
    guest: { name: s.guestName && s.guestName !== 'Unknown Guest' ? s.guestName : 'Guest', email: '', phone: '', nationality: '' },
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
    checkInStatus: checkInStatusFromApi(res?.status || '', res?.checkIn || '', res?.checkOut || '', res?.createdAt || conv.reservationCreatedAt),
    reservationId: res?.id || conv.reservationId,
    reservationCreatedAt: res?.createdAt || conv.reservationCreatedAt,
    status: (detail.status as 'OPEN' | 'RESOLVED') || conv.status,
    aiOn: res?.aiEnabled ?? conv.aiOn,
    aiMode: (res?.aiMode as AiMode) || conv.aiMode,
    messages: (() => {
      const fromApi = (detail.messages || []).flatMap((m: ApiMessage): Message[] => {
        const sender = senderFromRole(m.role)
        const msgChannel = channelFromApi(m.channel || detail.channel || (conv.channel as string))
        const imgs = m.imageUrls && m.imageUrls.length > 0 ? m.imageUrls : undefined
        // Private notes have no channel; AI_PRIVATE and MANAGER_PRIVATE are outgoing (from host side)
        if (sender === 'private') {
          const fromSelf = m.role === 'AI_PRIVATE' || m.role === 'MANAGER_PRIVATE'
          return [{ id: m.id, sender: 'private', text: m.content, time: m.sentAt ? formatTimestamp(m.sentAt) : '', fromSelf, imageUrls: imgs }]
        }
        return [{
          id: m.id,
          sender,
          text: m.content,
          time: m.sentAt ? formatTimestamp(m.sentAt) : '',
          channel: msgChannel,
          imageUrls: imgs,
          ...(m.aiMeta ? { aiMeta: m.aiMeta } : {}),
          // Feature 040: propagate Shadow Mode preview state so Send/Edit buttons
          // persist across refresh and initial page loads (not just SSE-pushed messages).
          ...(m.previewState ? { previewState: m.previewState } : {}),
          ...(m.originalAiText ? { originalAiText: m.originalAiText } : {}),
          ...(m.editedByUserId ? { editedByUserId: m.editedByUserId } : {}),
          // Feature 042: server-persisted English translation (guest messages only).
          ...(m.contentTranslationEn ? { contentTranslationEn: m.contentTranslationEn } : {}),
        }]
      })
      // Preserve SSE-appended messages not yet in the API response (e.g., arrived during the fetch window).
      // Deduped by trimmed text to avoid duplicates once the API catches up.
      const apiContents = new Set(fromApi.map(m => m.text.trim()))
      const ssePending = conv.messages.filter(
        m => m.id.startsWith('sse-') && !apiContents.has(m.text.trim())
      )
      return [...fromApi, ...ssePending]
    })(),
    guest: {
      name: (() => { const n = detail.guest?.name || conv.guest.name; return n && n !== 'Unknown Guest' ? n : 'Guest'; })(),
      email: detail.guest?.email || '',
      phone: detail.guest?.phone || '',
      nationality: detail.guest?.nationality || '',
    },
    booking: {
      ...conv.booking,
      id: (detail as any).hostawayConversationId || conv.booking.id || '',
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
      // Feature 043 — scheduled overrides from reservation
      scheduledCheckInAt: res?.scheduledCheckInAt ?? null,
      scheduledCheckOutAt: res?.scheduledCheckOutAt ?? null,
    },
    documentChecklist: detail.documentChecklist ?? null,
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
          aria-label="Previous month"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: T.text.tertiary, display: 'flex', alignItems: 'center' }}
        >
          <ChevronLeft size={13} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: T.font.sans, color: T.text.primary }}>
          {MONTHS[month]} {year}
        </span>
        <button
          onClick={nextMonth}
          aria-label="Next month"
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

// Feature 043 — format "HH:MM" (24h) → friendly "h:mm AM/PM"; pass-through unparseable.
function friendlyTime(time: string | null | undefined): string {
  if (!time) return ''
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return time
  let h = parseInt(m[1], 10)
  const min = m[2]
  if (Number.isNaN(h) || h < 0 || h > 23) return time
  const period = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${min} ${period}`
}

function DataRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string
  value: string | React.ReactNode
  mono?: boolean
  last?: boolean
}) {
  if (value === null || value === undefined || value === '') return null
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
    apiGetConversationTasks(conversationId).then(setTasks).catch(err => console.error('[Tasks] Failed to load tasks:', err))
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
    if (urgency === 'modification_request') return T.status.red
    if (urgency === 'scheduled') return T.status.amber
    if (urgency === 'inquiry_decision') return T.accent
    if (urgency === 'info_request') return T.accent
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

function AlterationPanel({
  reservationId,
}: {
  reservationId: string
}) {
  const [alteration, setAlteration] = useState<BookingAlteration | null | 'loading'>('loading')
  const [actionInFlight, setActionInFlight] = useState<'accept' | 'reject' | null>(null)
  const [actionResult, setActionResult] = useState<{ status: 'success' | 'error'; message?: string } | null>(null)
  const [showRejectConfirm, setShowRejectConfirm] = useState(false)
  const [reconnectWarning, setReconnectWarning] = useState(false)
  const [channelError, setChannelError] = useState<string | null>(null)

  useEffect(() => {
    if (!reservationId) { setAlteration(null); return }
    setAlteration('loading')
    setActionResult(null)
    setReconnectWarning(false)
    setChannelError(null)
    apiGetAlteration(reservationId)
      .then(a => setAlteration(a))
      .catch(() => setAlteration(null))
  }, [reservationId])

  function fmtDate(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  async function handleAccept() {
    if (actionInFlight) return
    setActionInFlight('accept')
    setActionResult(null)
    setReconnectWarning(false)
    setChannelError(null)
    try {
      await apiAcceptAlteration(reservationId)
      setAlteration(prev => prev && prev !== 'loading' ? { ...prev, status: 'ACCEPTED' } : prev)
      setActionResult({ status: 'success' })
    } catch (err: any) {
      if (err?.status === 403) {
        setReconnectWarning(true)
      } else {
        setActionResult({ status: 'error', message: err?.data?.error || err?.message || 'Failed to accept alteration' })
      }
    } finally {
      setActionInFlight(null)
    }
  }

  async function handleReject() {
    if (actionInFlight) return
    setShowRejectConfirm(false)
    setActionInFlight('reject')
    setActionResult(null)
    setReconnectWarning(false)
    setChannelError(null)
    try {
      await apiRejectAlteration(reservationId)
      setAlteration(prev => prev && prev !== 'loading' ? { ...prev, status: 'REJECTED' } : prev)
      setActionResult({ status: 'success' })
    } catch (err: any) {
      if (err?.status === 403) {
        setReconnectWarning(true)
      } else if (err?.status === 422) {
        setChannelError('Rejection not supported for this channel — please reject on Airbnb/Booking.com.')
      } else {
        setActionResult({ status: 'error', message: err?.data?.error || err?.message || 'Failed to reject alteration' })
      }
    } finally {
      setActionInFlight(null)
    }
  }

  if (alteration === 'loading') return null
  if (!alteration) return null
  // Only show the panel for alterations that still need the host to act.
  // Once Hostaway (or the host via Hostaway's own dashboard) resolves it,
  // the GET endpoint reconciles the status and we hide the card.
  if (alteration.status !== 'PENDING') return null

  const hasDetails = alteration.originalCheckIn || alteration.proposedCheckIn || alteration.originalGuestCount !== null

  const checkInChanged = alteration.originalCheckIn !== alteration.proposedCheckIn
  const checkOutChanged = alteration.originalCheckOut !== alteration.proposedCheckOut
  const guestCountChanged = alteration.originalGuestCount !== alteration.proposedGuestCount

  const panelColor = T.status.amber

  return (
    <div style={{
      background: T.bg.primary,
      border: `1px solid ${T.border.default}`,
      borderRadius: 8,
      marginBottom: 8,
      overflow: 'hidden',
    }}>
      {/* Header — matches right panel section style */}
      <div style={{
        background: T.bg.secondary,
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <AlertTriangle size={12} color={panelColor} />
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: T.text.secondary,
          fontFamily: T.font.sans,
        }}>
          Alteration
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600,
          color: panelColor,
          background: panelColor + '20',
          padding: '1px 5px',
          borderRadius: 4,
          marginLeft: 'auto',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.04em',
        }}>
          Pending
        </span>
      </div>

      {/* Details */}
      <div style={{ padding: '8px 12px' }}>
        {alteration.fetchError ? (
          <div style={{ fontSize: 11, color: T.text.secondary, fontFamily: T.font.sans, fontStyle: 'italic' }}>
            Unable to load details — connect Hostaway Dashboard in Settings.
          </div>
        ) : hasDetails ? (
          <div style={{ fontSize: 11, fontFamily: T.font.sans }}>
            {/* Row labels */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <span style={{ flex: 1 }}></span>
              <span style={{ flex: 1, color: T.text.tertiary, fontWeight: 500, fontSize: 10 }}>Original</span>
              <span style={{ flex: 1, color: T.text.tertiary, fontWeight: 500, fontSize: 10 }}>Proposed</span>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
              <span style={{ flex: 1, color: T.text.secondary }}>Check-in</span>
              <span style={{ flex: 1, color: T.text.primary }}>{fmtDate(alteration.originalCheckIn)}</span>
              <span style={{
                flex: 1,
                color: checkInChanged ? panelColor : T.text.primary,
                fontWeight: checkInChanged ? 600 : 400,
              }}>{fmtDate(alteration.proposedCheckIn)}</span>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
              <span style={{ flex: 1, color: T.text.secondary }}>Check-out</span>
              <span style={{ flex: 1, color: T.text.primary }}>{fmtDate(alteration.originalCheckOut)}</span>
              <span style={{
                flex: 1,
                color: checkOutChanged ? panelColor : T.text.primary,
                fontWeight: checkOutChanged ? 600 : 400,
              }}>{fmtDate(alteration.proposedCheckOut)}</span>
            </div>
            {(alteration.originalGuestCount !== null || alteration.proposedGuestCount !== null) && (
              <div style={{ display: 'flex', gap: 4 }}>
                <span style={{ flex: 1, color: T.text.secondary }}>Guests</span>
                <span style={{ flex: 1, color: T.text.primary }}>{alteration.originalGuestCount ?? '—'}</span>
                <span style={{
                  flex: 1,
                  color: guestCountChanged ? panelColor : T.text.primary,
                  fontWeight: guestCountChanged ? 600 : 400,
                }}>{alteration.proposedGuestCount ?? '—'}</span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: T.text.secondary, fontFamily: T.font.sans }}>
            Loading alteration details...
          </div>
        )}
      </div>

      {alteration.status === 'PENDING' && (<>
      {/* Reconnect warning */}
      {reconnectWarning && (
        <div style={{
          padding: '6px 12px',
          background: T.status.red + '12',
          borderTop: `1px solid ${T.status.red}22`,
          fontSize: 11,
          color: T.status.red,
          fontFamily: T.font.sans,
        }}>
          Dashboard connection expired.{' '}
          <a href="/settings?tab=hostaway" style={{ color: T.status.red, fontWeight: 600 }}>Reconnect →</a>
        </div>
      )}

      {/* Channel error */}
      {channelError && (
        <div style={{
          padding: '6px 12px',
          background: T.status.amber + '12',
          borderTop: `1px solid ${T.status.amber}22`,
          fontSize: 11,
          color: T.text.secondary,
          fontFamily: T.font.sans,
        }}>
          {channelError}
        </div>
      )}

      {/* Action error */}
      {actionResult?.status === 'error' && (
        <div style={{
          padding: '6px 12px',
          background: T.status.red + '12',
          borderTop: `1px solid ${T.status.red}22`,
          fontSize: 11,
          color: T.status.red,
          fontFamily: T.font.sans,
        }}>
          {actionResult.message}
        </div>
      )}

      {/* Reject confirm */}
      {showRejectConfirm && (
        <div style={{
          padding: '8px 12px',
          background: T.status.red + '08',
          borderTop: `1px solid ${T.status.red}22`,
          display: 'flex',
          flexDirection: 'column' as const,
          gap: 6,
        }}>
          <span style={{ fontSize: 11, color: T.text.primary, fontFamily: T.font.sans }}>
            Reject? Original dates will be kept.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={handleReject}
              style={{
                flex: 1, height: 28, borderRadius: 6, border: 'none',
                background: T.status.red, color: '#fff',
                fontSize: 11, fontWeight: 700, fontFamily: T.font.sans, cursor: 'pointer',
              }}
            >
              Confirm
            </button>
            <button
              onClick={() => setShowRejectConfirm(false)}
              style={{
                flex: 1, height: 28, borderRadius: 6,
                border: `1px solid ${T.border.default}`,
                background: 'transparent', color: T.text.secondary,
                fontSize: 11, fontWeight: 500, fontFamily: T.font.sans, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!showRejectConfirm && (
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          gap: 6,
          borderTop: `1px solid ${T.border.default}`,
        }}>
          <button
            onClick={handleAccept}
            disabled={!!actionInFlight}
            style={{
              flex: 1, height: 30, borderRadius: 6, border: 'none',
              background: T.status.green,
              color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: T.font.sans,
              cursor: actionInFlight ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              opacity: actionInFlight === 'reject' ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {actionInFlight === 'accept' ? (
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <Check size={13} />
            )}
            Accept
          </button>
          <button
            onClick={() => setShowRejectConfirm(true)}
            disabled={!!actionInFlight}
            style={{
              flex: 0, minWidth: 70, height: 30, borderRadius: 6,
              border: `1px solid ${T.status.red}66`,
              background: 'transparent', color: T.status.red,
              fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
              cursor: actionInFlight ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              opacity: actionInFlight === 'accept' ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            <X size={12} />
            Reject
          </button>
        </div>
      )}
      </>)}
    </div>
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
@keyframes gp-cursor-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
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

export default function InboxV5() {
  const router = useRouter()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [activeTab, setActiveTab] = useState<InboxTab>('All')
  const [navTab, setNavTabRaw] = useState<NavTab>(() => {
    if (typeof window !== 'undefined') {
      // Feature 041 sprint 09 fix 13: the tuning /agent page deep-links to
      // /?tab=sops|faqs|tools. Honor the URL query first, fall back to
      // sessionStorage so other places preserve their last-tab behavior.
      // Sprint 046 Session C — 'studio' is a hash-state tab that replaces
      // the top-level /build and /tuning routes.
      const validTabs = [
        'overview','inbox','calendar','analytics','tasks','settings','configure',
        'logs','webhooks','sops','tools','sandbox','listings','faqs','tuning','studio',
      ] as const
      const params = new URLSearchParams(window.location.search)
      const urlTab = params.get('tab')
      if (urlTab && (validTabs as readonly string[]).includes(urlTab)) return urlTab as NavTab
      const saved = sessionStorage.getItem('gp-nav-tab')
      if (saved && (validTabs as readonly string[]).includes(saved)) return saved as NavTab
    }
    return 'inbox'
  })
  const [studioConversationId, setStudioConversationId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    return params.get('conversationId')
  })
  const setNavTab = useCallback((tab: NavTab) => {
    setNavTabRaw(tab)
    try { sessionStorage.setItem('gp-nav-tab', tab) } catch {}
    // Sprint 046 Session C — URL sync for Studio (hash-state tab). We use
    // replaceState (not push) so the browser back button doesn't trap in
    // tab-cycling. Non-studio tabs clear the studio conversationId from
    // the URL to avoid stale deep-links.
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(window.location.href)
        if (tab === 'studio') {
          url.searchParams.set('tab', 'studio')
        } else {
          url.searchParams.delete('tab')
          url.searchParams.delete('conversationId')
        }
        window.history.replaceState({}, '', url.toString())
      } catch {}
    }
  }, [])
  const updateStudioConversationId = useCallback((id: string | null) => {
    setStudioConversationId(id)
    if (typeof window === 'undefined') return
    try {
      const url = new URL(window.location.href)
      if (id) url.searchParams.set('conversationId', id)
      else url.searchParams.delete('conversationId')
      window.history.replaceState({}, '', url.toString())
    } catch {}
  }, [])
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
  // Streaming text accumulator: conversationId → partial text received so far
  const [streamingText, setStreamingText] = useState<Record<string, string>>({})
  // Feature 042 — per-conversation Translate toggle. Map keyed by conversation id.
  // Seeded from localStorage (key: `gp-translate-on:<convId>` → '1') on mount so
  // the preference survives reloads within the same browser (FR-003). Cleared
  // keys mean off.
  const [translateActiveMap, setTranslateActiveMap] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const out: Record<string, boolean> = {}
      const prefix = 'gp-translate-on:'
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (key && key.startsWith(prefix) && window.localStorage.getItem(key) === '1') {
          out[key.slice(prefix.length)] = true
        }
      }
      return out
    } catch {
      return {}
    }
  })
  // Feature 042 — per-message translation lifecycle. 'idle' = not yet requested,
  // 'loading' = in flight, 'error' = last attempt failed (retryable).
  const [translations, setTranslations] = useState<
    Record<string, { text?: string; status: 'idle' | 'loading' | 'error' }>
  >({})
  // Feature 043 — open action-card tasks for the currently-selected conversation.
  // Fetched when selectedConv changes; mutated in-place via Socket.IO events.
  const [conversationTasks, setConversationTasks] = useState<ApiTask[]>([])
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false)
  const [filterStep, setFilterStep] = useState<'root' | 'status' | 'aiMode'>('root')
  const [filterSearch, setFilterSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<CheckInStatus | 'all'>('all')
  const [filterAiMode, setFilterAiMode] = useState<AiMode | 'all'>('all')
  const [sendChannelOpen, setSendChannelOpen] = useState(false)
  const [sendChannelClosing, setSendChannelClosing] = useState(false)
  const [sendChannel, setSendChannel] = useState<string>('channel')

  const [messageRatings, setMessageRatings] = useState<Record<string, 'positive' | 'negative'>>({})
  const [correctionMsgId, setCorrectionMsgId] = useState<string | null>(null)
  const [correctionLabels, setCorrectionLabels] = useState<string[]>([])
  const [correctionSubmitted, setCorrectionSubmitted] = useState<Record<string, boolean>>({})
  const [imageModalUrl, setImageModalUrl] = useState<string | null>(null)

  // Socket.IO connection state
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'delayed' | 'reconnecting' | 'disconnected'>('reconnecting')
  const [showReconnectedBanner, setShowReconnectedBanner] = useState(false)
  const seenMessageIds = useRef<Set<string>>(new Set())
  const wsFailCount = useRef(0)
  const degradedPollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevStatusRef = useRef<string>('reconnecting')

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
  const [faqSuggestion, setFaqSuggestion] = useState<{
    id: string; question: string; answer: string; category: string;
    propertyId: string; propertyName: string;
  } | null>(null)
  const [faqSuggestionScope, setFaqSuggestionScope] = useState<'PROPERTY' | 'GLOBAL'>('PROPERTY')

  // ── Reservation action state ──
  const [actionInFlight, setActionInFlight] = useState<Record<string, string>>({}) // reservationId → action type
  const [actionResult, setActionResult] = useState<Record<string, { status: 'success' | 'error'; message?: string; suggestion?: string }>>({})
  const [lastActions, setLastActions] = useState<Record<string, LastActionResult>>({})
  const [hostawayConnectStatus, setHostawayConnectStatus] = useState<HostawayConnectStatus | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{ type: 'reject' | 'cancel'; reservationId: string; conversationId?: string } | null>(null)
  // Feature 040: Shadow Mode — in-progress preview edit state
  const [editingPreviewId, setEditingPreviewId] = useState<string | null>(null)
  const [previewEditBuffer, setPreviewEditBuffer] = useState<string>('')
  const [sendingPreviewId, setSendingPreviewId] = useState<string | null>(null)
  const [shadowToast, setShadowToast] = useState<string | null>(null)
  const [syncingChat, setSyncingChat] = useState(false)

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

  // Feature 042 — translation toggle state, scoped to currently-selected conversation.
  const translateActive = !!(selectedConv?.id && translateActiveMap[selectedConv.id])
  const toggleTranslate = useCallback(() => {
    const convId = selectedConv?.id
    if (!convId) return
    setTranslateActiveMap(prev => {
      const next = !prev[convId]
      const updated = { ...prev }
      if (next) updated[convId] = true
      else delete updated[convId]
      try {
        if (typeof window !== 'undefined') {
          const key = `gp-translate-on:${convId}`
          if (next) window.localStorage.setItem(key, '1')
          else window.localStorage.removeItem(key)
        }
      } catch { /* ignore quota / private-mode errors */ }
      return updated
    })
  }, [selectedConv?.id])

  // Feature 042 — set of message ids currently being translated, across all
  // conversations. Serves two purposes: prevents duplicate in-flight requests
  // for the same message, and caps total concurrent provider calls at 4 so the
  // free Google endpoint doesn't get hammered when a long history is opened.
  const translateInFlightIds = useRef<Set<string>>(new Set())

  const enqueueTranslation = useCallback((messageId: string) => {
    if (translateInFlightIds.current.has(messageId)) return
    if (translateInFlightIds.current.size >= 4) return
    translateInFlightIds.current.add(messageId)
    setTranslations(prev => ({ ...prev, [messageId]: { status: 'loading' } }))
    apiTranslateMessage(messageId)
      .then(res => {
        setTranslations(prev => ({ ...prev, [messageId]: { text: res.translated, status: 'idle' } }))
        setConversations(prev =>
          prev.map(c => ({
            ...c,
            messages: c.messages.map(m =>
              m.id === messageId ? { ...m, contentTranslationEn: res.translated } : m
            ),
          }))
        )
      })
      .catch(() => {
        setTranslations(prev => ({ ...prev, [messageId]: { status: 'error' } }))
      })
      .finally(() => {
        translateInFlightIds.current.delete(messageId)
      })
  }, [])

  // Feature 042 — when toggle is on for the current conversation, bulk-fetch
  // translations for every inbound guest message missing one. Newest-first,
  // concurrency-capped at 4 (FR-007, research Decision 6).
  useEffect(() => {
    if (!translateActive || !selectedConv) return
    const candidates = [...selectedConv.messages]
      .filter(m =>
        m.sender === 'guest' &&
        !m.contentTranslationEn &&
        !translateInFlightIds.current.has(m.id) &&
        translations[m.id]?.status !== 'error' // errors require an explicit retry click
      )
      .reverse() // messages are stored asc by sentAt — reverse to prioritize newest

    for (const msg of candidates) {
      if (translateInFlightIds.current.size >= 4) break
      enqueueTranslation(msg.id)
    }
  }, [translateActive, selectedConv?.id, selectedConv?.messages, enqueueTranslation, translations])

  // Feature 043 — fetch open action-card tasks for the selected conversation.
  useEffect(() => {
    if (!selectedConv?.id) {
      setConversationTasks([])
      return
    }
    let cancelled = false
    apiListConversationTasks(selectedConv.id)
      .then(tasks => {
        if (cancelled) return
        // Only show OPEN tasks of types the registry renders.
        setConversationTasks(
          tasks.filter(t =>
            t.status === 'open' &&
            (t.type === 'late_checkout_request' || t.type === 'early_checkin_request')
          )
        )
      })
      .catch(() => {
        if (!cancelled) setConversationTasks([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedConv?.id])

  // Feature 043 — Socket.IO listeners: task_resolved removes cards; new_task
  // appends them; reservation_scheduled_updated refreshes the Property card.
  useEffect(() => {
    function onTaskResolved(data: { taskId: string; conversationId: string }) {
      if (!data?.taskId) return
      setConversationTasks(prev => prev.filter(t => t.id !== data.taskId))
    }
    function onNewTask(data: { conversationId: string; task: ApiTask }) {
      if (!data?.task) return
      if (selectedConv?.id !== data.conversationId) return
      if (data.task.type !== 'late_checkout_request' && data.task.type !== 'early_checkin_request') return
      setConversationTasks(prev => {
        if (prev.some(t => t.id === data.task.id)) return prev
        return [data.task, ...prev]
      })
    }
    function onReservationScheduledUpdated(data: {
      reservationId: string
      conversationId: string
      scheduledCheckInAt: string | null
      scheduledCheckOutAt: string | null
    }) {
      if (!data?.conversationId) return
      setConversations(prev =>
        prev.map(c => {
          if (c.id !== data.conversationId) return c
          return {
            ...c,
            property: {
              ...c.property,
              scheduledCheckInAt: data.scheduledCheckInAt,
              scheduledCheckOutAt: data.scheduledCheckOutAt,
            },
          }
        })
      )
    }

    socket.on('task_resolved', onTaskResolved)
    socket.on('new_task', onNewTask)
    socket.on('reservation_scheduled_updated', onReservationScheduledUpdated)

    return () => {
      socket.off('task_resolved', onTaskResolved)
      socket.off('new_task', onNewTask)
      socket.off('reservation_scheduled_updated', onReservationScheduledUpdated)
    }
  }, [selectedConv?.id])

  // Feature 042 — prune orphan localStorage keys for conversations that no
  // longer appear in this user's list. Runs once after the conversation list
  // first populates. Prevents unbounded growth for long-lived browser sessions.
  const translatePruneRan = useRef(false)
  useEffect(() => {
    if (translatePruneRan.current) return
    if (conversations.length === 0) return
    if (typeof window === 'undefined') return
    translatePruneRan.current = true
    try {
      const alive = new Set(conversations.map(c => c.id))
      const prefix = 'gp-translate-on:'
      const toRemove: string[] = []
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (!key?.startsWith(prefix)) continue
        const convId = key.slice(prefix.length)
        if (!alive.has(convId)) toRemove.push(key)
      }
      toRemove.forEach(k => window.localStorage.removeItem(k))
    } catch { /* ignore */ }
  }, [conversations])

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

  // ── Track previous connection status for reconnection banner ──
  useEffect(() => {
    prevStatusRef.current = connectionStatus
  }, [connectionStatus])

  // ── Effect 1: Load conversations + poll 30s ──
  useEffect(() => {
    async function load() {
      try {
        const data = await apiGetConversations()
        const mapped = data.map(summaryToConversation)
        setConversations(prev => {
          const updated = mapped.map(newConv => {
            const existing = prev.find(p => p.id === newConv.id)
            if (existing) {
              // Always preserve messages/guest/booking/property from existing state —
              // a list refresh must never wipe messages that SSE or mergeDetail already loaded.
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

          // Heartbeat: if selected conversation's timestamp changed, re-fetch detail
          const sel = selectedIdRef.current
          if (sel) {
            const oldConv = prev.find(c => c.id === sel)
            const newConv = updated.find(c => c.id === sel)
            if (oldConv && newConv && oldConv.timestamp !== newConv.timestamp) {
              apiGetConversation(sel).then(detail => {
                if (detail) {
                  setConversations(p => p.map(c => c.id === sel ? mergeDetail(c, detail) : c))
                  setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
                }
              }).catch(() => {})
            }
          }

          return updated
        })
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

  // ── Effect 2: Load detail on selection ──
  useEffect(() => {
    // Clear copilot suggestion, typing state, and FAQ suggestion when switching conversations
    setAiSuggestion(null)
    setAiTyping(false)
    setFaqSuggestion(null)
    seenMessageIds.current.clear()
    if (!selectedId) return

    let cancelled = false

    function loadDetail() {
      if (cancelled) return
      const fetchPromise = !fetchedDetails.current.has(selectedId)
        ? (setLoadingDetail(true), apiGetConversation(selectedId))
        : apiGetConversation(selectedId)

      fetchPromise
        .then(detail => {
          if (cancelled || !detail) return
          fetchedDetails.current.add(selectedId)
          try {
            setConversations(prev =>
              prev.map(c => (c.id === selectedId ? mergeDetail(c, detail) : c))
            )
          } catch (mergeErr) {
            console.error('[Inbox] mergeDetail crashed:', mergeErr, 'detail:', JSON.stringify(detail).slice(0, 500))
          }
          // Fetch pending copilot suggestion if in copilot mode
          if (detail?.reservation?.aiMode === 'copilot') {
            apiGetConversationSuggestion(selectedId)
              .then(data => { if (data?.suggestion) setAiSuggestion(data.suggestion) })
              .catch(() => {})
          }
        })
        .catch(err => console.error('[Inbox] apiGetConversation failed:', err))
        .finally(() => setLoadingDetail(false))
    }

    // Initial load
    loadDetail()

    // On-open sync: force=true to bypass 30s cooldown — the user explicitly
    // opened this conversation and expects fresh messages from Hostaway.
    apiSyncConversation(selectedId, true).then(res => {
      // If sync found new messages, refresh immediately
      if (res.newMessages && res.newMessages > 0) loadDetail()
    }).catch(() => {})

    return () => {
      cancelled = true
    }
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

  // ── Effect 3: Socket.IO real-time ──
  useEffect(() => {
    const token =
      typeof window !== 'undefined' ? localStorage.getItem('gp_token') : null
    if (!token) return

    connectSocket(token)

    // Connection events
    socket.on('connect', () => {
      wsFailCount.current = 0
      if (degradedPollTimer.current) {
        clearInterval(degradedPollTimer.current)
        degradedPollTimer.current = null
      }
      setConnectionStatus('connected')

      const wasDisconnected = prevStatusRef.current === 'reconnecting' || prevStatusRef.current === 'delayed'

      // ALWAYS re-fetch on reconnect — CSR is disabled, messages are lost during gaps
      if (selectedIdRef.current) {
        apiGetConversation(selectedIdRef.current).then(detail => {
          if (detail) {
            setConversations(prev => prev.map(c => c.id === selectedIdRef.current ? mergeDetail(c, detail) : c))
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          }
          // Show banner AFTER fetch completes (not before)
          if (wasDisconnected) {
            setShowReconnectedBanner(true)
            setTimeout(() => setShowReconnectedBanner(false), 3000)
          }
        }).catch(() => {
          if (wasDisconnected) {
            setShowReconnectedBanner(true)
            setTimeout(() => setShowReconnectedBanner(false), 3000)
          }
        })
      } else if (wasDisconnected) {
        setShowReconnectedBanner(true)
        setTimeout(() => setShowReconnectedBanner(false), 3000)
      }
    })

    socket.on('disconnect', () => {
      setConnectionStatus('reconnecting')
    })

    socket.on('connect_error', () => {
      wsFailCount.current++
      if (wsFailCount.current >= 3 && !degradedPollTimer.current) {
        setConnectionStatus('delayed')
        degradedPollTimer.current = setInterval(() => {
          if (selectedIdRef.current) {
            apiGetConversation(selectedIdRef.current).then(detail => {
              if (detail) {
                setConversations(prev => prev.map(c => c.id === selectedIdRef.current ? mergeDetail(c, detail) : c))
              }
            }).catch(() => {})
          }
        }, 5000)
      }
    })

    // Message events
    socket.on('message', (data: any, ack?: () => void) => {
      const convId = data.conversationId
      if (!convId || !data.message) { if (typeof ack === 'function') ack(); return }

      // Feature 040: Shadow Mode broadcasts the SAME message id twice — once when
      // the preview is created (previewState=PREVIEW_PENDING) and again when the
      // admin hits Send (previewState cleared). A pure "skip if seen" dedup would
      // drop the second broadcast and leave the preview bubble stuck. Instead,
      // we always let the event through and merge-by-id inside setConversations.

      const msg = data.message
      const sender = senderFromRole(data.lastMessageRole || msg.role)

      // If AI message arrived, stop typing indicator, clear suggestion, and clear streaming text
      if (sender === 'ai' && selectedIdRef.current === convId) {
        setAiTyping(false)
        setAiSuggestion(null)
        setStreamingText(prev => {
          const next = { ...prev }
          delete next[convId]
          return next
        })
      }

      // Play notification sound for new guest messages
      if (sender === 'guest') {
        try {
          const audio = new Audio('/notification.wav')
          audio.volume = 0.3
          audio.play().catch(() => {})
        } catch {}
      }

      // Clear old copilot suggestion when new guest message arrives (will be regenerated)
      if (data.message?.role === 'GUEST' || data.lastMessageRole === 'GUEST') {
        setAiSuggestion(null)
      }

      const newSseMsgs: Message[] = []
      // Prefer the real Message.id from the backend when present — enables Send/Edit targeting for shadow previews.
      const realMsgId: string = msg.id || `sse-${Date.now()}`
      if (sender === 'private') {
        const fromSelf = msg.role === 'AI_PRIVATE' || msg.role === 'MANAGER_PRIVATE'
        newSseMsgs.push({ id: realMsgId, sender: 'private', text: msg.content, time: formatTimestamp(msg.sentAt), fromSelf })
      } else {
        const resolved = msg.channel ? channelFromApi(msg.channel) : undefined
        // 'direct' is the catch-all fallback — treat as no channel so conversation channel is used
        const sseChannel = (resolved && resolved !== 'direct') ? resolved : undefined
        newSseMsgs.push({
          id: realMsgId,
          sender,
          text: msg.content,
          time: formatTimestamp(msg.sentAt),
          channel: sseChannel,
          // Shadow Mode preview fields — passed through from the extended 'message' payload
          previewState: msg.previewState,
          originalAiText: msg.originalAiText,
          editedByUserId: msg.editedByUserId,
          // AI metadata (confidence, autopilotDowngraded, etc.) — passed through
          // so the confidence badge renders instantly instead of only after refresh.
          ...(msg.aiMeta ? { aiMeta: msg.aiMeta } : {}),
        })
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
          // Merge-by-id: if the incoming message already exists (e.g. a shadow
          // preview being transitioned from PENDING → sent), update it in place
          // instead of appending a duplicate.
          const existingIds = new Set(c.messages.map(m => m.id))
          const updatedMsgs = c.messages.map(m => {
            const incoming = msgsWithChannel.find(n => n.id === m.id)
            if (!incoming) return m
            return {
              ...m,
              ...incoming,
              // Explicit previewState handling: the send broadcast omits
              // previewState entirely (meaning "cleared"), so we must set it to
              // undefined rather than letting the spread preserve the old value.
              previewState: incoming.previewState,
              originalAiText: incoming.originalAiText ?? m.originalAiText,
              editedByUserId: incoming.editedByUserId ?? m.editedByUserId,
            }
          })
          const appendNew = msgsWithChannel.filter(m => !existingIds.has(m.id))
          const allMsgs = [...updatedMsgs, ...appendNew]
          return {
            ...c,
            messages: allMsgs,
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
      if (typeof ack === 'function') ack()
    })

    // Copilot: AI generated a suggestion for host approval
    socket.on('ai_suggestion', (data: any, ack?: () => void) => {
      if (data.conversationId === selectedIdRef.current) {
        setAiTyping(false)
        setAiSuggestion(data.suggestion)
      }
      if (typeof ack === 'function') ack()
    })

    // Feature 040: Shadow Mode — older unsent previews just got locked by a newer preview
    socket.on('shadow_preview_locked', (data: any, ack?: () => void) => {
      const convId = data?.conversationId
      const lockedIds: string[] = Array.isArray(data?.lockedMessageIds) ? data.lockedMessageIds : []
      if (!convId || lockedIds.length === 0) { if (typeof ack === 'function') ack(); return }
      setConversations(prev =>
        prev.map(c => {
          if (c.id !== convId) return c
          return {
            ...c,
            // Unconditional transition: backend already confirmed these ids are
            // locked. Guarding on the current client previewState meant that
            // a stale or pre-fix client session (where previewState was missing)
            // would silently drop the event and leave the bubble stuck at
            // full opacity with no faded indication.
            messages: c.messages.map(m =>
              lockedIds.includes(m.id)
                ? { ...m, previewState: 'PREVIEW_LOCKED' as const }
                : m
            ),
          }
        })
      )
      // FR-011a: if the admin has an in-progress edit on one of the now-locked previews,
      // discard the edit buffer and surface a toast.
      setEditingPreviewId(prev => {
        if (prev && lockedIds.includes(prev)) {
          setPreviewEditBuffer('')
          setShadowToast('A newer preview replaced the one you were editing.')
          setTimeout(() => setShadowToast(null), 3500)
          return null
        }
        return prev
      })
      if (typeof ack === 'function') ack()
    })

    // AI decided not to send (empty message) — clear typing
    socket.on('ai_typing_clear', (data: any) => {
      if (data.conversationId === selectedIdRef.current) {
        setAiTyping(false)
      }
    })

    // Streaming AI response text — show progressive text instead of "Generating response..."
    socket.on('ai_typing_text', (data: any) => {
      const convId = data.conversationId
      if (data.done) {
        // Stream finished — clear streaming text (full message arrives via normal 'message' event)
        setStreamingText(prev => {
          const next = { ...prev }
          delete next[convId]
          return next
        })
        if (convId === selectedIdRef.current) {
          setAiTyping(false)
        }
      } else {
        // Accumulate delta text
        setStreamingText(prev => ({
          ...prev,
          [convId]: (prev[convId] || '') + data.delta,
        }))
        // Ensure typing indicator is on while streaming
        if (convId === selectedIdRef.current) {
          setAiTyping(true)
        }
        // Auto-scroll as text streams in
        if (convId === selectedIdRef.current) {
          setTimeout(
            () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
            30
          )
        }
      }
    })

    socket.on('reservation_created', () => {
      // New reservation arrived — refresh the conversation list so it appears immediately
      apiGetConversations()
        .then(data => {
          const mapped = data.map(summaryToConversation)
          setConversations(prev =>
            mapped.map(newConv => {
              const existing = prev.find(p => p.id === newConv.id)
              if (existing) {
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
        })
        .catch(err => console.error('[Socket] reservation_created list refresh failed:', err))
    })

    socket.on('reservation_updated', (data: any) => {
      const ids = data.conversationIds ?? []

      // Invalidate the detail cache so next selection triggers a fresh fetch
      ids.forEach((id: string) => fetchedDetails.current.delete(id))

      // Update reservationStatus in the sidebar list immediately from payload
      if (data.status) {
        setConversations(prev =>
          prev.map(c => ids.includes(c.id) ? { ...c, reservationStatus: data.status! } : c)
        )
      }

      // Re-fetch full detail for the currently selected conversation if it's affected
      const currentId = selectedIdRef.current
      if (currentId && ids.includes(currentId)) {
        setLoadingDetail(true)
        apiGetConversation(currentId)
          .then(detail => {
            fetchedDetails.current.add(currentId)
            setConversations(prev =>
              prev.map(c => (c.id === currentId ? mergeDetail(c, detail) : c))
            )
          })
          .catch(err => console.error('[Socket] reservation_updated re-fetch failed:', err))
          .finally(() => setLoadingDetail(false))
      }
    })

    // ── Mobile/Web sync events ──
    socket.on('ai_toggled', (data: any) => {
      try {
        setConversations(prev => prev.map(c =>
          c.id === data.conversationId ? { ...c, aiEnabled: data.aiEnabled } : c
        ))
      } catch { /* ignore */ }
    })

    socket.on('ai_mode_changed', (data: any) => {
      try {
        setConversations(prev => prev.map(c =>
          c.id === data.conversationId ? { ...c, aiMode: data.aiMode } : c
        ))
      } catch { /* ignore */ }
    })

    socket.on('conversation_starred', (data: any) => {
      try {
        setConversations(prev => prev.map(c =>
          c.id === data.conversationId ? { ...c, starred: data.starred } : c
        ))
      } catch { /* ignore */ }
    })

    socket.on('conversation_resolved', (data: any) => {
      try {
        setConversations(prev => prev.map(c =>
          c.id === data.conversationId ? { ...c, status: data.status } : c
        ))
      } catch { /* ignore */ }
    })

    socket.on('property_ai_changed', () => {
      apiGetConversations()
        .then(data => { if ((data as any)?.conversations) setConversations((data as any).conversations) })
        .catch(err => console.error('[Socket] property_ai_changed refresh failed:', err))
    })

    socket.on('faq_suggestion', (data: any) => {
      if (data.conversationId === selectedIdRef.current && data.suggestion) {
        setFaqSuggestion(data.suggestion)
      }
    })

    return () => {
      socket.off('connect')
      socket.off('disconnect')
      socket.off('connect_error')
      socket.off('message')
      socket.off('ai_suggestion')
      socket.off('shadow_preview_locked')
      socket.off('ai_typing_clear')
      socket.off('ai_typing_text')
      socket.off('reservation_created')
      socket.off('reservation_updated')
      socket.off('ai_toggled')
      socket.off('ai_mode_changed')
      socket.off('conversation_starred')
      socket.off('conversation_resolved')
      socket.off('property_ai_changed')
      socket.off('faq_suggestion')
      if (degradedPollTimer.current) clearInterval(degradedPollTimer.current)
      disconnectSocket()
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

  // ── FAQ suggestion handlers ──
  const handleFaqApprove = async () => {
    if (!faqSuggestion) return
    try {
      await apiUpdateFaqEntry(faqSuggestion.id, { status: 'ACTIVE', scope: faqSuggestionScope })
      setFaqSuggestion(null)
    } catch (err) { console.warn('FAQ approve failed:', err) }
  }

  const handleFaqReject = async () => {
    if (!faqSuggestion) return
    try {
      await apiUpdateFaqEntry(faqSuggestion.id, { status: 'ARCHIVED' })
      setFaqSuggestion(null)
    } catch (err) { console.warn('FAQ reject failed:', err) }
  }

  // ── Fetch hostaway connect status on mount ──
  useEffect(() => {
    apiGetHostawayConnectStatus()
      .then(s => setHostawayConnectStatus(s))
      .catch(() => {/* silent */})
  }, [])

  // ── Fetch last action when selected conversation changes ──
  useEffect(() => {
    if (!selectedConv?.reservationId) return
    const rid = selectedConv.reservationId
    if (lastActions[rid]) return // already cached
    apiGetLastAction(rid)
      .then(result => {
        if (result) setLastActions(prev => ({ ...prev, [rid]: result }))
      })
      .catch(() => {/* silent */})
  }, [selectedConv?.reservationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reservation action handler ──
  async function executeReservationAction(
    reservationId: string,
    action: 'approve' | 'reject' | 'cancel',
    conversationId?: string
  ) {
    if (!reservationId || actionInFlight[reservationId]) return

    setActionInFlight(prev => ({ ...prev, [reservationId]: action }))
    setActionResult(prev => { const next = { ...prev }; delete next[reservationId]; return next })

    try {
      const fn =
        action === 'approve' ? apiApproveReservation :
        action === 'reject' ? apiRejectReservation :
        apiCancelReservation
      await fn(reservationId)

      setActionResult(prev => ({ ...prev, [reservationId]: { status: 'success' } }))

      // Refresh last action cache
      apiGetLastAction(reservationId)
        .then(result => { if (result) setLastActions(prev => ({ ...prev, [reservationId]: result })) })
        .catch(() => {/* silent */})

      // Refresh conversations list to pick up status change
      setTimeout(async () => {
        try {
          const data = await apiGetConversations()
          setConversations(prev => {
            const newConvs = data.map(summaryToConversation)
            // Preserve loaded details for conversations that were already fetched
            return newConvs.map(nc => {
              const existing = prev.find(p => p.id === nc.id)
              return existing && existing.messages.length > 0
                ? { ...existing, checkInStatus: nc.checkInStatus, reservationId: nc.reservationId }
                : nc
            })
          })
        } catch { /* silent */ }
      }, 1000)

      // Auto-dismiss success after 1.5s
      setTimeout(() => {
        setActionResult(prev => { const next = { ...prev }; delete next[reservationId]; return next })
      }, 1500)
    } catch (err: unknown) {
      let message = 'Something went wrong'
      let suggestion: string | undefined
      if (err instanceof ApiError) {
        if (err.status === 403) {
          message = 'Hostaway dashboard not connected'
        } else if (err.status === 422) {
          suggestion = (err.data as any)?.suggestion || err.message
          message = err.message
        } else if (err.status === 502) {
          message = err.message || 'Hostaway API error'
        } else {
          message = err.message
        }
      } else if (err instanceof Error) {
        message = err.message
      }
      setActionResult(prev => ({ ...prev, [reservationId]: { status: 'error', message, suggestion } }))
    } finally {
      setActionInFlight(prev => { const next = { ...prev }; delete next[reservationId]; return next })
    }
  }

  function handleConfirmAction() {
    if (!confirmDialog) return
    executeReservationAction(confirmDialog.reservationId, confirmDialog.type, confirmDialog.conversationId)
    setConfirmDialog(null)
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
            <DataRow label="Hostaway Conv" value={selectedConv.booking.id} mono last />
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
            {/* Feature 043 — scheduled override replaces default with green "Modified" pill */}
            {(() => {
              const override = selectedConv.property.scheduledCheckInAt
              const defaultTime = selectedConv.property.checkInTime
              if (override) {
                return (
                  <DataRow
                    label="Check-in Time"
                    value={
                      <span title={`Default: ${defaultTime || '—'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: T.status.green, fontWeight: 600 }}>{friendlyTime(override)}</span>
                        <span style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          color: T.status.green,
                          background: T.status.green + '1A',
                          border: `1px solid ${T.status.green}33`,
                          padding: '1px 5px',
                          borderRadius: 4,
                        }}>Modified</span>
                      </span>
                    }
                  />
                )
              }
              return <DataRow label="Check-in Time" value={defaultTime} />
            })()}
            {(() => {
              const override = selectedConv.property.scheduledCheckOutAt
              const defaultTime = selectedConv.property.checkOutTime
              if (override) {
                return (
                  <DataRow
                    label="Check-out Time"
                    last
                    value={
                      <span title={`Default: ${defaultTime || '—'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: T.status.green, fontWeight: 600 }}>{friendlyTime(override)}</span>
                        <span style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          color: T.status.green,
                          background: T.status.green + '1A',
                          border: `1px solid ${T.status.green}33`,
                          padding: '1px 5px',
                          borderRadius: 4,
                        }}>Modified</span>
                      </span>
                    }
                  />
                )
              }
              return <DataRow label="Check-out Time" value={defaultTime} last />
            })()}
          </PanelSection>
        ))

      case 'tasks':
        return wrapPanelSection('tasks', (
          <div style={{ pointerEvents: wiggleMode ? 'none' : 'auto' }}>
            <TasksBox key={selectedConv.id} conversationId={selectedConv.id} dragHandle={dragHandle} />
            {/* Document Checklist — below tasks */}
            {selectedConv.documentChecklist && (
              <div style={{ marginTop: 16, padding: '8px 12px', background: T.bg.secondary, borderRadius: 8, border: `1px solid ${T.border.default}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FileText size={12} strokeWidth={2.5} />
                  DOCUMENTS
                </div>
                {/* Passports */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontFamily: T.font.sans, color: T.text.secondary }}>
                    Passports/IDs
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, fontFamily: T.font.mono,
                      color: selectedConv.documentChecklist.passportsReceived >= selectedConv.documentChecklist.passportsNeeded ? T.status.green : T.status.amber,
                    }}>
                      {selectedConv.documentChecklist.passportsReceived}/{selectedConv.documentChecklist.passportsNeeded}
                    </span>
                    <button
                      onClick={() => {
                        const current = selectedConv.documentChecklist!.passportsReceived
                        const needed = selectedConv.documentChecklist!.passportsNeeded
                        const next = current >= needed ? 0 : current + 1
                        apiUpdateConversationChecklist(selectedConv.id, { passportsReceived: next }).catch(console.error)
                        setConversations(prev => prev.map(c => c.id === selectedConv.id ? {
                          ...c, documentChecklist: { ...c.documentChecklist!, passportsReceived: next }
                        } : c))
                      }}
                      title="Toggle passport count"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', fontSize: 10, color: T.text.tertiary }}
                    >
                      {selectedConv.documentChecklist.passportsReceived >= selectedConv.documentChecklist.passportsNeeded ? <Check size={12} color={T.status.green} /> : <Circle size={12} />}
                    </button>
                  </div>
                </div>
                {/* Marriage Certificate */}
                {selectedConv.documentChecklist.marriageCertNeeded && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, fontFamily: T.font.sans, color: T.text.secondary }}>
                      Marriage Cert
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, fontFamily: T.font.mono,
                        color: selectedConv.documentChecklist.marriageCertReceived ? T.status.green : T.status.amber,
                      }}>
                        {selectedConv.documentChecklist.marriageCertReceived ? 'received' : 'pending'}
                      </span>
                      <button
                        onClick={() => {
                          const next = !selectedConv.documentChecklist!.marriageCertReceived
                          apiUpdateConversationChecklist(selectedConv.id, { marriageCertReceived: next }).catch(console.error)
                          setConversations(prev => prev.map(c => c.id === selectedConv.id ? {
                            ...c, documentChecklist: { ...c.documentChecklist!, marriageCertReceived: next }
                          } : c))
                        }}
                        title="Toggle marriage certificate"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', fontSize: 10, color: T.text.tertiary }}
                      >
                        {selectedConv.documentChecklist.marriageCertReceived ? <Check size={12} color={T.status.green} /> : <Circle size={12} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
          aria-label="Log out"
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
            { id: 'calendar', label: 'Calendar' },
            { id: 'analytics', label: 'Analytics' },
            { id: 'tasks', label: 'Tasks' },
            { id: 'settings', label: 'Settings' },
            { id: 'configure', label: 'Configure AI' },
            { id: 'logs', label: 'AI Logs' },
            { id: 'webhooks', label: 'Webhooks' },
            /* Pipeline tab removed */
            { id: 'sops', label: 'SOPs' },
            /* Examples tab removed — 013-sop-tool-routing */
            { id: 'tools', label: 'Tools' },
            { id: 'sandbox', label: 'Sandbox' },
            /* OPUS tab removed — 014-openai-migration */
            { id: 'listings', label: 'Listings' },
            { id: 'faqs', label: 'FAQs' },
            // Sprint 046 Session C — 'Studio' replaces the separate Tuning + Build tabs.
            // Old /build and /tuning routes 302 to /?tab=studio via the redirect stubs.
            { id: 'studio', label: 'Studio' },
            /* SOP Monitor tab removed */
          ] as { id: NavTab; label: string }[]
        ).map(tab => (
          <button
            key={tab.id}
            data-tab={tab.id}
            onClick={() => {
              setNavTab(tab.id)
            }}
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
                  aria-label="Toggle filters"
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
                    <button onClick={() => setFilterStatus('all')} aria-label="Clear status filter" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px', color: T.text.tertiary, height: '100%', display: 'flex', alignItems: 'center' }}>
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
                    <button onClick={() => setFilterAiMode('all')} aria-label="Clear AI mode filter" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px', color: T.text.tertiary, height: '100%', display: 'flex', alignItems: 'center' }}>
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

                    {/* Row 4: status pill + AI mode badge + inline actions */}
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
                          color: (!conv.aiOn || conv.aiMode === 'off') ? T.text.tertiary : conv.aiMode === 'autopilot' ? T.accent : T.status.green,
                          background: (!conv.aiOn || conv.aiMode === 'off') ? T.bg.tertiary : conv.aiMode === 'autopilot' ? T.accent + '14' : T.status.green + '14',
                          borderRadius: 999,
                          padding: '1px 5px',
                        }}
                      >
                        {(!conv.aiOn || conv.aiMode === 'off') ? 'OFF' : conv.aiMode === 'autopilot' ? 'AUTOPILOT' : 'COPILOT'}
                      </span>
                      {/* Inline reservation action buttons removed — actions available in conversation detail */}
                      {conv.reservationId && (conv.checkInStatus === 'upcoming' || conv.checkInStatus === 'checked-in' || conv.checkInStatus === 'checking-in-today' || conv.checkInStatus === 'checking-out-today') && (
                        <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
                          {(() => {
                            const rid = conv.reservationId
                            const inFlight = actionInFlight[rid]
                            const result = actionResult[rid]
                            if (result?.status === 'success') return <CheckCircle2 size={14} color={T.status.green} />
                            if (result?.status === 'error') return <span title={result.message}><AlertTriangle size={13} color={T.status.red} /></span>
                            return (
                              <button
                                disabled={!!inFlight}
                                onClick={(e) => { e.stopPropagation(); setConfirmDialog({ type: 'cancel', reservationId: rid, conversationId: conv.id }) }}
                                title="Cancel reservation"
                                style={{
                                  width: 22, height: 22, borderRadius: 4, border: 'none',
                                  background: inFlight === 'cancel' ? T.status.red + '44' : T.status.red + '18',
                                  color: T.status.red, cursor: inFlight ? 'not-allowed' : 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  transition: 'all 0.15s',
                                }}
                              >
                                {inFlight === 'cancel' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Ban size={12} />}
                              </button>
                            )
                          })()}
                        </div>
                      )}
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
                {/* Right: Refresh + Connection + Star + Archive + Translate + AI ON */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {/* Refresh chat — force-sync from Hostaway */}
                  <button
                    disabled={syncingChat}
                    onClick={async () => {
                      setSyncingChat(true)
                      try {
                        const res = await apiSyncConversation(selectedConv.id, true)
                        if (res.newMessages && res.newMessages > 0) {
                          const detail = await apiGetConversation(selectedConv.id)
                          if (detail) {
                            setConversations(prev => prev.map(c => c.id === selectedConv.id ? mergeDetail(c, detail) : c))
                            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
                          }
                        }
                      } catch {}
                      setSyncingChat(false)
                    }}
                    title="Refresh chat"
                    style={{
                      width: 30, height: 30,
                      borderRadius: 8,
                      border: `1px solid ${T.border.default}`,
                      cursor: syncingChat ? 'not-allowed' : 'pointer',
                      background: 'transparent',
                      color: T.text.secondary,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'all 0.2s',
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: syncingChat ? 'spin 1s linear infinite' : 'none' }}>
                      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                    </svg>
                  </button>
                  {/* Connection status */}
                  <ConnectionStatus status={connectionStatus} />
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
                    onClick={toggleTranslate}
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

              {/* Reconnected banner */}
              {showReconnectedBanner && (
                <div style={{
                  background: '#22c55e', color: 'white', padding: '6px 16px',
                  fontSize: 13, fontWeight: 500, textAlign: 'center' as const,
                }}>
                  Back online — messages synced
                </div>
              )}
              {/* Feature 040: Shadow Mode toast */}
              {shadowToast && (
                <div style={{
                  background: T.status.amber, color: 'white', padding: '6px 16px',
                  fontSize: 13, fontWeight: 500, textAlign: 'center' as const,
                }}>
                  {shadowToast}
                </div>
              )}

              {/* FAQ suggestion banner */}
              <div style={{
                maxHeight: faqSuggestion ? 120 : 0,
                opacity: faqSuggestion ? 1 : 0,
                overflow: 'hidden',
                transition: 'max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease',
              }}>
                {faqSuggestion && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 16px',
                    background: '#FFFBEB',
                    borderBottom: '1px solid #F59E0B22',
                    fontSize: 12,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: '#92400E' }}>FAQ suggestion </span>
                      <span style={{ color: '#78716C' }}>
                        {faqSuggestion.question} — <span style={{ fontStyle: 'italic' }}>{faqSuggestion.answer}</span>
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <select
                        value={faqSuggestionScope}
                        onChange={(e) => setFaqSuggestionScope(e.target.value as 'PROPERTY' | 'GLOBAL')}
                        style={{
                          fontSize: 11, padding: '3px 6px', borderRadius: 4,
                          border: '1px solid #D6D3D1', background: 'white', color: '#57534E', cursor: 'pointer',
                        }}
                      >
                        <option value="PROPERTY">Property</option>
                        <option value="GLOBAL">Global</option>
                      </select>
                      <button onClick={handleFaqApprove} style={{
                        padding: '3px 10px', background: '#16a34a', color: 'white',
                        border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        transition: 'background 0.15s',
                      }} onMouseOver={e => (e.currentTarget.style.background = '#15803d')}
                         onMouseOut={e => (e.currentTarget.style.background = '#16a34a')}>
                        Save
                      </button>
                      <button onClick={handleFaqReject} style={{
                        padding: '3px 10px', background: 'transparent', color: '#A8A29E',
                        border: '1px solid #E7E5E4', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer',
                        transition: 'all 0.15s',
                      }} onMouseOver={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.borderColor = '#fca5a5' }}
                         onMouseOut={e => { e.currentTarget.style.color = '#A8A29E'; e.currentTarget.style.borderColor = '#E7E5E4' }}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
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
                  (() => {
                    // Feature 040: compute the id of the latest PREVIEW_PENDING message in the
                    // current conversation — only this message gets Send/Edit action buttons.
                    const latestPendingPreviewId = (() => {
                      for (let i = selectedConv.messages.length - 1; i >= 0; i--) {
                        if (selectedConv.messages[i].previewState === 'PREVIEW_PENDING') {
                          return selectedConv.messages[i].id
                        }
                      }
                      return null
                    })()
                    return selectedConv.messages
                  .filter(msg => {
                    // Hide alteration system messages from thread (shown in right panel instead)
                    const t = (msg.text || '').toLowerCase()
                    if (msg.sender === 'guest' && (
                      t.includes('alteration request') ||
                      t.includes('reservation alteration') ||
                      t.includes('modification request') ||
                      t.includes('wants to change') ||
                      t.includes('alteration has been')
                    )) return false
                    return true
                  })
                  .map(msg => {
                    const isGuest = msg.sender === 'guest'
                    const isAI = msg.sender === 'ai'
                    const isHost = msg.sender === 'host'
                    const isPrivate = msg.sender === 'private'
                    const isLeft = isGuest
                    // Feature 040: Shadow Mode preview bubble detection
                    const isPreview = isAI && (msg.previewState === 'PREVIEW_PENDING' || msg.previewState === 'PREVIEW_LOCKED' || msg.previewState === 'PREVIEW_SENDING')
                    const isLockedPreview = msg.previewState === 'PREVIEW_LOCKED'

                    const bubbleBg = isGuest
                      ? T.bg.secondary
                      : isLockedPreview
                      ? T.bg.tertiary // muted gray for superseded previews — visually "done"
                      : isPreview
                      ? T.status.amber + '14' // amber tint for active preview bubbles
                      : isAI
                      ? T.accent + '0D'
                      : isPrivate
                      ? T.status.amber + '1F'
                      : T.accent + '0D'

                    const bubbleBorder = isLockedPreview
                      ? T.border.default // neutral border for locked previews
                      : isPreview
                      ? T.status.amber + '80'
                      : isPrivate
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
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  crossOrigin="anonymous"
                                  onClick={() => setImageModalUrl(url)}
                                  style={{
                                    maxWidth: 180,
                                    maxHeight: 140,
                                    borderRadius: 6,
                                    objectFit: 'cover',
                                    cursor: 'pointer',
                                    border: `1px solid ${T.border.default}`,
                                    background: T.bg.secondary,
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
                              opacity: isLockedPreview ? 0.6 : 1,
                            }}
                          >
                            {/* Feature 040: "Not sent to guest" pill for shadow-mode previews */}
                            {isPreview && (
                              <div
                                style={{
                                  display: 'inline-block',
                                  fontSize: 10,
                                  fontWeight: 700,
                                  textTransform: 'uppercase',
                                  letterSpacing: 0.3,
                                  color: T.status.amber,
                                  background: T.status.amber + '1F',
                                  border: `1px solid ${T.status.amber + '60'}`,
                                  borderRadius: 4,
                                  padding: '1px 6px',
                                  marginBottom: 4,
                                }}
                              >
                                {isLockedPreview ? 'Superseded — not sent' : 'Not sent to guest'}
                              </div>
                            )}
                            {isPreview && <br />}
                            {msg.text}
                            {/* Feature 042: inline translation block — inbound guest messages only,
                                rendered directly below the original in the same bubble (FR-011, FR-012). */}
                            {isGuest && translateActive && (() => {
                              const tx = translations[msg.id]
                              const translated = msg.contentTranslationEn || tx?.text
                              const isSameAsOriginal =
                                translated &&
                                translated.trim().toLowerCase() === (msg.text || '').trim().toLowerCase()
                              // Skip entirely for already-English sources (FR-006).
                              if (translated && isSameAsOriginal) return null
                              if (translated) {
                                return (
                                  <>
                                    <div
                                      style={{
                                        marginTop: 6,
                                        paddingTop: 6,
                                        borderTop: `1px solid ${T.border.default}`,
                                        fontSize: 12,
                                        lineHeight: 1.5,
                                        color: T.text.secondary,
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                      }}
                                    >
                                      <span
                                        style={{
                                          display: 'inline-block',
                                          fontSize: 9,
                                          fontWeight: 700,
                                          textTransform: 'uppercase',
                                          letterSpacing: 0.4,
                                          color: T.text.tertiary,
                                          marginRight: 6,
                                          verticalAlign: 'middle',
                                        }}
                                      >
                                        Translated
                                      </span>
                                      {translated}
                                    </div>
                                  </>
                                )
                              }
                              if (tx?.status === 'loading') {
                                return (
                                  <div
                                    style={{
                                      marginTop: 6,
                                      paddingTop: 6,
                                      borderTop: `1px solid ${T.border.default}`,
                                      fontSize: 11,
                                      color: T.text.tertiary,
                                      fontStyle: 'italic',
                                    }}
                                  >
                                    Translating…
                                  </div>
                                )
                              }
                              if (tx?.status === 'error') {
                                return (
                                  <div
                                    style={{
                                      marginTop: 6,
                                      paddingTop: 6,
                                      borderTop: `1px solid ${T.border.default}`,
                                      fontSize: 11,
                                      color: T.status.red,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 6,
                                    }}
                                  >
                                    <span>Translation unavailable</span>
                                    <button
                                      onClick={() => {
                                        setTranslations(prev => {
                                          const next = { ...prev }
                                          delete next[msg.id]
                                          return next
                                        })
                                        enqueueTranslation(msg.id)
                                      }}
                                      style={{
                                        background: 'transparent',
                                        border: `1px solid ${T.border.default}`,
                                        borderRadius: 4,
                                        padding: '1px 6px',
                                        fontSize: 10,
                                        color: T.text.secondary,
                                        cursor: 'pointer',
                                      }}
                                    >
                                      Retry
                                    </button>
                                  </div>
                                )
                              }
                              return null
                            })()}
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
                            {/* SOP & tool badges for AI messages */}
                            {isAI && msg.aiMeta?.sopCategories?.length ? (
                              <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                                {msg.aiMeta.sopCategories.map((sop: string) => (
                                  <span
                                    key={sop}
                                    title={sop}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 2,
                                      fontSize: 9,
                                      fontFamily: T.font.mono,
                                      color: T.text.tertiary,
                                      background: T.accent + '12',
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                    }}
                                  >
                                    <FileText size={8} strokeWidth={2} />
                                    {sop.replace('sop-', '').replace(/-/g, ' ')}
                                  </span>
                                ))}
                                {(msg.aiMeta.toolNames || (msg.aiMeta.toolName ? [msg.aiMeta.toolName] : [])).map((tn: string) => (
                                  <span
                                    key={tn}
                                    title={`Tool: ${tn}`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 2,
                                      fontSize: 9,
                                      fontFamily: T.font.mono,
                                      color: tn === 'get_faq' ? '#0891B2' : T.text.tertiary,
                                      background: tn === 'get_faq' ? '#0891B218' : T.status.amber + '18',
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                    }}
                                  >
                                    <Wrench size={8} strokeWidth={2} />
                                    {tn.replace(/_/g, ' ')}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            {/* Confidence badge — self-rated by the AI per reply (0-1) */}
                            {isAI && typeof msg.aiMeta?.confidence === 'number' ? (() => {
                              const c = msg.aiMeta.confidence as number
                              const pct = Math.round(c * 100)
                              const tier = c >= 0.90 ? 'high' : c >= 0.70 ? 'good' : c >= 0.50 ? 'fair' : 'low'
                              const palette = tier === 'high'
                                ? { fg: T.status.green, bg: T.status.green + '18' }
                                : tier === 'good'
                                  ? { fg: '#0891B2', bg: '#0891B218' }
                                  : tier === 'fair'
                                    ? { fg: T.status.amber, bg: T.status.amber + '18' }
                                    : { fg: T.status.red, bg: T.status.red + '18' }
                              const tip = msg.aiMeta?.autopilotDowngraded
                                ? `Confidence ${pct}% — below your autopilot threshold, so this reply is held for review`
                                : `Self-rated confidence: ${pct}% (${tier === 'high' ? 'unambiguous' : tier === 'good' ? 'minor uncertainty' : tier === 'fair' ? 'material uncertainty' : 'high uncertainty'})`
                              return (
                                <span
                                  title={tip}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 3,
                                    fontSize: 9,
                                    fontFamily: T.font.mono,
                                    fontWeight: 700,
                                    color: palette.fg,
                                    background: palette.bg,
                                    padding: '1px 5px',
                                    borderRadius: 4,
                                    marginLeft: 3,
                                  }}
                                >
                                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: palette.fg }} />
                                  {pct}%
                                  {msg.aiMeta?.autopilotDowngraded && (
                                    <span style={{ marginLeft: 2, opacity: 0.8 }}>• held</span>
                                  )}
                                </span>
                              )
                            })() : null}
                            {/* AI message rating buttons */}
                            {isAI && (
                              <span style={{ display: 'flex', gap: 2, marginLeft: 2, alignItems: 'center' }}>
                                <button
                                  onClick={() => {
                                    const newRating = 'positive' as const
                                    setMessageRatings(r => ({ ...r, [msg.id]: newRating }))
                                    setCorrectionMsgId(null)
                                    apiRateMessage(msg.id, newRating).catch(err => console.error('[Rate] Failed to rate message:', err))
                                  }}
                                  title="Good response (reinforces AI learning)"
                                  aria-label="Rate response as good"
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
                                    apiRateMessage(msg.id, newRating).catch(err => console.error('[Rate] Failed to rate message:', err))
                                    // Toggle correction popover
                                    if (correctionMsgId === msg.id) {
                                      setCorrectionMsgId(null)
                                    } else {
                                      setCorrectionMsgId(msg.id)
                                      setCorrectionLabels([])
                                    }
                                  }}
                                  title="Poor response (click to add correction labels)"
                                  aria-label="Rate response as poor"
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
                                {correctionSubmitted[msg.id] && (
                                  <span style={{ fontSize: 9, color: T.status.green, fontFamily: T.font.mono }}>
                                    correction saved
                                  </span>
                                )}
                                {/* Feature 041 sprint 04 — anchor this message into a tuning conversation */}
                                <button
                                  onClick={async () => {
                                    try {
                                      const { conversation } = await apiCreateTuningConversation({
                                        anchorMessageId: msg.id,
                                        triggerType: 'MANUAL',
                                      })
                                      // Sprint 046 Session C — in-place tab switch instead of route transition.
                                      updateStudioConversationId(conversation.id)
                                      setNavTab('studio')
                                    } catch (err) {
                                      console.error('[DiscussInTuning] failed:', err)
                                    }
                                  }}
                                  title="Open a Studio chat anchored to this message"
                                  aria-label="Discuss this message in Studio"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '1px 4px',
                                    marginLeft: 2,
                                    color: T.text.tertiary + 'AA',
                                    fontSize: 9,
                                    fontFamily: T.font.mono,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.08em',
                                  }}
                                >
                                  discuss in tuning
                                </button>
                              </span>
                            )}
                            {/* Correction popover — appears below thumbs-down for AI messages */}
                            {isAI && correctionMsgId === msg.id && !correctionSubmitted[msg.id] && (
                              <div
                                style={{
                                  marginTop: 4,
                                  padding: '6px 8px',
                                  background: '#FFF',
                                  border: `1px solid ${T.border.default}`,
                                  borderRadius: 6,
                                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                                  maxWidth: 320,
                                }}
                              >
                                <div style={{ fontSize: 10, fontWeight: 600, color: T.text.secondary, marginBottom: 4 }}>
                                  Correct classification (select SOPs):
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
                                  {SOP_LABELS.map(label => {
                                    const sel = correctionLabels.includes(label)
                                    return (
                                      <button
                                        key={label}
                                        onClick={() => {
                                          setCorrectionLabels(prev =>
                                            sel ? prev.filter(l => l !== label) : [...prev, label]
                                          )
                                        }}
                                        style={{
                                          fontSize: 9,
                                          padding: '2px 5px',
                                          borderRadius: 3,
                                          border: `1px solid ${sel ? T.accent : T.border.default}`,
                                          background: sel ? T.accent + '15' : 'transparent',
                                          color: sel ? T.accent : T.text.secondary,
                                          cursor: 'pointer',
                                          fontFamily: T.font.mono,
                                          transition: 'all 0.1s ease',
                                        }}
                                      >
                                        {label.replace('sop-', '')}
                                      </button>
                                    )
                                  })}
                                </div>
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button
                                    disabled={correctionLabels.length === 0}
                                    onClick={() => {
                                      apiRateMessage(msg.id, 'negative', correctionLabels).catch(err => console.error('[Rate] Failed to submit correction:', err))
                                      setCorrectionSubmitted(s => ({ ...s, [msg.id]: true }))
                                      setCorrectionMsgId(null)
                                    }}
                                    style={{
                                      fontSize: 10,
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      border: 'none',
                                      background: correctionLabels.length > 0 ? T.accent : T.bg.tertiary,
                                      color: correctionLabels.length > 0 ? '#FFF' : T.text.tertiary,
                                      cursor: correctionLabels.length > 0 ? 'pointer' : 'not-allowed',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Submit correction ({correctionLabels.length})
                                  </button>
                                  <button
                                    onClick={() => setCorrectionMsgId(null)}
                                    style={{
                                      fontSize: 10,
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      border: `1px solid ${T.border.default}`,
                                      background: 'transparent',
                                      color: T.text.secondary,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                          {/* Feature 040: Shadow Mode Send/Edit actions — only on the latest PENDING preview */}
                          {isPreview && msg.previewState === 'PREVIEW_PENDING' && msg.id === latestPendingPreviewId && (
                            <div style={{ marginTop: 6 }}>
                              {editingPreviewId === msg.id ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <textarea
                                    value={previewEditBuffer}
                                    onChange={e => setPreviewEditBuffer(e.target.value)}
                                    rows={4}
                                    style={{
                                      width: '100%',
                                      padding: '6px 8px',
                                      fontSize: 13,
                                      fontFamily: T.font.sans,
                                      color: T.text.primary,
                                      background: T.bg.primary,
                                      border: `1px solid ${T.border.default}`,
                                      borderRadius: 6,
                                      outline: 'none',
                                      resize: 'vertical',
                                      boxSizing: 'border-box',
                                    }}
                                  />
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button
                                      disabled={sendingPreviewId === msg.id}
                                      onClick={async () => {
                                        const finalText = previewEditBuffer.trim()
                                        if (!finalText) return
                                        setSendingPreviewId(msg.id)
                                        try {
                                          await apiSendShadowPreview(msg.id, finalText !== msg.text ? finalText : undefined)
                                          setEditingPreviewId(null)
                                          setPreviewEditBuffer('')
                                        } catch (err: any) {
                                          const detail = err?.data?.error || err?.message || 'Send failed'
                                          if (detail === 'PREVIEW_NOT_PENDING') {
                                            setShadowToast('This preview has already been superseded.')
                                          } else if (detail === 'HOSTAWAY_DELIVERY_FAILED') {
                                            setShadowToast('Send failed — guest channel rejected the message.')
                                          } else {
                                            setShadowToast('Send failed.')
                                          }
                                          setTimeout(() => setShadowToast(null), 3500)
                                        } finally {
                                          setSendingPreviewId(null)
                                        }
                                      }}
                                      style={{
                                        padding: '4px 12px',
                                        fontSize: 12,
                                        fontWeight: 600,
                                        color: '#fff',
                                        background: sendingPreviewId === msg.id ? T.bg.tertiary : T.accent,
                                        border: 'none',
                                        borderRadius: 5,
                                        cursor: sendingPreviewId === msg.id ? 'not-allowed' : 'pointer',
                                      }}
                                    >
                                      {sendingPreviewId === msg.id ? 'Sending…' : 'Send edited'}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setEditingPreviewId(null)
                                        setPreviewEditBuffer('')
                                      }}
                                      style={{
                                        padding: '4px 12px',
                                        fontSize: 12,
                                        fontWeight: 600,
                                        color: T.text.secondary,
                                        background: 'transparent',
                                        border: `1px solid ${T.border.default}`,
                                        borderRadius: 5,
                                        cursor: 'pointer',
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button
                                    disabled={sendingPreviewId === msg.id}
                                    onClick={async () => {
                                      setSendingPreviewId(msg.id)
                                      try {
                                        await apiSendShadowPreview(msg.id)
                                      } catch (err: any) {
                                        const detail = err?.data?.error || err?.message || 'Send failed'
                                        if (detail === 'PREVIEW_NOT_PENDING') {
                                          setShadowToast('This preview has already been superseded.')
                                        } else if (detail === 'HOSTAWAY_DELIVERY_FAILED') {
                                          setShadowToast('Send failed — guest channel rejected the message.')
                                        } else {
                                          setShadowToast('Send failed.')
                                        }
                                        setTimeout(() => setShadowToast(null), 3500)
                                      } finally {
                                        setSendingPreviewId(null)
                                      }
                                    }}
                                    style={{
                                      padding: '4px 14px',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      color: '#fff',
                                      background: sendingPreviewId === msg.id ? T.bg.tertiary : T.accent,
                                      border: 'none',
                                      borderRadius: 5,
                                      cursor: sendingPreviewId === msg.id ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    {sendingPreviewId === msg.id ? 'Sending…' : 'Send'}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditingPreviewId(msg.id)
                                      setPreviewEditBuffer(msg.text)
                                    }}
                                    style={{
                                      padding: '4px 14px',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      color: T.text.primary,
                                      background: T.bg.secondary,
                                      border: `1px solid ${T.border.default}`,
                                      borderRadius: 5,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Edit
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })
                  })()
                )}

                {/* Streaming AI text bubble — shows progressive text while AI generates */}
                {selectedConv && streamingText[selectedConv.id] && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      padding: '0 16px',
                    }}
                  >
                    <div style={{
                      maxWidth: '75%',
                      padding: '10px 14px',
                      borderRadius: '14px 14px 4px 14px',
                      background: T.accent + '0D',
                      border: `1px solid ${T.accent}22`,
                      fontSize: 13,
                      lineHeight: 1.55,
                      color: T.text.primary,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {streamingText[selectedConv.id]}
                      <span style={{
                        display: 'inline-block',
                        width: 5,
                        height: 14,
                        background: T.accent,
                        marginLeft: 1,
                        borderRadius: 1,
                        animation: 'gp-cursor-blink 0.8s step-end infinite',
                        verticalAlign: 'text-bottom',
                      }} />
                    </div>
                  </div>
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
                              ? (selectedConv.aiMode === 'copilot'
                                ? <ShimmerText text="Copilot is generating a response…" />
                                : streamingText[selectedConv.id]
                                  ? <span style={{ fontWeight: 400 }}>Streaming response…</span>
                                  : <ShimmerText text="Generating response…" />)
                              : aiSuggestion ?? (selectedConv.aiMode === 'copilot' ? 'Copilot will suggest replies' : 'AI is handling responses automatically')}
                            {aiSuggestion && (
                              <button
                                onClick={async () => {
                                  const s = aiSuggestion
                                  setAiSuggestion(null)
                                  try { await apiApproveSuggestion(selectedConv.id, s) } catch { setAiSuggestion(s) }
                                }}
                                title="Send this response"
                                aria-label="Approve and send AI suggestion"
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
                        aria-label="Attach file"
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
                        aria-label="Send property link"
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
                        aria-label="Add task"
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
                          aria-label="Choose send channel"
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
                        aria-label="Send private note"
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
                        aria-label="Send message"
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
                  aria-label="Reorder detail sections"
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
              {/* ── Reservation Action Block ── */}
              {(() => {
                const st = selectedConv.checkInStatus
                const rid = selectedConv.reservationId
                const isActionable = rid && (st === 'inquiry' || st === 'pending' || st === 'upcoming' || st === 'checked-in' || st === 'checking-in-today' || st === 'checking-out-today')
                if (!isActionable) return null

                const inFlight = rid ? actionInFlight[rid] : undefined
                const result = rid ? actionResult[rid] : undefined
                const lastAction = rid ? lastActions[rid] : undefined
                const showApproveReject = st === 'inquiry' || st === 'pending'
                const showCancel = false

                // Compute time remaining for inquiry/pending (24h from creation)
                let timeRemaining: string | null = null
                if (showApproveReject && selectedConv.reservationCreatedAt) {
                  const created = new Date(selectedConv.reservationCreatedAt).getTime()
                  const expiresAt = created + 24 * 60 * 60 * 1000
                  const msLeft = expiresAt - Date.now()
                  if (msLeft > 0) {
                    const hours = Math.floor(msLeft / (60 * 60 * 1000))
                    const mins = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000))
                    timeRemaining = hours > 0 ? `${hours}h ${mins}m left to respond` : `${mins}m left to respond`
                  }
                }

                return (
                  <div
                    style={{
                      background: T.bg.primary,
                      border: `1px solid ${T.border.default}`,
                      borderRadius: 8,
                      marginBottom: 8,
                      overflow: 'hidden',
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
                      <ShieldAlert size={12} color={T.text.tertiary} />
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
                        ACTIONS
                      </span>
                      {timeRemaining && (
                        <span style={{
                          marginLeft: 'auto',
                          fontSize: 11,
                          fontWeight: 600,
                          color: T.status.amber,
                          fontFamily: T.font.sans,
                        }}>
                          {timeRemaining}
                        </span>
                      )}
                    </div>
                    <div style={{ padding: 12 }}>
                      {/* Success flash */}
                      {result?.status === 'success' && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '8px 12px', borderRadius: 6,
                          background: T.status.green + '14', color: T.status.green,
                          fontSize: 12, fontWeight: 600, marginBottom: 8,
                        }}>
                          <CheckCircle2 size={14} />
                          Action completed
                        </div>
                      )}

                      {/* Error state */}
                      {result?.status === 'error' && (
                        <div style={{
                          padding: '8px 12px', borderRadius: 6,
                          background: T.status.red + '14',
                          fontSize: 12, marginBottom: 8,
                        }}>
                          <div style={{ color: T.status.red, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <AlertTriangle size={13} />
                            {result.message || 'Action failed'}
                          </div>
                          {result.suggestion && (
                            <div style={{ color: T.text.secondary, fontSize: 11, marginBottom: 6 }}>
                              {result.suggestion}
                            </div>
                          )}
                          {result.message === 'Hostaway dashboard not connected' ? (
                            <button
                              onClick={() => setNavTab('settings')}
                              style={{
                                fontSize: 11, fontWeight: 600, color: T.accent,
                                background: 'none', border: 'none', cursor: 'pointer',
                                padding: 0, textDecoration: 'underline',
                              }}
                            >
                              Go to Settings to connect
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setActionResult(prev => { const next = { ...prev }; delete next[rid]; return next })
                              }}
                              style={{
                                fontSize: 11, fontWeight: 600, color: T.accent,
                                background: 'none', border: `1px solid ${T.accent}`,
                                borderRadius: 4, cursor: 'pointer', padding: '2px 8px',
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                              }}
                            >
                              <RefreshCw size={10} />
                              Retry
                            </button>
                          )}
                        </div>
                      )}

                      {/* Action buttons */}
                      {result?.status !== 'success' && (
                        <div style={{ display: 'flex', gap: 8 }}>
                          {showApproveReject && (
                            <>
                              <button
                                disabled={!!inFlight}
                                onClick={() => executeReservationAction(rid, 'approve', selectedConv.id)}
                                style={{
                                  flex: 1, padding: '8px 0', borderRadius: 6, border: 'none',
                                  fontSize: 13, fontWeight: 600, cursor: inFlight ? 'not-allowed' : 'pointer',
                                  fontFamily: T.font.sans, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                  background: inFlight === 'approve' ? T.status.green + '44' : T.status.green,
                                  color: '#fff', opacity: inFlight && inFlight !== 'approve' ? 0.5 : 1,
                                  transition: 'all 0.15s',
                                }}
                              >
                                {inFlight === 'approve' ? (
                                  <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Approving...</>
                                ) : (
                                  <><Check size={14} /> Approve</>
                                )}
                              </button>
                              <button
                                disabled={!!inFlight}
                                onClick={() => setConfirmDialog({ type: 'reject', reservationId: rid, conversationId: selectedConv.id })}
                                style={{
                                  flex: 1, padding: '8px 0', borderRadius: 6, border: 'none',
                                  fontSize: 13, fontWeight: 600, cursor: inFlight ? 'not-allowed' : 'pointer',
                                  fontFamily: T.font.sans, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                  background: inFlight === 'reject' ? T.status.red + '44' : T.status.red,
                                  color: '#fff', opacity: inFlight && inFlight !== 'reject' ? 0.5 : 1,
                                  transition: 'all 0.15s',
                                }}
                              >
                                {inFlight === 'reject' ? (
                                  <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Rejecting...</>
                                ) : (
                                  <><X size={14} /> Reject</>
                                )}
                              </button>
                            </>
                          )}
                          {showCancel && (
                            <button
                              disabled={!!inFlight}
                              onClick={() => setConfirmDialog({ type: 'cancel', reservationId: rid, conversationId: selectedConv.id })}
                              style={{
                                flex: 1, padding: '8px 0', borderRadius: 6, border: 'none',
                                fontSize: 13, fontWeight: 600, cursor: inFlight ? 'not-allowed' : 'pointer',
                                fontFamily: T.font.sans, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                background: inFlight === 'cancel' ? T.status.red + '44' : T.status.red,
                                color: '#fff', opacity: inFlight && inFlight !== 'cancel' ? 0.5 : 1,
                                transition: 'all 0.15s',
                              }}
                            >
                              {inFlight === 'cancel' ? (
                                <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Cancelling...</>
                              ) : (
                                <><Ban size={14} /> Cancel Reservation</>
                              )}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Last action label */}
                      {lastAction && (
                        <div style={{
                          marginTop: 8, fontSize: 11, color: T.text.tertiary,
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                          <Clock size={10} />
                          {lastAction.action.charAt(0).toUpperCase() + lastAction.action.slice(1).toLowerCase()}d by {lastAction.initiatedBy.split('@')[0]}
                          {', '}
                          {(() => {
                            const diff = Date.now() - new Date(lastAction.createdAt).getTime()
                            const mins = Math.floor(diff / 60000)
                            if (mins < 1) return 'just now'
                            if (mins < 60) return `${mins}m ago`
                            const hours = Math.floor(mins / 60)
                            if (hours < 24) return `${hours}h ago`
                            const days = Math.floor(hours / 24)
                            return `${days}d ago`
                          })()}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
              {/* Alteration Panel — right panel */}
              <AlterationPanel
                key={`alteration-${selectedConv.reservationId}`}
                reservationId={selectedConv.reservationId}
              />
              {/* Feature 043 — action-card registry renders late-checkout /
                   early-check-in tasks alongside alteration actions. Other
                   escalation types plug in via action-card-registry.ts. */}
              {conversationTasks.length > 0 && (
                <div style={{ padding: '0 12px 12px' }}>
                  {conversationTasks.map(task => {
                    const Renderer = getActionCardFor(task)
                    if (!Renderer) return null
                    return (
                      <Renderer
                        key={task.id}
                        task={task}
                        onResolved={(taskId) => {
                          setConversationTasks(prev => prev.filter(t => t.id !== taskId))
                        }}
                        onReservationUpdated={(reservation) => {
                          setConversations(prev =>
                            prev.map(c => {
                              if (c.id !== selectedConv.id) return c
                              return {
                                ...c,
                                property: {
                                  ...c.property,
                                  scheduledCheckInAt: reservation.scheduledCheckInAt,
                                  scheduledCheckOutAt: reservation.scheduledCheckOutAt,
                                },
                              }
                            })
                          )
                        }}
                      />
                    )
                  })}
                </div>
              )}
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
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <OverviewV5
            conversations={conversations}
            onSelectConversation={id => {
              setSelectedId(id)
              setNavTab('inbox')
            }}
          />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'calendar' && (
        <ErrorBoundary>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <CalendarV5 onSelectConversation={id => { setSelectedId(id); setNavTab('inbox') }} />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'analytics' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <AnalyticsV5 />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'tasks' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TasksV5 />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'settings' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <SettingsV5 onImportComplete={() => {
            apiGetConversations().then(data => setConversations(data.map(summaryToConversation))).catch(err => console.error('[Settings] Failed to refresh conversations:', err))
          }} />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'configure' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ConfigureAiV5 />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'logs' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <AiLogsV5 />
        </div>
        </ErrorBoundary>
      )}
      {navTab === 'webhooks' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <WebhookLogsV5 />
        </div>
        </ErrorBoundary>
      )}
      {/* Pipeline tab removed */}
      {navTab === 'sops' && (
        <ErrorBoundary>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <SopEditorV5 />
        </div>
        </ErrorBoundary>
      )}
      {/* Examples tab removed — classifier training data no longer managed (013-sop-tool-routing) */}
      {navTab === 'tools' && (
        <ErrorBoundary>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ToolsV5 />
        </div>
        </ErrorBoundary>
      )}
      <div style={{ flex: 1, overflow: 'hidden', display: navTab === 'sandbox' ? 'flex' : 'none' }}>
        <ErrorBoundary>
          <SandboxChatV5 />
        </ErrorBoundary>
      </div>
      {/* OPUS tab render removed — 014-openai-migration */}
      {navTab === 'listings' && (
        <ErrorBoundary>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ListingsV5 />
        </div>
        </ErrorBoundary>
      )}
      {/* SOP Monitor tab removed */}
      {navTab === 'faqs' && (
        <ErrorBoundary>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <FaqV5 />
        </div>
        </ErrorBoundary>
      )}
      {/* Sprint 046 Session C — legacy 'tuning' navTab forwards to Studio.
          The separate /tuning/build routes ship as 302 stubs this sprint
          (deleted next sprint); the in-app tab simply renders Studio. */}
      {navTab === 'tuning' && (
        <ErrorBoundary>
          <StudioSurface
            conversationId={studioConversationId}
            onConversationChange={updateStudioConversationId}
          />
        </ErrorBoundary>
      )}

      {/* Sprint 046 Session C — Studio tab. Hash-state (plan §3.4), no
          router push, three-pane surface mounted inline. */}
      {navTab === 'studio' && (
        <ErrorBoundary>
          <StudioSurface
            conversationId={studioConversationId}
            onConversationChange={updateStudioConversationId}
          />
        </ErrorBoundary>
      )}

      {/* Confirmation dialog for reject / cancel */}
      {confirmDialog && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDialog(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.bg.primary, borderRadius: 12,
              padding: 24, width: 380, maxWidth: '90vw',
              boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
              fontFamily: T.font.sans,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, marginBottom: 8 }}>
              {confirmDialog.type === 'reject' ? 'Reject Inquiry' : 'Cancel Reservation'}
            </div>
            <div style={{ fontSize: 13, color: T.text.secondary, marginBottom: 20, lineHeight: 1.5 }}>
              {confirmDialog.type === 'reject'
                ? 'Are you sure you want to reject this inquiry?'
                : 'Are you sure you want to cancel this reservation? This cannot be undone.'}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDialog(null)}
                style={{
                  padding: '8px 16px', borderRadius: 6,
                  border: `1px solid ${T.border.default}`, background: T.bg.primary,
                  fontSize: 13, fontWeight: 500, cursor: 'pointer',
                  color: T.text.secondary, fontFamily: T.font.sans,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmAction}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  background: T.status.red, color: '#fff',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  fontFamily: T.font.sans,
                }}
              >
                {confirmDialog.type === 'reject' ? 'Reject' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hostaway connection expiry warning banner */}
      {hostawayConnectStatus?.warning && navTab === 'inbox' && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
            background: '#FFFBEB', borderBottom: '1px solid #F59E0B44',
            padding: '8px 16px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 8, fontSize: 13,
            fontFamily: T.font.sans,
          }}
        >
          <AlertTriangle size={14} color="#D97706" />
          <span style={{ color: '#92400E' }}>
            Your Hostaway connection expires in {hostawayConnectStatus.daysRemaining} day{hostawayConnectStatus.daysRemaining !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => setNavTab('settings')}
            style={{
              fontSize: 12, fontWeight: 600, color: T.accent,
              background: 'none', border: `1px solid ${T.accent}`,
              borderRadius: 4, cursor: 'pointer', padding: '2px 10px',
            }}
          >
            Reconnect in Settings
          </button>
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
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
          />
        </div>
      )}
    </div>
  )
}
