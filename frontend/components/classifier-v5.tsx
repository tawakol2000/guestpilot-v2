'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  RefreshCw, Search, X, Activity, CheckCircle, AlertTriangle, Wrench,
  ChevronDown, ChevronRight, Plus, Trash2, Play, Brain,
} from 'lucide-react'
import {
  apiGetClassifierStatus,
  apiTestClassify,
  apiGetEvaluationStats,
  apiGetEvaluations,
  apiGetClassifierExamples,
  apiAddClassifierExample,
  apiDeleteClassifierExample,
  apiReinitializeClassifier,
  type ClassifierEvaluation,
  type ClassifierExampleItem,
} from '@/lib/api'

// ─── Design Tokens (matches ai-logs-v5 exactly) ───────────────────────────────
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

// ─── Styles ───────────────────────────────────────────────────────────────────
const STYLE_ID = 'classifier-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
`
  document.head.appendChild(style)
}

// ─── Label colors ─────────────────────────────────────────────────────────────
const LABEL_COLORS: Record<string, string> = {
  'sop-cleaning': '#15803D',
  'sop-amenity-request': '#0891B2',
  'sop-maintenance': '#DC2626',
  'sop-wifi-doorcode': '#7C3AED',
  'sop-visitor-policy': '#D97706',
  'sop-early-checkin': '#1D4ED8',
  'sop-late-checkout': '#2563EB',
  'sop-escalation-info': '#DB2777',
  'property-info': '#57534E',
  'property-description': '#78716C',
  'property-amenities': '#44403C',
}

const ALL_LABEL_IDS = Object.keys(LABEL_COLORS)

function labelColor(label: string): string {
  return LABEL_COLORS[label] ?? '#57534E'
}

// ─── Label Pill ───────────────────────────────────────────────────────────────
function LabelPill({ label, size = 'sm' }: { label: string; size?: 'sm' | 'xs' }) {
  const color = labelColor(label)
  return (
    <span
      style={{
        display: 'inline-block',
        background: `${color}14`,
        color,
        border: `1px solid ${color}28`,
        borderRadius: 999,
        fontSize: size === 'xs' ? 9 : 10,
        padding: size === 'xs' ? '1px 5px' : '2px 8px',
        fontFamily: T.font.mono,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

// ─── Source Badge ─────────────────────────────────────────────────────────────
function SourceBadge({ source }: { source: string }) {
  const cfg =
    source === 'llm-judge' ? { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE', label: 'llm-judge' } :
    source === 'manual'    ? { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'manual' } :
                             { bg: T.bg.tertiary, color: T.text.tertiary, border: T.border.default, label: 'seed' }
  return (
    <span
      style={{
        display: 'inline-block',
        background: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.border}`,
        borderRadius: 999,
        fontSize: 9,
        padding: '1px 6px',
        fontFamily: T.font.sans,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {cfg.label}
    </span>
  )
}

// ─── Metric Card ──────────────────────────────────────────────────────────────
function MetricCard({ icon, label, value, sub }: {
  icon: React.ReactNode; label: string; value: string; sub?: string
}) {
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
      <div style={{
        width: 32, height: 32, borderRadius: T.radius.sm,
        background: T.bg.secondary,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
          color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 2,
        }}>
          {label}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, lineHeight: 1.1 }}>
          {value}
        </div>
        {sub && (
          <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 1 }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Section Card wrapper ─────────────────────────────────────────────────────
function SectionCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: T.bg.primary,
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        boxShadow: T.shadow.sm,
        overflow: 'hidden',
        animation: 'scaleIn 0.3s ease-out both',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ─── Section Header ───────────────────────────────────────────────────────────
function SectionHeader({ icon, title, sub, right }: {
  icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode
}) {
  return (
    <div style={{
      padding: '12px 20px',
      borderBottom: `1px solid ${T.border.default}`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>
        {title}
      </span>
      {sub && (
        <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono }}>
          {sub}
        </span>
      )}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  )
}

// ─── Filter pills ─────────────────────────────────────────────────────────────
function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 28, padding: '0 12px',
        fontSize: 11, fontWeight: 600,
        border: `1px solid ${active ? T.border.strong : T.border.default}`,
        borderRadius: T.radius.sm,
        background: active ? T.border.strong : T.bg.primary,
        color: active ? '#FFFFFF' : T.text.secondary,
        cursor: 'pointer',
        fontFamily: T.font.sans,
        transition: 'all 0.15s ease',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}

// ─── Sim color helper ─────────────────────────────────────────────────────────
function simColor(sim: number): string {
  if (sim >= 0.8) return T.status.green
  if (sim >= 0.6) return T.status.amber
  return T.status.red
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ─── Section 2: Live Test ─────────────────────────────────────────────────────
function LiveTestSection(): React.ReactElement {
  const [msg, setMsg] = useState('')
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    labels: string[]
    method: string
    topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>
    tokensUsed: number
    topSimilarity: number
  } | null>(null)
  const [error, setError] = useState('')

  async function handleClassify() {
    if (!msg.trim() || loading) return
    setLoading(true)
    setError('')
    try {
      const r = await apiTestClassify(msg.trim())
      setResult(r)
    } catch (e: any) {
      setError(e.message || 'Classification failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SectionCard>
      <SectionHeader
        icon={<Play size={14} color={T.text.secondary} />}
        title="Live Test"
        sub="type a message and see what the classifier returns"
      />

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Input row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={msg}
            onChange={e => setMsg(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={e => { if (e.key === 'Enter') handleClassify() }}
            placeholder={`e.g. "Can we get cleaning today?" or "The AC isn't working"`}
            style={{
              flex: 1, height: 38,
              padding: '0 12px',
              fontSize: 13,
              border: `1px solid ${focused ? T.accent : T.border.default}`,
              borderRadius: T.radius.sm,
              fontFamily: T.font.sans,
              color: T.text.primary,
              outline: 'none',
              background: T.bg.primary,
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
              boxShadow: focused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
            }}
          />
          <button
            onClick={handleClassify}
            disabled={!msg.trim() || loading}
            style={{
              height: 38, padding: '0 20px',
              fontSize: 12, fontWeight: 700,
              border: `1px solid ${T.border.strong}`,
              borderRadius: T.radius.sm,
              background: T.border.strong,
              color: '#FFFFFF',
              cursor: !msg.trim() || loading ? 'default' : 'pointer',
              fontFamily: T.font.sans,
              opacity: !msg.trim() || loading ? 0.5 : 1,
              transition: 'opacity 0.15s ease',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {loading
              ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
              : <Play size={12} />
            }
            Classify
          </button>
        </div>

        {error && (
          <div style={{
            fontSize: 11, color: T.status.red, fontFamily: T.font.mono,
            padding: '6px 10px', background: 'rgba(220,38,38,0.06)',
            borderRadius: T.radius.sm, border: '1px solid rgba(220,38,38,0.12)',
          }}>
            {error}
          </div>
        )}

        {result && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            animation: 'fadeInUp 0.25s ease-out both',
          }}>
            {/* Result summary row */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 14px',
              background: T.bg.secondary,
              borderRadius: T.radius.sm,
              border: `1px solid ${T.border.default}`,
            }}>
              {/* Labels */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
                {result.labels.length === 0
                  ? <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>no labels (empty result)</span>
                  : result.labels.map(l => <LabelPill key={l} label={l} />)
                }
              </div>

              {/* Method */}
              <span style={{
                fontSize: 10, fontFamily: T.font.mono,
                color: T.text.tertiary, whiteSpace: 'nowrap',
              }}>
                {result.method}
              </span>

              {/* Top similarity */}
              <span style={{
                fontSize: 12, fontWeight: 700, fontFamily: T.font.mono,
                color: simColor(result.topSimilarity), whiteSpace: 'nowrap',
              }}>
                sim {result.topSimilarity.toFixed(3)}
              </span>

              {/* Tokens */}
              {result.tokensUsed > 0 && (
                <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, whiteSpace: 'nowrap' }}>
                  {result.tokensUsed} tok
                </span>
              )}
            </div>

            {/* Top K neighbors */}
            {result.topK.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div style={{
                  fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
                  color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 6,
                }}>
                  Top {result.topK.length} Nearest Neighbors
                </div>
                {result.topK.map((n, i) => (
                  <div key={i} style={{
                    display: 'grid',
                    gridTemplateColumns: '28px 60px 1fr auto',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 10px',
                    borderRadius: T.radius.sm,
                    background: i % 2 === 0 ? T.bg.secondary : 'transparent',
                    fontSize: 11,
                  }}>
                    <span style={{
                      fontFamily: T.font.mono, fontSize: 12, fontWeight: 700,
                      color: simColor(n.similarity), textAlign: 'right',
                    }}>
                      {n.similarity.toFixed(2)}
                    </span>
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      {n.labels.length === 0
                        ? <span style={{ fontSize: 9, color: T.text.tertiary, fontFamily: T.font.mono }}>—</span>
                        : n.labels.map(l => <LabelPill key={l} label={l} size="xs" />)
                      }
                    </div>
                    <span style={{
                      fontFamily: T.font.mono, fontSize: 11, color: T.text.secondary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {n.text}
                    </span>
                    <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>
                      #{n.index}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

// ─── Evaluation row (collapsible) ─────────────────────────────────────────────
function EvalRow({ ev, index }: { ev: ClassifierEvaluation; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)

  const rowBg = ev.retrievalCorrect
    ? hovered ? 'rgba(21,128,61,0.06)' : 'rgba(21,128,61,0.03)'
    : hovered ? 'rgba(220,38,38,0.06)' : 'rgba(220,38,38,0.03)'

  return (
    <div
      style={{
        borderRadius: T.radius.sm,
        border: `1px solid ${ev.retrievalCorrect ? 'rgba(21,128,61,0.15)' : 'rgba(220,38,38,0.15)'}`,
        marginBottom: 4,
        overflow: 'hidden',
        fontFamily: T.font.sans,
        transition: 'box-shadow 0.15s ease',
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        animation: 'fadeInUp 0.25s ease-out both',
        animationDelay: `${Math.min(index * 0.02, 0.4)}s`,
      }}
    >
      {/* Collapsed row */}
      <div
        onClick={() => setExpanded(v => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          padding: '0 14px', minHeight: 42,
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer', background: rowBg,
          transition: 'background 0.15s ease',
        }}
      >
        {/* Status icon */}
        {ev.retrievalCorrect
          ? <CheckCircle size={13} color={T.status.green} style={{ flexShrink: 0 }} />
          : <AlertTriangle size={13} color={T.status.red} style={{ flexShrink: 0 }} />
        }

        {/* Auto-fixed badge */}
        {ev.autoFixed && (
          <span style={{
            background: '#EFF6FF', color: '#1D4ED8',
            border: '1px solid #BFDBFE',
            borderRadius: 999, fontSize: 9,
            padding: '1px 6px', fontFamily: T.font.sans, fontWeight: 600, flexShrink: 0,
          }}>
            🔧 fixed
          </span>
        )}

        {/* Guest message */}
        <span style={{
          flex: 1, fontSize: 11, color: T.text.primary, fontFamily: T.font.sans,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {ev.guestMessage}
        </span>

        {/* Classifier labels */}
        <div style={{ display: 'flex', gap: 3, flexShrink: 0, flexWrap: 'nowrap' }}>
          {ev.classifierLabels.length === 0
            ? <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>∅</span>
            : ev.classifierLabels.slice(0, 2).map(l => <LabelPill key={l} label={l} size="xs" />)
          }
          {ev.classifierLabels.length > 2 && (
            <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>+{ev.classifierLabels.length - 2}</span>
          )}
        </div>

        {/* Top sim */}
        <span style={{
          fontSize: 10, fontFamily: T.font.mono, fontWeight: 600,
          color: simColor(ev.classifierTopSim), flexShrink: 0,
        }}>
          {ev.classifierTopSim.toFixed(2)}
        </span>

        {/* Time */}
        <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, flexShrink: 0 }}>
          {formatTime(ev.createdAt)}
        </span>

        <ChevronRight
          size={13}
          color={T.text.tertiary}
          style={{ flexShrink: 0, transition: 'transform 0.2s ease', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
      </div>

      {/* Expanded */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${T.border.default}`,
          padding: '12px 16px',
          display: 'flex', flexDirection: 'column', gap: 10,
          animation: 'fadeInUp 0.2s ease-out both',
          background: T.bg.primary,
        }}>
          {/* Label comparison */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 6 }}>
                Classifier Retrieved
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {ev.classifierLabels.length === 0
                  ? <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>nothing</span>
                  : ev.classifierLabels.map(l => <LabelPill key={l} label={l} />)
                }
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: ev.retrievalCorrect ? T.text.tertiary : T.status.red, fontFamily: T.font.sans, marginBottom: 6 }}>
                Judge Says Should Be
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {ev.judgeCorrectLabels.length === 0
                  ? <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>nothing</span>
                  : ev.judgeCorrectLabels.map(l => <LabelPill key={l} label={l} />)
                }
              </div>
            </div>
          </div>

          {/* Reasoning + meta */}
          <div style={{
            padding: '8px 12px',
            background: T.bg.secondary,
            borderRadius: T.radius.sm,
            border: `1px solid ${T.border.default}`,
          }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 4 }}>
              Judge Reasoning
            </div>
            <div style={{ fontSize: 11, fontFamily: T.font.sans, color: T.text.secondary, lineHeight: 1.5 }}>
              {ev.judgeReasoning || '—'}
            </div>
          </div>

          {/* Meta row */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
            <span>method: {ev.classifierMethod}</span>
            <span>sim: {ev.classifierTopSim.toFixed(3)}</span>
            <span>confidence: {ev.judgeConfidence}</span>
            {ev.conversationId && <span>conv: {ev.conversationId.slice(0, 8)}…</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Section 3: Evaluation Log ────────────────────────────────────────────────
function EvaluationLogSection(): React.ReactElement {
  const [evals, setEvals] = useState<ClassifierEvaluation[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'correct' | 'incorrect' | 'autofixed'>('all')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 30

  const load = useCallback(async (f: typeof filter, p: number) => {
    setLoading(true)
    try {
      const params: { limit: number; offset: number; correct?: boolean } = {
        limit: PAGE_SIZE,
        offset: p * PAGE_SIZE,
      }
      if (f === 'correct') params.correct = true
      if (f === 'incorrect') params.correct = false

      const data = await apiGetEvaluations(params)
      let items = data.evaluations
      if (f === 'autofixed') items = items.filter(e => e.autoFixed)
      setEvals(items)
      setTotal(f === 'autofixed' ? items.length : data.total)
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(filter, page) }, [load, filter, page])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <SectionCard style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionHeader
        icon={<Activity size={14} color={T.text.secondary} />}
        title="Evaluation Log"
        sub={`${total} evaluations`}
        right={
          <button
            onClick={() => load(filter, page)}
            disabled={loading}
            style={{
              height: 28, padding: '0 10px',
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              background: T.bg.primary,
              color: T.text.secondary,
              cursor: loading ? 'default' : 'pointer',
              fontFamily: T.font.sans,
              opacity: loading ? 0.6 : 1,
            }}
          >
            <RefreshCw size={11} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Refresh
          </button>
        }
      />

      {/* Filter pills */}
      <div style={{ padding: '10px 20px', display: 'flex', gap: 6, borderBottom: `1px solid ${T.border.default}` }}>
        {(['all', 'correct', 'incorrect', 'autofixed'] as const).map(f => (
          <FilterPill key={f} label={f === 'autofixed' ? '🔧 auto-fixed' : f.charAt(0).toUpperCase() + f.slice(1)} active={filter === f} onClick={() => { setFilter(f); setPage(0) }} />
        ))}
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px', minHeight: 200, maxHeight: 500 }}>
        {evals.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '40px 0', gap: 8, animation: 'fadeInUp 0.3s ease-out both',
          }}>
            <Activity size={24} color={T.text.tertiary} />
            <span style={{ fontSize: 13, color: T.text.tertiary, fontFamily: T.font.sans, fontWeight: 500 }}>
              No evaluations yet
            </span>
            <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono }}>
              Evaluations appear after guest messages are processed
            </span>
          </div>
        ) : (
          evals.map((ev, i) => <EvalRow key={ev.id} ev={ev} index={i} />)
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          padding: '8px 20px',
          borderTop: `1px solid ${T.border.default}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ padding: '4px 12px', fontSize: 11, borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`, background: T.bg.primary, cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontFamily: T.font.sans, color: T.text.secondary }}>
            Prev
          </button>
          <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
            {page + 1} / {totalPages}
          </span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            style={{ padding: '4px 12px', fontSize: 11, borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`, background: T.bg.primary, cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontFamily: T.font.sans, color: T.text.secondary }}>
            Next
          </button>
        </div>
      )}
    </SectionCard>
  )
}

// ─── Section 4: Training Examples ─────────────────────────────────────────────
function TrainingExamplesSection(): React.ReactElement {
  const [examples, setExamples] = useState<ClassifierExampleItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<'all' | 'llm-judge' | 'manual'>('all')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [reinitLoading, setReinitLoading] = useState(false)
  const [reinitMsg, setReinitMsg] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Add form state
  const [addText, setAddText] = useState('')
  const [addLabels, setAddLabels] = useState<string[]>([])
  const [addFocused, setAddFocused] = useState(false)
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState('')

  const load = useCallback(async (src: typeof sourceFilter) => {
    setLoading(true)
    try {
      const params: { limit: number; source?: string } = { limit: 500 }
      if (src !== 'all') params.source = src
      const data = await apiGetClassifierExamples(params)
      setExamples(data.examples)
      setTotal(data.total)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(sourceFilter) }, [load, sourceFilter])

  const filtered = examples.filter(e =>
    !search || e.text.toLowerCase().includes(search.toLowerCase())
  )

  // Source counts
  const judgeCnt = examples.filter(e => e.source === 'llm-judge').length
  const manualCnt = examples.filter(e => e.source === 'manual').length

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await apiDeleteClassifierExample(id)
      setExamples(prev => prev.filter(e => e.id !== id))
      setTotal(prev => prev - 1)
    } catch {
      // silent
    } finally {
      setDeletingId(null)
    }
  }

  async function handleAdd() {
    if (!addText.trim() || addLoading) return
    setAddLoading(true)
    setAddError('')
    try {
      await apiAddClassifierExample({ text: addText.trim(), labels: addLabels })
      setAddText('')
      setAddLabels([])
      await load(sourceFilter)
    } catch (e: any) {
      setAddError(e.message || 'Failed to add example')
    } finally {
      setAddLoading(false)
    }
  }

  async function handleReinit() {
    setReinitLoading(true)
    setReinitMsg('')
    try {
      const r = await apiReinitializeClassifier()
      setReinitMsg(`✓ Re-initialized with ${r.exampleCount} examples`)
      setTimeout(() => setReinitMsg(''), 4000)
    } catch (e: any) {
      setReinitMsg(`Error: ${e.message}`)
    } finally {
      setReinitLoading(false)
    }
  }

  function toggleLabel(l: string) {
    setAddLabels(prev => prev.includes(l) ? prev.filter(x => x !== l) : [...prev, l])
  }

  return (
    <SectionCard style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionHeader
        icon={<Brain size={14} color={T.text.secondary} />}
        title="Training Examples"
        sub={`${total} DB examples`}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {reinitMsg && (
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: reinitMsg.startsWith('✓') ? T.status.green : T.status.red }}>
                {reinitMsg}
              </span>
            )}
            <button
              onClick={handleReinit}
              disabled={reinitLoading}
              style={{
                height: 28, padding: '0 12px',
                fontSize: 11, fontWeight: 600,
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                background: T.bg.primary,
                color: T.text.secondary,
                cursor: reinitLoading ? 'default' : 'pointer',
                fontFamily: T.font.sans,
                opacity: reinitLoading ? 0.6 : 1,
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <RefreshCw size={11} style={reinitLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
              Reinitialize
            </button>
          </div>
        }
      />

      {/* Source counts + filter */}
      <div style={{
        padding: '10px 20px',
        borderBottom: `1px solid ${T.border.default}`,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
          {judgeCnt} llm-judge + {manualCnt} manual
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'llm-judge', 'manual'] as const).map(s => (
            <FilterPill key={s} label={s === 'all' ? 'All' : s} active={sourceFilter === s} onClick={() => setSourceFilter(s)} />
          ))}
        </div>

        {/* Search */}
        <div style={{ marginLeft: 'auto', position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={12} color={searchFocused ? T.accent : T.text.tertiary}
            style={{ position: 'absolute', left: 8, pointerEvents: 'none', transition: 'color 0.15s ease' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Filter by text..."
            style={{
              height: 28, width: 200,
              padding: '0 28px 0 26px',
              fontSize: 11,
              border: `1px solid ${searchFocused ? T.accent : T.border.default}`,
              borderRadius: T.radius.sm,
              fontFamily: T.font.sans, color: T.text.primary,
              outline: 'none', background: T.bg.primary,
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
              boxShadow: searchFocused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')}
              style={{ position: 'absolute', right: 6, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: T.bg.tertiary, borderRadius: '50%', cursor: 'pointer', padding: 0 }}>
              <X size={9} color={T.text.secondary} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', maxHeight: 400, padding: '8px 16px' }}>
        {loading ? (
          <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
            {search ? 'No examples match your search' : 'No DB examples yet — they appear when the judge adds them'}
          </div>
        ) : (
          filtered.map((ex, i) => (
            <div key={ex.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px',
              borderRadius: T.radius.sm,
              background: i % 2 === 0 ? T.bg.secondary : 'transparent',
              animation: 'fadeInUp 0.2s ease-out both',
              animationDelay: `${Math.min(i * 0.01, 0.3)}s`,
            }}>
              <span style={{ flex: 1, fontSize: 11, fontFamily: T.font.sans, color: T.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ex.text}
              </span>
              <div style={{ display: 'flex', gap: 3, flexShrink: 0, flexWrap: 'nowrap' }}>
                {ex.labels.length === 0
                  ? <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>—</span>
                  : ex.labels.slice(0, 2).map(l => <LabelPill key={l} label={l} size="xs" />)
                }
                {ex.labels.length > 2 && <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>+{ex.labels.length - 2}</span>}
              </div>
              <SourceBadge source={ex.source} />
              <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary, flexShrink: 0 }}>
                {formatTime(ex.createdAt)}
              </span>
              <button
                onClick={() => handleDelete(ex.id)}
                disabled={deletingId === ex.id}
                style={{
                  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.sm,
                  background: T.bg.primary,
                  cursor: deletingId === ex.id ? 'default' : 'pointer',
                  opacity: deletingId === ex.id ? 0.5 : 1,
                  padding: 0, flexShrink: 0,
                }}
              >
                <Trash2 size={11} color={T.status.red} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add Example form */}
      <div style={{
        borderTop: `1px solid ${T.border.default}`,
        padding: '14px 20px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.text.secondary, fontFamily: T.font.sans }}>
          Add Training Example
        </div>

        {/* Text input */}
        <input
          value={addText}
          onChange={e => setAddText(e.target.value)}
          onFocus={() => setAddFocused(true)}
          onBlur={() => setAddFocused(false)}
          placeholder="Guest message text..."
          style={{
            height: 34, padding: '0 12px',
            fontSize: 12,
            border: `1px solid ${addFocused ? T.accent : T.border.default}`,
            borderRadius: T.radius.sm,
            fontFamily: T.font.sans, color: T.text.primary,
            outline: 'none', background: T.bg.primary,
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
            boxShadow: addFocused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
          }}
        />

        {/* Label checkboxes */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {ALL_LABEL_IDS.map(l => {
            const active = addLabels.includes(l)
            const color = labelColor(l)
            return (
              <button
                key={l}
                onClick={() => toggleLabel(l)}
                style={{
                  height: 24, padding: '0 9px',
                  fontSize: 10, fontFamily: T.font.mono,
                  background: active ? `${color}18` : T.bg.secondary,
                  color: active ? color : T.text.tertiary,
                  border: `1px solid ${active ? `${color}30` : T.border.default}`,
                  borderRadius: 999, cursor: 'pointer',
                  transition: 'all 0.12s ease', fontWeight: active ? 600 : 400,
                }}
              >
                {l}
              </button>
            )
          })}
        </div>

        {addError && (
          <div style={{ fontSize: 10, color: T.status.red, fontFamily: T.font.mono }}>
            {addError}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleAdd}
          disabled={!addText.trim() || addLoading}
          style={{
            alignSelf: 'flex-start',
            height: 32, padding: '0 16px',
            fontSize: 12, fontWeight: 700,
            border: `1px solid ${T.border.strong}`,
            borderRadius: T.radius.sm,
            background: T.border.strong, color: '#FFFFFF',
            cursor: !addText.trim() || addLoading ? 'default' : 'pointer',
            fontFamily: T.font.sans,
            opacity: !addText.trim() || addLoading ? 0.5 : 1,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {addLoading
            ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <Plus size={11} />
          }
          Add Example
        </button>
      </div>
    </SectionCard>
  )
}

// ─── Main Export ──────────────────────────────────────────────────────────────
export function ClassifierV5(): React.ReactElement {
  const [status, setStatus] = useState<{
    initialized: boolean; exampleCount: number; initDurationMs: number
    sopChunkCount: number; bakedInCount: number
  } | null>(null)
  const [evalStats, setEvalStats] = useState<{
    total: number; correct: number; incorrect: number; autoFixed: number; accuracyPercent: number
  } | null>(null)

  useEffect(() => { ensureStyles() }, [])

  const loadStats = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        apiGetClassifierStatus().catch(() => null),
        apiGetEvaluationStats().catch(() => null),
      ])
      if (s) setStatus(s)
      if (e) setEvalStats(e)
    } catch { /* silent */ }
  }, [])

  // Initial load + 30s poll
  useEffect(() => {
    loadStats()
    const id = setInterval(loadStats, 30000)
    return () => clearInterval(id)
  }, [loadStats])

  const accuracyColor = evalStats
    ? evalStats.accuracyPercent >= 90 ? T.status.green
    : evalStats.accuracyPercent >= 70 ? T.status.amber
    : T.status.red
    : T.text.primary

  return (
    <div style={{
      height: '100%',
      display: 'flex', flexDirection: 'column',
      fontFamily: T.font.sans,
      background: T.bg.secondary,
      padding: 20, gap: 16,
      overflowY: 'auto',
    }}>

      {/* ── Stats bar ── */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
        <MetricCard
          icon={<Brain size={16} color={T.text.secondary} />}
          label="Training Examples"
          value={status ? String(status.exampleCount) : '—'}
          sub={status ? `${status.initDurationMs}ms init` : undefined}
        />
        <MetricCard
          icon={<Activity size={16} color={T.text.secondary} />}
          label="Evaluations"
          value={evalStats ? String(evalStats.total) : '—'}
          sub={evalStats?.total ? `${evalStats.correct} correct` : undefined}
        />
        <MetricCard
          icon={<CheckCircle size={16} color={accuracyColor} />}
          label="Retrieval Accuracy"
          value={evalStats ? `${evalStats.accuracyPercent}%` : '—'}
          sub={evalStats?.total ? `${evalStats.incorrect} incorrect` : undefined}
        />
        <MetricCard
          icon={<Wrench size={16} color={T.text.secondary} />}
          label="Auto-Fixed"
          value={evalStats ? String(evalStats.autoFixed) : '—'}
          sub={evalStats?.autoFixed ? 'new examples added' : undefined}
        />
      </div>

      {/* ── Classifier status pill ── */}
      {status && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: status.initialized ? T.status.green : T.status.amber,
            boxShadow: status.initialized
              ? '0 0 0 3px rgba(21,128,61,0.1)'
              : '0 0 0 3px rgba(217,119,6,0.1)',
          }} />
          <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary }}>
            {status.initialized
              ? `Classifier ready · ${status.exampleCount} examples · ${status.sopChunkCount} SOP chunks`
              : 'Classifier not initialized'
            }
          </span>
        </div>
      )}

      {/* ── Live Test ── */}
      <LiveTestSection />

      {/* ── Evaluation Log ── */}
      <EvaluationLogSection />

      {/* ── Training Examples ── */}
      <TrainingExamplesSection />
    </div>
  )
}
