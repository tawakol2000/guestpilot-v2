'use client'

import { useState, useEffect } from 'react'
import { RefreshCw, ChevronDown, ChevronUp, AlertCircle, Clock, Zap, FileText, ArrowRight } from 'lucide-react'
import { apiGetAiLogs, type AiApiLogEntry } from '@/lib/api'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function LogEntryCard({ entry }: { entry: AiApiLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const hasError = !!entry.error

  return (
    <div style={{
      background: '#fff',
      borderRadius: 10,
      border: hasError ? '1px solid #FECACA' : '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      {/* Summary row */}
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {/* Status dot */}
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: hasError ? '#DC2626' : '#22C55E',
          }}
        />

        {/* Agent name — primary row label */}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--brown-dark)', flexShrink: 0, minWidth: 130 }}>
          {entry.agentName ?? 'unknown'}
        </span>

        {/* Time */}
        <span style={{ fontSize: 11, color: 'var(--muted-foreground)', fontVariantNumeric: 'tabular-nums', width: 72, flexShrink: 0 }}>
          {formatTime(entry.timestamp)}
        </span>

        {/* Model badge */}
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 5,
          background: entry.model.includes('opus') ? '#EDE9FE' : entry.model.includes('sonnet') ? '#DBEAFE' : '#FEF3C7',
          color: entry.model.includes('opus') ? '#7C3AED' : entry.model.includes('sonnet') ? '#2563EB' : '#D97706',
          flexShrink: 0,
        }}>
          {entry.model.replace('claude-', '').replace(/-\d+$/, '')}
        </span>

        {/* Tokens */}
        <span style={{ fontSize: 11, color: 'var(--brown-dark)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {entry.inputTokens.toLocaleString()}
          <ArrowRight size={9} style={{ display: 'inline', margin: '0 3px', opacity: 0.4 }} />
          {entry.outputTokens.toLocaleString()} tok
        </span>

        {/* Duration */}
        <span style={{ fontSize: 11, color: 'var(--muted-foreground)', flexShrink: 0 }}>
          {formatDuration(entry.durationMs)}
        </span>

        {/* Response preview */}
        <span style={{
          flex: 1, fontSize: 11, color: hasError ? '#DC2626' : 'var(--brown-dark)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {hasError ? `Error: ${entry.error}` : entry.responseText.substring(0, 60)}
        </span>

        {expanded
          ? <ChevronUp size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
          : <ChevronDown size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
        }
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Parameters row */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Model', value: entry.model },
              { label: 'Temperature', value: entry.temperature?.toFixed(2) ?? '—' },
              { label: 'Max Tokens', value: String(entry.maxTokens) },
              { label: 'Top K', value: entry.topK !== undefined ? String(entry.topK) : '—' },
              { label: 'Top P', value: entry.topP !== undefined ? String(entry.topP) : '—' },
              { label: 'Input Tokens', value: entry.inputTokens.toLocaleString() },
              { label: 'Output Tokens', value: entry.outputTokens.toLocaleString() },
              { label: 'Duration', value: formatDuration(entry.durationMs) },
            ].map(({ label, value }) => (
              <div key={label} style={{ minWidth: 100 }}>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-foreground)', marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--brown-dark)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* System prompt preview */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-foreground)', marginBottom: 4 }}>
              System Prompt ({entry.systemPromptLength.toLocaleString()} chars)
            </div>
            <pre style={{
              fontSize: 11, lineHeight: 1.5, padding: '10px 12px', borderRadius: 6,
              background: '#F8F8FA', border: '1px solid var(--border)', margin: 0,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--brown-dark)',
              maxHeight: 120, overflow: 'auto',
            }}>
              {entry.systemPromptPreview}...
            </pre>
          </div>

          {/* Content blocks sent */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-foreground)', marginBottom: 4 }}>
              Content Blocks Sent ({entry.contentBlocks.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {entry.contentBlocks.map((block, i) => (
                <div key={i} style={{
                  padding: '8px 12px', borderRadius: 6, background: '#F8F8FA', border: '1px solid var(--border)',
                }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-foreground)', marginBottom: 3 }}>
                    Block {i + 1} — {block.type}{block.textLength ? ` (${block.textLength.toLocaleString()} chars)` : ''}
                  </div>
                  {block.textPreview && (
                    <pre style={{
                      fontSize: 11, lineHeight: 1.4, margin: 0,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--brown-dark)',
                      maxHeight: 300, overflow: 'auto',
                    }}>
                      {block.textPreview}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Response */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: hasError ? '#DC2626' : 'var(--muted-foreground)', marginBottom: 4 }}>
              {hasError ? 'Error' : `Response (${entry.responseLength.toLocaleString()} chars)`}
            </div>
            <pre style={{
              fontSize: 11, lineHeight: 1.5, padding: '10px 12px', borderRadius: 6,
              background: hasError ? '#FEF2F2' : '#1E1E2E',
              border: hasError ? '1px solid #FECACA' : '1px solid transparent',
              color: hasError ? '#DC2626' : '#CDD6F4',
              margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 300, overflow: 'auto',
              fontFamily: '"Berkeley Mono", "Fira Code", monospace',
            }}>
              {hasError ? entry.error : entry.responseText}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

export function AiLogsPage() {
  const [logs, setLogs] = useState<AiApiLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)

  function load() {
    setLoading(true)
    apiGetAiLogs()
      .then(data => { setLogs(data.logs); setError(null) })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [autoRefresh])

  return (
    <div className="flex flex-col h-full" style={{ background: '#fff' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 shrink-0" style={{ height: 44, borderBottom: '1px solid var(--border)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--brown-dark)' }}>
          AI API Logs
        </span>
        <div className="flex items-center gap-3">
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg transition-all"
            style={
              autoRefresh
                ? { background: '#F0FDF4', color: '#16A34A', border: '1.5px solid #BBF7D0' }
                : { background: 'var(--muted)', color: 'var(--muted-foreground)', border: '1.5px solid transparent' }
            }
          >
            <Clock size={11} />
            Auto {autoRefresh ? 'ON' : 'OFF'}
          </button>

          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--muted)', color: 'var(--brown-dark)', border: '1px solid var(--border)', cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '16px 24px' }}>
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg mb-4" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
            <AlertCircle size={14} style={{ color: '#DC2626', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#DC2626' }}>{error}</span>
          </div>
        )}

        {logs.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <FileText size={32} style={{ color: 'var(--border)' }} />
            <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
              No API calls logged yet. Logs appear here when the AI processes a guest message.
            </p>
            <p style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
              Last 50 calls are kept in memory (resets on server restart).
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--muted-foreground)', marginBottom: 4 }}>
              Showing {logs.length} most recent API call{logs.length !== 1 ? 's' : ''} (in-memory, last 50)
            </div>
            {logs.map(entry => (
              <LogEntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
