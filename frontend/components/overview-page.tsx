'use client'

import { useState, useMemo } from 'react'
import type { Conversation, CheckInStatus, AiStatus } from '@/lib/inbox-data'
import { Search, SlidersHorizontal, TriangleAlert } from 'lucide-react'

const CHANNEL_LOGO: Record<string, string> = {
  'Airbnb':      '/logos/airbnb.png',
  'Booking.com': '/logos/booking.png',
  'Direct':      '/logos/hostaway.png',
}

const STATUS_CONFIG: Record<CheckInStatus, { label: string; bg: string; text: string; dot: string }> = {
  'confirmed':         { label: 'Upcoming',        bg: '#EFF6FF', text: '#2563EB', dot: '#3B82F6' },
  'checking-in-today': { label: 'Arrival',          bg: '#FFF7ED', text: '#C2410C', dot: '#F97316' },
  'checked-in':        { label: 'Staying',          bg: '#F0FDF4', text: '#15803D', dot: '#22C55E' },
  'checked-out':       { label: 'Checked out',      bg: '#F9FAFB', text: '#6B7280', dot: '#9CA3AF' },
  'cancelled':         { label: 'Cancelled',        bg: '#FEF2F2', text: '#DC2626', dot: '#EF4444' },
  'inquiry':           { label: 'Inquiry',          bg: '#FAF5FF', text: '#7C3AED', dot: '#A855F7' },
}

function StatusPill({ status }: { status: CheckInStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: cfg.bg, color: cfg.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cfg.dot }} />
      {cfg.label}
    </span>
  )
}

function AiStatusDot({ status }: { status: AiStatus }) {
  const isOn = status === 'on'
  const isWarn = status === 'intervention'
  const bg = isOn ? '#22C55E' : isWarn ? '#F59E0B' : '#EF4444'

  return (
    <span
      className="inline-flex items-center justify-center rounded-full shrink-0 font-bold"
      style={{ width: 22, height: 22, background: bg, color: '#fff' }}
    >
      {isWarn ? (
        <TriangleAlert size={11} strokeWidth={2.5} />
      ) : (
        <span style={{ fontSize: 8, letterSpacing: '-0.02em' }}>{isOn ? 'ON' : 'OFF'}</span>
      )}
    </span>
  )
}

function ChannelBadge({ channel }: { channel: string }) {
  const src = CHANNEL_LOGO[channel]
  if (!src) return null
  return (
    <div
      className="flex items-center justify-center rounded-lg shrink-0"
      style={{ width: 30, height: 30, background: 'var(--muted)', border: '1px solid var(--border)' }}
    >
      <img
        src={src}
        alt={channel}
        width={18}
        height={18}
        style={{ filter: 'grayscale(1) opacity(0.55)', objectFit: 'contain' }}
      />
    </div>
  )
}

function parseDate(str: string): Date {
  return new Date(str)
}

function formatRange(checkIn: string, checkOut: string) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const ci = parseDate(checkIn)
  const co = parseDate(checkOut)
  return `${months[ci.getMonth()]} ${ci.getDate()} – ${months[co.getMonth()]} ${co.getDate()}`
}

type FilterKey = 'all' | CheckInStatus

const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: 'all',              label: 'All' },
  { key: 'inquiry',          label: 'Inquiry' },
  { key: 'confirmed',        label: 'Upcoming' },
  { key: 'checking-in-today',label: 'Arrival' },
  { key: 'checked-in',       label: 'Staying' },
  { key: 'checked-out',      label: 'Checked Out' },
  { key: 'cancelled',        label: 'Cancelled' },
]

export function OverviewPage({ conversations, onOpenConversation }: { conversations: Conversation[]; onOpenConversation: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [showFilter, setShowFilter] = useState(false)

  const rows = useMemo(() => {
    return conversations.filter((c) => {
      const matchSearch =
        search === '' ||
        c.guestName.toLowerCase().includes(search.toLowerCase()) ||
        c.unitName.toLowerCase().includes(search.toLowerCase()) ||
        c.aiSummaryShort.toLowerCase().includes(search.toLowerCase())
      const matchFilter = filter === 'all' || c.checkInStatus === filter
      return matchSearch && matchFilter
    })
  }, [search, filter])

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" style={{ background: '#fff' }}>

      {/* ── Toolbar ── */}
      <div
        className="flex items-center justify-between px-6 shrink-0"
        style={{ height: 44, borderBottom: '1px solid var(--border)' }}
      >
        {/* Left: Filter */}
        <div className="relative">
          <button
            onClick={() => setShowFilter((v) => !v)}
            className="flex items-center gap-1.5 text-[12px] font-medium"
            style={{ color: filter !== 'all' ? 'var(--terracotta)' : 'var(--muted-foreground)' }}
          >
            <SlidersHorizontal size={13} />
            {filter === 'all' ? 'Filter' : FILTER_OPTIONS.find(f => f.key === filter)?.label}
          </button>
          {showFilter && (
            <div
              className="absolute top-full left-0 mt-1 z-50 rounded-lg overflow-hidden"
              style={{ background: '#fff', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.1)', minWidth: 160 }}
            >
              {FILTER_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => { setFilter(key); setShowFilter(false) }}
                  className="w-full text-left px-4 py-2 text-[12px] hover:bg-[var(--muted)]"
                  style={{ color: filter === key ? 'var(--terracotta)' : 'var(--brown-dark)', fontWeight: filter === key ? 600 : 400 }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: search + display */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-md" style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}>
            <Search size={12} style={{ color: 'var(--muted-foreground)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="text-[12px] bg-transparent outline-none w-36"
              style={{ color: 'var(--brown-dark)' }}
            />
          </div>
          <button
            className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium"
            style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
          >
            <SlidersHorizontal size={12} />
            Display
          </button>
        </div>
      </div>

      {/* ── Column headers ── */}
      <div
        className="grid shrink-0 px-6"
        style={{
          gridTemplateColumns: '28px 36px 160px 1fr 130px 130px 200px 36px 56px',
          columnGap: 12,
          height: 30,
          borderBottom: '1px solid var(--border)',
          alignItems: 'center',
        }}
      >
        {['', '', 'Guest', 'Subject / Last Message', 'Status', 'Dates', 'Property', '', 'Time'].map((h, i) => (
          <span key={i} className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
            {h}
          </span>
        ))}
      </div>

      {/* ── Rows ── */}
      <div className="flex-1 overflow-y-auto">
        {rows.map((conv) => (
          <OverviewRow key={conv.id} conv={conv} onClick={() => onOpenConversation(conv.id)} />
        ))}
        {rows.length === 0 && (
          <div className="flex items-center justify-center h-32 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            No conversations match your filter.
          </div>
        )}
      </div>
    </div>
  )
}

function OverviewRow({ conv, onClick }: { conv: Conversation; onClick: () => void }) {
  const lastMsg = conv.messages[conv.messages.length - 1]
  const senderLabel =
    lastMsg.sender === 'autopilot' ? '🤖' :
    lastMsg.sender === 'host' ? 'You' :
    conv.guestName.split(' ')[0]

  return (
    <button
      onClick={onClick}
      className="w-full text-left transition-colors hover:bg-[var(--muted)]"
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      <div
        className="grid px-6 items-center"
        style={{
          gridTemplateColumns: '28px 36px 160px 1fr 130px 130px 200px 36px 56px',
          columnGap: 12,
          minHeight: 44,
          paddingTop: 10,
          paddingBottom: 10,
        }}
      >
        {/* Col 1: AI status circle */}
        <div className="flex items-center justify-center">
          <AiStatusDot status={conv.aiStatus} />
        </div>

        {/* Col 2: Channel badge (replaces avatar) */}
        <div className="flex items-center justify-center">
          <ChannelBadge channel={conv.channel} />
        </div>

        {/* Col 3: Guest name */}
        <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--brown-dark)' }}>
          {conv.guestName}
        </span>

        {/* Col 4: Bold subject + muted last message */}
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[12px] font-semibold shrink-0 max-w-[180px] truncate" style={{ color: 'var(--brown-dark)' }}>
            {conv.aiSummaryShort}
          </span>
          <span className="text-[12px] truncate" style={{ color: 'var(--muted-foreground)' }}>
            <span className="font-medium">{senderLabel}:</span>{' '}
            {lastMsg.text}
          </span>
        </div>

        {/* Col 5: Status pill */}
        <div>
          <StatusPill status={conv.checkInStatus} />
        </div>

        {/* Col 6: Date range */}
        <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>
          {formatRange(conv.booking.checkIn, conv.booking.checkOut)}
        </span>

        {/* Col 7: Property */}
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>&#9632;</span>
          <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
            {conv.unitName}
          </span>
        </div>

        {/* Col 8: Channel logo (greyed, right side) */}
        <div className="flex items-center justify-center">
          {CHANNEL_LOGO[conv.channel] && (
            <img
              src={CHANNEL_LOGO[conv.channel]}
              alt={conv.channel}
              width={18}
              height={18}
              style={{ filter: 'grayscale(1) opacity(0.4)', objectFit: 'contain' }}
            />
          )}
        </div>

        {/* Col 9: Timestamp */}
        <span className="text-[11px] text-right block whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>
          {conv.timestamp}
        </span>
      </div>
    </button>
  )
}
