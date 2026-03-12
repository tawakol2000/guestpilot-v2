'use client'

import { useState } from 'react'
import { Search, SlidersHorizontal, ArrowUpDown, ChevronDown, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Conversation, AiStatus, CheckInStatus } from '@/lib/inbox-data'

interface ConversationListProps {
  conversations: Conversation[]
  selectedId: string
  onSelect: (id: string) => void
  searchQuery: string
  onSearchChange: (q: string) => void
}

// ── Channel logos (greyscale real images) ─────────────────────────────────────
const CHANNEL_LOGO: Record<string, string> = {
  'Airbnb':      '/logos/airbnb.png',
  'Booking.com': '/logos/booking.png',
  'Direct':      '/logos/hostaway.png',
}

function ChannelLogo({ channel }: { channel: string }) {
  const src = CHANNEL_LOGO[channel]
  if (!src) return null
  return (
    <img
      src={src}
      alt={channel}
      width={18}
      height={18}
      style={{ filter: 'grayscale(1) opacity(0.45)', objectFit: 'contain' }}
    />
  )
}

// ── Check-in status badge ─────────────────────────────────────────────────────
const checkInStatusConfig: Record<CheckInStatus, { label: string; bg: string; text: string }> = {
  confirmed:           { label: 'Confirmed',    bg: '#DCFCE7', text: '#15803D' },
  cancelled:           { label: 'Cancelled',    bg: '#FEE2E2', text: '#DC2626' },
  'checked-in':        { label: 'Checked In',   bg: '#DBEAFE', text: '#1D4ED8' },
  'checking-in-today': { label: 'Checking In',  bg: '#FEF9C3', text: '#A16207' },
  'checked-out':       { label: 'Checked Out',  bg: '#F3F4F6', text: '#6B7280' },
  inquiry:             { label: 'Inquiry',       bg: '#EDE9FE', text: '#7C3AED' },
}

function StatusBadge({ status }: { status: CheckInStatus }) {
  const cfg = checkInStatusConfig[status]
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold leading-none whitespace-nowrap shrink-0"
      style={{ background: cfg.bg, color: cfg.text }}
    >
      {cfg.label}
    </span>
  )
}

// ── AI badge pill ─────────────────────────────────────────────────────────────
const AI_STATUS_CONFIG: Record<AiStatus, { label: string; bg: string; text: string }> = {
  on:           { label: 'ON',  bg: '#DCFCE7', text: '#15803D' },
  intervention: { label: '!',   bg: '#FEF9C3', text: '#A16207' },
  off:          { label: 'OFF', bg: '#FEE2E2', text: '#DC2626' },
}

// ── Filter / sort types ───────────────────────────────────────────────────────
type BookingStatusFilter = 'all' | 'inquiry' | 'incoming' | 'canceled' | 'checked-in' | 'checked-out'
type AiFilter = 'all' | 'on' | 'intervention' | 'off'
type SortField = 'timestamp' | 'name' | 'unit'
type FilterField = 'channel' | 'bookingType' | 'unit' | 'name' | null

const bookingStatusLabels: Record<BookingStatusFilter, string> = {
  all:          'All',
  inquiry:      'Inquiry',
  incoming:     'Incoming',
  canceled:     'Canceled',
  'checked-in': 'Checked In',
  'checked-out':'Checked Out',
}
const aiFilterLabels: Record<AiFilter, string> = {
  all:          'All',
  on:           'On',
  intervention: 'Intervene',
  off:          'Off',
}
const filterFieldLabels: Record<NonNullable<FilterField>, string> = {
  channel:     'Channel',
  bookingType: 'Type',
  unit:        'Unit',
  name:        'Name',
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function senderPrefix(conv: Conversation): string {
  const sender = conv.lastMessageSender
    || (conv.messages.length ? conv.messages[conv.messages.length - 1].sender : '')
  if (!sender) return ''
  if (sender === 'autopilot') return '🤖'
  if (sender === 'host') return 'You'
  return conv.guestName.split(' ')[0]
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
}: ConversationListProps) {
  const [bookingFilter, setBookingFilter]       = useState<BookingStatusFilter>('all')
  const [bookingFilterOpen, setBookingFilterOpen] = useState(false)
  const [aiFilter, setAiFilter]                 = useState<AiFilter>('all')
  const [aiFilterOpen, setAiFilterOpen]         = useState(false)
  const [filterOpen, setFilterOpen]             = useState(false)
  const [sortOpen, setSortOpen]                 = useState(false)
  const [activeFilter, setActiveFilter]         = useState<FilterField>(null)
  const [filterValue, setFilterValue]           = useState('')
  const [sortField, setSortField]               = useState<SortField>('timestamp')

  const bookingStatusToCheckIn: Record<BookingStatusFilter, CheckInStatus[]> = {
    all:          [],
    inquiry:      ['inquiry'],
    incoming:     ['confirmed', 'checking-in-today'],
    canceled:     ['cancelled'],
    'checked-in': ['checked-in'],
    'checked-out':['checked-out'],
  }

  let filtered = conversations.filter((c) => {
    const q = searchQuery.toLowerCase()
    const matchesSearch =
      !q ||
      c.guestName.toLowerCase().includes(q) ||
      c.unitName.toLowerCase().includes(q) ||
      c.lastMessage.toLowerCase().includes(q)
    const statusValues = bookingStatusToCheckIn[bookingFilter]
    const matchesBooking = bookingFilter === 'all' || statusValues.includes(c.checkInStatus)
    const matchesAi      = aiFilter === 'all' || c.aiStatus === aiFilter
    const matchesField =
      !activeFilter || !filterValue ||
      (activeFilter === 'channel'      && c.channel.toLowerCase().includes(filterValue.toLowerCase())) ||
      (activeFilter === 'bookingType'  && c.bookingType.toLowerCase().includes(filterValue.toLowerCase())) ||
      (activeFilter === 'unit'         && c.unitName.toLowerCase().includes(filterValue.toLowerCase())) ||
      (activeFilter === 'name'         && c.guestName.toLowerCase().includes(filterValue.toLowerCase()))
    return matchesSearch && matchesBooking && matchesAi && matchesField
  })

  filtered = [...filtered].sort((a, b) => {
    if (sortField === 'name') return a.guestName.localeCompare(b.guestName)
    if (sortField === 'unit') return a.unitName.localeCompare(b.unitName)
    return 0
  })

  function closeAll() {
    setFilterOpen(false)
    setSortOpen(false)
    setBookingFilterOpen(false)
    setAiFilterOpen(false)
  }

  return (
    <aside className="flex flex-col h-full bg-white overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="px-3 pt-3 pb-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>

        {/* Search + filter + sort */}
        <div className="flex items-center gap-1.5 mb-2">
          <div className="relative flex-1">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--muted-foreground)' }}
            />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full h-7 pl-7 pr-2.5 text-[11px] rounded-full outline-none"
              style={{ background: 'var(--muted)', color: 'var(--brown-dark)', border: '1px solid var(--border)' }}
            />
          </div>

          {/* Filter */}
          <div className="relative">
            <button
              onClick={() => { setFilterOpen(v => !v); setSortOpen(false) }}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-colors"
              style={filterOpen || activeFilter
                ? { background: 'var(--terracotta)', color: '#fff' }
                : { background: 'var(--muted)', color: 'var(--muted-foreground)' }}
            >
              <SlidersHorizontal size={12} />
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-9 z-50 p-3 w-52"
                style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.10)' }}>
                <p className="text-[9px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--muted-foreground)' }}>Filter by</p>
                <div className="flex flex-wrap gap-1 mb-2.5">
                  {(Object.keys(filterFieldLabels) as NonNullable<FilterField>[]).map((field) => (
                    <button
                      key={field}
                      onClick={() => setActiveFilter(activeFilter === field ? null : field)}
                      className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
                      style={activeFilter === field
                        ? { background: 'var(--terracotta)', color: '#fff' }
                        : { background: 'var(--muted)', color: 'var(--brown-dark)' }}
                    >
                      {filterFieldLabels[field]}
                    </button>
                  ))}
                </div>
                {activeFilter && (
                  <input
                    autoFocus
                    placeholder={`Filter by ${filterFieldLabels[activeFilter]}...`}
                    className="w-full h-6 px-2 text-[11px] rounded-md outline-none"
                    style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
                    value={filterValue}
                    onChange={(e) => setFilterValue(e.target.value)}
                  />
                )}
                {(activeFilter || filterValue) && (
                  <button onClick={() => { setActiveFilter(null); setFilterValue('') }}
                    className="mt-1.5 text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Sort */}
          <div className="relative">
            <button
              onClick={() => { setSortOpen(v => !v); setFilterOpen(false) }}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-colors"
              style={sortOpen
                ? { background: 'var(--terracotta)', color: '#fff' }
                : { background: 'var(--muted)', color: 'var(--muted-foreground)' }}
            >
              <ArrowUpDown size={12} />
            </button>
            {sortOpen && (
              <div className="absolute right-0 top-9 z-50 p-2.5 w-40"
                style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.10)' }}>
                <p className="text-[9px] font-bold uppercase tracking-widest mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Sort by</p>
                {(['timestamp', 'name', 'unit'] as SortField[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => { setSortField(f); setSortOpen(false) }}
                    className="w-full text-left text-[11px] px-2 py-1.5 rounded-md transition-colors"
                    style={sortField === f
                      ? { background: 'var(--secondary)', color: 'var(--brown-dark)', fontWeight: 600 }
                      : { color: 'var(--muted-foreground)' }}
                  >
                    {f === 'timestamp' ? 'Recent' : f === 'name' ? 'Guest name' : 'Unit name'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Quick filters row */}
        <div className="flex items-center">
          {/* Booking Status */}
          <span className="text-[10px] font-semibold whitespace-nowrap mr-1.5" style={{ color: 'var(--muted-foreground)' }}>
            Booking Status
          </span>
          <div className="relative">
            <button
              onClick={() => { setBookingFilterOpen(v => !v); setAiFilterOpen(false) }}
              className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md transition-all"
              style={bookingFilter !== 'all'
                ? { background: 'var(--terracotta)', color: '#fff' }
                : { background: 'var(--muted)', color: 'var(--brown-dark)' }}
            >
              {bookingStatusLabels[bookingFilter]}
              <ChevronDown size={9} className={cn('transition-transform', bookingFilterOpen && 'rotate-180')} />
            </button>
            {bookingFilterOpen && (
              <div className="absolute left-0 top-8 z-50 overflow-hidden w-36"
                style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.10)' }}>
                {(Object.keys(bookingStatusLabels) as BookingStatusFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => { setBookingFilter(f); setBookingFilterOpen(false) }}
                    className="w-full text-left text-[11px] px-3 py-2 transition-colors"
                    style={bookingFilter === f
                      ? { background: 'var(--secondary)', color: 'var(--brown-dark)', fontWeight: 600 }
                      : { color: 'var(--muted-foreground)' }}
                  >
                    {bookingStatusLabels[f]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="mx-2 h-4 w-px shrink-0" style={{ background: 'var(--border)' }} />

          {/* AI Status — pushed right */}
          <span className="text-[10px] font-semibold whitespace-nowrap mr-1.5" style={{ color: 'var(--muted-foreground)' }}>
            AI Status
          </span>
          <div className="relative ml-auto">
            <button
              onClick={() => { setAiFilterOpen(v => !v); setBookingFilterOpen(false) }}
              className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md transition-all"
              style={aiFilter !== 'all'
                ? { background: 'var(--terracotta)', color: '#fff' }
                : { background: 'var(--muted)', color: 'var(--brown-dark)' }}
            >
              {aiFilterLabels[aiFilter]}
              <ChevronDown size={9} className={cn('transition-transform', aiFilterOpen && 'rotate-180')} />
            </button>
            {aiFilterOpen && (
              <div className="absolute right-0 top-8 z-50 overflow-hidden w-32"
                style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.10)' }}>
                {(Object.keys(aiFilterLabels) as AiFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => { setAiFilter(f); setAiFilterOpen(false) }}
                    className="w-full text-left text-[11px] px-3 py-2 transition-colors"
                    style={aiFilter === f
                      ? { background: 'var(--secondary)', color: 'var(--brown-dark)', fontWeight: 600 }
                      : { color: 'var(--muted-foreground)' }}
                  >
                    {aiFilterLabels[f]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Conversation rows ─────────���─────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto" onClick={closeAll}>
        {filtered.length === 0 && (
          <div className="px-4 py-10 text-center text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            No conversations match your filters.
          </div>
        )}

        {filtered.map((conv) => {
          const isSelected = conv.id === selectedId
          const aiCfg      = AI_STATUS_CONFIG[conv.aiStatus]
          const prefix     = senderPrefix(conv)
          // Always use lastMessage from summary — kept fresh by loadConversations(), not stale messages array
          const lastMsg    = conv.lastMessage || (conv.messages.length ? conv.messages[conv.messages.length - 1].text : '')

          return (
            <button
              key={conv.id}
              onClick={(e) => { e.stopPropagation(); onSelect(conv.id) }}
              className="w-full text-left px-3 py-3.5 transition-colors relative"
              style={{
                borderBottom: '1px solid var(--border)',
                background: isSelected ? '#F6EEE7' : conv.unreadCount > 0 ? '#FFFAF7' : '#fff',
              }}
              onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--muted)' }}
              onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = conv.unreadCount > 0 ? '#FFFAF7' : '#fff' }}
            >
              {/* Unread accent bar (show for both selected and unread) */}
              {(isSelected || conv.unreadCount > 0) && (
                <span
                  className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full"
                  style={{ background: isSelected ? 'var(--terracotta)' : 'rgba(196, 98, 58, 0.4)' }}
                />
              )}

              {/* Two-column layout: left = content, right = date + logo + AI badge */}
              <div className="flex gap-2 items-start">

              <div className="flex-1 min-w-0 flex flex-col gap-1.5">

                  {/* Row 1: guest name | unit name */}
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    <span className="text-[12px] leading-snug shrink-0" style={{ color: 'var(--brown-dark)', fontWeight: conv.unreadCount > 0 ? 700 : 600 }}>
                      {conv.guestName}
                    </span>
                    <span className="text-[10px] shrink-0" style={{ color: 'var(--border)' }}>|</span>
                    <span className="text-[10px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {conv.unitName}
                    </span>
                  </div>

                  {/* Row 2: booking status badge */}
                  <div>
                    <StatusBadge status={conv.checkInStatus} />
                  </div>

                  {/* Row 3: AI summary bubble */}
                  <div
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md self-start max-w-full"
                    style={{ background: '#F0EEF8' }}
                  >
                    <span className="text-[10px] leading-none shrink-0">⚡</span>
                    <span className="text-[9px] font-medium truncate" style={{ color: '#5B4A9B' }}>
                      {conv.aiSummaryShort}
                    </span>
                  </div>

                  {/* Row 4: last message with sender prefix — hidden when no message */}
                  {lastMsg ? (
                    <div className="flex items-baseline gap-1 min-w-0">
                      {prefix && (
                        <span className="text-[10px] font-semibold shrink-0 whitespace-nowrap" style={{ color: 'var(--brown-dark)' }}>
                          {prefix}:
                        </span>
                      )}
                      <span className="text-[10px] truncate leading-snug" style={{ color: 'var(--muted-foreground)' }}>
                        {lastMsg}
                      </span>
                    </div>
                  ) : null}
                </div>

                {/* RIGHT: timestamp+unread top, channel logo center, AI badge bottom */}
                <div className="flex flex-col items-end justify-between shrink-0" style={{ minHeight: 88, width: 44 }}>
                  {/* Timestamp + unread count side by side */}
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>
                      {conv.timestamp}
                    </span>
                    {conv.unreadCount > 0 && (
                      <span
                        className="rounded-full flex items-center justify-center font-bold text-white leading-none"
                        style={{
                          background: 'var(--terracotta)',
                          minWidth: 16,
                          height: 16,
                          fontSize: 9,
                          paddingLeft: 4,
                          paddingRight: 4,
                        }}
                      >
                        {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                      </span>
                    )}
                  </div>

                  {/* Channel logo */}
                  <ChannelLogo channel={conv.channel} />

                  {/* AI status — always visible */}
                  <span
                    className="rounded-full flex items-center justify-center font-bold leading-none"
                    style={{
                      background: aiCfg.bg,
                      color: aiCfg.text,
                      minWidth: 30,
                      height: 16,
                      fontSize: 8,
                      paddingLeft: 4,
                      paddingRight: 4,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {conv.aiStatus === 'intervention' ? (
                      <TriangleAlert size={8} strokeWidth={2.5} />
                    ) : conv.aiStatus === 'on' ? 'ON' : 'OFF'}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
