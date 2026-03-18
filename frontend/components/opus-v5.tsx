'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles, Download, FileText, RefreshCw, ChevronRight, Clock, Zap, DollarSign, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import {
  apiGenerateOpusReport,
  apiGetOpusReports,
  apiGetOpusReport,
  apiGetOpusReportRaw,
  type OpusReportSummary,
  type OpusReportDetail,
} from '@/lib/api'

// ─── Design Tokens (matches app design system) ──────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E' },
  accent: '#1D4ED8',
  opus: '#7C3AED',
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

// ─── Injected Styles ────────────────────────────────────────────────────────
const STYLE_ID = 'opus-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
@keyframes opus-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes opus-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes opus-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes spin { to { transform: rotate(360deg) } }
.opus-generating {
  background: linear-gradient(90deg, ${T.opus}15 25%, ${T.opus}30 50%, ${T.opus}15 75%);
  background-size: 200% 100%;
  animation: opus-shimmer 2s ease-in-out infinite;
}
`
  document.head.appendChild(s)
}

// ─── Safe Markdown → React Elements ─────────────────────────────────────────
// Renders markdown as React elements without dangerouslySetInnerHTML.
// The content is always from our own Opus API (trusted), but we use safe
// rendering to avoid any injection risk from report data embedded in the markdown.

function MarkdownRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.split('\n')
  const elements: React.ReactElement[] = []
  let i = 0
  let key = 0

  function inlineFormat(text: string): React.ReactNode {
    // Process bold, italic, inline code
    const parts: React.ReactNode[] = []
    let remaining = text
    let partKey = 0
    while (remaining) {
      // Bold
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/)
      // Inline code
      const codeMatch = remaining.match(/`([^`]+)`/)
      // Pick the earliest match
      const matches = [
        boldMatch ? { type: 'bold', index: boldMatch.index!, length: boldMatch[0].length, content: boldMatch[1] } : null,
        codeMatch ? { type: 'code', index: codeMatch.index!, length: codeMatch[0].length, content: codeMatch[1] } : null,
      ].filter(Boolean).sort((a, b) => a!.index - b!.index)

      if (matches.length === 0) {
        parts.push(remaining)
        break
      }
      const m = matches[0]!
      if (m.index > 0) parts.push(remaining.substring(0, m.index))
      if (m.type === 'bold') {
        parts.push(<strong key={partKey++} style={{ color: T.text.primary, fontWeight: 700 }}>{m.content}</strong>)
      } else {
        parts.push(<code key={partKey++} style={{
          fontFamily: T.font.mono, fontSize: 11, background: T.bg.tertiary,
          padding: '2px 5px', borderRadius: 4, color: T.opus,
        }}>{m.content}</code>)
      }
      remaining = remaining.substring(m.index + m.length)
    }
    return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>
  }

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      elements.push(
        <pre key={key++} style={{
          fontFamily: T.font.mono, fontSize: 11, lineHeight: 1.6,
          background: T.text.primary, color: '#e2e8f0',
          padding: 16, borderRadius: T.radius.sm, overflowX: 'auto', margin: '12px 0 16px',
        }}><code>{codeLines.join('\n')}</code></pre>
      )
      continue
    }

    // Headers
    if (line.startsWith('# ')) {
      elements.push(<h1 key={key++} style={{
        fontSize: 20, fontWeight: 800, color: T.text.primary, margin: '32px 0 16px',
        paddingBottom: 8, borderBottom: `2px solid ${T.opus}30`, fontFamily: T.font.sans,
      }}>{inlineFormat(line.slice(2))}</h1>)
      i++; continue
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={key++} style={{
        fontSize: 15, fontWeight: 700, color: T.text.primary, margin: '28px 0 12px', fontFamily: T.font.sans,
      }}>{inlineFormat(line.slice(3))}</h2>)
      i++; continue
    }
    if (line.startsWith('### ')) {
      elements.push(<h3 key={key++} style={{
        fontSize: 13, fontWeight: 700, color: T.text.secondary, margin: '20px 0 8px',
        textTransform: 'uppercase', letterSpacing: 0.3, fontFamily: T.font.sans,
      }}>{inlineFormat(line.slice(4))}</h3>)
      i++; continue
    }

    // HR
    if (line.trim() === '---') {
      elements.push(<hr key={key++} style={{ border: 'none', borderTop: `1px solid ${T.border.default}`, margin: '24px 0' }} />)
      i++; continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      elements.push(
        <blockquote key={key++} style={{
          borderLeft: `3px solid ${T.opus}40`, margin: '12px 0', padding: '8px 16px',
          background: `${T.opus}06`, borderRadius: `0 ${T.radius.sm}px ${T.radius.sm}px 0`,
        }}>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: T.text.secondary, margin: 0, fontFamily: T.font.sans }}>
            {inlineFormat(line.slice(2))}
          </p>
        </blockquote>
      )
      i++; continue
    }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: React.ReactElement[] = []
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(<li key={key++} style={{
          fontSize: 13, lineHeight: 1.7, color: T.text.secondary, marginBottom: 4, fontFamily: T.font.sans,
        }}>{inlineFormat(lines[i].replace(/^[-*] /, ''))}</li>)
        i++
      }
      elements.push(<ul key={key++} style={{ margin: '8px 0 16px', paddingLeft: 20 }}>{items}</ul>)
      continue
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: React.ReactElement[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(<li key={key++} style={{
          fontSize: 13, lineHeight: 1.7, color: T.text.secondary, marginBottom: 4, fontFamily: T.font.sans,
        }}>{inlineFormat(lines[i].replace(/^\d+\. /, ''))}</li>)
        i++
      }
      elements.push(<ol key={key++} style={{ margin: '8px 0 16px', paddingLeft: 20 }}>{items}</ol>)
      continue
    }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map(c => c.trim())
        // Skip separator rows
        if (!cells.every(c => /^[\s-:]+$/.test(c))) {
          tableRows.push(cells)
        }
        i++
      }
      if (tableRows.length > 0) {
        const [header, ...body] = tableRows
        elements.push(
          <table key={key++} style={{
            width: '100%', borderCollapse: 'collapse', margin: '12px 0 16px',
            fontSize: 12, fontFamily: T.font.sans,
          }}>
            <thead>
              <tr>{header.map((h, hi) => (
                <th key={hi} style={{
                  textAlign: 'left', padding: '8px 12px', fontWeight: 700, fontSize: 10,
                  textTransform: 'uppercase', letterSpacing: 0.5, color: T.text.tertiary,
                  borderBottom: `2px solid ${T.border.default}`,
                }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>{body.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => (
                <td key={ci} style={{
                  padding: '8px 12px', color: T.text.secondary,
                  borderBottom: `1px solid ${T.border.default}`,
                }}>{inlineFormat(cell)}</td>
              ))}</tr>
            ))}</tbody>
          </table>
        )
      }
      continue
    }

    // Empty line
    if (!line.trim()) { i++; continue }

    // Paragraph
    elements.push(<p key={key++} style={{
      fontSize: 13, lineHeight: 1.7, color: T.text.secondary, margin: '0 0 12px', fontFamily: T.font.sans,
    }}>{inlineFormat(line)}</p>)
    i++
  }

  return <>{elements}</>
}

// ─── Helper ──────────────────────────────────────────────────────────────────
function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Component ───────────────────────────────────────────────────────────────
export function OpusV5(): React.ReactElement {
  const [reports, setReports] = useState<OpusReportSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OpusReportDetail | null>(null)
  const [generating, setGenerating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { ensureStyles() }, [])

  const loadReports = useCallback(async () => {
    try {
      const data = await apiGetOpusReports()
      setReports(data)
      if (!selectedId && data.length > 0) {
        const latest = data.find(r => r.status === 'complete') || data[0]
        setSelectedId(latest.id)
      }
      const inProgress = data.find(r => r.status === 'pending' || r.status === 'generating')
      if (inProgress) {
        setGenerating(true)
        setSelectedId(inProgress.id)
      } else {
        setGenerating(false)
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      }
    } catch (e) {
      console.error('[OPUS] Failed to load reports:', e)
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => { loadReports() }, []) // eslint-disable-line

  useEffect(() => {
    if (!selectedId) return
    setLoadingDetail(true)
    apiGetOpusReport(selectedId)
      .then(d => { setDetail(d); setLoadingDetail(false) })
      .catch(() => setLoadingDetail(false))
  }, [selectedId])

  useEffect(() => {
    if (!generating) return
    pollRef.current = setInterval(async () => {
      const data = await apiGetOpusReports().catch(() => [])
      setReports(data)
      const inProgress = data.find((r: OpusReportSummary) => r.status === 'pending' || r.status === 'generating')
      if (!inProgress) {
        setGenerating(false)
        if (pollRef.current) clearInterval(pollRef.current)
        const latest = data[0]
        if (latest) {
          setSelectedId(latest.id)
          apiGetOpusReport(latest.id).then(setDetail).catch(() => {})
        }
      }
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [generating])

  async function handleGenerate() {
    try {
      setGenerating(true)
      const { id } = await apiGenerateOpusReport()
      setSelectedId(id)
      setReports(prev => [{
        id, reportDate: new Date().toISOString(), status: 'generating',
        inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, createdAt: new Date().toISOString(),
      }, ...prev])
    } catch (e: any) {
      setGenerating(false)
      alert(e.message || 'Failed to generate report')
    }
  }

  function downloadMarkdown() {
    if (!detail?.reportMarkdown) return
    const blob = new Blob([detail.reportMarkdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `opus-report-${formatDate(detail.reportDate).replace(/[\s,]/g, '-')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function downloadRaw() {
    if (!selectedId) return
    try {
      const data = await apiGetOpusReportRaw(selectedId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `opus-raw-${formatDate(detail?.reportDate || new Date().toISOString()).replace(/[\s,]/g, '-')}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('[OPUS] Raw download failed:', e)
    }
  }

  const selectedReport = reports.find(r => r.id === selectedId)
  const isGenerating = selectedReport?.status === 'pending' || selectedReport?.status === 'generating'

  return (
    <div style={{
      flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      fontFamily: T.font.sans, background: T.bg.primary,
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${T.border.default}`, background: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: T.radius.sm,
            background: `linear-gradient(135deg, ${T.opus}, ${T.opus}99)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={16} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text.primary, letterSpacing: -0.3 }}>OPUS</div>
            <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 1 }}>Daily AI System Audit</div>
          </div>
        </div>
        <button onClick={handleGenerate} disabled={generating} style={{
          height: 36, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 12, fontWeight: 700,
          background: generating ? T.bg.tertiary : `linear-gradient(135deg, ${T.opus}, ${T.opus}cc)`,
          color: generating ? T.text.tertiary : '#fff',
          border: 'none', borderRadius: T.radius.sm,
          cursor: generating ? 'default' : 'pointer', fontFamily: T.font.sans,
          boxShadow: generating ? 'none' : `0 2px 8px ${T.opus}40`,
          transition: 'all 0.2s',
        }}>
          {generating
            ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Generating...</>
            : <><Sparkles size={13} /> Generate Report</>}
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar — report list */}
        <div style={{ width: 260, borderRight: `1px solid ${T.border.default}`, overflow: 'auto', background: '#fff' }}>
          <div style={{ padding: '16px 16px 8px', fontSize: 10, fontWeight: 700, color: T.text.tertiary, fontFamily: T.font.mono, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Reports ({reports.length})
          </div>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: T.text.tertiary, fontSize: 12 }}>Loading...</div>
          ) : reports.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: T.text.tertiary, fontSize: 12 }}>
              No reports yet. Click Generate to create your first audit.
            </div>
          ) : reports.map(r => {
            const isActive = r.id === selectedId
            const isPending = r.status === 'pending' || r.status === 'generating'
            const isFailed = r.status === 'failed'
            return (
              <div key={r.id} onClick={() => setSelectedId(r.id)} style={{
                padding: '12px 16px', cursor: 'pointer',
                background: isActive ? `${T.opus}08` : 'transparent',
                borderLeft: isActive ? `3px solid ${T.opus}` : '3px solid transparent',
                borderBottom: `1px solid ${T.border.default}`, transition: 'all 0.15s',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: T.text.primary }}>{formatDate(r.reportDate)}</span>
                  {isPending && <Loader2 size={12} color={T.opus} style={{ animation: 'spin 1s linear infinite' }} />}
                  {isFailed && <AlertCircle size={12} color={T.status.red} />}
                  {r.status === 'complete' && <CheckCircle2 size={12} color={T.status.green} />}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  {r.status === 'complete' && <>
                    <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>${r.costUsd.toFixed(3)}</span>
                    <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>{Math.round(r.durationMs / 1000)}s</span>
                  </>}
                  {isPending && <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.opus }}>generating...</span>}
                  {isFailed && <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.status.red }}>failed</span>}
                </div>
              </div>
            )
          })}
        </div>

        {/* Main — report viewer */}
        <div style={{ flex: 1, overflow: 'auto', background: T.bg.primary }}>
          {!selectedId ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <div style={{ width: 64, height: 64, borderRadius: 20, background: `${T.opus}10`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={28} color={T.opus} style={{ opacity: 0.5 }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text.tertiary }}>Generate your first OPUS report</div>
              <div style={{ fontSize: 11, color: T.text.tertiary, maxWidth: 300, textAlign: 'center', lineHeight: 1.6 }}>
                Claude Opus analyzes your entire AI pipeline — classification accuracy, cost efficiency, SOP coverage, and system health.
              </div>
            </div>
          ) : isGenerating ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
              <div className="opus-generating" style={{ width: 80, height: 80, borderRadius: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={32} color={T.opus} style={{ animation: 'opus-pulse 2s ease-in-out infinite' }} />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, textAlign: 'center' }}>Opus is analyzing your system</div>
                <div style={{ fontSize: 11, color: T.text.tertiary, textAlign: 'center', marginTop: 6, fontFamily: T.font.mono }}>
                  Collecting pipeline data, evaluating classifications, reviewing examples...
                </div>
              </div>
            </div>
          ) : detail?.status === 'failed' ? (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <AlertCircle size={32} color={T.status.red} />
              <div style={{ fontSize: 14, fontWeight: 600, color: T.status.red }}>Report generation failed</div>
              <div style={{ fontSize: 12, color: T.text.tertiary, fontFamily: T.font.mono, maxWidth: 400, textAlign: 'center' }}>
                {detail.reportMarkdown || 'Unknown error'}
              </div>
            </div>
          ) : detail?.reportMarkdown ? (
            <div style={{ animation: 'opus-fade-in 0.3s ease-out' }}>
              {/* Meta bar */}
              <div style={{
                padding: '14px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderBottom: `1px solid ${T.border.default}`, background: '#fff',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  {[
                    { icon: Clock, label: `${Math.round(detail.durationMs / 1000)}s` },
                    { icon: Zap, label: `${(detail.inputTokens + detail.outputTokens).toLocaleString()} tok` },
                    { icon: DollarSign, label: `$${detail.costUsd.toFixed(3)}` },
                  ].map(({ icon: Icon, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Icon size={11} color={T.text.tertiary} />
                      <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>{label}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={downloadMarkdown} style={{
                    height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: 11, fontWeight: 600, color: T.text.secondary,
                    background: T.bg.secondary, border: `1px solid ${T.border.default}`,
                    borderRadius: T.radius.sm, cursor: 'pointer', fontFamily: T.font.sans,
                  }}>
                    <FileText size={11} /> Export .md
                  </button>
                  <button onClick={downloadRaw} style={{
                    height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: 11, fontWeight: 600, color: T.text.secondary,
                    background: T.bg.secondary, border: `1px solid ${T.border.default}`,
                    borderRadius: T.radius.sm, cursor: 'pointer', fontFamily: T.font.sans,
                  }}>
                    <Download size={11} /> Raw JSON
                  </button>
                </div>
              </div>
              {/* Report body */}
              <div style={{ padding: '8px 36px 60px', maxWidth: 800 }}>
                <MarkdownRenderer markdown={detail.reportMarkdown} />
              </div>
            </div>
          ) : loadingDetail ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <RefreshCw size={18} color={T.text.tertiary} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
