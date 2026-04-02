'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronRight, ChevronDown, RefreshCw, Search, X, Zap, Clock, DollarSign, Activity } from 'lucide-react'
import { apiGetAiLogs, apiGetAiLogDetail, type AiApiLogEntry } from '@/lib/api'

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

function toolColor(name: string): { bg: string; fg: string; border: string } {
  if (name.includes('faq')) return { bg: '#0891B210', fg: '#0891B2', border: '#0891B220' }
  if (name.includes('sop')) return { bg: '#D9770610', fg: '#D97706', border: '#D9770620' }
  if (name.includes('document') || name.includes('checklist')) return { bg: '#7C3AED10', fg: '#7C3AED', border: '#7C3AED20' }
  if (name.includes('reservation') || name.includes('extend') || name.includes('stay')) return { bg: '#15803D10', fg: '#15803D', border: '#15803D20' }
  return { bg: '#D9770610', fg: '#D97706', border: '#D9770620' }
}

function detectBlockLabel(text?: string): string {
  if (!text) return 'Content Block'
  const t = text.substring(0, 100).toLowerCase()
  if (t.includes('context summary') || t.includes('earlier messages')) return 'Context Summary'
  if (t.includes('pending documents') || t.includes('document checklist')) return 'Document Checklist'
  if (t.includes('property info') || t.includes('property:') || t.includes('listing:')) return 'Property Info'
  if (t.includes('guest info') || t.includes('guest name') || t.includes('reservation')) return 'Guest & Reservation'
  if (t.includes('open task') || t.includes('active task') || t.includes('escalat')) return 'Open Tasks'
  if (t.includes('conversation') || t.includes('message history') || t.includes('previous messages')) return 'Conversation History'
  if (t.includes('screening') || t.includes('checklist')) return 'Screening Data'
  if (t.includes('knowledge') || t.includes('custom knowledge')) return 'Property Knowledge'
  return 'Content Block'
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

// ─── Scrollable Text Box ──────────────────────────────────────────────────────
function TextBox({ content, maxHeight = 200 }: { content: string; maxHeight?: number }): React.ReactElement {
  return (
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
        maxHeight,
        overflowY: 'auto',
      }}
    >
      {content}
    </div>
  )
}

// ─── Log Card ─────────────────────────────────────────────────────────────────
function LogCard({ entry, index }: { entry: AiApiLogEntry; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [detail, setDetail] = useState<AiApiLogEntry | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const hasError = !!entry.error
  const preview = entry.responseText.slice(0, 80)

  // Fetch full detail on first expand
  useEffect(() => {
    if (!expanded || detail || loadingDetail) return
    setLoadingDetail(true)
    apiGetAiLogDetail(entry.id)
      .then(d => setDetail(d))
      .catch(() => {/* silently fall back to list data */})
      .finally(() => setLoadingDetail(false))
  }, [expanded, entry.id, detail, loadingDetail])

  const displayEntry = detail ?? entry
  const systemPrompt = detail?.systemPromptFull ?? displayEntry.systemPromptPreview
  const blocks = displayEntry.contentBlocks

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
          {(() => {
            const cached = (entry.ragContext as any)?.cachedInputTokens ?? 0;
            const total = (entry.ragContext as any)?.totalInputTokens ?? entry.inputTokens ?? 0;
            if (cached > 0 && total > 0) {
              const pct = Math.round((cached / total) * 100);
              return (
                <span style={{
                  fontSize: 9, fontWeight: 600, fontFamily: T.font.mono,
                  padding: '1px 5px', borderRadius: 4,
                  background: pct > 50 ? 'rgba(21,128,61,0.08)' : 'rgba(217,119,6,0.08)',
                  color: pct > 50 ? '#15803D' : '#D97706',
                  whiteSpace: 'nowrap',
                }}>
                  {pct}% cached
                </span>
              );
            }
            return null;
          })()}
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

        {/* SOP categories pills */}
        {entry.ragContext?.sopCategories?.length ? (
          entry.ragContext.sopCategories.map((sop: string) => (
            <span
              key={sop}
              style={{
                background: '#1D4ED810',
                color: T.accent,
                border: '1px solid #1D4ED820',
                borderRadius: 999,
                fontSize: 9,
                padding: '2px 6px',
                fontFamily: T.font.mono,
                fontWeight: 600,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              {sop.replace('sop-', '')}
            </span>
          ))
        ) : null}

        {/* SOP confidence */}
        {entry.ragContext?.sopConfidence && (
          <span style={{
            fontSize: 9, fontFamily: T.font.mono, fontWeight: 600, flexShrink: 0,
            color: entry.ragContext.sopConfidence === 'high' ? '#15803D' : entry.ragContext.sopConfidence === 'medium' ? '#D97706' : '#DC2626',
          }}>
            {entry.ragContext.sopConfidence}
          </span>
        )}

        {/* Tool pills — show all tools used */}
        {entry.ragContext?.toolUsed && (entry.ragContext?.toolNames ?? (entry.ragContext?.toolName ? [entry.ragContext.toolName] : [])).map((name: string, ti: number) => {
          const tc = toolColor(name)
          const toolDetail = entry.ragContext?.tools?.[ti]
          return (
            <span
              key={`${name}-${ti}`}
              style={{
                background: tc.bg,
                color: tc.fg,
                border: `1px solid ${tc.border}`,
                borderRadius: 999,
                fontSize: 9,
                padding: '2px 6px',
                fontFamily: T.font.mono,
                fontWeight: 600,
                flexShrink: 0,
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
            >
              {name.replace(/_/g, ' ')}
              {toolDetail?.durationMs != null && (
                <span style={{ opacity: 0.7 }}>({toolDetail.durationMs}ms)</span>
              )}
            </span>
          )
        })}

        {/* Escalation signals */}
        {entry.ragContext?.escalationSignals?.length ? (
          <span style={{
            background: '#DC262610',
            color: '#DC2626',
            border: '1px solid #DC262620',
            borderRadius: 999,
            fontSize: 9,
            padding: '2px 6px',
            fontFamily: T.font.mono,
            fontWeight: 600,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}>
            {entry.ragContext.escalationSignals.length} signal{entry.ragContext.escalationSignals.length !== 1 ? 's' : ''}
          </span>
        ) : null}

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
          {loadingDetail && (
            <div style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              Loading full data…
            </div>
          )}

          {/* System Prompt */}
          <ContentBlock label={`System Prompt${detail ? '' : ' (preview)'}`}>
            <TextBox content={systemPrompt} maxHeight={300} />
            {!detail && (
              <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 4 }}>
                {entry.systemPromptLength.toLocaleString()} chars total — loading full…
              </div>
            )}
          </ContentBlock>

          {/* Content Blocks — each labeled by detected content type */}
          {blocks.map((block, i) => {
            const label = detectBlockLabel(block.textPreview)
            const isFirst = i === 0
            // First block = user message, conversation history = long, collapse by default
            const isLong = (block.textLength ?? 0) > 2000
            return (
              <ContentBlock
                key={i}
                label={isFirst ? `User Message — ${label}` : `${label} (${(block.textLength ?? 0).toLocaleString()} chars)`}
                defaultExpanded={isFirst || !isLong}
              >
                <TextBox content={block.textPreview ?? `[${block.type}]`} maxHeight={isFirst ? 200 : 150} />
                {block.textLength && block.textLength > (block.textPreview?.length ?? 0) && (
                  <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 4 }}>
                    {block.textLength.toLocaleString()} chars total (preview: {(block.textPreview?.length ?? 0).toLocaleString()})
                  </div>
                )}
              </ContentBlock>
            )
          })}

          {/* Response */}
          <ContentBlock label="Response">
            <TextBox content={displayEntry.responseText} maxHeight={280} />
          </ContentBlock>

          {/* SOP Classification */}
          {(() => {
            const rc = displayEntry.ragContext as any
            if (!rc?.sopCategories?.length) return null
            return (
              <ContentBlock
                label={`SOP Classification — ${rc.sopCategories.join(', ')} (${rc.sopConfidence || 'unknown'})`}
                labelColor={T.accent}
                defaultExpanded={true}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, fontFamily: T.font.mono }}>
                  <div><span style={{ color: T.text.tertiary }}>categories: </span>{rc.sopCategories.join(', ')}</div>
                  <div><span style={{ color: T.text.tertiary }}>confidence: </span><span style={{ fontWeight: 600, color: rc.sopConfidence === 'high' ? '#15803D' : rc.sopConfidence === 'medium' ? '#D97706' : '#DC2626' }}>{rc.sopConfidence}</span></div>
                  {rc.sopReasoning && <div><span style={{ color: T.text.tertiary }}>reasoning: </span>{rc.sopReasoning}</div>}
                </div>
              </ContentBlock>
            )
          })()}

          {/* Tool Execution — show all tools */}
          {(() => {
            const rc = displayEntry.ragContext as any
            if (!rc?.toolUsed) return null
            // Use per-tool details array if available, fallback to legacy single tool
            const toolsList: Array<{ name: string; input: any; results: any; durationMs: number }> = rc.tools?.length
              ? rc.tools
              : rc.toolName
                ? [{ name: rc.toolName, input: rc.toolInput, results: rc.toolResults, durationMs: rc.toolDurationMs || 0 }]
                : []
            if (!toolsList.length) return null
            return toolsList.map((tool: any, ti: number) => {
              const tc = toolColor(tool.name)
              return (
                <ContentBlock
                  key={`tool-${ti}`}
                  label={`Tool: ${tool.name} (${tool.durationMs}ms)`}
                  labelColor={tc.fg}
                  defaultExpanded={true}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11, fontFamily: T.font.mono }}>
                    {tool.input && (
                      <div>
                        <div style={{ color: T.text.tertiary, marginBottom: 4 }}>Input:</div>
                        <TextBox content={JSON.stringify(tool.input, null, 2)} maxHeight={150} />
                      </div>
                    )}
                    {tool.results && (
                      <div>
                        <div style={{ color: T.text.tertiary, marginBottom: 4 }}>Results:</div>
                        <TextBox content={typeof tool.results === 'string' ? tool.results : JSON.stringify(tool.results, null, 2)} maxHeight={200} />
                      </div>
                    )}
                  </div>
                </ContentBlock>
              )
            })
          })()}

          {/* Escalation Signals */}
          {(() => {
            const rc = displayEntry.ragContext as any
            if (!rc?.escalationSignals?.length) return null
            return (
              <ContentBlock label={`Escalation Signals (${rc.escalationSignals.length})`} labelColor="#DC2626" defaultExpanded={false}>
                <div style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary }}>
                  {rc.escalationSignals.map((s: string, i: number) => (
                    <div key={i} style={{ padding: '2px 0' }}>{s}</div>
                  ))}
                </div>
              </ContentBlock>
            )
          })()}

          {/* Retrieved Context */}
          {(() => {
            const rc = displayEntry.ragContext as any
            const hasChunks = rc && typeof rc === 'object' && rc.totalRetrieved > 0
            const label = hasChunks
              ? `Retrieved Context (${rc.totalRetrieved} chunk${rc.totalRetrieved !== 1 ? 's' : ''} · ${rc.durationMs}ms)`
              : 'Retrieved Context'
            return (
            <ContentBlock
              label={label}
              labelColor="#6D28D9"
              defaultExpanded={true}
            >
              {!hasChunks ? (
                <div style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary, padding: '6px 0' }}>
                  {rc === undefined || rc === null
                    ? 'No RAG data — log predates observability or RAG is disabled'
                    : 'No context retrieved'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {/* Query row */}
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: T.font.mono,
                      color: T.text.secondary,
                      padding: '4px 0 8px',
                      borderBottom: `1px solid ${T.border.default}`,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ color: T.text.tertiary }}>query: </span>
                    {rc.query}
                  </div>
                  {rc.chunks.map((chunk: any, ci: number) => {
                    const catPrefix = chunk.category.split('-')[0]
                    const catColor =
                      chunk.category.startsWith('sop') ? '#7C3AED' :
                      chunk.category === 'access' ? '#1D4ED8' :
                      chunk.category === 'general' ? '#57534E' :
                      '#D97706'
                    const scoreColor =
                      chunk.similarity >= 0.75 ? '#15803D' :
                      chunk.similarity >= 0.5 ? '#D97706' :
                      '#DC2626'
                    return (
                      <div
                        key={ci}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'auto auto 80px auto 1fr auto',
                          alignItems: 'center',
                          gap: 8,
                          padding: '5px 8px',
                          borderRadius: T.radius.sm,
                          background: ci % 2 === 0 ? T.bg.secondary : 'transparent',
                          fontSize: 11,
                        }}
                      >
                        {/* Category badge */}
                        <span
                          style={{
                            background: `${catColor}12`,
                            color: catColor,
                            border: `1px solid ${catColor}20`,
                            borderRadius: 999,
                            fontSize: 9,
                            padding: '1px 6px',
                            fontFamily: T.font.sans,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {catPrefix}
                        </span>
                        {/* Source key */}
                        <span
                          style={{
                            fontFamily: T.font.mono,
                            fontSize: 10,
                            color: T.text.secondary,
                            maxWidth: 120,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {chunk.sourceKey || chunk.category}
                        </span>
                        {/* Similarity bar */}
                        <div
                          style={{
                            height: 4,
                            background: T.border.default,
                            borderRadius: 2,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(chunk.similarity * 100)}%`,
                              height: '100%',
                              background: scoreColor,
                              borderRadius: 2,
                            }}
                          />
                        </div>
                        {/* Score */}
                        <span
                          style={{
                            fontFamily: T.font.mono,
                            fontSize: 10,
                            fontWeight: 600,
                            color: scoreColor,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {chunk.similarity.toFixed(2)}
                        </span>
                        {/* Content preview */}
                        <span
                          style={{
                            fontFamily: T.font.mono,
                            fontSize: 10,
                            color: T.text.tertiary,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {chunk.content.slice(0, 80)}
                        </span>
                        {/* Global/Property tag */}
                        <span
                          style={{
                            fontSize: 9,
                            fontFamily: T.font.sans,
                            fontWeight: 500,
                            color: chunk.isGlobal ? '#7C3AED' : T.text.tertiary,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {chunk.isGlobal ? 'SOP' : 'prop'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </ContentBlock>
            )
          })()}

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
                  maxHeight: 150,
                  overflowY: 'auto',
                }}
              >
                {displayEntry.error}
              </div>
            </ContentBlock>
          )}

          {/* Meta row + Raw JSON button */}
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
            {displayEntry.temperature != null && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
                temp: {displayEntry.temperature}
              </span>
            )}
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              max_tokens: {displayEntry.maxTokens.toLocaleString()}
            </span>
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              sys_prompt_len: {displayEntry.systemPromptLength.toLocaleString()}
            </span>
            <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
              response_len: {displayEntry.responseLength.toLocaleString()}
            </span>
            {displayEntry.ragContext?.reasoningEffort && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
                reasoning: {displayEntry.ragContext.reasoningEffort}
                {displayEntry.ragContext.reasoningTokens ? ` (${displayEntry.ragContext.reasoningTokens.toLocaleString()} tokens)` : ''}
              </span>
            )}
            {displayEntry.conversationId && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.accent }}>
                conv: {displayEntry.conversationId.slice(0, 8)}…
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
    // Cache hit rate across loaded logs
    let cacheHitSum = 0, cacheHitCount = 0
    for (const l of logs) {
      const cached = (l.ragContext as any)?.cachedInputTokens ?? 0
      const total = (l.ragContext as any)?.totalInputTokens ?? l.inputTokens ?? 0
      if (total > 0) {
        cacheHitSum += cached / total
        cacheHitCount++
      }
    }
    const avgCacheHitRate = cacheHitCount > 0 ? Math.round((cacheHitSum / cacheHitCount) * 1000) / 10 : null
    return { totalCost, avgDuration, avgCacheHitRate }
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
        <MetricCard
          icon={<Zap size={16} color={stats.avgCacheHitRate !== null && stats.avgCacheHitRate > 50 ? '#15803D' : T.text.secondary} />}
          label="Cache Hit Rate"
          value={stats.avgCacheHitRate !== null ? `${stats.avgCacheHitRate}%` : '--'}
          subValue={stats.avgCacheHitRate !== null ? (stats.avgCacheHitRate > 50 ? 'saving ~90% on cached' : 'low — prompt may be changing') : undefined}
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
