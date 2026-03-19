'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Activity, Zap, Brain, RefreshCw, ChevronDown, ChevronRight,
  Clock, DollarSign, AlertTriangle, CheckCircle2, XCircle, Minus,
  ArrowRight, Layers, Target, Shield, Sparkles, BarChart3, TrendingUp, Radio,
  Camera,
} from 'lucide-react'
import { apiFetchAccuracy, apiGenerateSnapshot, type AccuracyMetrics } from '../lib/api'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4', card: '#FFFFFF' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E', inverse: '#FFFFFF' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706', blue: '#2563EB' },
  border: { default: '#E7E5E4', strong: '#D6D3D1' },
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

// ─── Tier Colors ──────────────────────────────────────────────────────────────
const TIER_COLORS = {
  tier1:    { bg: '#DCFCE7', fg: '#15803D', label: 'Tier 1' },
  tier2_needed: { bg: '#FEF3C7', fg: '#D97706', label: 'Tier 2' },
  tier3_cache:  { bg: '#DBEAFE', fg: '#2563EB', label: 'Tier 3' },
  unknown:  { bg: '#F3F4F6', fg: '#6B7280', label: 'Unknown' },
} as const

const PURPLE = '#7C3AED'

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
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
`

const STYLE_ID = 'ai-pipeline-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = injectedStyles
  document.head.appendChild(style)
}

// ─── API ──────────────────────────────────────────────────────────────────────
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'
const headers = () => ({
  Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('gp_token') : ''}`,
  'Content-Type': 'application/json',
})

interface PipelineStats {
  period: string
  totalMessages: number
  tiers: {
    tier1: { count: number; pct: number }
    tier2: { count: number; pct: number }
    tier3: { count: number; pct: number }
    unknown: { count: number; pct: number }
  }
  cost: { total: number; avgPerMessage: number }
  latency: { avgMs: number }
  selfImprovement: { evaluationsRun: number; correctPct: number; autoFixed: number }
  escalationSignals: number
  tier2Service: { calls: number; successes: number; failures: number }
  topicCache: { size: number; conversationIds: string[] }
  classifier: { initialized: boolean; exampleCount: number; sopChunkCount: number }
}

interface PipelineFeedEntry {
  id: string
  timestamp: string
  conversationId: string | null
  agentName: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
  responseText: string
  error: string | null
  pipeline: {
    query: string
    tier: 'tier1' | 'tier2_needed' | 'tier3_cache' | 'unknown'
    topSimilarity: number | null
    // Tier 1
    classifierLabels: string[]
    classifierTopSim: number | null
    classifierMethod: string | null
    // Tier 3
    tier3Reinjected: boolean
    tier3TopicSwitch: boolean
    tier3ReinjectedLabels: string[]
    // Tier 2
    tier2Output: { topic: string; status: string; urgency: string; sops: string[] } | null
    // Other
    escalationSignals: string[]
    chunksRetrieved: number
    chunks: Array<{ category: string; similarity: number; sourceKey: string; isGlobal: boolean }>
    ragDurationMs: number
  }
  evaluation: {
    retrievalCorrect: boolean
    classifierLabels: string[]
    classifierTopSim: number
    classifierMethod: string
    judgeCorrectLabels: string[]
    judgeConfidence: string
    judgeReasoning: string
    autoFixed: boolean
    judgeCost: number
    skipReason: string | null
  } | null
}

async function fetchStats(): Promise<PipelineStats> {
  const res = await fetch(`${API_BASE}/api/ai-pipeline/stats`, { headers: headers() })
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`)
  return res.json()
}

async function fetchFeed(limit = 50, offset = 0): Promise<{ entries: PipelineFeedEntry[]; total: number }> {
  const res = await fetch(`${API_BASE}/api/ai-pipeline/feed?limit=${limit}&offset=${offset}`, { headers: headers() })
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`)
  const data = await res.json()
  // Backend returns { feed, total } — normalize to { entries, total }
  return { entries: data.feed || data.entries || [], total: data.total || 0 }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTime(iso: string): string {
  const d = new Date(iso)
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(5)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

function similarityColor(sim: number): string {
  if (sim >= 0.75) return T.status.green
  if (sim >= 0.5) return T.status.amber
  return T.status.red
}

function sopBadgeColor(category: string): { bg: string; fg: string } {
  if (category.startsWith('sop')) return { bg: '#DBEAFE', fg: '#2563EB' }
  if (category.startsWith('property')) return { bg: '#DCFCE7', fg: '#15803D' }
  if (category.startsWith('pricing') || category.startsWith('payment') || category.startsWith('post-stay'))
    return { bg: '#FEF3C7', fg: '#D97706' }
  if (category === 'non-actionable') return { bg: '#F3F4F6', fg: '#6B7280' }
  return { bg: '#F3E8FF', fg: PURPLE }
}

// ─── Skeleton Components ──────────────────────────────────────────────────────
function SkeletonCard(): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 140,
        height: 88,
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
        boxShadow: T.shadow.sm,
      }}
    />
  )
}

function SkeletonRow(): React.ReactElement {
  return (
    <div
      style={{
        height: 44,
        borderRadius: T.radius.sm,
        border: `1px solid ${T.border.default}`,
        background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
        marginBottom: 6,
      }}
    />
  )
}

function SkeletonFlowDiagram(): React.ReactElement {
  return (
    <div
      style={{
        height: 100,
        borderRadius: T.radius.md,
        border: `1px solid ${T.border.default}`,
        background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
        boxShadow: T.shadow.sm,
      }}
    />
  )
}

// ─── Section 1: Pipeline Health Bar ───────────────────────────────────────────
function HealthCard({ accentColor, icon, label, value, subValue, animIdx }: {
  accentColor: string
  icon: React.ReactNode
  label: string
  value: string
  subValue?: string
  animIdx: number
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: 1,
        minWidth: 140,
        background: T.bg.card,
        border: `1px solid ${T.border.default}`,
        borderRadius: T.radius.md,
        overflow: 'hidden',
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
        animation: 'fadeInUp 0.4s ease-out both',
        animationDelay: `${animIdx * 0.06}s`,
      }}
    >
      {/* Accent bar */}
      <div style={{ height: 4, background: accentColor }} />
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: T.radius.sm,
            background: `${accentColor}14`,
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
              marginBottom: 4,
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: 22,
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
                marginTop: 3,
              }}
            >
              {subValue}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Section 2: Flow Step Box ─────────────────────────────────────────────────
function FlowStep({ label, count, color, isActive }: {
  label: string
  count: number | string
  color: string
  isActive?: boolean
}): React.ReactElement {
  return (
    <div
      style={{
        background: T.bg.card,
        border: `1px solid ${T.border.default}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: T.radius.sm,
        padding: '8px 14px',
        minWidth: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        opacity: isActive === false ? 0.45 : 1,
        transition: 'opacity 0.2s ease',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: color,
          fontFamily: T.font.sans,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: T.text.primary,
          fontFamily: T.font.mono,
          lineHeight: 1.1,
        }}
      >
        {count}
      </span>
    </div>
  )
}

function FlowArrow({ label, color }: { label?: string; color?: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, minWidth: 40 }}>
      {label && (
        <span style={{ fontSize: 8, fontWeight: 500, color: color || T.text.tertiary, fontFamily: T.font.mono, whiteSpace: 'nowrap' }}>
          {label}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ width: 20, height: 1, background: color || T.border.strong }} />
        <ArrowRight size={12} color={color || T.border.strong} />
      </div>
    </div>
  )
}

// ─── Section 3: Similarity Bar ────────────────────────────────────────────────
function SimilarityBar({ score, width = 60 }: { score: number; width?: number }): React.ReactElement {
  const pct = Math.max(0, Math.min(100, score * 100))
  const color = similarityColor(score)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          width,
          height: 6,
          background: T.bg.tertiary,
          borderRadius: 3,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          fontFamily: T.font.mono,
          color,
          minWidth: 28,
        }}
      >
        {score.toFixed(2)}
      </span>
    </div>
  )
}

// ─── Section 3: Tier Badge ────────────────────────────────────────────────────
function TierBadge({ tier }: { tier: string }): React.ReactElement {
  const tc = TIER_COLORS[tier as keyof typeof TIER_COLORS] || TIER_COLORS.unknown
  return (
    <span
      style={{
        background: tc.bg,
        color: tc.fg,
        fontSize: 10,
        fontWeight: 600,
        fontFamily: T.font.sans,
        padding: '2px 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        border: `1px solid ${tc.fg}20`,
      }}
    >
      {tc.label}
    </span>
  )
}

// ─── Section 3: Timeline Step ─────────────────────────────────────────────────
function TimelineStep({ stepNum, title, color, dimmed, children }: {
  stepNum: number
  title: string
  color: string
  dimmed?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        opacity: dimmed ? 0.45 : 1,
        transition: 'opacity 0.2s ease',
      }}
    >
      {/* Step number + vertical line */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: `${color}18`,
            border: `2px solid ${color}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
            color,
            fontFamily: T.font.mono,
            flexShrink: 0,
          }}
        >
          {stepNum}
        </div>
        <div style={{ width: 1, flex: 1, minHeight: 8, borderLeft: `1px dashed ${T.border.default}`, marginTop: 4 }} />
      </div>
      {/* Content */}
      <div
        style={{
          flex: 1,
          borderLeft: `3px solid ${color}`,
          borderRadius: T.radius.sm,
          background: T.bg.card,
          border: `1px solid ${T.border.default}`,
          borderLeftWidth: 3,
          borderLeftStyle: 'solid',
          borderLeftColor: color,
          padding: '10px 14px',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.text.primary,
            fontFamily: T.font.sans,
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        {children}
      </div>
    </div>
  )
}

// ─── Text Box (code/preformatted) ─────────────────────────────────────────────
function TextBox({ content, maxHeight = 200 }: { content: string; maxHeight?: number }): React.ReactElement {
  return (
    <div
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
        maxHeight,
        overflowY: 'auto',
      }}
    >
      {content}
    </div>
  )
}

// ─── Meta Pill ────────────────────────────────────────────────────────────────
function MetaPill({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        fontFamily: T.font.mono,
        color: color || T.text.secondary,
        background: T.bg.secondary,
        border: `1px solid ${T.border.default}`,
        borderRadius: 999,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: T.text.tertiary }}>{label}</span>
      {value}
    </span>
  )
}

// ─── Feed Card (Collapsed + Expanded) ─────────────────────────────────────────
function FeedCard({ entry, index }: { entry: PipelineFeedEntry; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const p = entry.pipeline || { query: '', tier: 'unknown' as const, topSimilarity: null, classifierLabels: [] as string[], classifierTopSim: null as number | null, classifierMethod: null as string | null, tier3Reinjected: false, tier3TopicSwitch: false, tier3ReinjectedLabels: [] as string[], tier2Output: null as any, escalationSignals: [] as string[], chunksRetrieved: 0, chunks: [] as Array<{ category: string; similarity: number; sourceKey: string; isGlobal: boolean }>, ragDurationMs: 0 }
  const ev = entry.evaluation
  const hasError = !!entry.error
  const tierKey = (p.tier || 'unknown') as keyof typeof TIER_COLORS
  const tc = TIER_COLORS[tierKey] || TIER_COLORS.unknown

  // Judge verdict icon
  const JudgeIcon = ev
    ? ev.retrievalCorrect
      ? () => <CheckCircle2 size={14} color={T.status.green} />
      : () => <XCircle size={14} color={T.status.red} />
    : () => <Minus size={13} color={T.text.tertiary} />

  return (
    <div
      style={{
        borderRadius: T.radius.sm,
        border: `1px solid ${hasError ? 'rgba(220,38,38,0.2)' : T.border.default}`,
        marginBottom: 6,
        overflow: 'hidden',
        background: T.bg.card,
        fontFamily: T.font.sans,
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transition: 'box-shadow 0.2s ease',
        animation: 'fadeInUp 0.3s ease-out both',
        animationDelay: `${Math.min(index * 0.03, 0.5)}s`,
      }}
    >
      {/* ─── Collapsed row ─── */}
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
        {/* Timestamp */}
        <span
          style={{
            fontSize: 10,
            fontFamily: T.font.mono,
            color: T.text.tertiary,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            minWidth: 58,
          }}
        >
          {formatTime(entry.timestamp)}
        </span>

        {/* Guest message preview */}
        <span
          style={{
            fontSize: 11,
            color: T.text.primary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 80,
            fontWeight: 500,
          }}
        >
          {truncate(p.query || '(no query)', 60)}
        </span>

        {/* Tier badge */}
        <TierBadge tier={p.tier} />

        {/* Similarity */}
        {p.topSimilarity != null && (
          <SimilarityBar score={p.topSimilarity} width={40} />
        )}

        {/* SOP count */}
        <span
          style={{
            background: 'rgba(109,40,217,0.08)',
            color: PURPLE,
            border: '1px solid rgba(109,40,217,0.15)',
            borderRadius: 999,
            fontSize: 10,
            padding: '2px 7px',
            fontFamily: T.font.mono,
            fontWeight: 500,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {p.chunksRetrieved} SOP{p.chunksRetrieved !== 1 ? 's' : ''}
        </span>

        {/* Cost */}
        <span
          style={{
            fontSize: 10,
            fontFamily: T.font.mono,
            fontWeight: 600,
            color: entry.costUsd < 0.01 ? T.status.green : entry.costUsd < 0.05 ? T.status.amber : T.status.red,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {formatCost(entry.costUsd)}
        </span>

        {/* Judge verdict icon */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <JudgeIcon />
        </div>

        {/* Skip reason badge (T021) */}
        {ev?.skipReason && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              fontFamily: T.font.sans,
              background: '#FEF3C7',
              color: '#92400E',
              padding: '2px 6px',
              borderRadius: 999,
              whiteSpace: 'nowrap',
              border: '1px solid rgba(146,64,14,0.15)',
              flexShrink: 0,
            }}
          >
            Skipped: {ev.skipReason.replace(/_/g, ' ')}
          </span>
        )}

        {/* Expand chevron */}
        <div
          style={{
            flexShrink: 0,
            transition: 'transform 0.2s ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <ChevronRight size={14} color={T.text.tertiary} />
        </div>
      </div>

      {/* ─── Expanded view ─── */}
      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${T.border.default}`,
            padding: '16px 18px',
            animation: 'fadeInUp 0.2s ease-out both',
          }}
        >
          {/* Step 1: Message Received */}
          <TimelineStep stepNum={1} title="Message Received" color={T.text.secondary}>
            <TextBox content={p.query || '(empty)'} maxHeight={120} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <MetaPill label="time:" value={formatTime(entry.timestamp)} />
              <MetaPill label="agent:" value={entry.agentName} color={T.accent} />
              {entry.conversationId && (
                <MetaPill label="conv:" value={entry.conversationId.slice(0, 8) + '...'} color={T.accent} />
              )}
            </div>
          </TimelineStep>

          {/* Step 2: Tier 1 -- Embedding Classifier */}
          <TimelineStep
            stepNum={2}
            title="Tier 1 -- Embedding Classifier"
            color={TIER_COLORS.tier1.fg}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Method + classifier similarity */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {(p.classifierMethod || ev?.classifierMethod) && (
                  <MetaPill label="method:" value={p.classifierMethod || ev?.classifierMethod || ''} />
                )}
                {(p.classifierTopSim != null || ev?.classifierTopSim != null) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>classifier sim:</span>
                    <SimilarityBar score={p.classifierTopSim ?? ev?.classifierTopSim ?? 0} width={80} />
                  </div>
                )}
              </div>
              {/* Classifier labels */}
              {(() => {
                const labels = p.classifierLabels?.length > 0 ? p.classifierLabels : ev?.classifierLabels || []
                return labels.length > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>→ classified as:</span>
                    {labels.map((label: string, i: number) => {
                      const sc = sopBadgeColor(label)
                      return (
                        <span key={i} style={{ background: sc.bg, color: sc.fg, fontSize: 10, fontWeight: 600, fontFamily: T.font.sans, padding: '2px 8px', borderRadius: 999, border: `1px solid ${sc.fg}20` }}>
                          {label}
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>→ classified as:</span>
                    <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, fontStyle: 'italic' }}>no labels (contextual)</span>
                  </div>
                )
              })()}
              {/* Verdict */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {p.tier === 'tier1' ? (
                  <>
                    <CheckCircle2 size={13} color={T.status.green} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: T.status.green, fontFamily: T.font.sans }}>
                      Confident
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={13} color={T.status.amber} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: T.status.amber, fontFamily: T.font.sans }}>
                      Low confidence — routed to {p.tier === 'tier3_cache' ? 'Tier 3' : p.tier === 'tier2_needed' ? 'Tier 2' : 'fallback'}
                    </span>
                  </>
                )}
              </div>
            </div>
          </TimelineStep>

          {/* Step 3: Tier 3 -- Topic State Cache */}
          <TimelineStep
            stepNum={3}
            title="Tier 3 -- Topic State Cache"
            color={TIER_COLORS.tier3_cache.fg}
            dimmed={p.tier === 'tier1' && !p.tier3Reinjected}
          >
            {p.tier === 'tier1' && !p.tier3Reinjected && !p.tier3TopicSwitch ? (
              <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
                -- Skipped (Tier 1 confident)
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>re-injected:</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: p.tier3Reinjected ? T.status.green : T.text.tertiary, fontFamily: T.font.sans }}>
                    {p.tier3Reinjected ? 'Yes' : 'No'}
                  </span>
                </div>
                {p.tier3Reinjected && (p.tier3ReinjectedLabels || []).length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>→ re-injected SOPs:</span>
                    {(p.tier3ReinjectedLabels || []).map((label: string, i: number) => {
                      const sc = sopBadgeColor(label)
                      return (
                        <span key={i} style={{ background: sc.bg, color: sc.fg, fontSize: 10, fontWeight: 600, fontFamily: T.font.sans, padding: '2px 8px', borderRadius: 999, border: `1px solid ${sc.fg}20` }}>
                          {label}
                        </span>
                      )
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>topic switch:</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: p.tier3TopicSwitch ? T.status.amber : T.text.tertiary, fontFamily: T.font.sans }}>
                    {p.tier3TopicSwitch ? 'Yes' : 'No'}
                  </span>
                </div>
              </div>
            )}
          </TimelineStep>

          {/* Step 4: Tier 2 -- Intent Extractor */}
          <TimelineStep
            stepNum={4}
            title="Tier 2 -- Intent Extractor (Haiku)"
            color={TIER_COLORS.tier2_needed.fg}
            dimmed={p.tier !== 'tier2_needed' && !p.tier2Output}
          >
            {p.tier !== 'tier2_needed' && !p.tier2Output ? (
              <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
                -- Skipped ({p.tier === 'tier1' ? 'Tier 1 confident' : 'Tier 3 handled'})
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Zap size={13} color={T.status.amber} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: T.status.amber, fontFamily: T.font.sans }}>Fired</span>
                </div>
                {p.tier2Output && (
                  <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <MetaPill label="topic:" value={p.tier2Output.topic} />
                      <MetaPill label="status:" value={p.tier2Output.status} color={p.tier2Output.status === 'ongoing_issue' ? T.status.amber : p.tier2Output.status === 'follow_up' ? T.status.blue : undefined} />
                      <MetaPill label="urgency:" value={p.tier2Output.urgency} color={p.tier2Output.urgency === 'angry' ? T.status.red : p.tier2Output.urgency === 'frustrated' ? T.status.amber : p.tier2Output.urgency === 'emergency' ? T.status.red : undefined} />
                    </div>
                    {p.tier2Output.sops.length > 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>→ SOPs:</span>
                        {p.tier2Output.sops.map((s: string, i: number) => {
                          const sc = sopBadgeColor(s)
                          return (
                            <span key={i} style={{ background: sc.bg, color: sc.fg, fontSize: 10, fontWeight: 600, fontFamily: T.font.sans, padding: '2px 8px', borderRadius: 999, border: `1px solid ${sc.fg}20` }}>
                              {s}
                            </span>
                          )
                        })}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>→ SOPs: none (contextual)</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </TimelineStep>

          {/* Step 5: Escalation Signals */}
          <TimelineStep
            stepNum={5}
            title="Escalation Signals"
            color={T.status.red}
            dimmed={p.escalationSignals.length === 0}
          >
            {p.escalationSignals.length === 0 ? (
              <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
                No signals
              </span>
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {p.escalationSignals.map((sig, i) => (
                  <span
                    key={i}
                    style={{
                      background: 'rgba(220,38,38,0.08)',
                      color: T.status.red,
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontFamily: T.font.sans,
                      border: '1px solid rgba(220,38,38,0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <AlertTriangle size={10} />
                    {sig}
                  </span>
                ))}
              </div>
            )}
          </TimelineStep>

          {/* Step 6: SOPs Selected */}
          <TimelineStep stepNum={6} title="SOPs Selected" color={PURPLE}>
            {p.chunks.length === 0 ? (
              <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
                No chunks retrieved
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {p.chunks.map((chunk, ci) => {
                  const sc = sopBadgeColor(chunk.category)
                  return (
                    <div
                      key={ci}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px',
                        borderRadius: T.radius.sm,
                        background: ci % 2 === 0 ? T.bg.secondary : 'transparent',
                        fontSize: 11,
                      }}
                    >
                      <span
                        style={{
                          background: sc.bg,
                          color: sc.fg,
                          fontSize: 9,
                          fontWeight: 600,
                          fontFamily: T.font.sans,
                          padding: '1px 6px',
                          borderRadius: 999,
                          whiteSpace: 'nowrap',
                          border: `1px solid ${sc.fg}20`,
                        }}
                      >
                        {chunk.category}
                      </span>
                      <span
                        style={{
                          fontFamily: T.font.mono,
                          fontSize: 10,
                          color: T.text.secondary,
                          maxWidth: 140,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {chunk.sourceKey}
                      </span>
                      <SimilarityBar score={chunk.similarity} width={50} />
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: T.font.sans,
                          fontWeight: 500,
                          color: chunk.isGlobal ? PURPLE : T.text.tertiary,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {chunk.isGlobal ? 'SOP' : 'prop'}
                      </span>
                    </div>
                  )
                })}
                <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                  <MetaPill label="chunks:" value={String(p.chunksRetrieved)} color={PURPLE} />
                  <MetaPill label="RAG:" value={formatDuration(p.ragDurationMs)} />
                </div>
              </div>
            )}
          </TimelineStep>

          {/* Step 7: Omar's Response */}
          <TimelineStep stepNum={7} title="Omar's Response" color={T.accent}>
            <TextBox content={entry.responseText || '(empty response)'} maxHeight={200} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <MetaPill label="model:" value={entry.model} />
              <MetaPill label="in:" value={entry.inputTokens.toLocaleString()} />
              <MetaPill label="out:" value={entry.outputTokens.toLocaleString()} />
              <MetaPill label="cost:" value={formatCost(entry.costUsd)} color={entry.costUsd < 0.01 ? T.status.green : T.status.amber} />
              <MetaPill label="dur:" value={formatDuration(entry.durationMs)} color={entry.durationMs < 2000 ? T.status.green : T.status.amber} />
            </div>
            {entry.error && (
              <div
                style={{
                  marginTop: 8,
                  background: 'rgba(220,38,38,0.04)',
                  padding: 10,
                  borderRadius: T.radius.sm,
                  fontSize: 11,
                  fontFamily: T.font.mono,
                  color: T.status.red,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: '1px solid rgba(220,38,38,0.12)',
                  maxHeight: 100,
                  overflowY: 'auto',
                }}
              >
                {entry.error}
              </div>
            )}
          </TimelineStep>

          {/* Step 8: Self-Improvement */}
          <TimelineStep
            stepNum={8}
            title="Self-Improvement (Judge)"
            color={PURPLE}
            dimmed={!ev}
          >
            {!ev ? (
              <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.tertiary }}>
                Not evaluated (confidence was high enough)
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Judge verdict */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {ev.retrievalCorrect ? (
                    <>
                      <CheckCircle2 size={14} color={T.status.green} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: T.status.green, fontFamily: T.font.sans }}>
                        Correct
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle size={14} color={T.status.red} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: T.status.red, fontFamily: T.font.sans }}>
                        Incorrect
                      </span>
                    </>
                  )}
                  <span
                    style={{
                      background: ev.judgeConfidence === 'high' ? '#DCFCE7' : ev.judgeConfidence === 'medium' ? '#FEF3C7' : '#FEE2E2',
                      color: ev.judgeConfidence === 'high' ? T.status.green : ev.judgeConfidence === 'medium' ? T.status.amber : T.status.red,
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontFamily: T.font.sans,
                    }}
                  >
                    {ev.judgeConfidence} confidence
                  </span>
                </div>

                {/* Correct labels (if incorrect) */}
                {!ev.retrievalCorrect && ev.judgeCorrectLabels.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary }}>correct labels:</span>
                    {ev.judgeCorrectLabels.map((l, i) => {
                      const sc = sopBadgeColor(l)
                      return (
                        <span
                          key={i}
                          style={{
                            background: sc.bg,
                            color: sc.fg,
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontFamily: T.font.sans,
                            border: `1px solid ${sc.fg}20`,
                          }}
                        >
                          {l}
                        </span>
                      )
                    })}
                  </div>
                )}

                {/* Auto-fixed badge */}
                {ev.autoFixed && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Sparkles size={13} color={T.status.green} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: T.status.green, fontFamily: T.font.sans }}>
                      Auto-fixed
                    </span>
                  </div>
                )}

                {/* Reasoning */}
                {ev.judgeReasoning && (
                  <div style={{ marginTop: 2 }}>
                    <span style={{ fontSize: 10, fontFamily: T.font.mono, color: T.text.tertiary, display: 'block', marginBottom: 4 }}>
                      reasoning:
                    </span>
                    <div
                      style={{
                        background: T.bg.secondary,
                        padding: 8,
                        borderRadius: T.radius.sm,
                        fontSize: 11,
                        fontFamily: T.font.mono,
                        color: T.text.secondary,
                        lineHeight: 1.5,
                        border: `1px solid ${T.border.default}`,
                      }}
                    >
                      {ev.judgeReasoning}
                    </div>
                  </div>
                )}

                {/* Judge cost */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <MetaPill label="judge cost:" value={formatCost(ev.judgeCost)} />
                  <MetaPill label="classifier sim:" value={ev.classifierTopSim.toFixed(2)} />
                </div>
              </div>
            )}
          </TimelineStep>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AiPipelineV5(): React.ReactElement {
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [feed, setFeed] = useState<PipelineFeedEntry[]>([])
  const [feedTotal, setFeedTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [feedLoading, setFeedLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Accuracy metrics state (T009/T010/T011)
  const [accuracy, setAccuracy] = useState<AccuracyMetrics | null>(null)
  const [accuracyPeriod, setAccuracyPeriod] = useState<'7d' | '30d'>('30d')
  const [accuracyLoading, setAccuracyLoading] = useState(false)

  // Snapshot state (T026)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotMessage, setSnapshotMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => { ensureStyles() }, [])

  // Fetch accuracy metrics when period changes
  useEffect(() => {
    setAccuracyLoading(true)
    apiFetchAccuracy(accuracyPeriod)
      .then(data => setAccuracy(data))
      .catch(() => setAccuracy(null))
      .finally(() => setAccuracyLoading(false))
  }, [accuracyPeriod])

  const loadAll = useCallback(async (offset = 0) => {
    try {
      const [s, f] = await Promise.all([
        fetchStats().catch(() => null),
        fetchFeed(PAGE_SIZE, offset).catch(() => ({ entries: [], total: 0 })),
      ])
      if (s) setStats(s)
      setFeed(f.entries)
      setFeedTotal(f.total)
    } catch {
      // silently fail
    }
  }, [])

  const loadFeed = useCallback(async (offset = 0) => {
    setFeedLoading(true)
    try {
      const f = await fetchFeed(PAGE_SIZE, offset)
      setFeed(f.entries)
      setFeedTotal(f.total)
    } catch {
      // silent
    } finally {
      setFeedLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    setLoading(true)
    loadAll().finally(() => setLoading(false))
  }, [loadAll])

  // Auto-refresh
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
    if (!autoRefresh) return
    refreshTimerRef.current = setInterval(() => {
      loadAll(page * PAGE_SIZE)
    }, 30000)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [autoRefresh, loadAll, page])

  const totalPages = Math.ceil(feedTotal / PAGE_SIZE)

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: T.font.sans,
        background: T.bg.secondary,
        overflow: 'hidden',
      }}
    >
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* ─── Header + Controls ─── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: T.radius.md,
              background: `${T.accent}14`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Activity size={18} color={T.accent} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans, lineHeight: 1.2 }}>
              AI Pipeline Monitor
            </div>
            <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans, marginTop: 1 }}>
              Real-time routing flow and self-improvement tracking
            </div>
          </div>
        </div>

        {/* Section 4: Auto-Refresh + Manual Refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(v => !v)}
            style={{
              height: 32,
              padding: '0 12px',
              fontSize: 11,
              fontWeight: 600,
              border: `1px solid ${autoRefresh ? '#1C1917' : T.border.default}`,
              cursor: 'pointer',
              borderRadius: T.radius.sm,
              background: autoRefresh ? '#1C1917' : T.bg.card,
              color: autoRefresh ? '#FFFFFF' : T.text.secondary,
              fontFamily: T.font.sans,
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Radio size={11} style={autoRefresh ? { animation: 'pulse 2s infinite' } : undefined} />
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: autoRefresh ? '#4ADE80' : T.text.tertiary,
                transition: 'background 0.15s ease',
              }}
            />
            {autoRefresh ? '30s Auto' : 'Auto'}
          </button>

          {/* Manual refresh */}
          <button
            onClick={() => { setLoading(true); loadAll(page * PAGE_SIZE).finally(() => setLoading(false)) }}
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
              background: T.bg.card,
              color: T.text.secondary,
              fontFamily: T.font.sans,
              opacity: loading ? 0.6 : 1,
              transition: 'opacity 0.15s ease',
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

      {/* ─── Section 1: Pipeline Health Bar ─── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        {loading || !stats ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <HealthCard
              accentColor={T.accent}
              icon={<Activity size={15} color={T.accent} />}
              label="Messages (24h)"
              value={stats.totalMessages.toLocaleString()}
              subValue="routed"
              animIdx={0}
            />
            <HealthCard
              accentColor={TIER_COLORS.tier1.fg}
              icon={<Target size={15} color={TIER_COLORS.tier1.fg} />}
              label="Tier 1 (Classifier)"
              value={`${stats.tiers.tier1.pct}%`}
              subValue={`${stats.tiers.tier1.count} messages`}
              animIdx={1}
            />
            <HealthCard
              accentColor={TIER_COLORS.tier2_needed.fg}
              icon={<Zap size={15} color={TIER_COLORS.tier2_needed.fg} />}
              label="Tier 2 (Haiku)"
              value={`${stats.tiers.tier2.pct}%`}
              subValue={`${stats.tiers.tier2.count} messages`}
              animIdx={2}
            />
            <HealthCard
              accentColor={TIER_COLORS.tier3_cache.fg}
              icon={<Layers size={15} color={TIER_COLORS.tier3_cache.fg} />}
              label="Tier 3 (Cache)"
              value={`${stats.tiers.tier3.pct}%`}
              subValue={`${stats.tiers.tier3.count} messages`}
              animIdx={3}
            />
            <HealthCard
              accentColor={PURPLE}
              icon={<Sparkles size={15} color={PURPLE} />}
              label="Self-Improvements"
              value={String(stats.selfImprovement.autoFixed)}
              subValue={`of ${stats.selfImprovement.evaluationsRun} evaluated`}
              animIdx={4}
            />
            <HealthCard
              accentColor={T.status.green}
              icon={<DollarSign size={15} color={T.status.green} />}
              label="Avg Cost"
              value={formatCost(stats.cost.avgPerMessage)}
              subValue={`total: ${formatCost(stats.cost.total)}`}
              animIdx={5}
            />
          </>
        )}
      </div>

      {/* ─── T009: Accuracy Metrics + T026: Snapshot Button ─── */}
      <div
        style={{
          background: T.bg.card,
          border: `1px solid ${T.border.default}`,
          borderRadius: T.radius.md,
          boxShadow: T.shadow.sm,
          padding: '16px 20px',
          flexShrink: 0,
          animation: 'fadeInUp 0.4s ease-out both',
          animationDelay: '0.15s',
        }}
      >
        {/* Header row with period toggle + snapshot button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Target size={13} color={T.text.secondary} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: T.text.secondary,
                fontFamily: T.font.sans,
              }}
            >
              Classifier Accuracy
            </span>
            {/* Period toggle */}
            <div style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
              {(['7d', '30d'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setAccuracyPeriod(p)}
                  style={{
                    fontSize: 10,
                    fontWeight: accuracyPeriod === p ? 700 : 500,
                    fontFamily: T.font.mono,
                    padding: '2px 8px',
                    borderRadius: T.radius.sm,
                    border: `1px solid ${accuracyPeriod === p ? '#1C1917' : T.border.default}`,
                    background: accuracyPeriod === p ? '#1C1917' : T.bg.card,
                    color: accuracyPeriod === p ? '#FFFFFF' : T.text.secondary,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* T026: Snapshot button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {snapshotMessage && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: T.font.sans,
                  fontWeight: 500,
                  color: snapshotMessage.type === 'success' ? T.status.green : T.status.red,
                  animation: 'fadeInUp 0.2s ease-out both',
                }}
              >
                {snapshotMessage.text}
              </span>
            )}
            <button
              onClick={async () => {
                setSnapshotLoading(true)
                setSnapshotMessage(null)
                try {
                  await apiGenerateSnapshot()
                  setSnapshotMessage({ type: 'success', text: 'Snapshot generated successfully' })
                  setTimeout(() => setSnapshotMessage(null), 5000)
                } catch (err: any) {
                  setSnapshotMessage({ type: 'error', text: err.message || 'Snapshot failed' })
                  setTimeout(() => setSnapshotMessage(null), 5000)
                } finally {
                  setSnapshotLoading(false)
                }
              }}
              disabled={snapshotLoading}
              style={{
                height: 28,
                padding: '0 10px',
                fontSize: 10,
                fontWeight: 600,
                border: `1px solid ${T.border.default}`,
                cursor: snapshotLoading ? 'default' : 'pointer',
                borderRadius: T.radius.sm,
                background: T.bg.card,
                color: T.text.secondary,
                fontFamily: T.font.sans,
                opacity: snapshotLoading ? 0.6 : 1,
                transition: 'all 0.15s ease',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Camera
                size={11}
                style={snapshotLoading ? { animation: 'spin 1s linear infinite' } : undefined}
              />
              Generate Snapshot
            </button>
          </div>
        </div>

        {/* Accuracy cards row */}
        {accuracyLoading ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : accuracy ? (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {/* Card 1: Classifier Accuracy */}
              <div
                style={{
                  flex: 1,
                  minWidth: 160,
                  background: T.bg.secondary,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.md,
                  padding: '12px 16px',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 4 }}>
                  Classifier Accuracy
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: accuracy.overall.accuracy >= 0.8 ? T.status.green : accuracy.overall.accuracy >= 0.6 ? T.status.amber : T.status.red, fontFamily: T.font.sans, lineHeight: 1.1 }}>
                  {(accuracy.overall.accuracy * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 3 }}>
                  {accuracy.overall.correct}/{accuracy.overall.total} correct
                </div>
              </div>

              {/* Card 2: Empty Label Rate */}
              <div
                style={{
                  flex: 1,
                  minWidth: 160,
                  background: T.bg.secondary,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.md,
                  padding: '12px 16px',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 4 }}>
                  Empty Label Rate
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: accuracy.emptyLabelRate <= 0.1 ? T.status.green : accuracy.emptyLabelRate <= 0.25 ? T.status.amber : T.status.red, fontFamily: T.font.sans, lineHeight: 1.1 }}>
                  {(accuracy.emptyLabelRate * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 3 }}>
                  messages with no labels
                </div>
              </div>

              {/* Card 3: Judge Mode */}
              <div
                style={{
                  flex: 1,
                  minWidth: 160,
                  background: T.bg.secondary,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.md,
                  padding: '12px 16px',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 4 }}>
                  Judge Mode
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span
                    style={{
                      background: accuracy.judgeMode === 'evaluate_all' ? '#DCFCE7' : accuracy.judgeMode === 'sampling' ? '#DBEAFE' : '#F3F4F6',
                      color: accuracy.judgeMode === 'evaluate_all' ? T.status.green : accuracy.judgeMode === 'sampling' ? T.status.blue : T.text.secondary,
                      fontSize: 12,
                      fontWeight: 700,
                      fontFamily: T.font.sans,
                      padding: '4px 12px',
                      borderRadius: 999,
                      border: `1px solid ${accuracy.judgeMode === 'evaluate_all' ? 'rgba(21,128,61,0.2)' : accuracy.judgeMode === 'sampling' ? 'rgba(37,99,235,0.2)' : T.border.default}`,
                    }}
                  >
                    {accuracy.judgeMode}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono, marginTop: 6 }}>
                  period: {accuracy.period}
                </div>
              </div>
            </div>

            {/* T010: Per-category breakdown table */}
            {accuracy.perCategory.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans, marginBottom: 8 }}>
                  Per-Category Breakdown
                </div>
                <div
                  style={{
                    border: `1px solid ${T.border.default}`,
                    borderRadius: T.radius.sm,
                    overflow: 'hidden',
                  }}
                >
                  {/* Table header */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 70px 70px 80px',
                      padding: '6px 12px',
                      background: T.bg.secondary,
                      borderBottom: `1px solid ${T.border.default}`,
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: T.text.tertiary,
                      fontFamily: T.font.sans,
                    }}
                  >
                    <span>Category</span>
                    <span style={{ textAlign: 'center' }}>Correct</span>
                    <span style={{ textAlign: 'center' }}>Total</span>
                    <span style={{ textAlign: 'right' }}>Accuracy</span>
                  </div>
                  {/* Table rows — sorted worst first */}
                  {[...accuracy.perCategory]
                    .sort((a, b) => a.accuracy - b.accuracy)
                    .map((cat, i) => {
                      const sc = sopBadgeColor(cat.category)
                      return (
                        <div
                          key={cat.category}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 70px 70px 80px',
                            padding: '5px 12px',
                            background: i % 2 === 0 ? T.bg.card : T.bg.secondary,
                            borderBottom: i < accuracy.perCategory.length - 1 ? `1px solid ${T.border.default}` : 'none',
                            fontSize: 11,
                            fontFamily: T.font.sans,
                            alignItems: 'center',
                          }}
                        >
                          <span>
                            <span
                              style={{
                                background: sc.bg,
                                color: sc.fg,
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '1px 8px',
                                borderRadius: 999,
                                border: `1px solid ${sc.fg}20`,
                              }}
                            >
                              {cat.category}
                            </span>
                          </span>
                          <span style={{ textAlign: 'center', fontFamily: T.font.mono, fontSize: 10, color: T.text.secondary }}>
                            {cat.correct}
                          </span>
                          <span style={{ textAlign: 'center', fontFamily: T.font.mono, fontSize: 10, color: T.text.secondary }}>
                            {cat.total}
                          </span>
                          <span
                            style={{
                              textAlign: 'right',
                              fontFamily: T.font.mono,
                              fontSize: 11,
                              fontWeight: 700,
                              color: cat.accuracy < 0.6 ? T.status.red : cat.accuracy < 0.8 ? T.status.amber : T.status.green,
                            }}
                          >
                            {(cat.accuracy * 100).toFixed(1)}%
                          </span>
                        </div>
                      )
                    })}
                </div>
              </div>
            )}

            {/* T011: Self-improvement stats */}
            <div
              style={{
                display: 'flex',
                gap: 16,
                paddingTop: 12,
                borderTop: `1px solid ${T.border.default}`,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={12} color={PURPLE} />
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.text.tertiary, fontFamily: T.font.sans }}>
                  Self-Improvement
                </span>
              </div>
              <MetaPill label="active examples:" value={String(accuracy.selfImprovement.totalActive)} color={PURPLE} />
              <MetaPill label="added this period:" value={String(accuracy.selfImprovement.addedThisPeriod)} color={T.status.green} />
              {Object.entries(accuracy.selfImprovement.bySource).map(([source, count]) => (
                <MetaPill key={source} label={`${source}:`} value={String(count)} />
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono, textAlign: 'center', padding: '16px 0' }}>
            No accuracy data available
          </div>
        )}
      </div>

      {/* ─── Section 2: Tier Flow Visualization ─── */}
      {loading || !stats ? (
        <SkeletonFlowDiagram />
      ) : (
        <div
          style={{
            background: T.bg.card,
            border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.md,
            boxShadow: T.shadow.sm,
            padding: '16px 20px',
            overflow: 'auto',
            flexShrink: 0,
            animation: 'fadeInUp 0.4s ease-out both',
            animationDelay: '0.2s',
          }}
        >
          {/* Section header */}
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: T.text.secondary,
              fontFamily: T.font.sans,
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <TrendingUp size={13} color={T.text.secondary} />
            Routing Flow
          </div>

          {/* Main flow row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 0,
              overflowX: 'auto',
              paddingBottom: 4,
            }}
          >
            {/* Message In */}
            <FlowStep
              label="Message In"
              count={stats.totalMessages}
              color={T.text.secondary}
            />
            <FlowArrow />

            {/* KNN Classifier */}
            <FlowStep
              label="Tier 1: KNN"
              count={stats.tiers.tier1.count}
              color={TIER_COLORS.tier1.fg}
              isActive={stats.tiers.tier1.count > 0}
            />

            {/* Branch arrow: confident path */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', minWidth: 80 }}>
              {/* Top path: confident */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ width: 30, height: 1, background: TIER_COLORS.tier1.fg }} />
                <span style={{ fontSize: 8, fontFamily: T.font.mono, color: TIER_COLORS.tier1.fg, whiteSpace: 'nowrap', padding: '0 4px' }}>
                  {stats.tiers.tier1.pct}%
                </span>
                <ArrowRight size={10} color={TIER_COLORS.tier1.fg} />
              </div>
              {/* Bottom path: low confidence */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ width: 30, height: 1, background: T.status.amber, opacity: 0.5 }} />
                <span style={{ fontSize: 8, fontFamily: T.font.mono, color: T.status.amber, whiteSpace: 'nowrap', padding: '0 4px' }}>
                  {100 - stats.tiers.tier1.pct}%
                </span>
                <ArrowRight size={10} color={T.status.amber} />
              </div>
            </div>

            {/* Two-path area */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Top: SOPs direct */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <FlowStep
                  label="SOPs"
                  count={stats.classifier.sopChunkCount}
                  color={PURPLE}
                />
                <FlowArrow />
                <FlowStep
                  label="Omar (Sonnet)"
                  count={stats.totalMessages}
                  color={T.accent}
                />
              </div>

              {/* Bottom: Tier 3 / Tier 2 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <FlowStep
                  label="Tier 3: Cache"
                  count={stats.tiers.tier3.count}
                  color={TIER_COLORS.tier3_cache.fg}
                  isActive={stats.tiers.tier3.count > 0}
                />
                <FlowArrow label="miss" color={T.status.amber} />
                <FlowStep
                  label="Tier 2: Haiku"
                  count={stats.tiers.tier2.count}
                  color={TIER_COLORS.tier2_needed.fg}
                  isActive={stats.tiers.tier2.count > 0}
                />
              </div>
            </div>

            {/* Final: Judge */}
            <FlowArrow />
            <FlowStep
              label="Judge"
              count={stats.selfImprovement.evaluationsRun}
              color={PURPLE}
              isActive={stats.selfImprovement.evaluationsRun > 0}
            />

            {/* Self-fix */}
            {stats.selfImprovement.autoFixed > 0 && (
              <>
                <FlowArrow label="fix" color={T.status.green} />
                <FlowStep
                  label="Self-Fix"
                  count={stats.selfImprovement.autoFixed}
                  color={T.status.green}
                />
              </>
            )}
          </div>

          {/* Extra stats row */}
          <div
            style={{
              display: 'flex',
              gap: 16,
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${T.border.default}`,
              flexWrap: 'wrap',
            }}
          >
            <MetaPill label="classifier:" value={stats.classifier.initialized ? 'ready' : 'not initialized'} color={stats.classifier.initialized ? T.status.green : T.status.red} />
            <MetaPill label="examples:" value={String(stats.classifier.exampleCount)} />
            <MetaPill label="SOP chunks:" value={String(stats.classifier.sopChunkCount)} />
            <MetaPill label="escalations:" value={String(stats.escalationSignals)} color={stats.escalationSignals > 0 ? T.status.red : T.text.tertiary} />
            <MetaPill label="avg latency:" value={formatDuration(stats.latency.avgMs)} />
            <MetaPill label="topic cache:" value={`${stats.topicCache.size} convs`} />
            <MetaPill label="tier2 calls:" value={`${stats.tier2Service.successes}/${stats.tier2Service.calls}`} color={stats.tier2Service.failures > 0 ? T.status.red : T.status.green} />
            <MetaPill label="judge correct:" value={`${stats.selfImprovement.correctPct}%`} color={stats.selfImprovement.correctPct >= 80 ? T.status.green : T.status.amber} />
          </div>
        </div>
      )}

      {/* ─── Section 3: Live Pipeline Feed ─── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: T.bg.card,
          borderRadius: T.radius.md,
          border: `1px solid ${T.border.default}`,
          boxShadow: T.shadow.sm,
          animation: 'scaleIn 0.3s ease-out both',
          animationDelay: '0.15s',
          minHeight: 300,
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            padding: '10px 20px',
            borderBottom: `1px solid ${T.border.default}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
            background: T.bg.secondary,
          }}
        >
          <BarChart3 size={14} color={T.text.secondary} />
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: T.text.secondary,
              fontFamily: T.font.sans,
            }}
          >
            Live Pipeline Feed
          </span>
          <span
            style={{
              fontSize: 10,
              color: T.text.tertiary,
              fontFamily: T.font.mono,
            }}
          >
            {feedTotal} {feedTotal === 1 ? 'entry' : 'entries'}
          </span>

          {/* Legend row */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {[
              { short: 'T1', color: TIER_COLORS.tier1.fg },
              { short: 'T2', color: TIER_COLORS.tier2_needed.fg },
              { short: 'T3', color: TIER_COLORS.tier3_cache.fg },
            ].map(({ short, color }) => (
              <div key={short} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: T.font.sans, color: T.text.secondary }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                {short}
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: T.font.sans, color: T.text.secondary }}>
              <CheckCircle2 size={10} color={T.status.green} />
              OK
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: T.font.sans, color: T.text.secondary }}>
              <XCircle size={10} color={T.status.red} />
              Fix
            </div>
          </div>
        </div>

        {/* Feed list */}
        <div
          style={{
            padding: '12px 16px',
          }}
        >
          {loading ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : feed.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 8,
                animation: 'fadeInUp 0.3s ease-out both',
                minHeight: 200,
              }}
            >
              <Brain size={28} color={T.text.tertiary} />
              <span
                style={{
                  fontSize: 14,
                  color: T.text.tertiary,
                  fontFamily: T.font.sans,
                  fontWeight: 500,
                }}
              >
                No pipeline data yet
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: T.text.tertiary,
                  fontFamily: T.font.mono,
                }}
              >
                Pipeline entries will appear here when AI processes messages
              </span>
            </div>
          ) : (
            feed.map((entry, i) => (
              <FeedCard key={entry.id} entry={entry} index={i} />
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
              onClick={() => { const p = Math.max(0, page - 1); setPage(p); loadFeed(p * PAGE_SIZE) }}
              disabled={page === 0}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '4px 12px',
                borderRadius: T.radius.sm,
                border: `1px solid ${T.border.default}`,
                background: T.bg.card,
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
                  onClick={() => { setPage(pageNum); loadFeed(pageNum * PAGE_SIZE) }}
                  style={{
                    width: 28,
                    height: 28,
                    fontSize: 11,
                    fontWeight: isActive ? 700 : 400,
                    borderRadius: T.radius.sm,
                    border: isActive ? '1px solid #1C1917' : '1px solid transparent',
                    background: isActive ? '#1C1917' : 'transparent',
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
              onClick={() => { const p = Math.min(totalPages - 1, page + 1); setPage(p); loadFeed(p * PAGE_SIZE) }}
              disabled={page >= totalPages - 1}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '4px 12px',
                borderRadius: T.radius.sm,
                border: `1px solid ${T.border.default}`,
                background: T.bg.card,
                cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                opacity: page >= totalPages - 1 ? 0.4 : 1,
                fontFamily: T.font.sans,
                color: T.text.secondary,
                transition: 'opacity 0.15s ease',
              }}
            >
              Next
            </button>

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
    </div>
  )
}
