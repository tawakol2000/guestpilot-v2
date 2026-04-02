'use client'

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Search,
  CalendarDays,
  Plane,
  Globe,
  MessageCircle,
  MoreHorizontal,
  Users,
  X,
} from 'lucide-react'
import {
  apiGetReservations,
  apiGetCalendarBulk,
  apiGetProperties,
  type CalendarReservation,
  type PropertyCalendar,
  type CalendarDay,
  type ApiProperty,
} from '@/lib/api'

// ════════════════════════════════════════════════════════════════════════════
// Design Tokens (from design-system.md)
// ════════════════════════════════════════════════════════════════════════════

const T = {
  primary: '#2563EB',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  text: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  border: '#E4ECFC',
  muted: '#F1F5FD',
  rowHeight: 52,
  sidebarWidth: 240,
  colWidth2w: 80,
  colWidthMonth: 48,
  barRadius: 6,
  barMinWidth: 28,
  barHeight: 28,
}

const CHANNEL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  AIRBNB:  { bg: '#FEE2E2', text: '#991B1B', border: '#F87171' },
  BOOKING: { bg: '#DBEAFE', text: '#1E3A8A', border: '#60A5FA' },
  DIRECT:  { bg: '#D1FAE5', text: '#065F46', border: '#34D399' },
  WHATSAPP:{ bg: '#DCFCE7', text: '#166534', border: '#4ADE80' },
  OTHER:   { bg: '#F1F5F9', text: '#334155', border: '#94A3B8' },
}

function channelColor(ch: string) {
  return CHANNEL_COLORS[ch] || CHANNEL_COLORS.OTHER
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function addDays(d: Date, n: number) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

function isWeekend(d: Date) {
  const day = d.getDay()
  return day === 0 || day === 6
}

function isToday(d: Date) {
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatPrice(price: number | null, currency?: string | null) {
  if (price == null) return '---'
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : (currency || '$')
  return `${sym}${Math.round(price)}`
}

function formatFullPrice(price: number | null, currency?: string | null) {
  if (price == null) return '---'
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : (currency || '$')
  return `${sym}${price.toFixed(2)}`
}

function channelLabel(ch: string) {
  switch (ch) {
    case 'AIRBNB': return 'Airbnb'
    case 'BOOKING': return 'Booking.com'
    case 'DIRECT': return 'Direct'
    case 'WHATSAPP': return 'WhatsApp'
    default: return 'Other'
  }
}

function guestFirstName(name: string) {
  return name.split(' ')[0]
}

// ════════════════════════════════════════════════════════════════════════════
// Channel Icon Component
// ════════════════════════════════════════════════════════════════════════════

function ChannelIcon({ channel, size = 14, color }: { channel: string; size?: number; color?: string }) {
  const c = color || channelColor(channel).text
  switch (channel) {
    case 'AIRBNB': return <Plane size={size} color={c} />
    case 'BOOKING': return <CalendarDays size={size} color={c} />
    case 'WHATSAPP': return <MessageCircle size={size} color={c} />
    case 'DIRECT': return <Globe size={size} color={c} />
    default: return <MoreHorizontal size={size} color={c} />
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Status bar styles
// ════════════════════════════════════════════════════════════════════════════

function barStyle(status: string, ch: string): React.CSSProperties {
  const cc = channelColor(ch)
  const base: React.CSSProperties = {
    borderRadius: T.barRadius,
    padding: '0 6px',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: T.barHeight,
    minWidth: T.barMinWidth,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'transform 150ms ease-out, box-shadow 150ms ease-out',
    position: 'relative',
    boxSizing: 'border-box',
  }

  switch (status) {
    case 'INQUIRY':
      return { ...base, background: `${cc.bg}40`, border: `1.5px dashed ${cc.border}`, color: cc.text }
    case 'PENDING':
      return { ...base, background: cc.bg, border: `1.5px solid ${cc.border}`, opacity: 0.75, color: cc.text }
    case 'CHECKED_IN':
      return { ...base, background: cc.bg, borderLeft: `3px solid ${cc.border}`, color: cc.text }
    default: // CONFIRMED
      return { ...base, background: cc.bg, color: cc.text }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Tooltip Component
// ════════════════════════════════════════════════════════════════════════════

interface TooltipData {
  reservation: CalendarReservation
  x: number
  y: number
}

function ReservationTooltip({ data, onClose }: { data: TooltipData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: data.x, y: data.y })

  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    let x = data.x
    let y = data.y
    if (x + rect.width > window.innerWidth - 16) x = data.x - rect.width - 8
    if (y + rect.height > window.innerHeight - 16) y = data.y - rect.height - 8
    setPos({ x, y })
  }, [data.x, data.y])

  const r = data.reservation
  const nights = daysBetween(new Date(r.checkIn), new Date(r.checkOut))
  const cc = channelColor(r.channel)

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos.x + 12,
        top: pos.y,
        zIndex: 1000,
        background: T.card,
        borderRadius: 10,
        boxShadow: '0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
        padding: 16,
        maxWidth: 280,
        animation: 'tooltipIn 150ms ease-out',
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 8 }}>
        {r.guest.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <ChannelIcon channel={r.channel} size={14} color={cc.border} />
        <span style={{ fontSize: 13, color: T.textSecondary }}>{channelLabel(r.channel)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 13, color: T.textSecondary }}>
        <div>Check-in</div>
        <div style={{ fontWeight: 500, color: T.text }}>{new Date(r.checkIn).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
        <div>Check-out</div>
        <div style={{ fontWeight: 500, color: T.text }}>{new Date(r.checkOut).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
        <div>Nights</div>
        <div style={{ fontWeight: 500, color: T.text }}>{nights}</div>
        <div>Guests</div>
        <div style={{ fontWeight: 500, color: T.text }}>{r.guestCount}</div>
        {r.totalPrice != null && (
          <>
            <div>Total</div>
            <div style={{ fontWeight: 600, color: T.text, fontVariantNumeric: 'tabular-nums' }}>{formatFullPrice(r.totalPrice, r.currency)}</div>
          </>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Main Calendar Component
// ════════════════════════════════════════════════════════════════════════════

type ViewMode = '2week' | 'month'

export default function CalendarV5() {
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [reservations, setReservations] = useState<CalendarReservation[]>([])
  const [pricing, setPricing] = useState<Map<string, CalendarDay[]>>(new Map())
  const [pricingCurrency, setPricingCurrency] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 3)
    d.setHours(0, 0, 0, 0)
    return d
  })
  const [viewMode, setViewMode] = useState<ViewMode>('2week')
  const [search, setSearch] = useState('')
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const numDays = viewMode === '2week' ? 14 : 30
  const colWidth = viewMode === '2week' ? T.colWidth2w : T.colWidthMonth
  const endDate = addDays(startDate, numDays)

  // Navigation limits: 2 months back, 6 months forward
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const minDate = addDays(now, -60)
  const maxDate = addDays(now, 180)
  const canGoBack = startDate > minDate
  const canGoForward = addDays(startDate, 7) < maxDate

  // ── Data fetching ──────────────────────────────────────────────────────
  const fetchData = useCallback(async (start: Date, days: number) => {
    const s = fmtDate(start)
    const e = fmtDate(addDays(start, days))
    try {
      const [propData, resData, calData] = await Promise.all([
        apiGetProperties(),
        apiGetReservations(s, e),
        apiGetCalendarBulk(s, e),
      ])
      setProperties(propData)
      setReservations(resData.reservations)

      const priceMap = new Map<string, CalendarDay[]>()
      const currMap = new Map<string, string>()
      for (const pc of calData.properties) {
        priceMap.set(pc.propertyId, pc.days)
        currMap.set(pc.propertyId, pc.currency)
      }
      setPricing(priceMap)
      setPricingCurrency(currMap)
    } catch (err) {
      console.error('[Calendar] Failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchData(startDate, numDays)
  }, [startDate, numDays, fetchData])

  // ── Filtered properties ────────────────────────────────────────────────
  const filteredProperties = useMemo(() => {
    if (!search.trim()) return properties
    const q = search.toLowerCase()
    return properties.filter(p => p.name.toLowerCase().includes(q))
  }, [properties, search])

  // ── Reservation map: propertyId → reservations ─────────────────────────
  const resByProperty = useMemo(() => {
    const m = new Map<string, CalendarReservation[]>()
    for (const r of reservations) {
      const arr = m.get(r.propertyId) || []
      arr.push(r)
      m.set(r.propertyId, arr)
    }
    return m
  }, [reservations])

  // ── Dates array ─────────────────────────────────────────────────────────
  const dates = useMemo(() => {
    const arr: Date[] = []
    for (let i = 0; i < numDays; i++) arr.push(addDays(startDate, i))
    return arr
  }, [startDate, numDays])

  // ── Occupancy per property ─────────────────────────────────────────────
  const occupancy = useMemo(() => {
    const m = new Map<string, { booked: number; total: number; count: number }>()
    for (const prop of properties) {
      const propRes = resByProperty.get(prop.id) || []
      let booked = 0
      for (const d of dates) {
        const ds = fmtDate(d)
        for (const r of propRes) {
          const ci = fmtDate(new Date(r.checkIn))
          const co = fmtDate(new Date(r.checkOut))
          if (ds >= ci && ds < co) { booked++; break }
        }
      }
      m.set(prop.id, { booked, total: numDays, count: propRes.length })
    }
    return m
  }, [properties, resByProperty, dates, numDays])

  // ── Navigation handlers ────────────────────────────────────────────────
  const goForward = () => {
    if (canGoForward) setStartDate(prev => addDays(prev, 7))
  }
  const goBack = () => {
    if (canGoBack) setStartDate(prev => addDays(prev, -7))
  }
  const goToday = () => {
    const d = new Date()
    d.setDate(d.getDate() - 3)
    d.setHours(0, 0, 0, 0)
    setStartDate(d)
  }

  // ── Month label ─────────────────────────────────────────────────────────
  const monthLabel = useMemo(() => {
    const mid = addDays(startDate, Math.floor(numDays / 2))
    return `${MONTHS[mid.getMonth()]} '${String(mid.getFullYear()).slice(2)}`
  }, [startDate, numDays])

  // ── Bar positioning ─────────────────────────────────────────────────────
  function barPos(r: CalendarReservation) {
    const ci = new Date(r.checkIn)
    const co = new Date(r.checkOut)
    ci.setHours(0, 0, 0, 0)
    co.setHours(0, 0, 0, 0)

    const rangeStart = new Date(startDate)
    rangeStart.setHours(0, 0, 0, 0)
    const rangeEnd = addDays(rangeStart, numDays)

    const barStart = ci < rangeStart ? rangeStart : ci
    const barEnd = co > rangeEnd ? rangeEnd : co

    const startCol = daysBetween(rangeStart, barStart)
    const endCol = daysBetween(rangeStart, barEnd)

    const clippedLeft = ci < rangeStart
    const clippedRight = co > rangeEnd

    // Padding: 2px on each side of the bar within its cell span
    const left = startCol * colWidth + 2
    const width = Math.max(T.barMinWidth, (endCol - startCol) * colWidth - 4)
    const nights = endCol - startCol

    return { left, width, clippedLeft, clippedRight, nights }
  }

  // ── Click handler ──────────────────────────────────────────────────────
  const handleBarClick = (r: CalendarReservation) => {
    if (r.conversationId) {
      // Navigate to inbox with conversation selected
      window.location.hash = ''
      window.location.search = `?conversation=${r.conversationId}`
      window.location.reload()
    }
  }

  // ── Reduced motion ─────────────────────────────────────────────────────
  const prefersReducedMotion = typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    : false

  // ══════════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: T.bg, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <style>{`
        @keyframes tooltipIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .cal-bar:hover {
          transform: translateY(-1px) !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12) !important;
          z-index: 10 !important;
        }
        .cal-bar:focus-visible {
          outline: 2px solid ${T.primary};
          outline-offset: 1px;
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes tooltipIn { from { opacity: 1; } to { opacity: 1; } }
          @keyframes shimmer { from {} to {} }
          .cal-bar:hover { transform: none !important; }
        }
      `}</style>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        borderBottom: `1px solid ${T.border}`, background: T.card, flexShrink: 0,
      }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: T.text, margin: 0 }}>Calendar</h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 16 }}>
          <button
            onClick={goToday}
            style={{
              height: 32, padding: '0 12px', fontSize: 13, fontWeight: 500,
              background: T.card, border: `1px solid ${T.border}`, borderRadius: 6,
              cursor: 'pointer', color: T.text,
            }}
          >
            Today
          </button>
          <button
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Previous week"
            style={{
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: T.card, border: `1px solid ${T.border}`, borderRadius: 6,
              cursor: canGoBack ? 'pointer' : 'not-allowed',
              opacity: canGoBack ? 1 : 0.4,
            }}
          >
            <ChevronLeft size={16} color={T.textSecondary} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            aria-label="Next week"
            style={{
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: T.card, border: `1px solid ${T.border}`, borderRadius: 6,
              cursor: canGoForward ? 'pointer' : 'not-allowed',
              opacity: canGoForward ? 1 : 0.4,
            }}
          >
            <ChevronRight size={16} color={T.textSecondary} />
          </button>
          <span style={{ fontSize: 15, fontWeight: 500, color: T.text, marginLeft: 8 }}>{monthLabel}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 16 }}>
          {(['2week', 'month'] as ViewMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                height: 32, padding: '0 12px', fontSize: 12, fontWeight: 500,
                background: viewMode === mode ? T.primary : T.card,
                color: viewMode === mode ? '#fff' : T.textSecondary,
                border: viewMode === mode ? 'none' : `1px solid ${T.border}`,
                borderRadius: 6, cursor: 'pointer',
                transition: prefersReducedMotion ? 'none' : 'all 150ms ease-out',
              }}
            >
              {mode === '2week' ? '2 Weeks' : 'Month'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ position: 'relative', width: 220 }}>
          <Search size={14} color={T.textMuted} style={{ position: 'absolute', left: 10, top: 9 }} />
          <input
            type="text"
            placeholder="Filter properties..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter properties by name"
            style={{
              width: '100%', height: 32, paddingLeft: 30, paddingRight: search ? 28 : 10,
              fontSize: 13, border: `1px solid ${T.border}`, borderRadius: 6,
              outline: 'none', background: T.card, color: T.text,
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear filter"
              style={{
                position: 'absolute', right: 6, top: 6, width: 20, height: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'none', border: 'none', cursor: 'pointer', borderRadius: 4,
              }}
            >
              <X size={12} color={T.textMuted} />
            </button>
          )}
        </div>
      </div>

      {/* ── Calendar Grid ──────────────────────────────────────────────── */}
      {loading ? (
        /* Skeleton */
        <div style={{ flex: 1, padding: 20, overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: 0 }}>
            <div style={{ width: T.sidebarWidth, flexShrink: 0 }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ height: T.rowHeight, display: 'flex', alignItems: 'center', padding: '0 16px' }}>
                  <div style={{
                    width: 140, height: 14, borderRadius: 4,
                    background: `linear-gradient(90deg, ${T.muted} 25%, #e8edf5 50%, ${T.muted} 75%)`,
                    backgroundSize: '200% 100%',
                    animation: prefersReducedMotion ? 'none' : 'shimmer 1.5s linear infinite',
                  }} />
                </div>
              ))}
            </div>
            <div style={{ flex: 1 }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ height: T.rowHeight, display: 'flex', gap: 1 }}>
                  {Array.from({ length: numDays }).map((_, j) => (
                    <div key={j} style={{
                      width: colWidth, height: T.rowHeight - 1,
                      background: `linear-gradient(90deg, ${T.muted} 25%, #e8edf5 50%, ${T.muted} 75%)`,
                      backgroundSize: '200% 100%',
                      animation: prefersReducedMotion ? 'none' : `shimmer 1.5s linear ${j * 30}ms infinite`,
                    }} />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {/* shimmer keyframes defined in global style block above */}
        </div>
      ) : (
        <div ref={gridRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <div style={{ display: 'inline-flex', minWidth: '100%' }}>
            {/* ── Sticky sidebar ──────────────────────────────────────── */}
            <div style={{
              width: T.sidebarWidth, flexShrink: 0, position: 'sticky', left: 0,
              zIndex: 20, background: T.card,
            }}>
              {/* Corner cell */}
              <div style={{
                height: 44, borderBottom: `1px solid ${T.border}`,
                borderRight: `1px solid ${T.border}`, position: 'sticky', top: 0,
                zIndex: 30, background: T.card, display: 'flex', alignItems: 'center',
                padding: '0 16px', fontSize: 12, color: T.textMuted, fontWeight: 500,
              }}>
                {filteredProperties.length} properties
              </div>
              {/* Property rows */}
              {filteredProperties.map(prop => {
                const occ = occupancy.get(prop.id)
                const pct = occ ? Math.round((occ.booked / occ.total) * 100) : 0
                return (
                  <div
                    key={prop.id}
                    onMouseEnter={() => setHoveredRow(prop.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                    style={{
                      height: T.rowHeight, borderBottom: `1px solid ${T.border}`,
                      borderRight: `1px solid ${T.border}`,
                      display: 'flex', flexDirection: 'column', justifyContent: 'center',
                      padding: '0 16px', cursor: 'default',
                      background: hoveredRow === prop.id ? T.muted : T.card,
                      transition: prefersReducedMotion ? 'none' : 'background 100ms ease-out',
                    }}
                  >
                    <div style={{
                      fontSize: 13, fontWeight: 500, color: T.text,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={prop.name}>
                      {prop.name}
                    </div>
                    <div style={{ fontSize: 11, color: T.textMuted, display: 'flex', gap: 6, marginTop: 1 }}>
                      <span>{pct}%</span>
                      <span style={{ color: T.border }}>·</span>
                      <span>{occ?.count || 0} bookings</span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* ── Timeline area ───────────────────────────────────────── */}
            <div style={{ position: 'relative' }}>
              {/* Date header (sticky top) */}
              <div style={{
                display: 'flex', position: 'sticky', top: 0, zIndex: 10,
                background: T.card, borderBottom: `1px solid ${T.border}`, height: 44,
              }}>
                {dates.map((d, i) => {
                  const today = isToday(d)
                  return (
                    <div key={i} style={{
                      width: colWidth, height: 44, flexShrink: 0,
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      borderRight: `1px solid ${T.border}`,
                      background: today ? '#EFF6FF' : isWeekend(d) ? T.muted : T.card,
                    }}>
                      <span style={{ fontSize: 11, color: today ? T.primary : T.textMuted, lineHeight: 1, marginBottom: 2 }}>
                        {WEEKDAYS[d.getDay()]}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: today ? 600 : 400, color: today ? T.primary : '#334155', lineHeight: 1 }}>
                        {d.getDate()}
                      </span>
                    </div>
                  )
                })}
              </div>

              {/* Property timelines */}
              {filteredProperties.map(prop => {
                const propRes = resByProperty.get(prop.id) || []
                const propPricing = pricing.get(prop.id) || []
                const propCurrency = pricingCurrency.get(prop.id) || null
                const pricingMap = new Map(propPricing.map(d => [d.date, d]))

                return (
                  <div
                    key={prop.id}
                    style={{
                      height: T.rowHeight, display: 'flex', position: 'relative',
                      borderBottom: `1px solid ${T.border}`,
                      background: hoveredRow === prop.id ? '#FAFBFE' : 'transparent',
                      transition: prefersReducedMotion ? 'none' : 'background 100ms ease-out',
                    }}
                    onMouseEnter={() => setHoveredRow(prop.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                  >
                    {/* Price cells (behind bars) */}
                    {dates.map((d, i) => {
                      const ds = fmtDate(d)
                      // Check if any reservation covers this date
                      const isBooked = propRes.some(r => {
                        const ci = fmtDate(new Date(r.checkIn))
                        const co = fmtDate(new Date(r.checkOut))
                        return ds >= ci && ds < co
                      })
                      const priceData = pricingMap.get(ds)
                      const today = isToday(d)

                      return (
                        <div key={i} style={{
                          width: colWidth, height: T.rowHeight, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          borderRight: `1px solid ${T.border}`,
                          background: today ? 'rgba(37,99,235,0.03)' : isWeekend(d) ? 'rgba(241,245,253,0.5)' : 'transparent',
                          position: 'relative',
                        }}>
                          {/* Today marker line */}
                          {today && (
                            <div style={{
                              position: 'absolute', top: 0, bottom: 0, left: '50%',
                              width: 2, background: T.primary, opacity: 0.3, zIndex: 1,
                            }} />
                          )}
                          {/* Price text (only for unbooked cells) */}
                          {!isBooked && (
                            <span style={{
                              fontSize: 11, color: T.textMuted, fontVariantNumeric: 'tabular-nums',
                              position: 'relative', zIndex: 2,
                            }}>
                              {priceData ? formatPrice(priceData.price, propCurrency) : ''}
                            </span>
                          )}
                        </div>
                      )
                    })}

                    {/* Reservation bars (positioned absolutely) */}
                    {propRes.map(r => {
                      const { left, width, clippedLeft, clippedRight, nights } = barPos(r)
                      const style = barStyle(r.status, r.channel)
                      // Smart content: hide text for very short bars
                      const showName = width > 60
                      const showCount = width > 100 && r.guestCount > 1
                      return (
                        <div
                          key={r.id}
                          onClick={() => handleBarClick(r)}
                          onMouseEnter={(e) => {
                            setTooltip({ reservation: r, x: e.clientX, y: e.clientY })
                          }}
                          onMouseMove={(e) => {
                            if (tooltip?.reservation.id === r.id) {
                              setTooltip({ reservation: r, x: e.clientX, y: e.clientY })
                            }
                          }}
                          onMouseLeave={() => setTooltip(null)}
                          style={{
                            ...style,
                            position: 'absolute',
                            left,
                            top: (T.rowHeight - T.barHeight) / 2,
                            width,
                            zIndex: 5,
                            ...(clippedLeft ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : {}),
                            ...(clippedRight ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {}),
                          }}
                          className="cal-bar"
                          role="button"
                          tabIndex={0}
                          aria-label={`${r.guest.name}, ${channelLabel(r.channel)}, ${new Date(r.checkIn).toLocaleDateString()} to ${new Date(r.checkOut).toLocaleDateString()}`}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleBarClick(r) }}
                        >
                          <ChannelIcon channel={r.channel} size={13} />
                          {showName && (
                            <span style={{
                              overflow: 'hidden', textOverflow: 'ellipsis',
                              lineHeight: 1, flex: 1, minWidth: 0,
                            }}>
                              {guestFirstName(r.guest.name)}
                            </span>
                          )}
                          {showCount && (
                            <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>
                              ·{r.guestCount}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Tooltip portal */}
          {tooltip && (
            <ReservationTooltip data={tooltip} onClose={() => setTooltip(null)} />
          )}
        </div>
      )}
    </div>
  )
}
