'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw, Search, X, Activity, CheckCircle, AlertTriangle, Wrench,
  ChevronRight, Plus, Trash2, Play, Brain, DollarSign, TrendingUp, TrendingDown,
  Settings2, Save, Minus, FileText,
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
  apiGetClassifierThresholds,
  apiSetClassifierThresholds,
  apiBatchClassify,
  apiGetTenantAiConfig,
  apiUpdateTenantAiConfig,
  type ClassifierEvaluation,
  type ClassifierExampleItem,
  type BatchClassifyResult,
} from '@/lib/api'

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
@keyframes scaleIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
@keyframes pulseGreen { 0%,100% { box-shadow: 0 0 0 3px rgba(21,128,61,0.1) } 50% { box-shadow: 0 0 0 5px rgba(21,128,61,0.18) } }
.cls-scroll::-webkit-scrollbar { width: 5px; }
.cls-scroll::-webkit-scrollbar-track { background: transparent; }
.cls-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.cls-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`
  document.head.appendChild(style)
}

// ─── Label colors ─────────────────────────────────────────────────────────────
const LABEL_COLORS: Record<string, string> = {
  'sop-cleaning':        '#15803D',
  'sop-amenity-request': '#0891B2',
  'sop-maintenance':     '#DC2626',
  'sop-wifi-doorcode':   '#7C3AED',
  'sop-visitor-policy':  '#D97706',
  'sop-early-checkin':   '#1D4ED8',
  'sop-late-checkout':   '#2563EB',
  'sop-escalation-info': '#DB2777',
  'property-info':       '#57534E',
  'property-description':'#78716C',
  'property-amenities':  '#44403C',
}
const ALL_LABEL_IDS = Object.keys(LABEL_COLORS)
function labelColor(l: string) { return LABEL_COLORS[l] ?? '#57534E' }

// ─── SOP categories ──────────────────────────────────────────────────────────
const ALL_SOP_CATEGORIES = [
  'sop-cleaning', 'sop-amenity-request', 'sop-maintenance', 'sop-wifi-doorcode',
  'sop-visitor-policy', 'sop-early-checkin', 'sop-late-checkout', 'sop-complaint',
  'sop-booking-inquiry', 'sop-booking-modification', 'sop-booking-confirmation',
  'sop-long-term-rental', 'sop-booking-cancellation', 'sop-property-viewing',
  'pricing-negotiation', 'pre-arrival-logistics', 'payment-issues', 'post-stay-issues',
] as const

type SopOverrideEntry = { enabled: boolean; override: string }
type SopOverrides = Record<string, SopOverrideEntry>

function formatSopName(key: string): string {
  return key
    .replace(/^sop-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Sim color ────────────────────────────────────────────────────────────────
function simColor(s: number) {
  return s >= 0.8 ? T.status.green : s >= 0.6 ? T.status.amber : T.status.red
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m` // sub-cent: show in milli-dollars
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ─── Primitives ───────────────────────────────────────────────────────────────
function LabelPill({ label, size = 'sm' }: { label: string; size?: 'sm' | 'xs' }) {
  const c = labelColor(label)
  return (
    <span style={{
      display: 'inline-block',
      background: `${c}14`, color: c, border: `1px solid ${c}28`,
      borderRadius: 999, fontSize: size === 'xs' ? 9 : 10,
      padding: size === 'xs' ? '1px 5px' : '2px 8px',
      fontFamily: T.font.mono, fontWeight: 500, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function SourceBadge({ source }: { source: string }) {
  const cfg =
    source === 'llm-judge' ? { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' } :
    source === 'manual'    ? { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' } :
                             { bg: T.bg.tertiary, color: T.text.tertiary, border: T.border.default }
  return (
    <span style={{
      display: 'inline-block', background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`, borderRadius: 999,
      fontSize: 9, padding: '1px 6px', fontFamily: T.font.sans, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{source}</span>
  )
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      height: 28, padding: '0 12px', fontSize: 11, fontWeight: 600,
      border: `1px solid ${active ? T.border.strong : T.border.default}`,
      borderRadius: T.radius.sm,
      background: active ? T.border.strong : T.bg.primary,
      color: active ? '#fff' : T.text.secondary,
      cursor: 'pointer', fontFamily: T.font.sans, transition: 'all 0.15s ease', flexShrink: 0,
    }}>{label}</button>
  )
}

// ─── Metric Card ──────────────────────────────────────────────────────────────
function MetricCard({ icon, label, value, sub, valueColor }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; valueColor?: string
}) {
  return (
    <div style={{
      flex: 1, minWidth: 150,
      background: T.bg.primary, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.md, padding: '14px 18px',
      boxShadow: T.shadow.sm, display: 'flex', alignItems: 'center', gap: 14,
      animation: 'scaleIn 0.3s ease-out both',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: T.radius.sm, background: T.bg.secondary,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em',
          color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 3,
        }}>{label}</div>
        <div style={{
          fontSize: 20, fontWeight: 800, color: valueColor ?? T.text.primary,
          fontFamily: T.font.sans, lineHeight: 1, letterSpacing: '-0.02em',
        }}>{value}</div>
        {sub && <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  )
}

// ─── Section Card ─────────────────────────────────────────────────────────────
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: T.bg.primary, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.md, boxShadow: T.shadow.sm,
      overflow: 'visible', // allow inner scroll areas to work
      animation: 'scaleIn 0.3s ease-out both',
      ...style,
    }}>{children}</div>
  )
}

function CardHeader({ icon, title, sub, right }: {
  icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode
}) {
  return (
    <div style={{
      padding: '13px 20px', borderBottom: `1px solid ${T.border.default}`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono }}>{sub}</span>}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  )
}

// ─── Sim Bar ──────────────────────────────────────────────────────────────────
function SimBar({ value }: { value: number }) {
  const c = simColor(value)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 48, height: 4, background: T.bg.tertiary, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: '100%', background: c, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10, fontFamily: T.font.mono, fontWeight: 700, color: c, minWidth: 32 }}>
        {value.toFixed(2)}
      </span>
    </div>
  )
}

// ─── Inline refresh btn ───────────────────────────────────────────────────────
function RefreshBtn({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      height: 28, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 11, fontWeight: 600, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.sm, background: T.bg.primary, color: T.text.secondary,
      cursor: loading ? 'default' : 'pointer', fontFamily: T.font.sans,
      opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s',
    }}>
      <RefreshCw size={11} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
      Refresh
    </button>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 1: Live Test
// ═════════════════════════════════════════════════════════════════════════════
function LiveTestSection() {
  const [msg, setMsg] = useState('')
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    labels: string[]; method: string;
    topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
    tokensUsed: number; topSimilarity: number
  } | null>(null)
  const [err, setErr] = useState('')

  async function classify() {
    if (!msg.trim() || loading) return
    setLoading(true); setErr('')
    try { setResult(await apiTestClassify(msg.trim())) }
    catch (e: any) { setErr(e.message || 'Classification failed') }
    finally { setLoading(false) }
  }

  return (
    <Card>
      <CardHeader
        icon={<Play size={14} color={T.text.secondary} />}
        title="Live Test"
        sub="type a guest message and see what the classifier returns"
      />
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Input row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={msg}
            onChange={e => setMsg(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={e => { if (e.key === 'Enter') classify() }}
            placeholder={`e.g. "Can we get cleaning today?" or "The AC isn't working"`}
            style={{
              flex: 1, height: 38, padding: '0 12px', fontSize: 13,
              border: `1px solid ${focused ? T.accent : T.border.default}`,
              borderRadius: T.radius.sm, fontFamily: T.font.sans, color: T.text.primary,
              outline: 'none', background: T.bg.primary,
              transition: 'border-color 0.15s, box-shadow 0.15s',
              boxShadow: focused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
            }}
          />
          <button
            onClick={classify} disabled={!msg.trim() || loading}
            style={{
              height: 38, padding: '0 20px', fontSize: 12, fontWeight: 700,
              border: `1px solid ${T.border.strong}`, borderRadius: T.radius.sm,
              background: T.border.strong, color: '#fff',
              cursor: !msg.trim() || loading ? 'default' : 'pointer',
              fontFamily: T.font.sans, opacity: !msg.trim() || loading ? 0.5 : 1,
              transition: 'opacity 0.15s', display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {loading
              ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
              : <Play size={12} />}
            Classify
          </button>
        </div>

        {err && (
          <div style={{
            fontSize: 11, color: T.status.red, fontFamily: T.font.mono,
            padding: '6px 10px', background: 'rgba(220,38,38,0.06)',
            borderRadius: T.radius.sm, border: '1px solid rgba(220,38,38,0.12)',
          }}>{err}</div>
        )}

        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, animation: 'fadeInUp 0.25s ease-out both' }}>
            {/* Result summary */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 14px', background: T.bg.secondary,
              borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`,
            }}>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                {result.labels.length === 0
                  ? <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>∅ no labels returned</span>
                  : result.labels.map(l => <LabelPill key={l} label={l} />)}
              </div>
              <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, whiteSpace: 'nowrap' }}>
                {result.method}
              </span>
              <SimBar value={result.topSimilarity} />
              {result.tokensUsed > 0 && (
                <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, whiteSpace: 'nowrap' }}>
                  {result.tokensUsed} tok
                </span>
              )}
            </div>

            {/* Nearest neighbors */}
            {result.topK.length > 0 && (
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em',
                  color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 6,
                }}>Top {result.topK.length} Nearest Neighbors</div>
                <div style={{ border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm, overflow: 'hidden' }}>
                  {result.topK.map((n, i) => (
                    <div key={i} style={{
                      display: 'grid', gridTemplateColumns: 'auto auto 1fr',
                      alignItems: 'center', gap: 12, padding: '8px 12px',
                      borderBottom: i < result.topK.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      background: i % 2 === 0 ? T.bg.secondary : T.bg.primary,
                    }}>
                      <SimBar value={n.similarity} />
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                        {n.labels.length === 0
                          ? <span style={{ fontSize: 9, color: T.text.tertiary, fontFamily: T.font.mono }}>—</span>
                          : n.labels.map(l => <LabelPill key={l} label={l} size="xs" />)}
                      </div>
                      <span style={{
                        fontFamily: T.font.mono, fontSize: 11, color: T.text.secondary,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{n.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Eval row
// ═════════════════════════════════════════════════════════════════════════════
function EvalRow({ ev, index }: { ev: ClassifierEvaluation; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const [hov, setHov] = useState(false)

  const tint = ev.retrievalCorrect
    ? hov ? 'rgba(21,128,61,0.06)' : 'rgba(21,128,61,0.025)'
    : hov ? 'rgba(220,38,38,0.06)' : 'rgba(220,38,38,0.025)'

  return (
    <div style={{
      borderRadius: T.radius.sm,
      border: `1px solid ${ev.retrievalCorrect ? 'rgba(21,128,61,0.18)' : 'rgba(220,38,38,0.18)'}`,
      marginBottom: 4, overflow: 'hidden', fontFamily: T.font.sans,
      transition: 'box-shadow 0.15s', boxShadow: hov ? T.shadow.md : T.shadow.sm,
      animation: 'fadeInUp 0.25s ease-out both', animationDelay: `${Math.min(index * 0.02, 0.35)}s`,
    }}>
      {/* Row */}
      <div
        onClick={() => setExpanded(v => !v)}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          padding: '0 14px', minHeight: 42, display: 'flex', alignItems: 'center',
          gap: 10, cursor: 'pointer', background: tint, transition: 'background 0.15s',
        }}
      >
        {ev.retrievalCorrect
          ? <CheckCircle size={13} color={T.status.green} style={{ flexShrink: 0 }} />
          : <AlertTriangle size={13} color={T.status.red} style={{ flexShrink: 0 }} />}

        {ev.autoFixed && (
          <span style={{
            background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE',
            borderRadius: 999, fontSize: 9, padding: '1px 6px',
            fontFamily: T.font.sans, fontWeight: 600, flexShrink: 0,
          }}>🔧 fixed</span>
        )}

        <span style={{
          flex: 1, fontSize: 11, color: T.text.primary, fontFamily: T.font.sans,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{ev.guestMessage}</span>

        {/* Classifier labels (up to 2) */}
        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
          {ev.classifierLabels.length === 0
            ? <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>∅</span>
            : ev.classifierLabels.slice(0, 2).map(l => <LabelPill key={l} label={l} size="xs" />)}
          {ev.classifierLabels.length > 2 && (
            <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>+{ev.classifierLabels.length - 2}</span>
          )}
        </div>

        <SimBar value={ev.classifierTopSim} />
        <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {fmtTime(ev.createdAt)}
        </span>

        <ChevronRight size={13} color={T.text.tertiary} style={{
          flexShrink: 0, transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }} />
      </div>

      {/* Expanded */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${T.border.default}`, padding: '12px 16px',
          display: 'flex', flexDirection: 'column', gap: 10,
          animation: 'fadeInUp 0.2s ease-out both', background: T.bg.primary,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              { heading: 'Classifier Retrieved', labels: ev.classifierLabels, headColor: T.text.tertiary },
              { heading: 'Judge Says Should Be', labels: ev.judgeCorrectLabels, headColor: ev.retrievalCorrect ? T.text.tertiary : T.status.red },
            ].map(({ heading, labels, headColor }) => (
              <div key={heading}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: headColor, fontFamily: T.font.sans, marginBottom: 6 }}>
                  {heading}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {labels.length === 0
                    ? <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>nothing</span>
                    : labels.map(l => <LabelPill key={l} label={l} />)}
                </div>
              </div>
            ))}
          </div>

          {ev.judgeReasoning && (
            <div style={{
              padding: '8px 12px', background: T.bg.secondary,
              borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`,
            }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 4 }}>
                Judge Reasoning
              </div>
              <div style={{ fontSize: 11, fontFamily: T.font.sans, color: T.text.secondary, lineHeight: 1.6 }}>
                {ev.judgeReasoning}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>
            <span>method: {ev.classifierMethod}</span>
            <span>confidence: {ev.judgeConfidence}</span>
            {ev.conversationId && <span>conv: {ev.conversationId.slice(0, 8)}…</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 2: Evaluation Log
// ═════════════════════════════════════════════════════════════════════════════
function EvaluationLogSection() {
  const [evals, setEvals] = useState<ClassifierEvaluation[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'correct' | 'incorrect' | 'autofixed'>('all')
  const [page, setPage] = useState(0)
  const PAGE = 30

  const load = useCallback(async (f: typeof filter, p: number) => {
    setLoading(true)
    try {
      const params: { limit: number; offset: number; correct?: boolean } = { limit: PAGE, offset: p * PAGE }
      if (f === 'correct') params.correct = true
      if (f === 'incorrect') params.correct = false
      const data = await apiGetEvaluations(params)
      let items = data.evaluations
      if (f === 'autofixed') items = items.filter(e => e.autoFixed)
      setEvals(items)
      setTotal(f === 'autofixed' ? items.length : data.total)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(filter, page) }, [load, filter, page])

  const pages = Math.ceil(total / PAGE)

  return (
    <Card>
      <CardHeader
        icon={<Activity size={14} color={T.text.secondary} />}
        title="Evaluation Log"
        sub={`${total} evaluations`}
        right={<RefreshBtn loading={loading} onClick={() => load(filter, page)} />}
      />

      {/* Filters */}
      <div style={{
        padding: '10px 20px', display: 'flex', gap: 6,
        borderBottom: `1px solid ${T.border.default}`,
      }}>
        {(['all', 'correct', 'incorrect', 'autofixed'] as const).map(f => (
          <FilterPill key={f}
            label={f === 'autofixed' ? '🔧 auto-fixed' : f.charAt(0).toUpperCase() + f.slice(1)}
            active={filter === f}
            onClick={() => { setFilter(f); setPage(0) }}
          />
        ))}
      </div>

      {/* Scrollable list — independent scroll */}
      <div
        className="cls-scroll"
        style={{ overflowY: 'auto', maxHeight: 480, padding: '12px 16px' }}
      >
        {evals.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', padding: '44px 0', gap: 8,
            animation: 'fadeInUp 0.3s ease-out both',
          }}>
            <Activity size={24} color={T.text.tertiary} />
            <span style={{ fontSize: 13, color: T.text.tertiary, fontFamily: T.font.sans, fontWeight: 500 }}>
              {loading ? 'Loading…' : 'No evaluations yet'}
            </span>
            {!loading && (
              <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono }}>
                Appear after guest messages are processed
              </span>
            )}
          </div>
        ) : (
          evals.map((ev, i) => <EvalRow key={ev.id} ev={ev} index={i} />)
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div style={{
          padding: '8px 20px', borderTop: `1px solid ${T.border.default}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ padding: '4px 12px', fontSize: 11, borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`, background: T.bg.primary, cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontFamily: T.font.sans, color: T.text.secondary }}>
            Prev
          </button>
          <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>{page + 1} / {pages}</span>
          <button onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}
            style={{ padding: '4px 12px', fontSize: 11, borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`, background: T.bg.primary, cursor: page >= pages - 1 ? 'default' : 'pointer', opacity: page >= pages - 1 ? 0.4 : 1, fontFamily: T.font.sans, color: T.text.secondary }}>
            Next
          </button>
        </div>
      )}
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3: Training Examples
// ═════════════════════════════════════════════════════════════════════════════
function TrainingExamplesSection() {
  const [examples, setExamples] = useState<ClassifierExampleItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [srcFilter, setSrcFilter] = useState<'all' | 'llm-judge' | 'manual'>('all')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [reinitLoading, setReinitLoading] = useState(false)
  const [reinitMsg, setReinitMsg] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [addText, setAddText] = useState('')
  const [addLabels, setAddLabels] = useState<string[]>([])
  const [addFocused, setAddFocused] = useState(false)
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState('')

  const load = useCallback(async (src: typeof srcFilter) => {
    setLoading(true)
    try {
      const params: { limit: number; source?: string } = { limit: 500 }
      if (src !== 'all') params.source = src
      const data = await apiGetClassifierExamples(params)
      setExamples(data.examples)
      setTotal(data.total)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(srcFilter) }, [load, srcFilter])

  const filtered = examples.filter(e => !search || e.text.toLowerCase().includes(search.toLowerCase()))
  const judgeCnt = examples.filter(e => e.source === 'llm-judge').length
  const manualCnt = examples.filter(e => e.source === 'manual').length

  async function handleDelete(id: string) {
    setDeletingId(id)
    try { await apiDeleteClassifierExample(id); setExamples(p => p.filter(e => e.id !== id)); setTotal(p => p - 1) }
    catch { /* silent */ }
    finally { setDeletingId(null) }
  }

  async function handleAdd() {
    if (!addText.trim() || addLoading) return
    setAddLoading(true); setAddError('')
    try { await apiAddClassifierExample({ text: addText.trim(), labels: addLabels }); setAddText(''); setAddLabels([]); await load(srcFilter) }
    catch (e: any) { setAddError(e.message || 'Failed to add example') }
    finally { setAddLoading(false) }
  }

  async function handleReinit() {
    setReinitLoading(true); setReinitMsg('')
    try {
      const r = await apiReinitializeClassifier()
      setReinitMsg(`✓ ${r.exampleCount} examples`)
      setTimeout(() => setReinitMsg(''), 4000)
    } catch (e: any) { setReinitMsg(`Error: ${e.message}`) }
    finally { setReinitLoading(false) }
  }

  return (
    <Card>
      <CardHeader
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
            <button onClick={handleReinit} disabled={reinitLoading} style={{
              height: 28, padding: '0 12px', fontSize: 11, fontWeight: 600,
              border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm,
              background: T.bg.primary, color: T.text.secondary,
              cursor: reinitLoading ? 'default' : 'pointer',
              fontFamily: T.font.sans, opacity: reinitLoading ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 5, transition: 'opacity 0.15s',
            }}>
              <RefreshCw size={11} style={reinitLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
              Reinitialize
            </button>
          </div>
        }
      />

      {/* Source counts + filters + search */}
      <div style={{
        padding: '10px 20px', borderBottom: `1px solid ${T.border.default}`,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary, whiteSpace: 'nowrap' }}>
          {judgeCnt} llm-judge + {manualCnt} manual
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'llm-judge', 'manual'] as const).map(s => (
            <FilterPill key={s} label={s === 'all' ? 'All' : s} active={srcFilter === s} onClick={() => setSrcFilter(s)} />
          ))}
        </div>
        {/* Search */}
        <div style={{ marginLeft: 'auto', position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={12} color={searchFocused ? T.accent : T.text.tertiary}
            style={{ position: 'absolute', left: 8, pointerEvents: 'none', transition: 'color 0.15s' }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
            placeholder="Filter by text..."
            style={{
              height: 28, width: 200, padding: '0 28px 0 26px', fontSize: 11,
              border: `1px solid ${searchFocused ? T.accent : T.border.default}`,
              borderRadius: T.radius.sm, fontFamily: T.font.sans, color: T.text.primary,
              outline: 'none', background: T.bg.primary,
              transition: 'border-color 0.15s, box-shadow 0.15s',
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

      {/* Scrollable example list */}
      <div className="cls-scroll" style={{ overflowY: 'auto', maxHeight: 380, padding: '8px 16px' }}>
        {loading ? (
          <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
            {search ? 'No examples match your search' : 'No DB examples yet — the judge adds them automatically'}
          </div>
        ) : (
          filtered.map((ex, i) => (
            <div key={ex.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
              borderRadius: T.radius.sm, background: i % 2 === 0 ? T.bg.secondary : 'transparent',
              animation: 'fadeInUp 0.2s ease-out both', animationDelay: `${Math.min(i * 0.01, 0.3)}s`,
            }}>
              <span style={{ flex: 1, fontSize: 11, fontFamily: T.font.sans, color: T.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ex.text}
              </span>
              <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                {ex.labels.length === 0
                  ? <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>—</span>
                  : ex.labels.slice(0, 2).map(l => <LabelPill key={l} label={l} size="xs" />)}
                {ex.labels.length > 2 && <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>+{ex.labels.length - 2}</span>}
              </div>
              <SourceBadge source={ex.source} />
              <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary, flexShrink: 0 }}>
                {fmtTime(ex.createdAt)}
              </span>
              <button onClick={() => handleDelete(ex.id)} disabled={deletingId === ex.id}
                style={{
                  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm,
                  background: T.bg.primary, cursor: deletingId === ex.id ? 'default' : 'pointer',
                  opacity: deletingId === ex.id ? 0.5 : 1, padding: 0, flexShrink: 0,
                }}>
                <Trash2 size={11} color={T.status.red} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add example form */}
      <div style={{
        borderTop: `1px solid ${T.border.default}`,
        padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10,
        background: T.bg.secondary,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, fontFamily: T.font.sans }}>
          Add Training Example
        </div>
        <input
          value={addText} onChange={e => setAddText(e.target.value)}
          onFocus={() => setAddFocused(true)} onBlur={() => setAddFocused(false)}
          placeholder="Guest message text..."
          style={{
            height: 34, padding: '0 12px', fontSize: 12,
            border: `1px solid ${addFocused ? T.accent : T.border.default}`,
            borderRadius: T.radius.sm, fontFamily: T.font.sans, color: T.text.primary,
            outline: 'none', background: T.bg.primary,
            transition: 'border-color 0.15s, box-shadow 0.15s',
            boxShadow: addFocused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
          }}
        />

        {/* Label toggles */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {ALL_LABEL_IDS.map(l => {
            const on = addLabels.includes(l)
            const c = labelColor(l)
            return (
              <button key={l} onClick={() => setAddLabels(p => p.includes(l) ? p.filter(x => x !== l) : [...p, l])}
                style={{
                  height: 24, padding: '0 9px', fontSize: 10, fontFamily: T.font.mono,
                  background: on ? `${c}18` : T.bg.primary, color: on ? c : T.text.tertiary,
                  border: `1px solid ${on ? `${c}30` : T.border.default}`,
                  borderRadius: 999, cursor: 'pointer',
                  transition: 'all 0.12s', fontWeight: on ? 600 : 400,
                }}>{l}</button>
            )
          })}
        </div>

        {addError && <div style={{ fontSize: 10, color: T.status.red, fontFamily: T.font.mono }}>{addError}</div>}

        <button onClick={handleAdd} disabled={!addText.trim() || addLoading}
          style={{
            alignSelf: 'flex-start', height: 32, padding: '0 16px',
            fontSize: 12, fontWeight: 700,
            border: `1px solid ${T.border.strong}`, borderRadius: T.radius.sm,
            background: T.border.strong, color: '#fff',
            cursor: !addText.trim() || addLoading ? 'default' : 'pointer',
            fontFamily: T.font.sans, opacity: !addText.trim() || addLoading ? 0.5 : 1,
            display: 'flex', alignItems: 'center', gap: 6, transition: 'opacity 0.15s',
          }}>
          {addLoading
            ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <Plus size={11} />}
          Add Example
        </button>
      </div>
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Threshold Settings Card
// ═════════════════════════════════════════════════════════════════════════════
function ThresholdSettings() {
  const [judgeVal,   setJudgeVal]   = useState(0.75)
  const [autoFixVal, setAutoFixVal] = useState(0.70)
  const [voteVal, setVoteVal] = useState(0.30)
  const [ctxGateVal, setCtxGateVal] = useState(0.85)
  const [tier2Val, setTier2Val] = useState(0.75)
  const [providerVal, setProviderVal] = useState<'openai' | 'cohere'>('openai')
  const [judgeModeVal, setJudgeModeVal] = useState<'evaluate_all' | 'sampling'>('evaluate_all')
  const [judgeModesSaving, setJudeModeSaving] = useState(false)
  const [judgeModeSavedMsg, setJudgeModeSavedMsg] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    apiGetClassifierThresholds()
      .then(d => {
        setJudgeVal(d.judgeThreshold); setAutoFixVal(d.autoFixThreshold)
        if (d.classifierVoteThreshold != null) setVoteVal(d.classifierVoteThreshold)
        if (d.classifierContextualGate != null) setCtxGateVal(d.classifierContextualGate)
        if ((d as any).tier2Threshold != null) setTier2Val((d as any).tier2Threshold)
        if (d.embeddingProvider) setProviderVal(d.embeddingProvider as 'openai' | 'cohere')
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    apiGetTenantAiConfig()
      .then(cfg => {
        if ((cfg as any).judgeMode) setJudgeModeVal((cfg as any).judgeMode)
      })
      .catch(() => {})
  }, [])

  async function saveJudgeMode(mode: 'evaluate_all' | 'sampling') {
    setJudgeModeVal(mode)
    setJudeModeSaving(true); setJudgeModeSavedMsg('')
    try {
      await apiUpdateTenantAiConfig({ judgeMode: mode } as any)
      setJudgeModeSavedMsg('Saved')
      setTimeout(() => setJudgeModeSavedMsg(''), 3000)
    } catch (e: any) {
      setJudgeModeSavedMsg(e.message || 'Error')
    } finally {
      setJudeModeSaving(false)
    }
  }

  const dirty = loaded  // always show save once loaded
  const autoFixErr = autoFixVal >= judgeVal

  async function save() {
    if (autoFixErr || saving) return
    setSaving(true); setSavedMsg('')
    try {
      await apiSetClassifierThresholds({
        judgeThreshold: judgeVal, autoFixThreshold: autoFixVal,
        classifierVoteThreshold: voteVal, classifierContextualGate: ctxGateVal,
        tier2Threshold: tier2Val,
        embeddingProvider: providerVal,
      })
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(''), 3000)
    } catch (e: any) {
      setSavedMsg(e.message || 'Error')
    } finally {
      setSaving(false)
    }
  }

  function SliderRow({
    label, hint, value, onChange, min, max, step, color,
  }: {
    label: string; hint: string; value: number; onChange: (v: number) => void
    min: number; max: number; step: number; color: string
  }) {
    const pct = ((value - min) / (max - min)) * 100
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>{label}</span>
            <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.sans, marginLeft: 8 }}>{hint}</span>
          </div>
          <span style={{
            fontSize: 13, fontWeight: 800, fontFamily: T.font.mono, color,
            minWidth: 36, textAlign: 'right',
          }}>{value.toFixed(2)}</span>
        </div>
        <div style={{ position: 'relative', height: 20, display: 'flex', alignItems: 'center' }}>
          {/* Track */}
          <div style={{
            position: 'absolute', left: 0, right: 0, height: 4,
            borderRadius: 2, background: T.bg.tertiary, overflow: 'hidden',
          }}>
            <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
          </div>
          {/* Native input */}
          <input
            type="range" min={min} max={max} step={step} value={value}
            onChange={e => onChange(parseFloat(e.target.value))}
            style={{
              position: 'absolute', left: 0, right: 0, width: '100%',
              height: 20, opacity: 0, cursor: 'pointer', margin: 0,
            }}
          />
          {/* Thumb overlay */}
          <div style={{
            position: 'absolute',
            left: `calc(${pct}% - 8px)`,
            width: 16, height: 16, borderRadius: '50%',
            background: '#fff', border: `2px solid ${color}`,
            boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
            pointerEvents: 'none',
          }} />
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader
        icon={<Settings2 size={14} color={T.text.secondary} />}
        title="Thresholds"
        sub="configure when the judge runs and when it auto-fixes"
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {savedMsg && (
              <span style={{
                fontSize: 10, fontFamily: T.font.mono,
                color: savedMsg === 'Saved' ? T.status.green : T.status.red,
              }}>{savedMsg}</span>
            )}
            <button onClick={save} disabled={saving || autoFixErr} style={{
              height: 28, padding: '0 12px',
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600,
              border: `1px solid ${autoFixErr ? T.border.default : T.border.strong}`,
              borderRadius: T.radius.sm,
              background: autoFixErr ? T.bg.secondary : T.border.strong,
              color: autoFixErr ? T.text.tertiary : '#fff',
              cursor: saving || autoFixErr ? 'default' : 'pointer',
              fontFamily: T.font.sans, opacity: saving ? 0.6 : 1,
              transition: 'all 0.15s',
            }}>
              {saving
                ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                : <Save size={11} />}
              Save
            </button>
          </div>
        }
      />

      <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <SliderRow
          label="Judge threshold"
          hint="— run LLM judge below this"
          value={judgeVal}
          onChange={v => { setJudgeVal(v); if (v <= autoFixVal) setAutoFixVal(Math.round((v - 0.05) * 100) / 100) }}
          min={0.40} max={0.99} step={0.01}
          color={T.status.amber}
        />
        <SliderRow
          label="Auto-fix threshold"
          hint="— auto-add training example below this"
          value={autoFixVal}
          onChange={v => setAutoFixVal(v)}
          min={0.20} max={0.94} step={0.01}
          color={T.status.red}
        />

        {/* Visual range legend */}
        <div style={{
          display: 'flex', alignItems: 'stretch', height: 24, borderRadius: T.radius.sm,
          overflow: 'hidden', border: `1px solid ${T.border.default}`, marginTop: 2,
        }}>
          {[
            { label: 'auto-fix', color: `${T.status.red}22`, textColor: T.status.red, pct: autoFixVal * 100 },
            { label: 'judge only', color: `${T.status.amber}18`, textColor: T.status.amber, pct: (judgeVal - autoFixVal) * 100 },
            { label: 'trusted — skip', color: `${T.status.green}12`, textColor: T.status.green, pct: (1 - judgeVal) * 100 },
          ].map(seg => (
            <div key={seg.label} style={{
              width: `${seg.pct}%`, background: seg.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden', minWidth: 0,
            }}>
              {seg.pct > 8 && (
                <span style={{ fontSize: 9, fontWeight: 600, fontFamily: T.font.sans, color: seg.textColor, whiteSpace: 'nowrap' }}>
                  {seg.label}
                </span>
              )}
            </div>
          ))}
        </div>

        {autoFixErr && (
          <div style={{ fontSize: 10, color: T.status.red, fontFamily: T.font.mono }}>
            Auto-fix threshold must be less than judge threshold
          </div>
        )}

        {/* Tier 1 classifier thresholds */}
        <div style={{ borderTop: `1px solid ${T.border.default}`, paddingTop: 16, marginTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: T.text.tertiary, fontFamily: T.font.mono, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Tier 1 — Embedding Classifier
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <SliderRow
              label="Vote threshold"
              hint="— label needs this % of weighted vote"
              value={voteVal}
              onChange={v => setVoteVal(v)}
              min={0.10} max={0.60} step={0.01}
              color={T.accent}
            />
            <SliderRow
              label="Contextual gate"
              hint="— short-circuit to contextual above this similarity"
              value={ctxGateVal}
              onChange={v => setCtxGateVal(v)}
              min={0.50} max={0.95} step={0.01}
              color={T.accent}
            />
            <SliderRow
              label="Tier 2 threshold"
              hint="— fire intent extractor (Haiku) below this similarity"
              value={tier2Val}
              onChange={v => setTier2Val(v)}
              min={0.40} max={0.90} step={0.01}
              color="#F59E0B"
            />
          </div>
        </div>

        {/* Embedding provider toggle */}
        <div style={{ borderTop: `1px solid ${T.border.default}`, paddingTop: 16, marginTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: T.text.tertiary, fontFamily: T.font.mono, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Embedding Provider
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['openai', 'cohere'] as const).map(p => (
              <button key={p} onClick={() => setProviderVal(p)} style={{
                flex: 1, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
                background: providerVal === p ? T.border.strong : T.bg.secondary,
                color: providerVal === p ? '#fff' : T.text.secondary,
                border: `1px solid ${providerVal === p ? T.border.strong : T.border.default}`,
                borderRadius: T.radius.sm, cursor: 'pointer', transition: 'all 0.15s',
              }}>
                {p === 'openai' ? 'OpenAI (1536d)' : 'Cohere v4 (1024d)'}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 8, lineHeight: 1.5 }}>
            {providerVal === 'cohere'
              ? 'embed-multilingual-v4.0 — optimized input types for classification + search. Better Arabic accuracy. Rerank enabled.'
              : 'text-embedding-3-small — default provider.'}
            {' '}Switching re-embeds all data (~30s).
          </div>
        </div>

        {/* Judge Mode toggle */}
        <div style={{ borderTop: `1px solid ${T.border.default}`, paddingTop: 16, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: T.text.tertiary, fontFamily: T.font.mono, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Judge Mode
            </div>
            {judgeModeSavedMsg && (
              <span style={{
                fontSize: 10, fontFamily: T.font.mono,
                color: judgeModeSavedMsg === 'Saved' ? T.status.green : T.status.red,
              }}>{judgeModeSavedMsg}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {([
              { value: 'evaluate_all' as const, label: 'Evaluate All' },
              { value: 'sampling' as const, label: 'Sampling (30%)' },
            ]).map(opt => (
              <button key={opt.value} onClick={() => saveJudgeMode(opt.value)} disabled={judgeModesSaving} style={{
                flex: 1, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
                background: judgeModeVal === opt.value ? T.border.strong : T.bg.secondary,
                color: judgeModeVal === opt.value ? '#fff' : T.text.secondary,
                border: `1px solid ${judgeModeVal === opt.value ? T.border.strong : T.border.default}`,
                borderRadius: T.radius.sm, cursor: judgeModesSaving ? 'default' : 'pointer',
                transition: 'all 0.15s', opacity: judgeModesSaving ? 0.6 : 1,
              }}>
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 8, lineHeight: 1.5 }}>
            Evaluate All: judge checks every AI response. Sampling: judge checks ~30% of responses.
          </div>
        </div>
      </div>
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Section: Batch Classification Test (T024)
// ═════════════════════════════════════════════════════════════════════════════
function BatchClassificationTest() {
  const [thresholdInput, setThresholdInput] = useState('0.30')
  const [testMessages, setTestMessages] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<BatchClassifyResult | null>(null)
  const [err, setErr] = useState('')
  const [thresholdFocused, setThresholdFocused] = useState(false)
  const [textareaFocused, setTextareaFocused] = useState(false)

  // Load current vote threshold as default
  useEffect(() => {
    apiGetClassifierThresholds()
      .then(d => {
        if (d.classifierVoteThreshold != null) setThresholdInput(d.classifierVoteThreshold.toFixed(2))
      })
      .catch(() => {})
  }, [])

  async function runBatch() {
    const messages = testMessages.split('\n').map(l => l.trim()).filter(Boolean)
    if (messages.length === 0 || loading) return
    setLoading(true); setErr(''); setResults(null)
    try {
      const data = await apiBatchClassify(messages, parseFloat(thresholdInput))
      setResults(data)
    } catch (e: any) {
      setErr(e.message || 'Batch classification failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Play size={14} color={T.text.secondary} />}
        title="Batch Classification Test"
        sub="paste messages and test classification at a given threshold"
      />
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Threshold input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 600, fontFamily: T.font.sans, color: T.text.primary, whiteSpace: 'nowrap' }}>
            Vote Threshold Override
          </label>
          <input
            type="number"
            step="0.01"
            min="0.05"
            max="0.99"
            value={thresholdInput}
            onChange={e => setThresholdInput(e.target.value)}
            onFocus={() => setThresholdFocused(true)}
            onBlur={() => setThresholdFocused(false)}
            style={{
              width: 80, height: 34, padding: '0 10px', fontSize: 13,
              fontFamily: T.font.mono, fontWeight: 700, color: T.accent,
              border: `1px solid ${thresholdFocused ? T.accent : T.border.default}`,
              borderRadius: T.radius.sm, outline: 'none', background: T.bg.primary,
              transition: 'border-color 0.15s, box-shadow 0.15s',
              boxShadow: thresholdFocused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
              textAlign: 'center',
            }}
          />
        </div>

        {/* Messages textarea */}
        <textarea
          value={testMessages}
          onChange={e => setTestMessages(e.target.value)}
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
          placeholder="Paste test messages here, one per line...&#10;e.g. Can we get cleaning today?&#10;The WiFi is not working&#10;What time is checkout?"
          rows={6}
          style={{
            width: '100%', padding: '10px 12px', fontSize: 12,
            fontFamily: T.font.sans, color: T.text.primary, lineHeight: 1.6,
            border: `1px solid ${textareaFocused ? T.accent : T.border.default}`,
            borderRadius: T.radius.sm, outline: 'none', background: T.bg.primary,
            resize: 'vertical',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            boxShadow: textareaFocused ? '0 0 0 3px rgba(29,78,216,0.08)' : 'none',
          }}
        />

        {/* Run button */}
        <button
          onClick={runBatch}
          disabled={!testMessages.trim() || loading}
          style={{
            alignSelf: 'flex-start', height: 36, padding: '0 20px',
            fontSize: 12, fontWeight: 700,
            border: `1px solid ${T.border.strong}`, borderRadius: T.radius.sm,
            background: T.border.strong, color: '#fff',
            cursor: !testMessages.trim() || loading ? 'default' : 'pointer',
            fontFamily: T.font.sans, opacity: !testMessages.trim() || loading ? 0.5 : 1,
            display: 'flex', alignItems: 'center', gap: 6, transition: 'opacity 0.15s',
          }}
        >
          {loading
            ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
            : <Play size={12} />}
          Run Batch Test
        </button>

        {err && (
          <div style={{
            fontSize: 11, color: T.status.red, fontFamily: T.font.mono,
            padding: '6px 10px', background: 'rgba(220,38,38,0.06)',
            borderRadius: T.radius.sm, border: '1px solid rgba(220,38,38,0.12)',
          }}>{err}</div>
        )}

        {/* Results table */}
        {results && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'fadeInUp 0.25s ease-out both' }}>
            {/* Summary */}
            <div style={{
              fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
              padding: '8px 12px', background: T.bg.secondary,
              borderRadius: T.radius.sm, border: `1px solid ${T.border.default}`,
            }}>
              {results.results.length}/{results.totalMessages} messages classified
              ({results.emptyLabelCount} empty labels)
              {' '}&middot; threshold: {results.threshold.toFixed(2)}
            </div>

            {/* Table */}
            <div style={{ border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr auto auto auto',
                gap: 12, padding: '8px 12px', background: T.bg.tertiary,
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                color: T.text.tertiary, fontFamily: T.font.sans,
              }}>
                <span>Message</span>
                <span>Labels</span>
                <span>Similarity</span>
                <span>Method</span>
              </div>
              {/* Rows */}
              <div className="cls-scroll" style={{ maxHeight: 380, overflowY: 'auto' }}>
                {results.results.map((r, i) => (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '1fr auto auto auto',
                    alignItems: 'center', gap: 12, padding: '7px 12px',
                    borderTop: `1px solid ${T.border.default}`,
                    background: i % 2 === 0 ? T.bg.secondary : T.bg.primary,
                    animation: 'fadeInUp 0.2s ease-out both',
                    animationDelay: `${Math.min(i * 0.015, 0.3)}s`,
                  }}>
                    <span style={{
                      fontSize: 11, fontFamily: T.font.sans, color: T.text.primary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{r.message}</span>
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', flexShrink: 0 }}>
                      {r.labels.length === 0
                        ? <span style={{ fontSize: 9, fontFamily: T.font.mono, color: T.text.tertiary }}>---</span>
                        : r.labels.map(l => <LabelPill key={l} label={l} size="xs" />)}
                    </div>
                    <SimBar value={r.topSimilarity} />
                    <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, whiteSpace: 'nowrap' }}>
                      {r.method}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Section: SOP Configuration (T036)
// ═════════════════════════════════════════════════════════════════════════════
function SOPConfigurationSection() {
  const [overrides, setOverrides] = useState<SopOverrides>({})
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    apiGetTenantAiConfig()
      .then(cfg => {
        const existing = (cfg as any).sopOverrides
        if (existing && typeof existing === 'object') {
          setOverrides(existing)
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  function toggleSop(key: string) {
    setOverrides(prev => {
      const current = prev[key]
      if (!current) {
        // Currently enabled (default) -> disable it
        return { ...prev, [key]: { enabled: false, override: '' } }
      } else if (!current.enabled) {
        // Currently disabled -> remove the override (back to default = enabled)
        const next = { ...prev }
        delete next[key]
        return next
      } else {
        // Explicitly enabled -> disable it
        return { ...prev, [key]: { enabled: false, override: current.override || '' } }
      }
    })
  }

  function setOverrideText(key: string, text: string) {
    setOverrides(prev => ({
      ...prev,
      [key]: { enabled: prev[key]?.enabled ?? false, override: text },
    }))
  }

  function isEnabled(key: string): boolean {
    const entry = overrides[key]
    return !entry || entry.enabled !== false
  }

  async function handleSave() {
    if (saving) return
    setSaving(true); setSavedMsg('')
    try {
      // Only send entries that differ from defaults (disabled ones)
      const toSend: SopOverrides = {}
      for (const [key, val] of Object.entries(overrides)) {
        if (val.enabled === false) {
          toSend[key] = val
        }
      }
      await apiUpdateTenantAiConfig({ sopOverrides: toSend } as any)
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(''), 3000)
    } catch (e: any) {
      setSavedMsg(e.message || 'Error')
    } finally {
      setSaving(false)
    }
  }

  const disabledCount = ALL_SOP_CATEGORIES.filter(k => !isEnabled(k)).length

  return (
    <Card>
      <CardHeader
        icon={<FileText size={14} color={T.text.secondary} />}
        title="SOP Configuration"
        sub={`${ALL_SOP_CATEGORIES.length} categories${disabledCount > 0 ? ` · ${disabledCount} disabled` : ''}`}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {savedMsg && (
              <span style={{
                fontSize: 10, fontFamily: T.font.mono,
                color: savedMsg === 'Saved' ? T.status.green : T.status.red,
              }}>{savedMsg}</span>
            )}
            <button onClick={handleSave} disabled={saving} style={{
              height: 28, padding: '0 12px',
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 11, fontWeight: 600,
              border: `1px solid ${T.border.strong}`,
              borderRadius: T.radius.sm,
              background: T.border.strong, color: '#fff',
              cursor: saving ? 'default' : 'pointer',
              fontFamily: T.font.sans, opacity: saving ? 0.6 : 1,
              transition: 'all 0.15s',
            }}>
              {saving
                ? <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                : <Save size={11} />}
              Save
            </button>
          </div>
        }
      />

      <div className="cls-scroll" style={{ maxHeight: 520, overflowY: 'auto' }}>
        {ALL_SOP_CATEGORIES.map((sop, i) => {
          const enabled = isEnabled(sop)
          const entry = overrides[sop]
          const c = labelColor(sop)
          return (
            <div key={sop} style={{
              padding: '10px 20px',
              borderBottom: i < ALL_SOP_CATEGORIES.length - 1 ? `1px solid ${T.border.default}` : 'none',
              background: !enabled ? 'rgba(220,38,38,0.025)' : 'transparent',
              transition: 'background 0.15s',
              animation: 'fadeInUp 0.2s ease-out both',
              animationDelay: `${Math.min(i * 0.02, 0.3)}s`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* SOP name */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    fontSize: 12, fontWeight: 600, fontFamily: T.font.sans,
                    color: enabled ? T.text.primary : T.text.tertiary,
                    transition: 'color 0.15s',
                  }}>
                    {formatSopName(sop)}
                  </span>
                  <span style={{
                    fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, marginLeft: 8,
                  }}>
                    {sop}
                  </span>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => toggleSop(sop)}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none',
                    background: enabled ? T.status.green : T.bg.tertiary,
                    cursor: 'pointer', position: 'relative',
                    transition: 'background 0.2s', flexShrink: 0, padding: 0,
                  }}
                >
                  <div style={{
                    width: 18, height: 18, borderRadius: '50%',
                    background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                    position: 'absolute', top: 3,
                    left: enabled ? 23 : 3,
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Override text input — shown when disabled */}
              {!enabled && (
                <div style={{
                  marginTop: 8,
                  animation: 'fadeInUp 0.2s ease-out both',
                }}>
                  <input
                    value={entry?.override ?? ''}
                    onChange={e => setOverrideText(sop, e.target.value)}
                    placeholder={`Override message, e.g. "We don't offer ${formatSopName(sop).toLowerCase()} services."`}
                    style={{
                      width: '100%', height: 32, padding: '0 10px', fontSize: 11,
                      fontFamily: T.font.sans, color: T.text.primary,
                      border: `1px solid ${T.border.default}`,
                      borderRadius: T.radius.sm, outline: 'none',
                      background: T.bg.primary, transition: 'border-color 0.15s',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(29,78,216,0.08)' }}
                    onBlur={e => { e.currentTarget.style.borderColor = T.border.default; e.currentTarget.style.boxShadow = 'none' }}
                  />
                  <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 4 }}>
                    When disabled, this text will be sent instead of the SOP response.
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Export
// ═════════════════════════════════════════════════════════════════════════════
export function ClassifierV5(): React.ReactElement {
  const [status, setStatus] = useState<{
    initialized: boolean; exampleCount: number; initDurationMs: number
    sopChunkCount: number; bakedInCount: number
  } | null>(null)
  const [evalStats, setEvalStats] = useState<{
    total: number; correct: number; incorrect: number; autoFixed: number; accuracyPercent: number
    totalJudgeCost: number; avgJudgeCost: number; totalInputTokens: number; totalOutputTokens: number
    avgSimRecent: number | null; avgSimPrev: number | null; recentSimCount: number
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

  useEffect(() => {
    loadStats()
    const id = setInterval(loadStats, 30000)
    return () => clearInterval(id)
  }, [loadStats])

  const accuracyColor = evalStats
    ? evalStats.accuracyPercent >= 90 ? T.status.green
    : evalStats.accuracyPercent >= 70 ? T.status.amber
    : T.status.red
    : undefined

  // ── Outer: scroll container fills the parent (flex:1 overflow:hidden) box ──
  return (
    <div
      className="cls-scroll"
      style={{
        height: '100%',
        overflowY: 'auto',
        background: T.bg.secondary,
        fontFamily: T.font.sans,
      }}
    >
      {/* ── Inner: natural-height column, never constrained by flex shrink ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 20px 32px' }}>

        {/* Stats bar */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
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
            icon={<CheckCircle size={16} color={accuracyColor ?? T.text.secondary} />}
            label="Retrieval Accuracy"
            value={evalStats ? `${evalStats.accuracyPercent}%` : '—'}
            valueColor={accuracyColor}
            sub={evalStats?.total ? `${evalStats.incorrect} incorrect` : undefined}
          />
          <MetricCard
            icon={<Wrench size={16} color={T.text.secondary} />}
            label="Auto-Fixed"
            value={evalStats ? String(evalStats.autoFixed) : '—'}
            sub={evalStats?.autoFixed ? 'examples added' : undefined}
          />
          <MetricCard
            icon={<DollarSign size={16} color={T.text.secondary} />}
            label="Judge Cost"
            value={evalStats ? fmtCost(evalStats.totalJudgeCost) : '—'}
            sub={evalStats?.total
              ? `avg ${fmtCost(evalStats.avgJudgeCost)}/eval · ${((evalStats.totalInputTokens + evalStats.totalOutputTokens) / 1000).toFixed(1)}k tok`
              : 'haiku-4-5'}
          />
          {(() => {
            const sim = evalStats?.avgSimRecent ?? null
            const prev = evalStats?.avgSimPrev ?? null
            const delta = sim !== null && prev !== null ? Math.round((sim - prev) * 1000) / 1000 : null
            const trendColor = delta === null ? undefined : delta > 0 ? T.status.green : delta < 0 ? T.status.red : T.text.tertiary
            const TrendIcon = delta !== null && delta > 0 ? TrendingUp : delta !== null && delta < 0 ? TrendingDown : Minus
            const n = evalStats?.recentSimCount ?? 0
            return (
              <MetricCard
                icon={<TrendIcon size={16} color={trendColor ?? T.text.secondary} />}
                label="Avg Confidence"
                value={sim !== null ? sim.toFixed(2) : '—'}
                valueColor={sim !== null ? simColor(sim) : undefined}
                sub={
                  sim === null ? 'judged evals' :
                  delta !== null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs prev ${n < 30 ? `${n} evals` : '30'}` :
                  `last ${n} eval${n !== 1 ? 's' : ''}`
                }
              />
            )
          })()}
        </div>

        {/* Status pill */}
        {status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: status.initialized ? T.status.green : T.status.amber,
              animation: status.initialized ? 'pulseGreen 2s ease-in-out infinite' : undefined,
            }} />
            <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary }}>
              {status.initialized
                ? `Classifier ready · ${status.exampleCount} examples · ${status.sopChunkCount} SOP chunks`
                : 'Classifier not initialized'}
            </span>
          </div>
        )}

        <ThresholdSettings />
        <BatchClassificationTest />
        <SOPConfigurationSection />
        <LiveTestSection />
        <EvaluationLogSection />
        <TrainingExamplesSection />
      </div>
    </div>
  )
}
