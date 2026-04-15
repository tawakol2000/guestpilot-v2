'use client'
/**
 * Feature 041 sprint 04 — chat-part renderers.
 *
 * Each UIMessage has a `parts: Array<{ type, ... }>` field from the Vercel
 * AI SDK. We render each part through a dedicated component:
 *
 *   - text → <TextPart>
 *   - reasoning → <ThinkingSection> (collapsible)
 *   - tool-<name> → <ToolCallPart> (quiet chip)
 *   - data-suggestion-preview → <SuggestionCard>
 *   - data-evidence-inline → <EvidenceInline>
 *   - data-follow-up → <FollowUpPart> (transient)
 *   - data-agent-disabled → <AgentDisabledCard>
 */

import { useState } from 'react'
import { TUNING_COLORS, categoryStyle } from './tokens'
import { DiffViewer } from './diff-viewer'
import type {
  TuningApplyMode,
  TuningDiagnosticCategory,
} from '@/lib/api'

export function TextPart({ text }: { text: string }) {
  return (
    <div
      className="whitespace-pre-wrap text-[15px] leading-relaxed"
      style={{ color: TUNING_COLORS.ink }}
    >
      {text}
    </div>
  )
}

export function ThinkingSection({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div
      className="rounded border"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: TUNING_COLORS.surfaceSunken,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-1.5 text-left text-[11px] uppercase tracking-[0.14em]"
        style={{ color: TUNING_COLORS.inkMuted }}
      >
        {open ? '▾ Reasoning' : '▸ Reasoning'}
      </button>
      {open ? (
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-[12px] leading-5"
          style={{ color: TUNING_COLORS.inkMuted }}
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}

export function ToolCallPart({
  toolName,
  input,
  output,
  state,
}: {
  toolName: string
  input?: unknown
  output?: unknown
  state: 'input-available' | 'output-available' | 'output-error' | 'input-start'
}) {
  const short = toolName.replace(/^mcp__tuning-agent__/, '')
  return (
    <div
      className="flex items-center gap-2 rounded-md border px-2 py-1 text-[11px]"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: TUNING_COLORS.surfaceSunken,
        color: TUNING_COLORS.inkMuted,
      }}
      title={JSON.stringify({ input, output }).slice(0, 300)}
    >
      <span className="font-mono">⚙ {short}</span>
      <span className="ml-auto text-[10px] uppercase tracking-[0.14em]">
        {state === 'output-available' ? 'done' : state === 'output-error' ? 'error' : 'running…'}
      </span>
    </div>
  )
}

export interface SuggestionPreviewData {
  previewId: string
  category: TuningDiagnosticCategory
  subLabel: string
  rationale: string
  confidence: number | null
  proposedText: string | null
  beforeText: string | null
  targetHint: Record<string, unknown> | null
  createdAt: string
}

/**
 * Renders the agent's inline suggestion-preview. The action buttons post
 * a follow-up user message that the agent reads + then calls
 * suggestion_action on. (V1: no direct accept endpoint — the manager
 * speaks and the agent persists.)
 */
export function SuggestionCard({
  data,
  onAction,
}: {
  data: SuggestionPreviewData
  onAction?: (action: 'apply' | 'queue' | 'reject' | 'edit') => void
}) {
  const style = categoryStyle(data.category)
  const confPct =
    typeof data.confidence === 'number' ? Math.round(data.confidence * 100) : null
  return (
    <article
      className="rounded-lg border p-4 shadow-sm"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: TUNING_COLORS.surfaceRaised,
      }}
    >
      <header className="flex items-center gap-2">
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: style.bg, color: style.fg }}
        >
          {style.label}
        </span>
        {data.subLabel ? (
          <span
            className="text-[11px] uppercase tracking-[0.14em]"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            {data.subLabel}
          </span>
        ) : null}
        {confPct !== null ? (
          <span
            className="ml-auto font-mono text-[11px]"
            style={{ color: TUNING_COLORS.inkMuted }}
          >
            conf {confPct}%
          </span>
        ) : null}
      </header>
      <p
        className="mt-3 text-[14px] leading-6"
        style={{ color: TUNING_COLORS.ink }}
      >
        {data.rationale}
      </p>
      {data.beforeText || data.proposedText ? (
        <div className="mt-3">
          <DiffViewer before={data.beforeText ?? ''} after={data.proposedText ?? ''} />
        </div>
      ) : null}
      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton label="Apply now" onClick={() => onAction?.('apply')} primary />
        <ActionButton label="Queue" onClick={() => onAction?.('queue')} />
        <ActionButton label="Edit" onClick={() => onAction?.('edit')} />
        <ActionButton label="Reject" onClick={() => onAction?.('reject')} subtle />
      </footer>
    </article>
  )
}

function ActionButton({
  label,
  onClick,
  primary,
  subtle,
}: {
  label: string
  onClick: () => void
  primary?: boolean
  subtle?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-3 py-1 text-[12px] font-medium transition-colors"
      style={{
        background: primary
          ? TUNING_COLORS.accent
          : subtle
          ? 'transparent'
          : TUNING_COLORS.surfaceSunken,
        color: primary ? '#FFFFFF' : subtle ? TUNING_COLORS.inkMuted : TUNING_COLORS.ink,
        border: `1px solid ${primary ? TUNING_COLORS.accent : TUNING_COLORS.hairline}`,
      }}
    >
      {label}
    </button>
  )
}

export interface EvidenceInlineData {
  trigger?: { triggerType?: string; messageId?: string } | null
  disputedMessage?: {
    contentExcerpt?: string
    originalAiText?: string | null
    editedByUserId?: string | null
    role?: string
  } | null
  hostaway?: { propertyName?: string | null; reservationStatus?: string | null } | null
  mainAiTrace?: {
    model?: string | null
    tokens?: unknown
    classifier?: { categories?: string[] } | null
  } | null
  sopsInEffect?: Array<{ category: string; status: string; hasOverride: boolean }>
  branchTags?: string[]
}

export function EvidenceInline({ data }: { data: EvidenceInlineData }) {
  const classifier = data.mainAiTrace?.classifier?.categories?.join(', ')
  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceSunken }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.14em]"
        style={{ color: TUNING_COLORS.inkMuted }}
      >
        Evidence
      </div>
      <div className="mt-2 space-y-2 text-[13px]" style={{ color: TUNING_COLORS.ink }}>
        {data.disputedMessage?.contentExcerpt ? (
          <div>
            <span className="font-mono text-[11px]" style={{ color: TUNING_COLORS.inkSubtle }}>
              disputed:
            </span>{' '}
            <span className="italic">"{data.disputedMessage.contentExcerpt}"</span>
          </div>
        ) : null}
        {data.disputedMessage?.originalAiText &&
        data.disputedMessage.originalAiText !== data.disputedMessage.contentExcerpt ? (
          <div>
            <span className="font-mono text-[11px]" style={{ color: TUNING_COLORS.inkSubtle }}>
              original AI:
            </span>{' '}
            <span>"{data.disputedMessage.originalAiText}"</span>
          </div>
        ) : null}
        {data.hostaway?.propertyName ? (
          <div>
            <span className="font-mono text-[11px]" style={{ color: TUNING_COLORS.inkSubtle }}>
              property:
            </span>{' '}
            {data.hostaway.propertyName}
            {data.hostaway.reservationStatus ? ` · ${data.hostaway.reservationStatus}` : ''}
          </div>
        ) : null}
        {classifier ? (
          <div>
            <span className="font-mono text-[11px]" style={{ color: TUNING_COLORS.inkSubtle }}>
              classifier:
            </span>{' '}
            {classifier}
          </div>
        ) : null}
        {data.sopsInEffect && data.sopsInEffect.length > 0 ? (
          <div>
            <span className="font-mono text-[11px]" style={{ color: TUNING_COLORS.inkSubtle }}>
              SOPs:
            </span>{' '}
            {data.sopsInEffect
              .map((s) => `${s.category}(${s.status}${s.hasOverride ? '·override' : ''})`)
              .join(', ')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function FollowUpPart({ suggestion }: { suggestion: string }) {
  return (
    <p
      className="text-[12px] italic"
      style={{ color: TUNING_COLORS.inkSubtle }}
    >
      {suggestion}
    </p>
  )
}

export function AgentDisabledCard({ reason }: { reason: string }) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: TUNING_COLORS.warnBg,
        color: TUNING_COLORS.warnFg,
      }}
    >
      <div className="text-[11px] uppercase tracking-[0.14em]">Tuning chat disabled</div>
      <p className="mt-1 text-[13px]">
        {reason === 'ANTHROPIC_API_KEY missing'
          ? 'Set ANTHROPIC_API_KEY on the backend to enable chat. The queue and dashboards still work.'
          : reason}
      </p>
    </div>
  )
}

// Re-export apply-mode labels for UI code that needs them.
export const APPLY_MODE_LABELS: Record<TuningApplyMode, string> = {
  IMMEDIATE: 'Apply now',
  QUEUED: 'Queue',
}
