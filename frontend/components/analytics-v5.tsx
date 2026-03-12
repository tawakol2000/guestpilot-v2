'use client'

import { useState, useEffect, useRef } from 'react'
import { apiGetAnalytics, type ApiAnalytics } from '@/lib/api'

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
`

type Range = '7d' | '30d' | '90d'

function formatResponseTime(ms: number): string {
  if (ms < 60000) return '< 1m'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

interface TooltipState {
  visible: boolean
  x: number
  y: number
  date: string
  received: number
  sent: number
  aiSent: number
}

function ShimmerStyle(): React.ReactElement {
  const styleRef = useRef<HTMLStyleElement | null>(null)

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = shimmerKeyframes
    document.head.appendChild(style)
    styleRef.current = style
    return () => {
      if (styleRef.current) {
        document.head.removeChild(styleRef.current)
      }
    }
  }, [])

  return <></>
}

function SkeletonCard(): React.ReactElement {
  return (
    <div
      style={{
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
        backgroundSize: '200% 100%',
        padding: 20,
        height: 80,
        flex: 1,
        animation: 'shimmer 1.5s ease-in-out infinite',
        boxShadow: T.shadow.sm,
      }}
    />
  )
}

function SkeletonChart(): React.ReactElement {
  return (
    <div
      style={{
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        background: T.bg.primary,
        padding: 20,
        boxShadow: T.shadow.sm,
      }}
    >
      <div
        style={{
          height: 20,
          width: 140,
          borderRadius: T.radius.sm,
          background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s ease-in-out infinite',
          marginBottom: 16,
        }}
      />
      <div
        style={{
          height: 140,
          borderRadius: T.radius.sm,
          background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s ease-in-out infinite',
        }}
      />
    </div>
  )
}

interface MetricCardProps {
  label: string
  value: string
  trend?: number | null
  animationIndex?: number
}

function MetricCard({ label, value, trend, animationIndex = 0 }: MetricCardProps): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  const hasTrend = trend != null && isFinite(trend)
  const trendUp = hasTrend && trend > 0
  const trendDown = hasTrend && trend < 0
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        background: T.bg.primary,
        padding: 20,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontFamily: T.font.sans,
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
        animation: 'fadeInUp 0.4s ease-out both',
        animationDelay: `${animationIndex * 0.06}s`,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: T.text.tertiary,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: T.text.primary,
            lineHeight: 1.1,
          }}
        >
          {value}
        </span>
        {hasTrend && trend !== 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: trendUp ? T.status.green : trendDown ? T.status.red : T.text.tertiary,
              background: trendUp ? '#15803D12' : trendDown ? '#DC262612' : 'transparent',
              borderRadius: 999,
              padding: '2px 8px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {trendUp ? '\u2191' : trendDown ? '\u2193' : ''} {trendUp ? '+' : ''}{Math.round(trend)}%
          </span>
        )}
      </div>
    </div>
  )
}

function computeTrend(byDay: Array<{ messagesReceived: number; messagesSent: number; aiMessagesSent: number }>, accessor: (d: { messagesReceived: number; messagesSent: number; aiMessagesSent: number }) => number): number | null {
  if (byDay.length < 4) return null
  const mid = Math.floor(byDay.length / 2)
  const firstHalf = byDay.slice(0, mid).reduce((s, d) => s + accessor(d), 0)
  const secondHalf = byDay.slice(mid).reduce((s, d) => s + accessor(d), 0)
  if (firstHalf === 0) return secondHalf > 0 ? 100 : null
  return ((secondHalf - firstHalf) / firstHalf) * 100
}

export function AnalyticsV5(): React.ReactElement {
  const [range, setRange] = useState<Range>('30d')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ApiAnalytics | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    date: '',
    received: 0,
    sent: 0,
    aiSent: 0,
  })
  const [hoveredDay, setHoveredDay] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    apiGetAnalytics(range)
      .then((result) => {
        setData(result)
      })
      .catch(() => {
        setData(null)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [range])

  const allDays = data?.byDay ?? []
  const dailySlice = allDays.slice(-14)
  const trendReceived = computeTrend(allDays, d => d.messagesReceived)
  const trendSent = computeTrend(allDays, d => d.messagesSent)
  const trendAi = computeTrend(allDays, d => d.aiMessagesSent)
  const maxVal = dailySlice.reduce((acc, d) => {
    return Math.max(acc, d.messagesReceived, d.messagesSent, d.aiMessagesSent)
  }, 1)

  const BAR_MAX_HEIGHT = 120
  const BAR_MIN_HEIGHT = 2

  function calcHeight(val: number): number {
    if (val <= 0) return BAR_MIN_HEIGHT
    return Math.max(BAR_MIN_HEIGHT, Math.round((val / maxVal) * BAR_MAX_HEIGHT))
  }

  function formatDayLabel(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00')
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  const ranges: Range[] = ['7d', '30d', '90d']

  return (
    <div
      style={{
        overflow: 'auto',
        padding: 24,
        fontFamily: T.font.sans,
        background: T.bg.secondary,
        minHeight: '100%',
        boxSizing: 'border-box',
      }}
    >
      <ShimmerStyle />

      {/* Page header with range pills */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: T.text.primary,
              lineHeight: 1.2,
              fontFamily: T.font.sans,
            }}
          >
            Analytics
          </div>
          <div
            style={{
              fontSize: 12,
              color: T.text.tertiary,
              marginTop: 2,
              fontFamily: T.font.sans,
            }}
          >
            Message volume and response metrics
          </div>
        </div>

        {/* Range pills */}
        <div
          style={{
            display: 'flex',
            gap: 4,
          }}
        >
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                height: 28,
                padding: '0 14px',
                borderRadius: 999,
                border: range === r ? `1px solid ${T.border.strong}` : `1px solid ${T.border.default}`,
                background: range === r ? T.border.strong : 'transparent',
                color: range === r ? '#FFFFFF' : T.text.secondary,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: T.font.sans,
                transition: 'all 0.2s ease',
                lineHeight: 1,
                boxShadow: range === r ? T.shadow.sm : 'none',
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Metric cards — row 1 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 12,
        }}
      >
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <MetricCard
              label="Messages Received"
              value={data?.totals.messagesReceived?.toLocaleString() ?? '—'}
              trend={trendReceived}
              animationIndex={0}
            />
            <MetricCard
              label="Messages Sent"
              value={data?.totals.messagesSent?.toLocaleString() ?? '—'}
              trend={trendSent}
              animationIndex={1}
            />
            <MetricCard
              label="AI Sent"
              value={data?.totals.aiMessagesSent?.toLocaleString() ?? '—'}
              trend={trendAi}
              animationIndex={2}
            />
            <MetricCard
              label="Avg Response Time"
              value={
                data?.totals.avgResponseTimeMs != null
                  ? formatResponseTime(data.totals.avgResponseTimeMs)
                  : '—'
              }
              animationIndex={3}
            />
          </>
        )}
      </div>

      {/* Metric cards — row 2 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          marginBottom: 20,
        }}
      >
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <MetricCard
              label="AI Resolution Rate"
              value={
                data?.totals.aiResolutionRate != null
                  ? `${Math.round(data.totals.aiResolutionRate * 100)}%`
                  : '—'
              }
              animationIndex={4}
            />
            <MetricCard
              label="Tasks Created"
              value={data?.totals.tasksCreated?.toLocaleString() ?? '—'}
              animationIndex={5}
            />
            <MetricCard
              label="Tasks Completed"
              value={data?.totals.tasksCompleted?.toLocaleString() ?? '—'}
              animationIndex={6}
            />
          </>
        )}
      </div>

      {/* Bar chart */}
      {loading ? (
        <SkeletonChart />
      ) : (
        <div
          style={{
            borderRadius: T.radius.md,
            border: `1px solid ${T.border.default}`,
            background: T.bg.primary,
            overflow: 'hidden',
            boxShadow: T.shadow.sm,
            animation: 'fadeInUp 0.4s ease-out both',
            animationDelay: '0.15s',
          }}
        >
          {/* Panel section header */}
          <div
            style={{
              background: T.bg.secondary,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: T.text.secondary,
              padding: '8px 16px',
              fontFamily: T.font.sans,
            }}
          >
            Daily Activity
          </div>

          <div style={{ padding: 20 }}>
            {/* Legend */}
            <div
              style={{
                display: 'flex',
                gap: 12,
                marginBottom: 20,
                alignItems: 'center',
              }}
            >
              {[
                { label: 'Received', color: T.border.strong },
                { label: 'Sent', color: T.accent },
                { label: 'AI', color: T.status.green },
              ].map(({ label, color }) => (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 11,
                    color: T.text.secondary,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: color,
                      flexShrink: 0,
                    }}
                  />
                  {label}
                </div>
              ))}
            </div>

            {/* Chart bars */}
            <div
              ref={chartRef}
              style={{
                position: 'relative',
                overflowX: 'auto',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 8,
                  minWidth: 'max-content',
                  paddingBottom: 4,
                }}
              >
                {dailySlice.map((day) => {
                  const hReceived = calcHeight(day.messagesReceived)
                  const hSent = calcHeight(day.messagesSent)
                  const hAi = calcHeight(day.aiMessagesSent)
                  const dayLabel = formatDayLabel(day.date)
                  const isGroupHovered = hoveredDay === day.date

                  return (
                    <div
                      key={day.date}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 4,
                      }}
                      onMouseEnter={() => setHoveredDay(day.date)}
                      onMouseLeave={() => setHoveredDay(null)}
                    >
                      {/* Bars group */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-end',
                          gap: 2,
                          height: BAR_MAX_HEIGHT,
                        }}
                      >
                        {/* Received bar */}
                        <div
                          title={`${day.date} — Received: ${day.messagesReceived}`}
                          data-testid={`bar-received-${day.date}`}
                          style={{
                            width: 10,
                            height: hReceived,
                            background: T.border.strong,
                            borderRadius: '3px 3px 0 0',
                            cursor: 'pointer',
                            transition: 'opacity 0.1s ease',
                            opacity: hoveredDay !== null && !isGroupHovered ? 0.3 : 1,
                          }}
                          onMouseEnter={(e) => {
                            const rect = (e.target as HTMLElement).getBoundingClientRect()
                            const containerRect = chartRef.current?.getBoundingClientRect()
                            setTooltip({
                              visible: true,
                              x: rect.left - (containerRect?.left ?? 0) + rect.width / 2,
                              y: rect.top - (containerRect?.top ?? 0) - 8,
                              date: day.date,
                              received: day.messagesReceived,
                              sent: day.messagesSent,
                              aiSent: day.aiMessagesSent,
                            })
                          }}
                          onMouseLeave={() => setTooltip((t) => ({ ...t, visible: false }))}
                        />
                        {/* Sent bar */}
                        <div
                          title={`${day.date} — Sent: ${day.messagesSent}`}
                          data-testid={`bar-sent-${day.date}`}
                          style={{
                            width: 10,
                            height: hSent,
                            background: T.accent,
                            borderRadius: '3px 3px 0 0',
                            cursor: 'pointer',
                            transition: 'opacity 0.1s ease',
                            opacity: hoveredDay !== null && !isGroupHovered ? 0.3 : 1,
                          }}
                          onMouseEnter={(e) => {
                            const rect = (e.target as HTMLElement).getBoundingClientRect()
                            const containerRect = chartRef.current?.getBoundingClientRect()
                            setTooltip({
                              visible: true,
                              x: rect.left - (containerRect?.left ?? 0) + rect.width / 2,
                              y: rect.top - (containerRect?.top ?? 0) - 8,
                              date: day.date,
                              received: day.messagesReceived,
                              sent: day.messagesSent,
                              aiSent: day.aiMessagesSent,
                            })
                          }}
                          onMouseLeave={() => setTooltip((t) => ({ ...t, visible: false }))}
                        />
                        {/* AI bar */}
                        <div
                          title={`${day.date} — AI: ${day.aiMessagesSent}`}
                          data-testid={`bar-ai-${day.date}`}
                          style={{
                            width: 10,
                            height: hAi,
                            background: T.status.green,
                            borderRadius: '3px 3px 0 0',
                            cursor: 'pointer',
                            transition: 'opacity 0.1s ease',
                            opacity: hoveredDay !== null && !isGroupHovered ? 0.3 : 1,
                          }}
                          onMouseEnter={(e) => {
                            const rect = (e.target as HTMLElement).getBoundingClientRect()
                            const containerRect = chartRef.current?.getBoundingClientRect()
                            setTooltip({
                              visible: true,
                              x: rect.left - (containerRect?.left ?? 0) + rect.width / 2,
                              y: rect.top - (containerRect?.top ?? 0) - 8,
                              date: day.date,
                              received: day.messagesReceived,
                              sent: day.messagesSent,
                              aiSent: day.aiMessagesSent,
                            })
                          }}
                          onMouseLeave={() => setTooltip((t) => ({ ...t, visible: false }))}
                        />
                      </div>

                      {/* Day label */}
                      <span
                        style={{
                          fontSize: 10,
                          color: T.text.tertiary,
                          fontFamily: T.font.sans,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {dayLabel}
                      </span>
                    </div>
                  )
                })}

                {dailySlice.length === 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '100%',
                      padding: '48px 0',
                      gap: 8,
                    }}
                  >
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={T.text.tertiary}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 3v18h18" />
                      <path d="M7 16l4-4 4 4 6-6" />
                    </svg>
                    <span
                      style={{
                        fontSize: 12,
                        color: T.text.tertiary,
                      }}
                    >
                      No data for this period
                    </span>
                  </div>
                )}
              </div>

              {/* Tooltip */}
              {tooltip.visible && (
                <div
                  style={{
                    position: 'absolute',
                    left: tooltip.x,
                    top: tooltip.y,
                    transform: 'translate(-50%, -100%)',
                    background: T.text.primary,
                    color: T.bg.primary,
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 11,
                    fontFamily: T.font.sans,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                    zIndex: 10,
                    boxShadow: T.shadow.lg,
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{tooltip.date}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                      <span style={{ color: T.text.tertiary }}>Received</span>
                      <span style={{ fontWeight: 600 }}>{tooltip.received}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                      <span style={{ color: T.text.tertiary }}>Sent</span>
                      <span style={{ fontWeight: 600, color: '#93C5FD' }}>{tooltip.sent}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                      <span style={{ color: T.text.tertiary }}>AI</span>
                      <span style={{ fontWeight: 600, color: '#86EFAC' }}>{tooltip.aiSent}</span>
                    </div>
                  </div>
                  {/* Arrow pointer */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: -5,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: 0,
                      height: 0,
                      borderLeft: '5px solid transparent',
                      borderRight: '5px solid transparent',
                      borderTop: `5px solid ${T.text.primary}`,
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Property Performance Table */}
      {!loading && data?.byProperty && data.byProperty.length > 0 && (
        <div
          style={{
            borderRadius: T.radius.md,
            border: `1px solid ${T.border.default}`,
            background: T.bg.primary,
            overflow: 'hidden',
            marginTop: 20,
            boxShadow: T.shadow.sm,
            animation: 'fadeInUp 0.4s ease-out both',
            animationDelay: '0.2s',
          }}
        >
          <div
            style={{
              background: T.bg.secondary,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: T.text.secondary,
              padding: '8px 16px',
              fontFamily: T.font.sans,
            }}
          >
            Property Performance
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.font.sans, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border.default}` }}>
                  {['Property', 'Conversations', 'AI Messages', 'Host Messages', 'AI %'].map(h => (
                    <th
                      key={h}
                      style={{
                        textAlign: h === 'Property' ? 'left' : 'right',
                        padding: '10px 16px',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: T.text.tertiary,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.byProperty.map((p, idx) => {
                  const total = p.aiMessages + p.hostMessages
                  const aiPct = total > 0 ? Math.round((p.aiMessages / total) * 100) : 0
                  return (
                    <tr
                      key={p.propertyId}
                      style={{
                        borderBottom: `1px solid ${T.border.default}`,
                        background: idx % 2 === 1 ? T.bg.secondary : 'transparent',
                        cursor: 'pointer',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = T.bg.tertiary }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = idx % 2 === 1 ? T.bg.secondary : 'transparent' }}
                    >
                      <td style={{ padding: '10px 16px', fontWeight: 500, color: T.text.primary }}>{p.propertyName}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', color: T.text.secondary }}>{p.conversations}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', color: T.status.green, fontWeight: 600 }}>{p.aiMessages}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', color: T.text.secondary }}>{p.hostMessages}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            borderRadius: 999,
                            background: T.accent + '14',
                            color: T.accent,
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '2px 10px',
                          }}
                        >
                          {aiPct}%
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* A3: Response Time Distribution */}
      {!loading && data?.responseTimeDistribution && (
        <div
          style={{
            borderRadius: T.radius.md,
            border: `1px solid ${T.border.default}`,
            background: T.bg.primary,
            overflow: 'hidden',
            marginTop: 20,
            boxShadow: T.shadow.sm,
            animation: 'fadeInUp 0.4s ease-out both',
            animationDelay: '0.25s',
          }}
        >
          <div
            style={{
              background: T.bg.secondary,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: T.text.secondary,
              padding: '8px 16px',
              fontFamily: T.font.sans,
            }}
          >
            Response Time Distribution
          </div>
          <div style={{ padding: 20 }}>
            {[
              { label: '< 5 min', value: data.responseTimeDistribution.under5m, color: T.accent },
              { label: '< 15 min', value: data.responseTimeDistribution.under15m, color: T.status.green },
              { label: '< 1 hour', value: data.responseTimeDistribution.under1h, color: T.status.amber },
              { label: '< 4 hours', value: data.responseTimeDistribution.under4h, color: '#EA580C' },
              { label: '> 4 hours', value: data.responseTimeDistribution.over4h, color: T.status.red },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.mono, width: 70, flexShrink: 0, fontWeight: 500 }}>
                  {label}
                </span>
                <div style={{ flex: 1, height: 22, background: T.bg.tertiary, borderRadius: T.radius.sm, overflow: 'hidden' }}>
                  <div
                    title={`${label}: ${value}%`}
                    style={{
                      height: '100%',
                      width: `${value}%`,
                      background: color,
                      borderRadius: T.radius.sm,
                      transition: 'width 0.4s ease',
                      minWidth: value > 0 ? 4 : 0,
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: T.text.primary, fontFamily: T.font.mono, width: 40, textAlign: 'right' }}>
                  {value}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* A4: Channel Performance */}
      {!loading && data?.byChannel && data.byChannel.length > 0 && (
        <div
          style={{
            borderRadius: T.radius.md,
            border: `1px solid ${T.border.default}`,
            background: T.bg.primary,
            overflow: 'hidden',
            marginTop: 20,
            boxShadow: T.shadow.sm,
            animation: 'fadeInUp 0.4s ease-out both',
            animationDelay: '0.3s',
          }}
        >
          <div
            style={{
              background: T.bg.secondary,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: T.text.secondary,
              padding: '8px 16px',
              fontFamily: T.font.sans,
            }}
          >
            Channel Performance
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.font.sans, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border.default}` }}>
                  {['Channel', 'Received', 'Sent', 'AI', 'Avg Response'].map(h => (
                    <th
                      key={h}
                      style={{
                        textAlign: h === 'Channel' ? 'left' : 'right',
                        padding: '10px 16px',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: T.text.tertiary,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.byChannel.map((ch, idx) => (
                  <tr
                    key={ch.channel}
                    style={{
                      borderBottom: `1px solid ${T.border.default}`,
                      background: idx % 2 === 1 ? T.bg.secondary : 'transparent',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = T.bg.tertiary }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = idx % 2 === 1 ? T.bg.secondary : 'transparent' }}
                  >
                    <td style={{ padding: '10px 16px', fontWeight: 500, color: T.text.primary }}>
                      {ch.channel.charAt(0) + ch.channel.slice(1).toLowerCase()}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', color: T.text.secondary }}>{ch.received}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', color: T.accent, fontWeight: 600 }}>{ch.sent}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', color: T.status.green, fontWeight: 600 }}>{ch.ai}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', color: T.text.secondary, fontFamily: T.font.mono, fontSize: 12 }}>
                      {ch.avgResponseTimeMs > 0 ? formatResponseTime(ch.avgResponseTimeMs) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* A8: Peak Hours Heatmap */}
      {!loading && data?.peakHoursHeatmap && (() => {
        const hm = data.peakHoursHeatmap
        const maxHm = Math.max(1, ...hm.flat())
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const heatColor = (intensity: number): string => {
          if (intensity <= 0) return T.bg.tertiary
          if (intensity < 0.25) return 'rgba(217,119,6,0.15)'
          if (intensity < 0.5) return 'rgba(217,119,6,0.35)'
          if (intensity < 0.75) return 'rgba(234,88,12,0.55)'
          return 'rgba(220,38,38,0.75)'
        }
        return (
          <div
            style={{
              borderRadius: T.radius.md,
              border: `1px solid ${T.border.default}`,
              background: T.bg.primary,
              overflow: 'hidden',
              marginTop: 20,
              boxShadow: T.shadow.sm,
              animation: 'fadeInUp 0.4s ease-out both',
              animationDelay: '0.35s',
            }}
          >
            <div
              style={{
                background: T.bg.secondary,
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: T.text.secondary,
                padding: '8px 16px',
                fontFamily: T.font.sans,
              }}
            >
              Peak Hours
            </div>
            <div style={{ padding: 16, overflowX: 'auto' }}>
              <div style={{ display: 'flex', paddingLeft: 36, marginBottom: 4 }}>
                {Array.from({ length: 24 }).map((_, h) => (
                  <div key={h} style={{ width: 20, textAlign: 'center', fontSize: 9, color: T.text.tertiary, fontFamily: T.font.mono, fontWeight: 500 }}>
                    {h % 6 === 0 ? `${h}` : ''}
                  </div>
                ))}
              </div>
              {dayLabels.map((day, di) => (
                <div key={day} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ width: 30, fontSize: 10, color: T.text.secondary, fontFamily: T.font.mono, textAlign: 'right', fontWeight: 500 }}>{day}</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    {Array.from({ length: 24 }).map((_, h) => {
                      const val = hm[di]?.[h] ?? 0
                      const intensity = val / maxHm
                      return (
                        <div
                          key={h}
                          title={`${day} ${h}:00 — ${val} messages`}
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            background: heatColor(intensity),
                            transition: 'background 0.2s, transform 0.15s',
                            cursor: 'default',
                          }}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
