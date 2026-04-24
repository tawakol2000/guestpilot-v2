'use client'

// Sprint 046 — Studio design overhaul (plan T030 + FR-034).
//
// Tests tab: renders the latest TestPipelineResultData as a test suite
// (per-variant case rows). Row click expands in place; Re-run chevron
// fires a single-variant re-run (T031 wiring via the shell).

import { useState } from 'react'
import { STUDIO_TOKENS_V2 } from '../tokens'
import { useStudioShell } from '../studio-shell-context'
import { CheckIcon, CircleIcon, ChevronRightIcon } from '../icons'
import { formatRunTestPipelineMessage } from '../runtime/run-test-pipeline'
import type {
  TestPipelineResultData,
} from '@/lib/build-api'

type Variant = {
  variantId?: string
  label?: string
  verdict?: string
  latencyMs?: number
  pipelineOutput?: string
  judgeRationale?: string
}

export function TestsTab() {
  const shell = useStudioShell()
  const result = shell.previewInput.lastResult
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (!result || !Array.isArray(result.variants) || result.variants.length === 0) {
    return (
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Test suite
        </span>
        <p style={{ fontSize: 13, color: STUDIO_TOKENS_V2.muted }}>
          No tests yet. Run one from the Preview tab.
        </p>
        <button
          type="button"
          onClick={() => shell.setActiveRightTab('preview')}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            fontSize: 12.5,
            fontWeight: 500,
            color: STUDIO_TOKENS_V2.ink,
            background: STUDIO_TOKENS_V2.surface2,
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            cursor: 'pointer',
          }}
        >
          Go to Preview
        </button>
      </div>
    )
  }

  const variants = result.variants as unknown as Variant[]
  const suiteLabel = suiteLabelFor(result)

  return (
    <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
          Test suite
        </span>
        <span style={{ fontSize: 15, fontWeight: 500, color: STUDIO_TOKENS_V2.ink }}>
          {suiteLabel} · {variants.length} case{variants.length === 1 ? '' : 's'}
        </span>
      </header>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {variants.map((v, i) => {
          const id = v.variantId || `v${i}`
          const expanded = expandedId === id
          return (
            <li key={id}>
              <CaseRow
                variant={v}
                expanded={expanded}
                onToggle={() => setExpandedId(expanded ? null : id)}
                onReRun={() => {
                  // Sprint 046 FR-034 — fire a single-variant re-run by
                  // asking the build agent to run `test_pipeline` for
                  // just this variant. The helper formats a message
                  // the agent's coordinator parses.
                  const lastInput = shell.previewInput.text.trim()
                  if (!lastInput) {
                    // No prior input means there's nothing to re-run
                    // against. Bounce the operator to Preview so they
                    // can enter a guest message instead of sending a
                    // junk "Re-run test suite" string to the agent.
                    shell.setActiveRightTab('preview')
                    return
                  }
                  // Use the formatted message so the agent receives the
                  // structured `onlyVariant` annotation.
                  const formatted = formatRunTestPipelineMessage({
                    message: lastInput,
                    onlyVariant: id,
                  })
                  shell.runPreview(formatted)
                }}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function suiteLabelFor(result: TestPipelineResultData): string {
  const anyResult = result as unknown as { runLabel?: string; ritualVersion?: string }
  return anyResult.runLabel || anyResult.ritualVersion || 'Latest run'
}

function statusFor(v: Variant): 'done-pass' | 'done-fail' | 'running' | 'pending' {
  if (v.verdict === 'passed') return 'done-pass'
  if (v.verdict === 'failed' || v.verdict === 'errored') return 'done-fail'
  if (typeof v.latencyMs === 'number' && v.latencyMs > 0) return 'done-pass'
  return 'pending'
}

function CaseRow({
  variant,
  expanded,
  onToggle,
  onReRun,
}: {
  variant: Variant
  expanded: boolean
  onToggle: () => void
  onReRun?: () => void
}) {
  const status = statusFor(variant)
  const durationLabel =
    typeof variant.latencyMs === 'number' && variant.latencyMs > 0
      ? `${(variant.latencyMs / 1000).toFixed(1)}s`
      : '—'

  return (
    <div
      style={{
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusMd,
        background: STUDIO_TOKENS_V2.bg,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <button
          type="button"
          role="button"
          aria-expanded={expanded}
          onClick={onToggle}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <StatusDot status={status} />
          <span
            style={{
              flex: 1,
              fontSize: 13,
              color: STUDIO_TOKENS_V2.ink2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {variant.label || variant.variantId || 'Case'}
          </span>
          <span
            style={{
              fontSize: 11.5,
              color: STUDIO_TOKENS_V2.muted2,
              fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
            }}
          >
            {durationLabel}
          </span>
        </button>
        {/* Sprint 046 FR-034 — Re-run chevron. Visible once the variant
           has a verdict; stopPropagation so it doesn't toggle the
           accordion. */}
        {onReRun && (status === 'done-pass' || status === 'done-fail') ? (
          <button
            type="button"
            aria-label={`Re-run variant ${variant.variantId || variant.label || 'case'}`}
            onClick={(e) => {
              e.stopPropagation()
              onReRun()
            }}
            style={{
              width: 28,
              height: 28,
              marginRight: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: STUDIO_TOKENS_V2.muted,
              cursor: 'pointer',
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = STUDIO_TOKENS_V2.ink
              e.currentTarget.style.background = STUDIO_TOKENS_V2.surface
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = STUDIO_TOKENS_V2.muted
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <ChevronRightIcon size={14} />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div
          role="region"
          style={{
            padding: '10px 12px 12px',
            borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: STUDIO_TOKENS_V2.ink2,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {variant.pipelineOutput ? (
            <section>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: STUDIO_TOKENS_V2.muted2,
                  marginBottom: 4,
                }}
              >
                Reply
              </div>
              <div
                style={{
                  padding: 8,
                  background: STUDIO_TOKENS_V2.blueTint,
                  border: `1px solid rgba(10, 91, 255, 0.12)`,
                  borderRadius: STUDIO_TOKENS_V2.radiusSm,
                }}
              >
                {variant.pipelineOutput}
              </div>
            </section>
          ) : null}
          {variant.judgeRationale ? (
            <section>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: STUDIO_TOKENS_V2.muted2,
                  marginBottom: 4,
                }}
              >
                Judge
              </div>
              <div style={{ fontSize: 12.5, color: STUDIO_TOKENS_V2.ink2 }}>
                {variant.judgeRationale}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StatusDot({ status }: { status: 'done-pass' | 'done-fail' | 'running' | 'pending' }) {
  if (status === 'done-pass') {
    return (
      <span
        aria-label="Passed"
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: STUDIO_TOKENS_V2.blueSoft,
          color: STUDIO_TOKENS_V2.blue,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <CheckIcon size={10} />
      </span>
    )
  }
  if (status === 'done-fail') {
    return (
      <span
        aria-label="Failed"
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'rgba(220,38,38,0.1)',
          color: STUDIO_TOKENS_V2.red,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <ChevronRightIcon size={10} />
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span
        aria-label="Running"
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: `1.5px solid ${STUDIO_TOKENS_V2.border}`,
          borderTopColor: STUDIO_TOKENS_V2.blue,
          animation: 'spin 0.9s linear infinite',
          flexShrink: 0,
        }}
      />
    )
  }
  return (
    <span
      aria-label="Pending"
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        color: STUDIO_TOKENS_V2.border,
        display: 'inline-flex',
      }}
    >
      <CircleIcon size={14} style={{ strokeDasharray: '2,3' }} />
    </span>
  )
}
