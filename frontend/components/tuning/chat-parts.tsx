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
 *
 * Sprint 07 refresh: tool chips get a CSS-only spinner that fades to a
 * checkmark on completion, the thinking section animates its height
 * rather than pop-showing the content, and the suggestion card picks up
 * a PR-review-card silhouette (sunken header + rationale + footer).
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Sparkles, X } from 'lucide-react'
import { TUNING_COLORS, categoryStyle } from '../studio/tokens'
import { DiffViewer } from './diff-viewer'
import type {
  TuningApplyMode,
  TuningDiagnosticCategory,
} from '@/lib/api'

export function TextPart({
  text,
  inverted,
}: {
  text: string
  inverted?: boolean
}) {
  return (
    <div
      className="whitespace-pre-wrap text-sm leading-relaxed"
      style={{ color: inverted ? '#FFFFFF' : TUNING_COLORS.ink }}
    >
      {text}
    </div>
  )
}

export function ThinkingSection({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const innerRef = useRef<HTMLDivElement>(null)
  const [maxH, setMaxH] = useState<number>(0)

  useEffect(() => {
    if (!innerRef.current) return
    // Recompute natural height on open + content change.
    setMaxH(open ? innerRef.current.scrollHeight : 0)
  }, [open, text])

  if (!text) return null
  return (
    <div
      className="mt-3 overflow-hidden rounded-lg border-l-2"
      style={{
        borderLeftColor: TUNING_COLORS.accentMuted,
        background: TUNING_COLORS.surfaceSunken,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-[#6B7280] transition-colors duration-150 hover:text-[#1A1A1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-inset"
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          className="transition-transform duration-200"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span>Reasoning</span>
      </button>
      <div
        className="overflow-hidden transition-[max-height] duration-300 ease-in-out motion-reduce:transition-none"
        style={{ maxHeight: maxH }}
        aria-hidden={!open}
      >
        <div
          ref={innerRef}
          className="whitespace-pre-wrap px-3 pb-3 font-mono text-xs leading-5 text-[#6B7280]"
        >
          {text}
        </div>
      </div>
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
  const short = toolName.replace(/^mcp__tuning-agent__/, '').replace(/_/g, ' ')
  const isRunning = state === 'input-available' || state === 'input-start'
  const isError = state === 'output-error'
  const isDone = state === 'output-available'
  return (
    <span
      className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200"
      style={{
        background: isError
          ? TUNING_COLORS.dangerBg
          : isDone
            ? '#ECFDF5'
            : TUNING_COLORS.surfaceSunken,
        color: isError
          ? TUNING_COLORS.dangerFg
          : isDone
            ? TUNING_COLORS.successFg
            : TUNING_COLORS.inkMuted,
      }}
      title={
        // compact preview tooltip for debug; truncated for sanity
        [
          input ? `input: ${JSON.stringify(input).slice(0, 200)}` : null,
          output ? `output: ${JSON.stringify(output).slice(0, 200)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      }
    >
      {isRunning ? (
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
        />
      ) : isError ? (
        <X size={12} strokeWidth={2.25} aria-hidden />
      ) : (
        <Check size={12} strokeWidth={2.25} aria-hidden />
      )}
      <span className="truncate">{short}</span>
    </span>
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
  const [acted, setActed] = useState<'apply' | 'queue' | 'reject' | 'edit' | null>(null)
  const [expanded, setExpanded] = useState(false)

  const ACTION_LABELS: Record<string, string> = {
    apply: 'Applied',
    queue: 'Queued',
    reject: 'Dismissed',
    edit: 'Sent for editing',
  }

  function handleAction(action: 'apply' | 'queue' | 'reject' | 'edit') {
    setActed(action)
    onAction?.(action)
  }

  // Collapsed one-liner after the user has acted.
  if (acted && !expanded) {
    return (
      <article
        className="w-full max-w-full overflow-hidden rounded-lg bg-white transition-all duration-300"
        style={{ border: `1px solid ${TUNING_COLORS.hairlineSoft}` }}
      >
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-[#F9FAFB]"
        >
          <Sparkles size={12} strokeWidth={2} className="shrink-0 text-[#9CA3AF]" aria-hidden />
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: style.bg, color: style.fg }}
          >
            {style.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-[#6B7280]">
            {data.rationale.slice(0, 80)}{data.rationale.length > 80 ? '…' : ''}
          </span>
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-[#9CA3AF]"
            style={{ background: TUNING_COLORS.surfaceSunken }}
          >
            {ACTION_LABELS[acted] ?? acted}
          </span>
          <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-[#9CA3AF]" aria-hidden />
        </button>
      </article>
    )
  }

  return (
    <article
      className="w-full max-w-full overflow-hidden rounded-lg bg-white shadow-sm transition-shadow duration-200 hover:shadow-md"
      style={{ border: `1px solid ${TUNING_COLORS.hairlineSoft}` }}
    >
      <header
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: TUNING_COLORS.surfaceSunken,
        }}
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6B7280]">
          <Sparkles size={12} strokeWidth={2} aria-hidden />
          <span>Suggestion preview</span>
        </span>
        <span
          aria-hidden
          className="h-3 w-px"
          style={{ background: TUNING_COLORS.hairline }}
        />
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ background: style.bg, color: style.fg }}
        >
          {style.label}
        </span>
        {data.subLabel ? (
          <span className="text-xs text-[#9CA3AF]">
            {data.subLabel.replace(/[-_]/g, ' ')}
          </span>
        ) : null}
        {confPct !== null ? (
          <span className="ml-auto font-mono text-xs text-[#6B7280]">
            {confPct}% confidence
          </span>
        ) : null}
      </header>

      <div className="space-y-3 px-3 py-3">
        <p className="text-[13px] leading-5 text-[#1A1A1A]">{data.rationale}</p>
        {data.beforeText || data.proposedText ? (
          <DiffViewer
            before={data.beforeText ?? ''}
            after={data.proposedText ?? ''}
          />
        ) : null}
      </div>

      <footer
        className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2"
        style={{ borderColor: TUNING_COLORS.hairlineSoft }}
      >
        <button
          type="button"
          onClick={() => handleAction('apply')}
          className="inline-flex items-center justify-center rounded-lg bg-[#6C5CE7] px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-all duration-200 hover:bg-[#5B4CDB] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
        >
          Apply now
        </button>
        <button
          type="button"
          onClick={() => handleAction('queue')}
          className="inline-flex items-center justify-center rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#1A1A1A] transition-colors duration-200 hover:bg-[#F3F4F6]"
        >
          Queue
        </button>
        <button
          type="button"
          onClick={() => handleAction('edit')}
          className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A]"
        >
          Edit
        </button>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => handleAction('reject')}
          className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium text-[#6B7280] transition-all duration-200 hover:bg-[#FEF2F2] hover:text-[#B91C1C]"
        >
          Dismiss
        </button>
      </footer>
    </article>
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
      className="w-full rounded-lg p-4"
      style={{ background: TUNING_COLORS.surfaceSunken }}
    >
      <div className="text-xs font-semibold text-[#6B7280]">Evidence</div>
      <dl className="mt-2 space-y-1.5 text-sm text-[#1A1A1A]">
        {data.disputedMessage?.contentExcerpt ? (
          <EvidenceRow label="Disputed">
            <span className="italic">&ldquo;{data.disputedMessage.contentExcerpt}&rdquo;</span>
          </EvidenceRow>
        ) : null}
        {data.disputedMessage?.originalAiText &&
        data.disputedMessage.originalAiText !== data.disputedMessage.contentExcerpt ? (
          <EvidenceRow label="Original AI">
            <span>&ldquo;{data.disputedMessage.originalAiText}&rdquo;</span>
          </EvidenceRow>
        ) : null}
        {data.hostaway?.propertyName ? (
          <EvidenceRow label="Property">
            {data.hostaway.propertyName}
            {data.hostaway.reservationStatus ? ` · ${data.hostaway.reservationStatus}` : ''}
          </EvidenceRow>
        ) : null}
        {classifier ? <EvidenceRow label="Classifier">{classifier}</EvidenceRow> : null}
        {data.sopsInEffect && data.sopsInEffect.length > 0 ? (
          <EvidenceRow label="SOPs">
            {data.sopsInEffect
              .map((s) => `${s.category}(${s.status}${s.hasOverride ? '·override' : ''})`)
              .join(', ')}
          </EvidenceRow>
        ) : null}
      </dl>
    </div>
  )
}

function EvidenceRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-xs font-medium text-[#9CA3AF] sm:w-24">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-[#1A1A1A]">{children}</dd>
    </div>
  )
}

export function FollowUpPart({ suggestion }: { suggestion: string }) {
  return (
    <p className="pl-3 text-xs italic text-[#9CA3AF]">{suggestion}</p>
  )
}

export function AgentDisabledCard({ reason }: { reason: string }) {
  return (
    <div
      className="flex w-full items-start gap-3 rounded-xl border p-4"
      style={{
        background: TUNING_COLORS.warnBg,
        borderColor: '#FDE68A',
        color: TUNING_COLORS.warnFg,
      }}
    >
      <AlertTriangle
        size={16}
        strokeWidth={2}
        className="mt-0.5 shrink-0"
        aria-hidden
      />
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold">Tuning chat disabled</div>
        <p className="text-sm leading-5">
          {reason === 'ANTHROPIC_API_KEY missing'
            ? 'Set ANTHROPIC_API_KEY on the backend to enable chat. The queue and dashboards still work.'
            : reason}
        </p>
      </div>
    </div>
  )
}

// Re-export apply-mode labels for UI code that needs them.
export const APPLY_MODE_LABELS: Record<TuningApplyMode, string> = {
  IMMEDIATE: 'Apply now',
  QUEUED: 'Queue',
}
