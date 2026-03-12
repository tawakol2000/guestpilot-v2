'use client'

import { useState, useEffect } from 'react'
import { apiGetAnalytics, type ApiAnalytics } from '@/lib/api'

function formatResponseTime(ms: number): string {
  if (ms <= 0) return '—'
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000)
    const s = Math.round((ms % 60000) / 1000)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const URGENCY_COLORS: Record<string, { bg: string; text: string }> = {
  immediate:    { bg: '#FEE2E2', text: '#DC2626' },
  scheduled:    { bg: '#FEF3C7', text: '#D97706' },
  info_request: { bg: '#DBEAFE', text: '#2563EB' },
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        flex: 1,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted-foreground)' }}>
        {label}
      </span>
      <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--brown-dark)', lineHeight: 1.1 }}>
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{sub}</span>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
      <div
        style={{
          width: 28,
          height: 28,
          border: '3px solid var(--border)',
          borderTopColor: 'var(--terracotta)',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function BarChart({ data }: { data: ApiAnalytics['byDay'] }) {
  // Show last 14 days max for readability
  const visible = data.slice(-14)
  const maxVal = Math.max(...visible.map(d => Math.max(d.messagesReceived, d.messagesSent)), 1)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 100, width: '100%' }}>
      {visible.map((d, i) => {
        const recvHeight = Math.max(Math.round((d.messagesReceived / maxVal) * 96), 2)
        const sentHeight = Math.max(Math.round((d.messagesSent / maxVal) * 96), 2)
        const aiHeight = Math.max(Math.round((d.aiMessagesSent / maxVal) * 96), 2)
        return (
          <div
            key={i}
            style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, justifyContent: 'center' }}
            title={`${formatShortDate(d.date)}\nReceived: ${d.messagesReceived}\nSent: ${d.messagesSent}\nAI: ${d.aiMessagesSent}`}
          >
            <div style={{ width: '30%', height: recvHeight, background: 'var(--terracotta)', borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
            <div style={{ width: '30%', height: sentHeight, background: 'var(--brown-dark)', borderRadius: '2px 2px 0 0', opacity: 0.5 }} />
            <div style={{ width: '30%', height: aiHeight, background: '#22C55E', borderRadius: '2px 2px 0 0', opacity: 0.7 }} />
          </div>
        )
      })}
    </div>
  )
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d')
  const [data, setData] = useState<ApiAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    apiGetAnalytics(range)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [range])

  const sectionHeader: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--muted-foreground)',
    marginBottom: 10,
  }

  const card: React.CSSProperties = {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 16,
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--brown-dark)', margin: 0 }}>Analytics</h2>
          {data && (
            <p style={{ fontSize: 12, color: 'var(--muted-foreground)', margin: '2px 0 0' }}>
              {formatShortDate(data.period.from)} – {formatShortDate(data.period.to)}
            </p>
          )}
        </div>
        {/* Range pills */}
        <div style={{ display: 'flex', gap: 4, background: 'rgba(0,0,0,0.06)', borderRadius: 8, padding: 3 }}>
          {(['7d', '30d', '90d'] as const).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '4px 14px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                background: range === r ? 'white' : 'transparent',
                color: range === r ? 'var(--brown-dark)' : 'var(--muted-foreground)',
                boxShadow: range === r ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {loading && <Spinner />}

      {error && (
        <div style={{ ...card, color: '#DC2626', fontSize: 13 }}>
          Failed to load analytics: {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Metric cards */}
          <div style={{ display: 'flex', gap: 10 }}>
            <MetricCard
              label="Messages Received"
              value={data.totals.messagesReceived.toLocaleString()}
              sub="from guests"
            />
            <MetricCard
              label="AI Messages Sent"
              value={data.totals.aiMessagesSent.toLocaleString()}
              sub={`of ${data.totals.messagesSent} total sent`}
            />
            <MetricCard
              label="AI Resolution Rate"
              value={`${Math.round(data.totals.aiResolutionRate)}%`}
              sub="conversations handled by AI"
            />
            <MetricCard
              label="Avg Response Time"
              value={formatResponseTime(data.totals.avgResponseTimeMs)}
              sub="time to first reply"
            />
          </div>

          {/* Messages over time chart */}
          <div style={card}>
            <p style={sectionHeader}>Messages Over Time</p>
            {data.byDay.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted-foreground)', textAlign: 'center', padding: '24px 0' }}>No data for this period.</p>
            ) : (
              <>
                <BarChart data={data.byDay} />
                {/* X-axis date labels */}
                <div style={{ display: 'flex', marginTop: 6 }}>
                  {data.byDay.slice(-14).map((d, i, arr) => {
                    const showLabel = i === 0 || i === Math.floor(arr.length / 2) || i === arr.length - 1
                    return (
                      <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: 'var(--muted-foreground)' }}>
                        {showLabel ? formatShortDate(d.date) : ''}
                      </div>
                    )
                  })}
                </div>
                {/* Legend */}
                <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
                  {[
                    { color: 'var(--terracotta)', label: 'Received' },
                    { color: 'var(--brown-dark)', label: 'Sent' },
                    { color: '#22C55E', label: 'AI sent' },
                  ].map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                      <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{label}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Per-property table */}
          <div style={card}>
            <p style={sectionHeader}>By Property</p>
            {data.byProperty.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted-foreground)', textAlign: 'center', padding: '16px 0' }}>No property data.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['Property', 'Conversations', 'AI Messages', 'Host Messages', 'AI %'].map(col => (
                      <th
                        key={col}
                        style={{
                          textAlign: col === 'Property' ? 'left' : 'right',
                          padding: '4px 8px',
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          color: 'var(--muted-foreground)',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.byProperty.map((row, i) => {
                    const total = row.aiMessages + row.hostMessages
                    const aiPct = total > 0 ? Math.round((row.aiMessages / total) * 100) : 0
                    return (
                      <tr
                        key={row.propertyId}
                        style={{ background: i % 2 === 1 ? 'var(--muted)' : 'transparent' }}
                      >
                        <td style={{ padding: '7px 8px', color: 'var(--brown-dark)', fontWeight: 500 }}>{row.propertyName}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--muted-foreground)' }}>{row.conversations}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--muted-foreground)' }}>{row.aiMessages}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', color: 'var(--muted-foreground)' }}>{row.hostMessages}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right' }}>
                          <span style={{
                            fontWeight: 600,
                            color: aiPct >= 70 ? '#22C55E' : aiPct >= 40 ? 'var(--terracotta)' : 'var(--muted-foreground)',
                          }}>
                            {aiPct}%
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Tasks summary */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ ...card, flex: 1 }}>
              <p style={sectionHeader}>Tasks Created</p>
              <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--brown-dark)' }}>
                {data.totals.tasksCreated}
              </span>
              <p style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2 }}>
                {data.totals.tasksCompleted} completed
              </p>
            </div>

            {data.topUrgencies.length > 0 && (
              <div style={{ ...card, flex: 2 }}>
                <p style={sectionHeader}>Tasks by Urgency</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.topUrgencies.map(({ urgency, count }) => {
                    const cfg = URGENCY_COLORS[urgency] ?? { bg: 'var(--muted)', text: 'var(--muted-foreground)' }
                    const label = urgency === 'info_request' ? 'Info Request' : urgency.charAt(0).toUpperCase() + urgency.slice(1)
                    return (
                      <div key={urgency} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: 20,
                          fontSize: 11,
                          fontWeight: 600,
                          background: cfg.bg,
                          color: cfg.text,
                          minWidth: 90,
                          textAlign: 'center',
                        }}>
                          {label}
                        </span>
                        <div style={{ flex: 1, height: 8, background: 'var(--muted)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.round((count / data.totals.tasksCreated) * 100)}%`,
                            background: cfg.text,
                            borderRadius: 4,
                            opacity: 0.6,
                            transition: 'width 0.4s ease',
                          }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--brown-dark)', minWidth: 24, textAlign: 'right' }}>
                          {count}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
