'use client'

import { useState, useMemo } from 'react'

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

// ─── Types ────────────────────────────────────────────────────────────────────

type CheckInStatus =
  | 'upcoming'
  | 'checked-in'
  | 'checked-out'
  | 'inquiry'
  | 'cancelled'
  | 'checking-in-today'
  | 'checking-out-today'
type Channel = 'airbnb' | 'booking' | 'direct' | 'vrbo' | 'whatsapp'
type AiMode = 'autopilot' | 'copilot' | 'off'
type Sender = 'guest' | 'host' | 'ai' | 'private'

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
  checkInStatus: CheckInStatus
  messages: any[]
  guest: { name: string; email: string; phone: string; nationality: string }
  booking: {
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
  property: {
    address: string
    doorCode: string
    wifiName: string
    wifiPassword: string
    checkInTime: string
    checkOutTime: string
  }
}

interface OverviewV5Props {
  conversations: Conversation[]
  onSelectConversation: (id: string) => void
  loading?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const statusConfig: Record<CheckInStatus, { label: string; color: string }> = {
  upcoming: { label: 'Upcoming', color: T.text.secondary },
  'checking-in-today': { label: 'Today', color: T.status.amber },
  'checked-in': { label: 'Checked In', color: T.status.green },
  'checked-out': { label: 'Checked Out', color: T.text.tertiary },
  'checking-out-today': { label: 'Checkout Today', color: T.status.amber },
  inquiry: { label: 'Inquiry', color: T.accent },
  cancelled: { label: 'Cancelled', color: T.status.red },
}

const channelAbbrev: Record<string, string> = {
  airbnb: 'AIR',
  booking: 'BKG',
  whatsapp: 'WA',
  vrbo: 'VBO',
  direct: 'DIR',
}

type StatusFilter = 'all' | CheckInStatus

const filterOptions: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Upcoming', value: 'upcoming' },
  { label: 'Checked In', value: 'checked-in' },
  { label: 'Checked Out', value: 'checked-out' },
  { label: 'Inquiry', value: 'inquiry' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'Today', value: 'checking-in-today' },
]

// ─── Column layout ────────────────────────────────────────────────────────────

const COL = {
  aiDot: '32px',
  channel: '48px',
  guest: '1',
  lastMessage: '2',
  status: '120px',
  dates: '160px',
  property: '1',
  timestamp: '80px',
} as const

// ─── Header cell style ───────────────────────────────────────────────────────

const headerCellStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: T.text.tertiary,
  fontFamily: T.font.sans,
  transition: 'color 0.15s ease',
}

// ─── Skeleton row ─────────────────────────────────────────────────────────────

const shimmerKeyframes = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
`

function SkeletonRow({ delay }: { delay: number }): React.ReactElement {
  const shimmerBg = `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`
  const bar = (width: string): React.CSSProperties => ({
    height: 10,
    borderRadius: 6,
    background: shimmerBg,
    backgroundSize: '200% 100%',
    width,
    animation: `shimmer 1.8s ease-in-out ${delay}s infinite`,
  })

  return (
    <div
      role="row"
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: '42px',
        borderBottom: `1px solid ${T.border.default}`,
        paddingLeft: '16px',
        paddingRight: '16px',
        animation: `fadeInUp 0.3s ease ${delay}s both`,
      }}
    >
      <div style={{ width: COL.aiDot, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: shimmerBg, backgroundSize: '200% 100%', animation: `shimmer 1.8s ease-in-out ${delay}s infinite` }} />
      </div>
      <div style={{ width: COL.channel, flexShrink: 0 }}><div style={bar('28px')} /></div>
      <div style={{ flex: COL.guest, minWidth: 0, paddingRight: '12px' }}><div style={bar('70%')} /></div>
      <div style={{ flex: COL.lastMessage, minWidth: 0, paddingRight: '12px' }}><div style={bar('60%')} /></div>
      <div style={{ width: COL.status, flexShrink: 0, paddingRight: '12px' }}><div style={bar('56px')} /></div>
      <div style={{ width: COL.dates, flexShrink: 0, paddingRight: '12px' }}><div style={bar('80%')} /></div>
      <div style={{ flex: COL.property, minWidth: 0, paddingRight: '12px' }}><div style={bar('50%')} /></div>
      <div style={{ width: COL.timestamp, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}><div style={bar('40px')} /></div>
    </div>
  )
}

// ─── Search icon SVG ──────────────────────────────────────────────────────────

function SearchIcon({ size = 14, color = T.text.tertiary }: { size?: number; color?: string }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// ─── Row component ────────────────────────────────────────────────────────────

function ConversationRow({
  conversation,
  onSelect,
}: {
  conversation: Conversation
  onSelect: () => void
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  const { label: statusLabel, color: statusColor } = statusConfig[conversation.checkInStatus]
  const hasUnread = conversation.unreadCount > 0

  return (
    <div
      role="row"
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: '42px',
        borderBottom: `1px solid ${T.border.default}`,
        background: hovered ? '#F5F3F1' : hasUnread ? '#FDFCFB' : T.bg.primary,
        cursor: 'pointer',
        paddingLeft: hasUnread ? '13px' : '16px',
        paddingRight: '16px',
        gap: '0px',
        transition: 'all 0.15s ease',
        userSelect: 'none',
        borderLeft: hasUnread ? `3px solid ${T.accent}` : '3px solid transparent',
      }}
    >
      {/* AI dot */}
      <div
        style={{
          width: COL.aiDot,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: conversation.aiOn ? T.status.green : T.status.red,
            flexShrink: 0,
            boxShadow: conversation.aiOn ? `0 0 0 2px ${T.status.green}30` : 'none',
            animation: conversation.aiOn ? 'pulse 2s ease-in-out infinite' : 'none',
          }}
        />
      </div>

      {/* Channel */}
      <div
        style={{
          width: COL.channel,
          flexShrink: 0,
          fontFamily: T.font.mono,
          fontSize: '10px',
          fontWeight: 600,
          color: T.text.secondary,
          letterSpacing: '0.04em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {channelAbbrev[conversation.channel] ?? conversation.channel.toUpperCase()}
      </div>

      {/* Guest name */}
      <div
        style={{
          flex: COL.guest,
          minWidth: 0,
          paddingRight: '12px',
          fontFamily: T.font.sans,
          fontSize: '13px',
          fontWeight: hasUnread ? 600 : 500,
          color: T.text.primary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {conversation.guestName}
      </div>

      {/* Last message */}
      <div
        style={{
          flex: COL.lastMessage,
          minWidth: 0,
          paddingRight: '12px',
          fontFamily: T.font.sans,
          fontSize: '13px',
          color: hasUnread ? T.text.primary : T.text.secondary,
          fontWeight: hasUnread ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {conversation.lastMessage}
      </div>

      {/* Status pill */}
      <div
        style={{
          width: COL.status,
          flexShrink: 0,
          paddingRight: '12px',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 999,
            background: statusColor + '14',
            color: statusColor,
            fontSize: '10px',
            fontWeight: 600,
            padding: '3px 9px',
            fontFamily: T.font.sans,
            whiteSpace: 'nowrap',
            letterSpacing: '0.02em',
          }}
        >
          {statusLabel}
        </span>
      </div>

      {/* Dates */}
      <div
        style={{
          width: COL.dates,
          flexShrink: 0,
          paddingRight: '12px',
          fontFamily: T.font.sans,
          fontSize: '12px',
          color: T.text.secondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {conversation.booking.checkIn}
        <span style={{ color: T.text.tertiary, margin: '0 4px' }}>→</span>
        {conversation.booking.checkOut}
      </div>

      {/* Property */}
      <div
        style={{
          flex: COL.property,
          minWidth: 0,
          paddingRight: '12px',
          fontFamily: T.font.sans,
          fontSize: '13px',
          color: T.text.secondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {conversation.booking.property}
      </div>

      {/* Timestamp */}
      <div
        style={{
          width: COL.timestamp,
          flexShrink: 0,
          fontFamily: T.font.sans,
          fontSize: '12px',
          color: T.text.tertiary,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {conversation.timestamp}
      </div>
    </div>
  )
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, accent, index = 0 }: { label: string; value: string | number; accent?: string; index?: number }): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  const topBorderColors = [T.accent, T.status.green, T.status.red, T.status.amber]
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        borderTop: `2px solid ${topBorderColors[index % topBorderColors.length]}`,
        background: 'linear-gradient(135deg, #FFFFFF 0%, #FAFAF9 100%)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontFamily: T.font.sans,
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transform: hovered ? 'translateY(-1px)' : 'none',
        animation: `fadeInUp 0.4s ease both`,
        animationDelay: `${index * 0.08}s`,
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text.tertiary }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 800, color: accent || T.text.primary, lineHeight: 1.1, fontFamily: T.font.sans }}>{value}</span>
    </div>
  )
}

function KpiSkeleton({ index = 0 }: { index?: number }): React.ReactElement {
  const shimmerBg = `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`
  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      borderRadius: T.radius.md,
      border: `1px solid ${T.border.default}`,
      borderTop: `2px solid ${T.bg.tertiary}`,
      background: 'linear-gradient(135deg, #FFFFFF 0%, #FAFAF9 100%)',
      padding: '14px 16px',
      height: 68,
      animation: `fadeInUp 0.3s ease ${index * 0.06}s both`,
      boxShadow: T.shadow.sm,
    }}>
      <div style={{ height: 10, width: 60, borderRadius: 6, background: shimmerBg, backgroundSize: '200% 100%', animation: 'shimmer 1.8s ease-in-out infinite', marginBottom: 8 }} />
      <div style={{ height: 22, width: 48, borderRadius: 6, background: shimmerBg, backgroundSize: '200% 100%', animation: 'shimmer 1.8s ease-in-out 0.1s infinite' }} />
    </div>
  )
}

// ─── Today Card ──────────────────────────────────────────────────────────────

function TodayCard({ conversation, type, index, onSelect }: { conversation: Conversation; type: 'check-in' | 'check-out'; index: number; onSelect: () => void }): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  const color = type === 'check-in' ? T.status.green : T.status.red
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flexShrink: 0,
        padding: '10px 14px',
        borderRadius: T.radius.md,
        border: `1px solid ${color}33`,
        background: `${color}08`,
        cursor: 'pointer',
        fontFamily: T.font.sans,
        transition: 'all 0.2s ease',
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transform: hovered ? 'translateY(-2px)' : 'none',
        animation: `fadeInUp 0.4s ease both`,
        animationDelay: `${index * 0.06}s`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {type === 'check-in' ? 'Check-in' : 'Check-out'}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.text.primary }}>{conversation.guestName}</div>
      <div style={{ fontSize: 11, color: T.text.secondary, marginTop: 2 }}>{conversation.booking.property}</div>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

type SortKey = 'guest' | 'status' | 'dates' | 'property' | 'timestamp'
type SortDir = 'asc' | 'desc'

export function OverviewV5({ conversations, onSelectConversation, loading }: OverviewV5Props): React.ReactElement {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('timestamp')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(key: SortKey): void {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'timestamp' || key === 'dates' ? 'desc' : 'asc')
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = conversations.filter((c) => {
      const matchesStatus = statusFilter === 'all' || c.checkInStatus === statusFilter
      if (!matchesStatus) return false
      if (!q) return true
      return (
        c.guestName.toLowerCase().includes(q) ||
        c.booking.property.toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q)
      )
    })
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      switch (sortKey) {
        case 'guest': return dir * a.guestName.localeCompare(b.guestName)
        case 'status': return dir * a.checkInStatus.localeCompare(b.checkInStatus)
        case 'dates': return dir * (new Date(a.booking.checkInIso).getTime() - new Date(b.booking.checkInIso).getTime())
        case 'property': return dir * a.booking.property.localeCompare(b.booking.property)
        case 'timestamp': return dir * (new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        default: return 0
      }
    })
    return list
  }, [conversations, search, statusFilter, sortKey, sortDir])

  // O2: Today's arrivals and departures
  const todayArrivals = useMemo(() =>
    conversations.filter(c => c.checkInStatus === 'checking-in-today'),
  [conversations])
  const todayDepartures = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    return conversations.filter(c => c.booking.checkOutIso?.slice(0, 10) === today && c.checkInStatus === 'checked-in')
  }, [conversations])

  const hasSearchQuery = search.trim().length > 0

  // KPI computations
  const kpis = useMemo(() => {
    const active = conversations.filter(c => c.checkInStatus !== 'checked-out' && c.checkInStatus !== 'cancelled').length
    const arrivingToday = conversations.filter(c => c.checkInStatus === 'checking-in-today').length
    const unread = conversations.reduce((sum, c) => sum + c.unreadCount, 0)
    const aiOnCount = conversations.filter(c => c.aiOn).length
    const aiRate = conversations.length > 0 ? Math.round((aiOnCount / conversations.length) * 100) : 0
    return { active, arrivingToday, unread, aiRate }
  }, [conversations])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: `linear-gradient(180deg, ${T.bg.secondary} 0%, #EDEBE9 100%)`,
        fontFamily: T.font.sans,
      }}
    >
      {/* Inject shimmer keyframes */}
      <style>{shimmerKeyframes}</style>

      {/* Page header */}
      <div
        style={{
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          flexShrink: 0,
        }}
      >
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: T.text.primary,
              fontFamily: T.font.sans,
            }}
          >
            Overview
          </span>
          <span
            style={{
              fontSize: 12,
              color: T.text.tertiary,
              fontFamily: T.font.sans,
            }}
          >
            {filtered.length} conversation{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* KPI summary cards */}
        <div style={{ display: 'flex', gap: 10 }}>
          {loading ? (
            <>
              <KpiSkeleton index={0} />
              <KpiSkeleton index={1} />
              <KpiSkeleton index={2} />
              <KpiSkeleton index={3} />
            </>
          ) : (
            <>
              <KpiCard label="Active Conversations" value={kpis.active} index={0} />
              <KpiCard label="Arriving Today" value={kpis.arrivingToday} accent={kpis.arrivingToday > 0 ? T.status.amber : undefined} index={1} />
              <KpiCard label="Unread Messages" value={kpis.unread} accent={kpis.unread > 0 ? T.status.red : undefined} index={2} />
              <KpiCard label="AI Enabled" value={`${kpis.aiRate}%`} accent={T.accent} index={3} />
            </>
          )}
        </div>

        {/* O2: Today's arrivals/departures strip */}
        {!loading && (todayArrivals.length > 0 || todayDepartures.length > 0) && (
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {todayArrivals.map((c, i) => (
              <TodayCard key={`arr-${c.id}`} conversation={c} type="check-in" index={i} onSelect={() => onSelectConversation(c.id)} />
            ))}
            {todayDepartures.map((c, i) => (
              <TodayCard key={`dep-${c.id}`} conversation={c} type="check-out" index={todayArrivals.length + i} onSelect={() => onSelectConversation(c.id)} />
            ))}
          </div>
        )}

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: '340px' }}>
          <div
            style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <SearchIcon size={15} color={searchFocused ? T.accent : T.text.tertiary} />
          </div>
          <input
            type="text"
            placeholder="Search guests, properties, messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            style={{
              width: '100%',
              height: '38px',
              paddingLeft: '34px',
              paddingRight: '12px',
              border: `1px solid ${searchFocused ? T.accent : T.border.default}`,
              borderRadius: T.radius.md,
              background: '#FFFFFF',
              fontFamily: T.font.sans,
              fontSize: '13px',
              color: T.text.primary,
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
              boxShadow: searchFocused ? `0 0 0 3px rgba(29,78,216,0.12)` : T.shadow.sm,
            }}
          />
        </div>

        {/* Status filter pills */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {filterOptions.map(({ label, value }) => {
            const active = statusFilter === value
            return (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  border: active ? 'none' : `1px solid ${T.border.default}`,
                  background: active ? T.accent : 'transparent',
                  color: active ? '#FFFFFF' : T.text.secondary,
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '0 12px',
                  height: 26,
                  cursor: 'pointer',
                  fontFamily: T.font.sans,
                  transition: 'all 0.2s ease',
                  lineHeight: 1,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Table card */}
      <div
        style={{
          flex: 1,
          margin: '0 20px 20px 20px',
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.lg,
          overflow: 'hidden',
          background: T.bg.primary,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          boxShadow: T.shadow.md,
          animation: 'scaleIn 0.3s ease both',
          animationDelay: '0.15s',
        }}
      >
        {/* Header row */}
        <div
          role="row"
          style={{
            display: 'flex',
            alignItems: 'center',
            background: '#EFEEED',
            paddingLeft: '16px',
            paddingRight: '16px',
            height: '32px',
            flexShrink: 0,
            borderBottom: `1px solid ${T.border.default}`,
          }}
        >
          <div style={{ width: COL.aiDot, flexShrink: 0 }}>
            <span style={headerCellStyle}>AI</span>
          </div>
          <div style={{ width: COL.channel, flexShrink: 0 }}>
            <span style={headerCellStyle}>CH</span>
          </div>
          <div style={{ flex: COL.guest, minWidth: 0, paddingRight: '12px', cursor: 'pointer', borderRadius: 4, transition: 'background 0.15s' }} onClick={() => handleSort('guest')}>
            <span style={{ ...headerCellStyle, color: sortKey === 'guest' ? T.text.primary : headerCellStyle.color }}>Guest{sortKey === 'guest' ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''}</span>
          </div>
          <div style={{ flex: COL.lastMessage, minWidth: 0, paddingRight: '12px' }}>
            <span style={headerCellStyle}>Last Message</span>
          </div>
          <div style={{ width: COL.status, flexShrink: 0, paddingRight: '12px', cursor: 'pointer', borderRadius: 4, transition: 'background 0.15s' }} onClick={() => handleSort('status')}>
            <span style={{ ...headerCellStyle, color: sortKey === 'status' ? T.text.primary : headerCellStyle.color }}>Status{sortKey === 'status' ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''}</span>
          </div>
          <div style={{ width: COL.dates, flexShrink: 0, paddingRight: '12px', cursor: 'pointer', borderRadius: 4, transition: 'background 0.15s' }} onClick={() => handleSort('dates')}>
            <span style={{ ...headerCellStyle, color: sortKey === 'dates' ? T.text.primary : headerCellStyle.color }}>Check-in \u2192 Out{sortKey === 'dates' ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''}</span>
          </div>
          <div style={{ flex: COL.property, minWidth: 0, paddingRight: '12px', cursor: 'pointer', borderRadius: 4, transition: 'background 0.15s' }} onClick={() => handleSort('property')}>
            <span style={{ ...headerCellStyle, color: sortKey === 'property' ? T.text.primary : headerCellStyle.color }}>Property{sortKey === 'property' ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''}</span>
          </div>
          <div style={{ width: COL.timestamp, flexShrink: 0, textAlign: 'right', cursor: 'pointer', borderRadius: 4, transition: 'background 0.15s' }} onClick={() => handleSort('timestamp')}>
            <span style={{ ...headerCellStyle, color: sortKey === 'timestamp' ? T.text.primary : headerCellStyle.color }}>Time{sortKey === 'timestamp' ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''}</span>
          </div>
        </div>

        {/* Scrollable rows */}
        <div
          role="rowgroup"
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          {loading ? (
            // Skeleton loading state
            <>
              {Array.from({ length: 8 }).map((_, i) => (
                <SkeletonRow key={i} delay={i * 0.08} />
              ))}
            </>
          ) : filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                minHeight: '240px',
                fontFamily: T.font.sans,
                color: T.text.tertiary,
                gap: '12px',
                padding: '40px 20px',
                animation: 'fadeInUp 0.4s ease both',
              }}
            >
              <div style={{
                width: 48,
                height: 48,
                borderRadius: T.radius.md,
                background: T.bg.tertiary + '60',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <SearchIcon size={22} color={T.text.tertiary} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, color: T.text.secondary }}>
                {hasSearchQuery
                  ? 'No results found'
                  : 'No conversations found'}
              </span>
              <span style={{ fontSize: 12, color: T.text.tertiary }}>
                {hasSearchQuery
                  ? 'Try adjusting your search or filters'
                  : 'Conversations will appear here once available'}
              </span>
            </div>
          ) : (
            filtered.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                onSelect={() => onSelectConversation(conversation.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
