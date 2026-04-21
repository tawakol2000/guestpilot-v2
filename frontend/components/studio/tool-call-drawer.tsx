'use client'

/**
 * Sprint 050 A2 — tool-call drill-in drawer (operator-tier).
 *
 * Slide-out from the right edge of the centre pane (not the full-screen
 * right rail — the state snapshot must stay visible while the operator
 * audits a tool call). Viewer-only: no re-run, no edit-args. Those are
 * Bundle B/C territory.
 *
 * Payload is always sanitised via `tool-call-sanitise.ts`:
 *   - Redact-by-key at every level.
 *   - Truncate string values > 1000 chars for operator-tier viewers.
 *   - Admin-tier "Show full output" toggle only renders when both
 *     `capabilities.isAdmin` and `capabilities.traceViewEnabled` are
 *     set (the same gate the existing admin Trace drawer uses).
 *
 * Close: Esc, click-outside, or the × button. Focus returns to the
 * element that opened the drawer.
 */
import { useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { sanitiseToolPayload } from '@/lib/tool-call-sanitise'
import { STUDIO_COLORS } from './tokens'

export interface ToolCallDrawerPart {
  type: string
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
  /** Optional AI-SDK-native provider metadata. Not guaranteed. */
  providerMetadata?: Record<string, unknown>
  /** Optional — present on error states. */
  errorText?: string
}

export interface ToolCallDrawerProps {
  open: boolean
  onClose: () => void
  part: ToolCallDrawerPart | null
  /** Admin toggle — unlocks "Show full output" (skips truncation). */
  isAdmin: boolean
  /** Admin tier gating — mirrors capabilities.traceViewEnabled. */
  traceViewEnabled: boolean
  /** Controlled flag so parent can persist admin preference per-session. */
  showFull?: boolean
  onToggleShowFull?: (next: boolean) => void
}

function shortToolName(raw: string | undefined): string {
  if (!raw) return 'tool'
  return raw.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')
}

function formatPayload(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ToolCallDrawer({
  open,
  onClose,
  part,
  isAdmin,
  traceViewEnabled,
  showFull = false,
  onToggleShowFull,
}: ToolCallDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc closes.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Focus the panel when it opens.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  const adminGated = isAdmin && traceViewEnabled
  const operatorView = !(adminGated && showFull)

  const { inputText, outputText, outputError } = useMemo(() => {
    if (!part) return { inputText: '', outputText: '', outputError: undefined }
    const tier = operatorView ? 'operator' : 'admin'
    const sanitisedInput = sanitiseToolPayload(part.input, { tier })
    const sanitisedOutput = sanitiseToolPayload(part.output, { tier })
    const err =
      part.state === 'output-error'
        ? typeof part.errorText === 'string'
          ? part.errorText
          : 'Tool call failed.'
        : undefined
    return {
      inputText: formatPayload(sanitisedInput),
      outputText: formatPayload(sanitisedOutput),
      outputError: err,
    }
  }, [part, operatorView])

  if (!open || !part) return null

  const short = shortToolName(part.toolName ?? part.type.replace(/^tool-/, ''))
  const state = part.state ?? 'unknown'
  const waitingForOutput =
    (state === 'input-available' || state === 'input-start') && !outputText

  return (
    <div
      aria-hidden={false}
      // Overlay covers only the chat column; click-outside closes.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        justifyContent: 'flex-end',
        background: 'rgba(10, 10, 10, 0.12)',
        zIndex: 30,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Tool call details: ${short}`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 360,
          maxWidth: '90%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: STUDIO_COLORS.canvas,
          borderLeft: `1px solid ${STUDIO_COLORS.hairline}`,
          boxShadow: '-8px 0 24px rgba(10,10,10,0.06)',
          outline: 'none',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
            background: STUDIO_COLORS.surfaceRaised,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: STUDIO_COLORS.ink,
              textTransform: 'capitalize',
            }}
          >
            {short}
          </span>
          <StateChip state={state} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tool call details"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              height: 26,
              width: 26,
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px solid ${STUDIO_COLORS.hairline}`,
              background: STUDIO_COLORS.surfaceRaised,
              color: STUDIO_COLORS.inkMuted,
              borderRadius: 5,
              cursor: 'pointer',
            }}
          >
            <X size={14} strokeWidth={2.25} aria-hidden />
          </button>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <Section title="Input" body={inputText} empty="No input captured." />
          {outputError ? (
            <Section
              title="Error"
              body={outputError}
              tone="danger"
            />
          ) : waitingForOutput ? (
            <Section title="Output" body="" placeholder="Waiting for output…" />
          ) : (
            <Section title="Output" body={outputText} empty="No output captured." />
          )}

          {adminGated ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 4,
                fontSize: 11,
                color: STUDIO_COLORS.inkMuted,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={showFull}
                onChange={(e) => onToggleShowFull?.(e.currentTarget.checked)}
                aria-label="Show full output (admin)"
              />
              <span>Show full output (admin)</span>
            </label>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StateChip({ state }: { state: string }) {
  const running = state === 'input-available' || state === 'input-start'
  const err = state === 'output-error'
  const bg = err
    ? STUDIO_COLORS.dangerBg
    : running
      ? STUDIO_COLORS.surfaceSunken
      : STUDIO_COLORS.successBg
  const fg = err
    ? STUDIO_COLORS.dangerFg
    : running
      ? STUDIO_COLORS.inkMuted
      : STUDIO_COLORS.successFg
  const label = err ? 'error' : running ? 'running' : state === 'output-available' ? 'ok' : state
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 8px',
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  )
}

function Section({
  title,
  body,
  empty,
  placeholder,
  tone,
}: {
  title: string
  body: string
  empty?: string
  placeholder?: string
  tone?: 'danger'
}) {
  const bg = tone === 'danger' ? STUDIO_COLORS.dangerBg : STUDIO_COLORS.surfaceSunken
  const fg = tone === 'danger' ? STUDIO_COLORS.dangerFg : STUDIO_COLORS.ink
  const content = body || placeholder || empty || ''
  const emptyish = !body && (empty || placeholder)
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          color: STUDIO_COLORS.inkMuted,
        }}
      >
        {title}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          borderRadius: 6,
          background: bg,
          color: emptyish ? STUDIO_COLORS.inkSubtle : fg,
          border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 11.5,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontStyle: emptyish ? 'italic' : 'normal',
        }}
      >
        {content}
      </pre>
    </section>
  )
}
