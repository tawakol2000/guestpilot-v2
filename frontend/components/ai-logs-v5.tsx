'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronRight, ChevronDown, RefreshCw, Search, X, Zap, Clock, DollarSign, Activity } from 'lucide-react'
import { apiGetAiLogs, type AiApiLogEntry } from '@/lib/api'

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

// ─── Injected Styles ──────────────────────────────────────────────────────────
const injectedStyles = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
`

const STYLE_ID = 'ai-logs-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = injectedStyles
  document.head.appendChild(style)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatHHMMSS(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function modelBadgeColor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('opus')) return '#7C3AED'
  if (m.includes('sonnet')) return '#1D4ED8'
  if (m.includes('haiku')) return '#D97706'
  return '#57534E'
}

function durationColor(ms: number): string {
  if (ms < 1000) return T.status.green
  if (ms <= 3000) return T.status.amber
  return T.status.red
}

function costColor(usd: number): string {
  if (usd < 0.01) return T.status.green
  if (usd < 0.05) return T.status.amber
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
        animation: 'scaleIn 0.3s ease-out both',
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

// ─── Content Block (collapsible) ──────────────────────────────────────────────
function ContentBlock({ label, children, labelColor, defaultExpanded }: {
  label: string
  children: React.ReactNode
  labelColor?: string
  defaultExpanded?: boolean
}): React.ReactElement {
  const [open, setOpen] = useState(defaultExpanded ?? true)

  return (
    <div>
      <div
        onClick={() => setOpen(v => !v)}
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase' as const,
          color: labelColor ?? T.text.tertiary,
          marginBottom: open ? 6 : 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          userSelect: 'none',
        }}
      >
        {open
          ? <ChevronDown size={11} color={labelColor ?? T.text.tertiary} />
          : <ChevronRight size={11} color={labelColor ?? T.text.tertiary} />
        }
        {label}
      </div>
      {open && children}
    </div>
  )
}

// ─── Log Card ─────────────────────────────────────────────────────────────────
function LogCard({ entry, index }: { entry: AiApiLogEntry; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const hasError = !!entry.error
  const preview = entry.responseText.slice(0, 80)
  const firstBlock = entry.contentBlocks[0]

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
        animation: 'fadeInUp 0.3s ease-out both',
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

        {/* Agent name */}
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            fontFamily: T.font.sans,
            color: T.text.primary,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {entry.agentName ?? 'unknown'}
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
          {formatHHMMSS(entry.timestamp)}
        </span>

        {/* Model badge — pill with subtle background */}
        <span
          style={{
            background: `${modelBadgeColor(entry.model)}14`,
            color: modelBadgeColor(entry.model),
            borderRadius: 999,
            fontSize: 10,
            padding: '2px 8px',
            fontFamily: T.font.mono,
            fontWeight: 500,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            border: `1px solid ${modelBadgeColor(entry.model)}1A`,
          }}
        >
          {entry.model}
        </span>

        {/* Token counts */}
        <span
          style={{
            fontSize: 10,
            fontFamily: T.font.mono,
            color: T.text.secondary,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
          }}
        >
          <span style={{ color: T.text.tertiary }}>{entry.inputTokens.toLocaleString()}</span>
          <span style={{ color: T.border.default, fontSize: 9 }}>{'\u2192'}</span>
          <span style={{ color: T.text.secondary }}>{entry.outputTokens.toLocaleString()}</span>
        </span>

        {/* Cost */}
        {entry.costUsd != null && entry.costUsd > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: T.font.mono,
              color: costColor(entry.costUsd),
              fontWeight: 600,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            ${entry.costUsd.toFixed(4)}
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

        {/* Response preview */}
        <span
          style={{
            fontSize: 11,
            color: T.text.tertiary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {preview}
        </span>

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
            animation: 'fadeInUp 0.2s ease-out both',
          }}
        >
          {/* System Prompt */}
          <ContentBlock label="System Prompt">
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
              }}
            >
              {entry.systemPromptPreview}
            </div>
          </ContentBlock>

          {/* User Message */}
          {firstBlock && (
            <ContentBlock label="User Message">
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
                }}
              >
                {firstBlock.textPreview ?? `[${firstBlock.type}]`}
              </div>
            </ContentBlock>
          )}

          {/* Additional Content Blocks */}
          {entry.contentBlocks.length > 1 && (
            <ContentBlock label={`Content Blocks (${entry.contentBlocks.length})`} defaultExpanded={false}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entry.contentBlocks.slice(1).map((block, i) => (
                  <div
                    key={i}
                    style={{
                      background: T.bg.secondary,
                      padding: 10,
                      borderRadius: T.radius.sm,
                      fontSize: 11,
                      fontFamily: T.font.mono,
                      color: T.text.primary,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      lineHeight: 1.5,
                      border: `1px solid ${T.border.default}`,
                    }}
                  >
                    <span style={{ color: T.text.tertiary, fontSize: 10, fontWeight: 500 }}>[{block.type}]</span>
                    {block.textPreview && (
                      <div style={{ marginTop: 4 }}>{block.textPreview}</div>
                    )}
                  </div>
                ))}
              </div>
            </ContentBlock>
          )}

          {/* Response */}
          <ContentBlock label="Response">
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
                maxHeight: 240,
                overflowY: 'auto',
                lineHeight: 1.5,
                border: `1px solid ${T.border.default}`,
              }}
            >
              {entry.responseText}
            </div>
          </ContentBlock>

          {/* Error */}
          {hasError && (
            <ContentBlock label="Error" labelColor={T.status.red}>
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
                  border: `1px solid rgba(220,38,38,0.12)`,
                }}
              >
                {entry.error}
              </div>
            </ContentBlock>
          )}

          {/* Meta row */}
          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              paddingTop: 8,
              borderTop: `1px solid ${T.border.default}`,
            }}
          >
            {entry.temperature != null && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
                temp: {entry.temperature}
              </span>
            )}
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              max_tokens: {entry.maxTokens.toLocaleString()}
            </span>
            {entry.topP != null && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
                top_p: {entry.topP}
              </span>
            )}
            {entry.topK != null && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
                top_k: {entry.topK}
              </span>
            )}
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              sys_prompt_len: {entry.systemPromptLength.toLocaleString()}
            </span>
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              response_len: {entry.responseLength.toLocaleString()}
            </span>
            {entry.conversationId && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.accent }}>
                conv: {entry.conversationId.slice(0, 8)}...
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function AiLogsV5(): React.ReactElement {
  const [logs, setLogs] = useState<AiApiLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  useEffect(() => { ensureStyles() }, [])

  const fetchLogs = useCallback(async (search?: string, offset?: number): Promise<void> => {
    setLoading(true)
    try {
      const data = await apiGetAiLogs({
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: offset ?? 0,
      })
      if (data.logs) {
        setLogs(data.logs)
        setTotal(data.total)
      } else {
        // Fallback for old API format (array response)
        const arr = data as unknown as AiApiLogEntry[]
        if (Array.isArray(arr)) {
          setLogs(arr.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()))
          setTotal(arr.length)
        }
      }
    } catch {
      // silently fail on refresh errors
    } finally {
      setLoading(false)
    }
  }, [])

  // Load on mount
  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => {
      fetchLogs(searchQuery, page * PAGE_SIZE)
    }, 5000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchLogs, searchQuery, page])

  const stats = useMemo(() => {
    const totalCost = logs.reduce((sum, l) => sum + (l.costUsd ?? 0), 0)
    const avgDuration = logs.length > 0
      ? Math.round(logs.reduce((sum, l) => sum + l.durationMs, 0) / logs.length)
      : 0
    return { totalCost, avgDuration }
  }, [logs])

  const totalPages = Math.ceil(total / PAGE_SIZE)

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
          label="Total Logs"
          value={total.toLocaleString()}
          subValue={logs.length > 0 ? `${logs.length} loaded` : undefined}
        />
        <MetricCard
          icon={<DollarSign size={16} color={T.text.secondary} />}
          label="Total Cost"
          value={stats.totalCost > 0 ? `$${stats.totalCost.toFixed(4)}` : '--'}
          subValue={stats.totalCost > 0 ? 'this page' : undefined}
        />
        <MetricCard
          icon={<Clock size={16} color={T.text.secondary} />}
          label="Avg Duration"
          value={stats.avgDuration > 0 ? (stats.avgDuration < 1000 ? `${stats.avgDuration}ms` : `${(stats.avgDuration / 1000).toFixed(1)}s`) : '--'}
          subValue={stats.avgDuration > 0 ? `${logs.length} calls` : undefined}
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
          animation: 'scaleIn 0.3s ease-out both',
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
          }}
        >
          {/* Title section */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Zap size={14} color={T.text.secondary} />
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: T.text.primary,
                fontFamily: T.font.sans,
              }}
            >
              AI Logs
            </span>
            <span
              style={{
                fontSize: 11,
                color: T.text.tertiary,
                fontFamily: T.font.mono,
              }}
            >
              {total} {total === 1 ? 'entry' : 'entries'}
            </span>
          </div>

          {/* Search input */}
          <div
            style={{
              marginLeft: 'auto',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Search
              size={13}
              color={searchFocused ? T.accent : T.text.tertiary}
              style={{
                position: 'absolute',
                left: 10,
                transition: 'color 0.15s ease',
                pointerEvents: 'none',
              }}
            />
            <input
              placeholder="Search logs..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={e => {
                if (e.key === 'Enter') { setPage(0); fetchLogs(searchQuery, 0) }
              }}
              style={{
                height: 32,
                width: 220,
                padding: '0 32px 0 30px',
                fontSize: 12,
                border: `1px solid ${searchFocused ? T.accent : T.border.default}`,
                borderRadius: T.radius.sm,
                fontFamily: T.font.sans,
                color: T.text.primary,
                outline: 'none',
                background: T.bg.primary,
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                boxShadow: searchFocused ? `0 0 0 3px rgba(29,78,216,0.08)` : 'none',
              }}
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setPage(0); fetchLogs('', 0) }}
                style={{
                  position: 'absolute',
                  right: 6,
                  width: 20,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: T.bg.tertiary,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <X size={10} color={T.text.secondary} />
              </button>
            )}
          </div>

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
              Auto
            </button>

            {/* Refresh button */}
            <button
              onClick={() => fetchLogs(searchQuery, page * PAGE_SIZE)}
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
                style={loading ? { animation: 'spin 1s linear infinite' } : undefined}
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
                animation: 'fadeInUp 0.3s ease-out both',
              }}
            >
              <Zap size={24} color={T.text.tertiary} />
              <span
                style={{
                  fontSize: 14,
                  color: T.text.tertiary,
                  fontFamily: T.font.sans,
                  fontWeight: 500,
                }}
              >
                No AI logs yet
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: T.text.tertiary,
                  fontFamily: T.font.mono,
                }}
              >
                Logs will appear here when AI agents process requests
              </span>
            </div>
          ) : (
            logs.map((entry, i) => (
              <LogCard key={entry.id} entry={entry} index={i} />
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{
              padding: '10px 20px',
              borderTop: `1px solid ${T.border.default}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => { const p = Math.max(0, page - 1); setPage(p); fetchLogs(searchQuery, p * PAGE_SIZE) }}
              disabled={page === 0}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '4px 12px',
                borderRadius: T.radius.sm,
                border: `1px solid ${T.border.default}`,
                background: T.bg.primary,
                cursor: page === 0 ? 'default' : 'pointer',
                opacity: page === 0 ? 0.4 : 1,
                fontFamily: T.font.sans,
                color: T.text.secondary,
                transition: 'opacity 0.15s ease',
              }}
            >
              Prev
            </button>

            {/* Page numbers */}
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let pageNum: number
              if (totalPages <= 7) {
                pageNum = i
              } else if (page < 3) {
                pageNum = i
              } else if (page > totalPages - 4) {
                pageNum = totalPages - 7 + i
              } else {
                pageNum = page - 3 + i
              }
              const isActive = pageNum === page
              return (
                <button
                  key={pageNum}
                  onClick={() => { setPage(pageNum); fetchLogs(searchQuery, pageNum * PAGE_SIZE) }}
                  style={{
                    width: 28,
                    height: 28,
                    fontSize: 11,
                    fontWeight: isActive ? 700 : 400,
                    borderRadius: T.radius.sm,
                    border: isActive ? `1px solid ${T.border.strong}` : `1px solid transparent`,
                    background: isActive ? T.border.strong : 'transparent',
                    cursor: 'pointer',
                    fontFamily: T.font.mono,
                    color: isActive ? '#FFFFFF' : T.text.secondary,
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                >
                  {pageNum + 1}
                </button>
              )
            })}

            <button
              onClick={() => { const p = Math.min(totalPages - 1, page + 1); setPage(p); fetchLogs(searchQuery, p * PAGE_SIZE) }}
              disabled={page >= totalPages - 1}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '4px 12px',
                borderRadius: T.radius.sm,
                border: `1px solid ${T.border.default}`,
                background: T.bg.primary,
                cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                opacity: page >= totalPages - 1 ? 0.4 : 1,
                fontFamily: T.font.sans,
                color: T.text.secondary,
                transition: 'opacity 0.15s ease',
              }}
            >
              Next
            </button>

            {/* Page size indicator */}
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontFamily: T.font.mono,
                color: T.text.tertiary,
              }}
            >
              {PAGE_SIZE}/page
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
