'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronRight, ChevronDown, RefreshCw, Globe, Activity, Clock, AlertTriangle } from 'lucide-react'
import { apiGetWebhookLogs, type WebhookLogEntry } from '@/lib/api'

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
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

// ─── Injected Styles ──────────────────────────────────────────────────────────
const injectedStyles = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes wh-spin { to { transform: rotate(360deg) } }
@keyframes wh-fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes wh-scaleIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
`

const STYLE_ID = 'webhook-logs-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = injectedStyles
  document.head.appendChild(style)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function eventColor(event: string): string {
  if (event.includes('message')) return T.accent
  if (event.includes('reservation.created')) return T.status.green
  if (event.includes('reservation.updated')) return T.status.amber
  return T.text.secondary
}

function durationColor(ms: number): string {
  if (ms < 500) return T.status.green
  if (ms <= 2000) return T.status.amber
  return T.status.red
}

// ─── Metric Card ──────────────────────────────────────────────────────────────
function MetricCard({ icon, label, value, subValue }: {
  icon: React.ReactNode
  label: string
  value: string
  subValue?: string
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        background: T.bg.primary,
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.sm,
        padding: '12px 16px',
        boxShadow: T.shadow.sm,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        animation: 'wh-scaleIn 0.3s ease-out both',
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: T.radius.sm,
          background: T.bg.secondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: T.text.tertiary,
            fontFamily: T.font.sans,
            marginBottom: 2,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: T.text.primary,
            fontFamily: T.font.sans,
            lineHeight: 1.1,
          }}
        >
          {value}
        </div>
        {subValue && (
          <div
            style={{
              fontSize: 10,
              color: T.text.tertiary,
              fontFamily: T.font.mono,
              marginTop: 1,
            }}
          >
            {subValue}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Filter Dropdown ──────────────────────────────────────────────────────────
function FilterSelect({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: T.text.tertiary,
          fontFamily: T.font.sans,
        }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          height: 32,
          padding: '0 28px 0 10px',
          fontSize: 12,
          fontWeight: 500,
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.sm,
          background: T.bg.primary,
          color: T.text.primary,
          fontFamily: T.font.sans,
          cursor: 'pointer',
          outline: 'none',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23A8A29E' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 8px center',
        }}
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

// ─── Log Row ──────────────────────────────────────────────────────────────────
function LogRow({ entry, index }: { entry: WebhookLogEntry; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const hasError = entry.status === 'error'
  const evtColor = eventColor(entry.event)

  return (
    <div
      style={{
        borderRadius: T.radius.sm,
        border: `1px solid ${hasError ? 'rgba(220,38,38,0.2)' : T.border.default}`,
        borderLeft: hasError ? `3px solid ${T.status.red}` : `1px solid ${hasError ? 'rgba(220,38,38,0.2)' : T.border.default}`,
        marginBottom: 6,
        overflow: 'hidden',
        background: T.bg.primary,
        fontFamily: T.font.sans,
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
        animation: 'wh-fadeInUp 0.3s ease-out both',
        animationDelay: `${Math.min(index * 0.03, 0.5)}s`,
      }}
    >
      {/* Collapsed row */}
      <div
        onClick={() => setExpanded(v => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          padding: '0 14px',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          background: hovered ? T.bg.secondary : 'transparent',
          transition: 'background 0.15s ease',
        }}
      >
        {/* Status dot */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: hasError ? T.status.red : T.status.green,
            boxShadow: hasError
              ? '0 0 0 3px rgba(220,38,38,0.12)'
              : '0 0 0 3px rgba(21,128,61,0.1)',
          }}
        />

        {/* Relative time */}
        <span
          style={{
            fontSize: 10,
            fontFamily: T.font.mono,
            color: T.text.tertiary,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            minWidth: 64,
          }}
        >
          {formatRelativeTime(entry.createdAt)}
        </span>

        {/* Timestamp */}
        <span
          style={{
            fontSize: 10,
            fontFamily: T.font.mono,
            color: T.text.tertiary,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {formatTimestamp(entry.createdAt)}
        </span>

        {/* Event type badge */}
        <span
          style={{
            background: `${evtColor}14`,
            color: evtColor,
            borderRadius: 999,
            fontSize: 10,
            padding: '2px 8px',
            fontFamily: T.font.mono,
            fontWeight: 600,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            border: `1px solid ${evtColor}1A`,
          }}
        >
          {entry.event}
        </span>

        {/* Status badge */}
        <span
          style={{
            background: hasError ? `${T.status.red}10` : `${T.status.green}10`,
            color: hasError ? T.status.red : T.status.green,
            borderRadius: 999,
            fontSize: 10,
            padding: '2px 8px',
            fontFamily: T.font.mono,
            fontWeight: 600,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            border: `1px solid ${hasError ? T.status.red : T.status.green}1A`,
          }}
        >
          {entry.status}
        </span>

        {/* Hostaway ID */}
        {entry.hostawayId && (
          <span
            style={{
              fontSize: 10,
              fontFamily: T.font.mono,
              color: T.text.secondary,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            #{entry.hostawayId}
          </span>
        )}

        {/* Duration */}
        <span
          style={{
            fontSize: 10,
            fontFamily: T.font.mono,
            color: durationColor(entry.durationMs),
            fontWeight: 500,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {entry.durationMs < 1000
            ? `${entry.durationMs}ms`
            : `${(entry.durationMs / 1000).toFixed(1)}s`
          }
        </span>

        {/* Error preview */}
        {hasError && entry.error && (
          <span
            style={{
              fontSize: 11,
              color: T.status.red,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {entry.error.slice(0, 80)}
          </span>
        )}

        {/* Spacer */}
        {!hasError && <span style={{ flex: 1 }} />}

        {/* Chevron */}
        <div
          style={{
            flexShrink: 0,
            transition: 'transform 0.2s ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          <ChevronRight size={14} color={T.text.tertiary} />
        </div>
      </div>

      {/* Expanded view */}
      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${T.border.default}`,
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            animation: 'wh-fadeInUp 0.2s ease-out both',
          }}
        >
          {/* Error message */}
          {hasError && entry.error && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: T.status.red,
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <AlertTriangle size={11} color={T.status.red} />
                Error
              </div>
              <div
                style={{
                  background: 'rgba(220,38,38,0.04)',
                  padding: 12,
                  borderRadius: T.radius.sm,
                  fontSize: 11,
                  fontFamily: T.font.mono,
                  color: T.status.red,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  lineHeight: 1.5,
                  border: '1px solid rgba(220,38,38,0.12)',
                  maxHeight: 150,
                  overflowY: 'auto',
                }}
              >
                {entry.error}
              </div>
            </div>
          )}

          {/* Payload */}
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: T.text.tertiary,
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <ChevronDown size={11} color={T.text.tertiary} />
              Payload
            </div>
            <div
              style={{
                background: T.bg.secondary,
                padding: 12,
                borderRadius: T.radius.sm,
                fontSize: 11,
                fontFamily: T.font.mono,
                color: T.text.primary,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                lineHeight: 1.5,
                border: `1px solid ${T.border.default}`,
                maxHeight: 300,
                overflowY: 'auto',
              }}
            >
              {entry.payload
                ? JSON.stringify(entry.payload, null, 2)
                : 'No payload data'}
            </div>
          </div>

          {/* Meta row */}
          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              alignItems: 'center',
              paddingTop: 8,
              borderTop: `1px solid ${T.border.default}`,
            }}
          >
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              id: {entry.id.slice(0, 12)}...
            </span>
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              event: {entry.event}
            </span>
            {entry.hostawayId && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
                hostaway_id: {entry.hostawayId}
              </span>
            )}
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              duration: {entry.durationMs}ms
            </span>
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function WebhookLogsV5(): React.ReactElement {
  const [logs, setLogs] = useState<WebhookLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [eventFilter, setEventFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [limitFilter, setLimitFilter] = useState('50')

  useEffect(() => { ensureStyles() }, [])

  const fetchLogs = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await apiGetWebhookLogs({
        limit: Number(limitFilter) || 50,
        event: eventFilter || undefined,
        status: statusFilter || undefined,
      })
      setLogs(data.logs ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // silently fail on refresh errors
    } finally {
      setLoading(false)
    }
  }, [eventFilter, statusFilter, limitFilter])

  // Load on mount
  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => { fetchLogs() }, 30000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchLogs])

  const stats = useMemo(() => {
    const errorCount = logs.filter(l => l.status === 'error').length
    const processedCount = logs.filter(l => l.status === 'processed').length
    const avgDuration = logs.length > 0
      ? Math.round(logs.reduce((sum, l) => sum + l.durationMs, 0) / logs.length)
      : 0
    return { errorCount, processedCount, avgDuration }
  }, [logs])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: T.font.sans,
        background: T.bg.secondary,
        padding: 20,
        gap: 16,
      }}
    >
      {/* Summary stats row */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
        <MetricCard
          icon={<Activity size={16} color={T.text.secondary} />}
          label="Total Webhooks"
          value={total.toLocaleString()}
          subValue={logs.length > 0 ? `${logs.length} loaded` : undefined}
        />
        <MetricCard
          icon={<Globe size={16} color={T.status.green} />}
          label="Processed"
          value={stats.processedCount.toLocaleString()}
        />
        <MetricCard
          icon={<AlertTriangle size={16} color={stats.errorCount > 0 ? T.status.red : T.text.secondary} />}
          label="Errors"
          value={stats.errorCount.toLocaleString()}
          subValue={stats.errorCount > 0 ? 'needs attention' : undefined}
        />
        <MetricCard
          icon={<Clock size={16} color={T.text.secondary} />}
          label="Avg Duration"
          value={stats.avgDuration > 0 ? (stats.avgDuration < 1000 ? `${stats.avgDuration}ms` : `${(stats.avgDuration / 1000).toFixed(1)}s`) : '--'}
          subValue={stats.avgDuration > 0 ? `${logs.length} webhooks` : undefined}
        />
      </div>

      {/* Main content card */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: T.bg.primary,
          borderRadius: T.radius.md,
          border: `1px solid ${T.border.default}`,
          boxShadow: T.shadow.sm,
          overflow: 'hidden',
          animation: 'wh-scaleIn 0.3s ease-out both',
          animationDelay: '0.1s',
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            padding: '12px 20px',
            borderBottom: `1px solid ${T.border.default}`,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexShrink: 0,
            flexWrap: 'wrap',
          }}
        >
          {/* Title section */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={14} color={T.text.secondary} />
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: T.text.primary,
                fontFamily: T.font.sans,
              }}
            >
              Webhook Logs
            </span>
            <span
              style={{
                fontSize: 11,
                color: T.text.tertiary,
                fontFamily: T.font.mono,
              }}
            >
              Monitor incoming Hostaway webhooks
            </span>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Filters */}
          <FilterSelect
            label="Event"
            value={eventFilter}
            onChange={setEventFilter}
            options={[
              { value: '', label: 'All' },
              { value: 'message.received', label: 'message.received' },
              { value: 'reservation.created', label: 'reservation.created' },
              { value: 'reservation.updated', label: 'reservation.updated' },
            ]}
          />

          <FilterSelect
            label="Status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: '', label: 'All' },
              { value: 'processed', label: 'processed' },
              { value: 'error', label: 'error' },
            ]}
          />

          <FilterSelect
            label="Limit"
            value={limitFilter}
            onChange={setLimitFilter}
            options={[
              { value: '50', label: '50' },
              { value: '100', label: '100' },
              { value: '200', label: '200' },
            ]}
          />

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Auto-refresh toggle */}
            <button
              onClick={() => setAutoRefresh(v => !v)}
              style={{
                height: 32,
                padding: '0 12px',
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${autoRefresh ? T.border.strong : T.border.default}`,
                cursor: 'pointer',
                borderRadius: T.radius.sm,
                background: autoRefresh ? T.border.strong : T.bg.primary,
                color: autoRefresh ? '#FFFFFF' : T.text.secondary,
                fontFamily: T.font.sans,
                transition: 'all 0.15s ease',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: autoRefresh ? '#FFFFFF' : T.text.tertiary,
                  transition: 'background 0.15s ease',
                }}
              />
              Auto (30s)
            </button>

            {/* Refresh button */}
            <button
              onClick={() => fetchLogs()}
              disabled={loading}
              style={{
                height: 32,
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${T.border.default}`,
                cursor: loading ? 'default' : 'pointer',
                borderRadius: T.radius.sm,
                background: T.bg.primary,
                color: T.text.secondary,
                fontFamily: T.font.sans,
                opacity: loading ? 0.6 : 1,
                transition: 'opacity 0.15s ease, box-shadow 0.15s ease',
              }}
            >
              <RefreshCw
                size={12}
                style={loading ? { animation: 'wh-spin 1s linear infinite' } : undefined}
              />
              Refresh
            </button>
          </div>
        </div>

        {/* Log list */}
        <div
          style={{
            overflowY: 'auto',
            flex: 1,
            padding: '12px 16px',
          }}
        >
          {logs.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 8,
                animation: 'wh-fadeInUp 0.3s ease-out both',
              }}
            >
              <Globe size={24} color={T.text.tertiary} />
              <span
                style={{
                  fontSize: 14,
                  color: T.text.tertiary,
                  fontFamily: T.font.sans,
                  fontWeight: 500,
                }}
              >
                No webhook logs yet
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: T.text.tertiary,
                  fontFamily: T.font.mono,
                  textAlign: 'center',
                }}
              >
                Logs appear as Hostaway sends webhooks.
              </span>
            </div>
          ) : (
            logs.map((entry, i) => (
              <LogRow key={entry.id} entry={entry} index={i} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default WebhookLogsV5
