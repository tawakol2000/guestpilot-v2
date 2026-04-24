'use client'

// Sprint 046 — Studio design overhaul (plan T028 + FR-033).
//
// Preview tab. Top-to-bottom:
//   1. REPLY AGENT PREVIEW eyebrow + model + `draft` env tag
//   2. Inline single-line input + "Send test" button
//   3. Preview conversation area (guest bubble right / agent bubble left)
//      with inline code-pill rendering for backtick-wrapped tokens
//   4. LATENCY BUDGET 3-card row with amber warn threshold state
//      (reply > 2s, cost > $0.01)

import { useState } from 'react'
import type { FormEvent } from 'react'
import { STUDIO_TOKENS_V2 } from '../tokens'
import { useStudioShell } from '../studio-shell-context'
import { PlayIcon } from '../icons'
import { renderInlineCodePills } from '../utils/render-code-pills'
import type { TestPipelineResultData } from '@/lib/build-api'

const DRAFT_MODEL_LABEL = 'GPT-5.4-mini · draft'
const REPLY_WARN_SECONDS = 2
const COST_WARN_USD = 0.01

export function PreviewTab() {
  const shell = useStudioShell()
  const [localInput, setLocalInput] = useState('')

  const { previewInput, runPreview } = shell
  const { lastResult, isSending, lastError } = previewInput

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const text = localInput.trim()
    if (!text || isSending) return
    runPreview(text)
  }

  const budget = deriveBudget(lastResult)

  return (
    <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Reply agent preview
        </span>
        <span style={{ fontSize: 13, color: STUDIO_TOKENS_V2.ink }}>{DRAFT_MODEL_LABEL}</span>
      </header>

      <form onSubmit={onSubmit} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          value={localInput}
          onChange={(e) => setLocalInput(e.target.value)}
          placeholder="Type a guest message to test…"
          aria-label="Test guest message"
          data-testid="studio-preview-input"
          style={{
            flex: 1,
            padding: '7px 10px',
            fontSize: 13,
            color: STUDIO_TOKENS_V2.ink,
            background: STUDIO_TOKENS_V2.bg,
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            outline: 'none',
            minWidth: 0,
          }}
        />
        <button
          type="submit"
          disabled={!localInput.trim() || isSending}
          aria-label="Send test"
          data-testid="studio-preview-send"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 10px',
            fontSize: 12,
            fontWeight: 500,
            color: STUDIO_TOKENS_V2.ink2,
            background: STUDIO_TOKENS_V2.bg,
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            cursor: localInput.trim() && !isSending ? 'pointer' : 'default',
            opacity: localInput.trim() && !isSending ? 1 : 0.55,
            flexShrink: 0,
          }}
        >
          <PlayIcon size={11} />
          {isSending ? 'Sending…' : 'Send test'}
        </button>
      </form>

      {lastError ? (
        <div
          style={{
            padding: '8px 10px',
            fontSize: 12,
            color: STUDIO_TOKENS_V2.red,
            background: 'rgba(220, 38, 38, 0.06)',
            border: `1px solid ${STUDIO_TOKENS_V2.red}22`,
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
          }}
        >
          {lastError}
        </div>
      ) : null}

      <PreviewConversation
        input={previewInput.text}
        reply={firstReplyText(lastResult)}
        isSending={isSending}
      />

      {budget ? <LatencyBudgetRow budget={budget} /> : null}
    </div>
  )
}

// ─── Conversation area ────────────────────────────────────────────────────

function PreviewConversation({
  input,
  reply,
  isSending,
}: {
  input: string
  reply: string | null
  isSending: boolean
}) {
  if (!input && !reply && !isSending) {
    return (
      <div
        style={{
          padding: 14,
          fontSize: 12,
          color: STUDIO_TOKENS_V2.muted2,
          border: `1px dashed ${STUDIO_TOKENS_V2.border}`,
          borderRadius: STUDIO_TOKENS_V2.radiusMd,
          textAlign: 'center',
        }}
      >
        No test run yet. Type a guest message above and press Send test.
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusMd,
        background: STUDIO_TOKENS_V2.bg,
      }}
    >
      {input ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            role="article"
            aria-label="Test guest message"
            style={{
              maxWidth: '85%',
              padding: '8px 12px',
              fontSize: 13,
              color: STUDIO_TOKENS_V2.ink2,
              background: STUDIO_TOKENS_V2.surface2,
              borderRadius: STUDIO_TOKENS_V2.radiusMd,
              borderBottomRightRadius: 4,
            }}
          >
            {input}
          </div>
        </div>
      ) : null}

      {isSending ? (
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <span style={{ fontSize: 12, color: STUDIO_TOKENS_V2.muted }}>Draft reply agent…</span>
        </div>
      ) : null}

      {reply ? (
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <div
            role="article"
            aria-label="Draft reply agent response"
            style={{
              maxWidth: '85%',
              padding: '8px 12px',
              fontSize: 13.5,
              lineHeight: 1.55,
              color: STUDIO_TOKENS_V2.ink2,
              background: STUDIO_TOKENS_V2.blueTint,
              border: `1px solid rgba(10, 91, 255, 0.15)`,
              borderRadius: STUDIO_TOKENS_V2.radiusMd,
              borderBottomLeftRadius: 4,
            }}
          >
            {renderInlineCodePills(reply)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ─── LATENCY BUDGET row ───────────────────────────────────────────────────

interface LatencyBudget {
  replySeconds: number
  tokens: number
  costUsd: number
  warnReply: boolean
  warnCost: boolean
}

function deriveBudget(result: TestPipelineResultData | null): LatencyBudget | null {
  if (!result || !Array.isArray(result.variants) || result.variants.length === 0) return null
  const v = result.variants[0] as unknown as {
    latencyMs?: number
    tokensUsed?: number
    costUsd?: number
  }
  const replySeconds = typeof v.latencyMs === 'number' ? v.latencyMs / 1000 : 0
  const tokens = typeof v.tokensUsed === 'number' ? v.tokensUsed : 0
  const costUsd = typeof v.costUsd === 'number' ? v.costUsd : 0
  return {
    replySeconds,
    tokens,
    costUsd,
    warnReply: replySeconds > REPLY_WARN_SECONDS,
    warnCost: costUsd > COST_WARN_USD,
  }
}

function firstReplyText(result: TestPipelineResultData | null): string | null {
  if (!result || !Array.isArray(result.variants) || result.variants.length === 0) return null
  const v = result.variants[0] as unknown as { pipelineOutput?: string }
  return typeof v.pipelineOutput === 'string' ? v.pipelineOutput : null
}

function LatencyBudgetRow({ budget }: { budget: LatencyBudget }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: STUDIO_TOKENS_V2.muted2,
        }}
      >
        Latency budget
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <BudgetCard
          label="Reply"
          value={`${budget.replySeconds.toFixed(1)}s`}
          warn={budget.warnReply}
          ariaLabel={
            budget.warnReply
              ? `Reply latency ${budget.replySeconds.toFixed(1)}s exceeds ${REPLY_WARN_SECONDS}s budget`
              : undefined
          }
        />
        <BudgetCard label="Tokens" value={String(budget.tokens)} />
        <BudgetCard
          label="Cost"
          value={`$${budget.costUsd.toFixed(4)}`}
          warn={budget.warnCost}
          ariaLabel={
            budget.warnCost
              ? `Cost $${budget.costUsd.toFixed(4)} exceeds $${COST_WARN_USD} budget`
              : undefined
          }
        />
      </div>
    </div>
  )
}

function BudgetCard({
  label,
  value,
  warn,
  ariaLabel,
}: {
  label: string
  value: string
  warn?: boolean
  ariaLabel?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        flex: 1,
        padding: '10px 11px',
        border: `1px solid ${warn ? STUDIO_TOKENS_V2.warnFg + '55' : STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusMd,
        background: warn ? STUDIO_TOKENS_V2.warnBg : STUDIO_TOKENS_V2.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: warn ? STUDIO_TOKENS_V2.warnFg : STUDIO_TOKENS_V2.ink,
          fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: warn ? STUDIO_TOKENS_V2.warnFg : STUDIO_TOKENS_V2.muted,
        }}
      >
        {label}
      </span>
    </div>
  )
}
