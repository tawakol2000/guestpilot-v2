'use client'

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import {
  apiGetReservations,
  apiGetProperties,
  type CalendarReservation,
  type ApiProperty,
} from '@/lib/api'

// ════════════════════════════════════════════════════════════════════════════
// Design Tokens
// ════════════════════════════════════════════════════════════════════════════

const T = {
  primary: '#2563EB',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  text: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  border: '#E2E8F0',
  muted: '#F1F5F9',
  rowBaseHeight: 48,
  rowOverlapExtra: 30,
  sidebarWidth: 220,
  colWidth2w: 72,
  colWidthMonth: 44,
  barRadius: 5,
  barMinWidth: 24,
  barHeight: 26,
}

// Brand colors — match actual platform brand identity
const CHANNEL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  AIRBNB:   { bg: '#FF5A5F28', text: '#CC2936', border: '#FF5A5F' },
  BOOKING:  { bg: '#00358025', text: '#002A66', border: '#003580' },
  DIRECT:   { bg: '#FF8C0025', text: '#B36200', border: '#FF8C00' },
  WHATSAPP: { bg: '#25D36620', text: '#0E7A5E', border: '#25D366' },
  OTHER:    { bg: '#64748B18', text: '#475569', border: '#94A3B8' },
}

const CHANNEL_LOGOS: Record<string, string | null> = {
  AIRBNB: '/logos/airbnb.png',
  BOOKING: '/logos/booking.png',
  WHATSAPP: '/logos/whatsapp.png',
  DIRECT: null,
  OTHER: null,
}

function channelColor(ch: string) { return CHANNEL_COLORS[ch] || CHANNEL_COLORS.OTHER }

const STATUS_LABELS: Record<string, string> = {
  INQUIRY: 'Inquiry',
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked In',
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function fmtDate(d: Date) { return d.toISOString().slice(0, 10) }
function daysBetween(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / 86400000) }
function isWeekend(d: Date) { const day = d.getDay(); return day === 0 || day === 6 }
function isToday(d: Date) { const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate() }
function guestFirstName(name: string) { return name.split(' ')[0] }

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function channelLabel(ch: string) {
  switch (ch) { case 'AIRBNB': return 'Airbnb'; case 'BOOKING': return 'Booking.com'; case 'DIRECT': return 'Direct'; case 'WHATSAPP': return 'WhatsApp'; default: return 'Other' }
}

function formatFullPrice(price: number | null, currency?: string | null) {
  if (price == null) return null
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : (currency || '$')
  return `${sym}${price.toFixed(2)}`
}

/** Assign vertical lanes to overlapping reservations */
function assignLanes(reservations: CalendarReservation[]): Map<string, number> {
  const lanes = new Map<string, number>()
  if (!reservations.length) return lanes
  const sorted = [...reservations].sort((a, b) => new Date(a.checkIn).getTime() - new Date(b.checkIn).getTime())
  const laneEnds: Date[] = []
  for (const r of sorted) {
    const start = new Date(r.checkIn)
    let assigned = -1
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= start) { assigned = i; laneEnds[i] = new Date(r.checkOut); break }
    }
    if (assigned === -1) { assigned = laneEnds.length; laneEnds.push(new Date(r.checkOut)) }
    lanes.set(r.id, assigned)
  }
  return lanes
}

// ════════════════════════════════════════════════════════════════════════════
// Channel Icon — uses logo images for Airbnb/Booking/WhatsApp, letter for others
// ════════════════════════════════════════════════════════════════════════════

function ChannelIcon({ channel, size = 14 }: { channel: string; size?: number }) {
  const logo = CHANNEL_LOGOS[channel]
  if (logo) {
    return <img src={logo} alt={channelLabel(channel)} width={size} height={size} style={{ borderRadius: 2, objectFit: 'contain', flexShrink: 0 }} />
  }
  const cc = channelColor(channel)
  const letter = channel === 'DIRECT' ? 'D' : '?'
  return (
    <span style={{ width: size, height: size, borderRadius: 3, background: cc.border, color: '#fff', fontSize: size * 0.6, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1 }}>
      {letter}
    </span>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Bar styles per status
// ════════════════════════════════════════════════════════════════════════════

function barStyle(status: string, ch: string): React.CSSProperties {
  const cc = channelColor(ch)
  const base: React.CSSProperties = {
    borderRadius: T.barRadius, padding: '0 6px', display: 'flex', alignItems: 'center', gap: 4,
    height: T.barHeight, minWidth: T.barMinWidth, overflow: 'hidden', whiteSpace: 'nowrap',
    fontSize: 11, fontWeight: 500, cursor: 'pointer',
    transition: 'transform 150ms ease-out, box-shadow 150ms ease-out',
    boxSizing: 'border-box',
  }
  switch (status) {
    case 'INQUIRY': return { ...base, background: cc.bg, border: `1.5px dashed ${cc.border}`, color: cc.text, opacity: 0.75 }
    case 'PENDING': return { ...base, background: cc.bg, border: `1.5px solid ${cc.border}`, color: cc.text, opacity: 0.85 }
    case 'CHECKED_IN': return { ...base, background: cc.bg, borderLeft: `3px solid ${cc.border}`, color: cc.text, opacity: 0.9 }
    default: return { ...base, background: cc.bg, color: cc.text, opacity: 0.8 }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Tooltip
// ════════════════════════════════════════════════════════════════════════════

function ReservationTooltip({ data }: { data: { reservation: CalendarReservation; x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: data.x, y: data.y })
  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    let x = data.x, y = data.y
    if (x + rect.width > window.innerWidth - 16) x = data.x - rect.width - 8
    if (y + rect.height > window.innerHeight - 16) y = data.y - rect.height - 8
    setPos({ x, y })
  }, [data.x, data.y])

  const r = data.reservation
  const nights = daysBetween(new Date(r.checkIn), new Date(r.checkOut))
  const cc = channelColor(r.channel)
  const priceStr = formatFullPrice(r.totalPrice, r.currency)

  return (
    <div ref={ref} style={{
      position: 'fixed', left: pos.x + 12, top: pos.y, zIndex: 1000, background: T.card,
      borderRadius: 10, boxShadow: '0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
      padding: 16, maxWidth: 280, animation: 'tooltipIn 150ms ease-out', pointerEvents: 'none',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 6 }}>{r.guest.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <ChannelIcon channel={r.channel} size={14} />
        <span style={{ fontSize: 13, color: T.textSecondary }}>{channelLabel(r.channel)}</span>
      </div>
      <div style={{
        display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, marginBottom: 8,
        background: cc.bg, color: cc.text, border: `1px solid ${cc.border}40`,
      }}>
        {STATUS_LABELS[r.status] || r.status}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 13, color: T.textSecondary }}>
        <div>Check-in</div>
        <div style={{ fontWeight: 500, color: T.text }}>{new Date(r.checkIn).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
        <div>Check-out</div>
        <div style={{ fontWeight: 500, color: T.text }}>{new Date(r.checkOut).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
        <div>Nights</div>
        <div style={{ fontWeight: 500, color: T.text }}>{nights}</div>
        <div>Guests</div>
        <div style={{ fontWeight: 500, color: T.text }}>{r.guestCount}</div>
        {priceStr && (<><div>Total</div><div style={{ fontWeight: 600, color: T.text, fontVariantNumeric: 'tabular-nums' }}>{priceStr}</div></>)}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Loading Spinner
// ════════════════════════════════════════════════════════════════════════════

function CalendarLoader() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <div style={{ position: 'relative', width: 48, height: 48 }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%', border: `3px solid ${T.border}`,
          borderTopColor: T.primary, animation: 'calSpin 0.8s linear infinite',
        }} />
      </div>
      <span style={{ fontSize: 13, color: T.textMuted }}>Loading calendar...</span>
      <style>{`@keyframes calSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Main Component
// ════════════════════════════════════════════════════════════════════════════

type ViewMode = '2week' | 'month'

interface CalendarProps {
  onSelectConversation?: (conversationId: string) => void
}

export default function CalendarV5({ onSelectConversation }: CalendarProps) {
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [reservations, setReservations] = useState<CalendarReservation[]>([])
  const [loading, setLoading] = useState(true)
  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 3); d.setHours(0, 0, 0, 0); return d })
  const [viewMode, setViewMode] = useState<ViewMode>('2week')
  const [search, setSearch] = useState('')
  const [tooltip, setTooltip] = useState<{ reservation: CalendarReservation; x: number; y: number } | null>(null)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)

  const numDays = viewMode === '2week' ? 14 : 30

  // Fixed column widths — grid scrolls horizontally when wider than viewport
  const colWidth = viewMode === '2week' ? 80 : 52

  // Navigation limits
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const canGoBack = startDate > addDays(now, -60)
  const canGoForward = addDays(startDate, 7) < addDays(now, 180)

  // ── Data fetching ─────────────────────────────────────────────────────
  const fetchData = useCallback(async (start: Date, days: number) => {
    const s = fmtDate(start), e = fmtDate(addDays(start, days))
    try {
      const [propData, resData] = await Promise.all([apiGetProperties(), apiGetReservations(s, e)])
      setProperties(propData)
      setReservations(resData.reservations)
    } catch (err) { console.error('[Calendar] Failed:', err) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { setLoading(true); fetchData(startDate, numDays) }, [startDate, numDays, fetchData])

  // ── Derived data ──────────────────────────────────────────────────────
  const filteredProperties = useMemo(() => {
    if (!search.trim()) return properties
    const q = search.toLowerCase()
    return properties.filter(p => p.name.toLowerCase().includes(q))
  }, [properties, search])

  const resByProperty = useMemo(() => {
    const m = new Map<string, CalendarReservation[]>()
    for (const r of reservations) { const arr = m.get(r.propertyId) || []; arr.push(r); m.set(r.propertyId, arr) }
    return m
  }, [reservations])

  const dates = useMemo(() => Array.from({ length: numDays }, (_, i) => addDays(startDate, i)), [startDate, numDays])

  const laneData = useMemo(() => {
    const m = new Map<string, { lanes: Map<string, number>; maxLane: number }>()
    for (const prop of properties) {
      const propRes = resByProperty.get(prop.id) || []
      const lanes = assignLanes(propRes)
      let maxLane = 0; lanes.forEach(l => { if (l > maxLane) maxLane = l })
      m.set(prop.id, { lanes, maxLane })
    }
    return m
  }, [properties, resByProperty])

  function rowHeight(pid: string) { return T.rowBaseHeight + (laneData.get(pid)?.maxLane || 0) * T.rowOverlapExtra }

  // Sidebar stats: confirmed count, inquiry count, occupancy (confirmed only)
  const sidebarStats = useMemo(() => {
    const m = new Map<string, { confirmed: number; inquiries: number; occPct: number }>()
    for (const prop of properties) {
      const propRes = resByProperty.get(prop.id) || []
      const confirmed = propRes.filter(r => r.status === 'CONFIRMED' || r.status === 'CHECKED_IN').length
      const inquiries = propRes.filter(r => r.status === 'INQUIRY' || r.status === 'PENDING').length
      // Occupancy: count nights covered by CONFIRMED/CHECKED_IN only
      let bookedNights = 0
      for (const d of dates) {
        const ds = fmtDate(d)
        if (propRes.some(r => (r.status === 'CONFIRMED' || r.status === 'CHECKED_IN') && ds >= fmtDate(new Date(r.checkIn)) && ds < fmtDate(new Date(r.checkOut)))) bookedNights++
      }
      m.set(prop.id, { confirmed, inquiries, occPct: Math.round((bookedNights / numDays) * 100) })
    }
    return m
  }, [properties, resByProperty, dates, numDays])

  // ── Navigation ────────────────────────────────────────────────────────
  const goForward = () => { if (canGoForward) setStartDate(prev => addDays(prev, 7)) }
  const goBack = () => { if (canGoBack) setStartDate(prev => addDays(prev, -7)) }
  const goToday = () => { const d = new Date(); d.setDate(d.getDate() - 3); d.setHours(0, 0, 0, 0); setStartDate(d) }

  const monthLabel = useMemo(() => {
    const mid = addDays(startDate, Math.floor(numDays / 2))
    return `${MONTHS[mid.getMonth()]} '${String(mid.getFullYear()).slice(2)}`
  }, [startDate, numDays])

  // ── Bar positioning ───────────────────────────────────────────────────
  function barPos(r: CalendarReservation) {
    const ci = new Date(r.checkIn); ci.setHours(0, 0, 0, 0)
    const co = new Date(r.checkOut); co.setHours(0, 0, 0, 0)
    const rangeStart = new Date(startDate); rangeStart.setHours(0, 0, 0, 0)
    const rangeEnd = addDays(rangeStart, numDays)
    const clippedLeft = ci < rangeStart
    const clippedRight = co > rangeEnd
    const barStart = clippedLeft ? rangeStart : ci
    const barEnd = clippedRight ? rangeEnd : co
    const startCol = daysBetween(rangeStart, barStart)
    const endCol = daysBetween(rangeStart, barEnd)
    // Bars start/end at midpoint of day column (check-in/out happens midday, not midnight)
    // Clipped edges go to the column boundary instead of midpoint
    const left = clippedLeft ? 0 : startCol * colWidth + colWidth / 2
    const right = clippedRight ? endCol * colWidth : endCol * colWidth + colWidth / 2
    return { left, width: Math.max(T.barMinWidth, right - left), clippedLeft, clippedRight }
  }

  // ── Click handler ─────────────────────────────────────────────────────
  const handleBarClick = (r: CalendarReservation) => {
    if (r.conversationId && onSelectConversation) {
      onSelectConversation(r.conversationId)
    }
  }

  const prefersReducedMotion = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches : false

  // ══════════════════════════════════════════════════════════════════════
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: T.bg, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <style>{`
        @keyframes tooltipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .cal-bar:hover { transform: translateY(-1px) !important; box-shadow: 0 2px 8px rgba(0,0,0,0.12) !important; z-index: 10 !important; }
        .cal-bar:focus-visible { outline: 2px solid ${T.primary}; outline-offset: 1px; }
        @media (prefers-reduced-motion: reduce) {
          @keyframes tooltipIn { from { opacity: 1; } to { opacity: 1; } }
          .cal-bar:hover { transform: none !important; }
        }
      `}</style>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: `1px solid ${T.border}`, background: T.card, flexShrink: 0 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: T.text, margin: 0 }}>Calendar</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 16 }}>
          <button onClick={goToday} style={{ height: 30, padding: '0 12px', fontSize: 12, fontWeight: 500, background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer', color: T.text }}>Today</button>
          <button onClick={goBack} disabled={!canGoBack} aria-label="Previous week" style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, cursor: canGoBack ? 'pointer' : 'not-allowed', opacity: canGoBack ? 1 : 0.4 }}>
            <ChevronLeft size={16} color={T.textSecondary} />
          </button>
          <button onClick={goForward} disabled={!canGoForward} aria-label="Next week" style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, cursor: canGoForward ? 'pointer' : 'not-allowed', opacity: canGoForward ? 1 : 0.4 }}>
            <ChevronRight size={16} color={T.textSecondary} />
          </button>
          <span style={{ fontSize: 15, fontWeight: 500, color: T.text, marginLeft: 8 }}>{monthLabel}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 16 }}>
          {(['2week', 'month'] as ViewMode[]).map(mode => (
            <button key={mode} onClick={() => setViewMode(mode)} style={{
              height: 30, padding: '0 12px', fontSize: 12, fontWeight: 500,
              background: viewMode === mode ? T.primary : T.card, color: viewMode === mode ? '#fff' : T.textSecondary,
              border: viewMode === mode ? 'none' : `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer',
            }}>{mode === '2week' ? '2 Weeks' : 'Month'}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', width: 200 }}>
          <Search size={14} color={T.textMuted} style={{ position: 'absolute', left: 10, top: 8 }} />
          <input type="text" placeholder="Filter properties..." value={search} onChange={e => setSearch(e.target.value)} aria-label="Filter properties" style={{ width: '100%', height: 30, paddingLeft: 30, paddingRight: search ? 28 : 10, fontSize: 12, border: `1px solid ${T.border}`, borderRadius: 6, outline: 'none', background: T.card, color: T.text }} />
          {search && <button onClick={() => setSearch('')} aria-label="Clear" style={{ position: 'absolute', right: 6, top: 5, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer' }}><X size={12} color={T.textMuted} /></button>}
        </div>
      </div>

      {/* Grid */}
      {loading ? <CalendarLoader /> : (
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <div style={{ display: 'inline-flex', minWidth: '100%' }}>
            {/* Sidebar */}
            <div style={{ width: T.sidebarWidth, flexShrink: 0, position: 'sticky', left: 0, zIndex: 20, background: T.card }}>
              <div style={{ height: 40, borderBottom: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`, position: 'sticky', top: 0, zIndex: 30, background: T.card, display: 'flex', alignItems: 'center', padding: '0 14px', fontSize: 11, color: T.textMuted, fontWeight: 500 }}>
                {filteredProperties.length} properties
              </div>
              {filteredProperties.map(prop => {
                const stats = sidebarStats.get(prop.id)
                const rh = rowHeight(prop.id)
                return (
                  <div key={prop.id} onMouseEnter={() => setHoveredRow(prop.id)} onMouseLeave={() => setHoveredRow(null)} style={{ height: rh, borderBottom: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 14px', background: hoveredRow === prop.id ? T.muted : T.card, transition: prefersReducedMotion ? 'none' : 'background 100ms ease-out' }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={prop.name}>{prop.name}</div>
                    <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2, display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span>{stats?.occPct || 0}%</span>
                      <span style={{ opacity: 0.3 }}>·</span>
                      <span>{stats?.confirmed || 0} res.</span>
                      {(stats?.inquiries || 0) > 0 && <><span style={{ opacity: 0.3 }}>·</span><span>{stats.inquiries} inq.</span></>}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Timeline */}
            <div style={{ position: 'relative' }}>
              {/* Date header */}
              <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 10, background: T.card, borderBottom: `1px solid ${T.border}`, height: 40 }}>
                {dates.map((d, i) => {
                  const today = isToday(d)
                  return (
                    <div key={i} style={{ width: colWidth, height: 40, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRight: `1px solid ${T.border}`, background: today ? '#EFF6FF' : isWeekend(d) ? T.muted : T.card }}>
                      <span style={{ fontSize: 10, color: today ? T.primary : T.textMuted, lineHeight: 1, marginBottom: 1 }}>{WEEKDAYS[d.getDay()]}</span>
                      <span style={{ fontSize: 13, fontWeight: today ? 600 : 400, color: today ? T.primary : '#334155', lineHeight: 1 }}>{d.getDate()}</span>
                    </div>
                  )
                })}
              </div>

              {/* Rows */}
              {filteredProperties.map(prop => {
                const propRes = resByProperty.get(prop.id) || []
                const rh = rowHeight(prop.id)
                const ld = laneData.get(prop.id)
                return (
                  <div key={prop.id} style={{ height: rh, display: 'flex', position: 'relative', borderBottom: `1px solid ${T.border}`, background: hoveredRow === prop.id ? '#FAFBFE' : 'transparent', transition: prefersReducedMotion ? 'none' : 'background 100ms ease-out' }} onMouseEnter={() => setHoveredRow(prop.id)} onMouseLeave={() => setHoveredRow(null)}>
                    {/* Cell grid */}
                    {dates.map((d, i) => {
                      const today = isToday(d)
                      return (
                        <div key={i} style={{ width: colWidth, height: rh, flexShrink: 0, borderRight: `1px solid ${T.border}`, background: today ? 'rgba(37,99,235,0.03)' : isWeekend(d) ? 'rgba(241,245,249,0.5)' : 'transparent', position: 'relative' }}>
                          {today && <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 2, background: T.primary, opacity: 0.25, zIndex: 1 }} />}
                        </div>
                      )
                    })}
                    {/* Bars */}
                    {propRes.map(r => {
                      const { left, width, clippedLeft, clippedRight } = barPos(r)
                      const style = barStyle(r.status, r.channel)
                      const lane = ld?.lanes.get(r.id) || 0
                      const barTop = 4 + lane * (T.barHeight + 2)
                      const showText = width > 50
                      const label = showText ? (r.guestCount > 1 ? `${guestFirstName(r.guest.name)} ·${r.guestCount}` : guestFirstName(r.guest.name)) : ''
                      return (
                        <div key={r.id} onClick={() => handleBarClick(r)} onMouseEnter={e => setTooltip({ reservation: r, x: e.clientX, y: e.clientY })} onMouseMove={e => { if (tooltip?.reservation.id === r.id) setTooltip({ reservation: r, x: e.clientX, y: e.clientY }) }} onMouseLeave={() => setTooltip(null)} className="cal-bar" role="button" tabIndex={0} aria-label={`${r.guest.name}, ${channelLabel(r.channel)}, ${r.status}`} onKeyDown={e => { if (e.key === 'Enter') handleBarClick(r) }}
                          style={{ ...style, position: 'absolute', left, top: barTop, width, zIndex: 5, ...(clippedLeft ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : {}), ...(clippedRight ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {}) }}>
                          <ChannelIcon channel={r.channel} size={12} />
                          {showText && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1 }}>{label}</span>}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
          {tooltip && <ReservationTooltip data={tooltip} />}
        </div>
      )}
    </div>
  )
}
