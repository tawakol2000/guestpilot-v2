'use client'

/**
 * Sprint 056-A F1 — ComposeBubble.
 *
 * A floating inline-chat affordance for text-selection-driven editing.
 * The operator selects a span inside the artifact drawer body; this
 * component anchors near the selection and lets them ask the agent to
 * improve just that span.
 *
 * State machine: idle → loading → showing-result → (accept | redo | dismiss)
 * Up to 3 redos. On Accept the replacement is merged into the preview
 * buffer via `onAccept`. Apply in the drawer is still the only write gate.
 *
 * Validator: single-line selection + multi-paragraph replacement → reject
 * with a "try a narrower ask" message rather than silently applying a
 * bigger change.
 */
import { useEffect, useRef, useState } from 'react'
import { X, RotateCcw, Check } from 'lucide-react'
import { apiComposeSpan } from '@/lib/build-api'
import { STUDIO_COLORS, attributedStyle } from './tokens'

export interface ComposeBubbleSelection {
  start: number
  end: number
  text: string
}

export interface ComposeBubbleProps {
  selection: ComposeBubbleSelection
  bodyText: string
  artifactId: string
  artifactType: string
  conversationId?: string | null
  onAccept: (replacement: string) => void
  onDismiss: () => void
}

type BubbleState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'showing-result'; replacement: string; rationale: string }
  | { phase: 'validator-error'; message: string }

const MAX_REDOS = 3

/**
 * Single-line selection: no newlines AND < 200 chars.
 */
function isSingleLineSelection(selectionText: string): boolean {
  return !selectionText.includes('\n') && selectionText.length < 200
}

/**
 * Multi-paragraph replacement: has 2+ newlines separated by non-whitespace
 * content (i.e. actual paragraphs, not just trailing newlines).
 */
function isMultiParagraphReplacement(text: string): boolean {
  // Split on blank lines (paragraph separators) and count non-empty segments
  const segments = text.split(/\n\s*\n/)
  const nonEmpty = segments.filter((s) => s.trim().length > 0)
  return nonEmpty.length >= 2
}

/**
 * Merge a replacement span back into a body string at the stored offsets.
 */
export function mergeSpan(
  bodyText: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return bodyText.slice(0, start) + replacement + bodyText.slice(end)
}

export function ComposeBubble({
  selection,
  bodyText,
  artifactId,
  artifactType,
  conversationId,
  onAccept,
  onDismiss,
}: ComposeBubbleProps) {
  const [instruction, setInstruction] = useState('')
  const [state, setState] = useState<BubbleState>({ phase: 'idle' })
  const [redoCount, setRedoCount] = useState(0)
  const [priorReplacement, setPriorReplacement] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  // Auto-focus the input on mount.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc closes bubble.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDismiss])

  async function handleSubmit() {
    if (!instruction.trim()) return
    setState({ phase: 'loading' })

    try {
      const result = await apiComposeSpan({
        artifactId,
        artifactType,
        selection,
        surroundingBody: bodyText,
        instruction: instruction.trim(),
        ...(conversationId ? { conversationId } : {}),
        ...(priorReplacement ? { priorAttempt: priorReplacement } : {}),
      })

      const replacement = result.replacement

      // Validator: reject multi-paragraph expansions for single-line selections.
      if (isSingleLineSelection(selection.text) && isMultiParagraphReplacement(replacement)) {
        setState({
          phase: 'validator-error',
          message: 'The agent returned more than the selection. Try a narrower ask.',
        })
        return
      }

      setState({ phase: 'showing-result', replacement, rationale: result.rationale })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({ phase: 'validator-error', message: `Error: ${msg}` })
    }
  }

  function handleAccept() {
    if (state.phase !== 'showing-result') return
    onAccept(state.replacement)
  }

  function handleRedo() {
    if (state.phase !== 'showing-result') return
    if (redoCount >= MAX_REDOS) return
    setPriorReplacement(state.phase === 'showing-result' ? state.replacement : null)
    setRedoCount((n) => n + 1)
    setState({ phase: 'idle' })
  }

  function handleRetry() {
    setState({ phase: 'idle' })
  }

  const canRedo =
    state.phase === 'showing-result' && redoCount < MAX_REDOS

  return (
    <div
      ref={bubbleRef}
      data-testid="compose-bubble"
      role="dialog"
      aria-label="Compose at selection"
      style={{
        position: 'fixed',
        bottom: 80,
        right: 24,
        width: 360,
        maxWidth: 'calc(100vw - 48px)',
        background: STUDIO_COLORS.canvas,
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 12px 8px',
          borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 0.2,
              textTransform: 'uppercase',
              color: STUDIO_COLORS.inkMuted,
              marginBottom: 4,
            }}
          >
            Edit selection
          </div>
          <div
            data-testid="compose-bubble-selection-preview"
            style={{
              fontSize: 11.5,
              color: STUDIO_COLORS.inkMuted,
              background: STUDIO_COLORS.surfaceSunken,
              border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
              borderRadius: 4,
              padding: '3px 6px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontStyle: 'italic',
              maxWidth: '100%',
            }}
            title={selection.text}
          >
            &ldquo;{selection.text.length > 60 ? selection.text.slice(0, 60) + '…' : selection.text}&rdquo;
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss compose bubble"
          onClick={onDismiss}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 2,
            cursor: 'pointer',
            color: STUDIO_COLORS.inkMuted,
            display: 'inline-flex',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Result display */}
        {state.phase === 'showing-result' && (
          <div data-testid="compose-bubble-result" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Before / After diff */}
            <div
              style={{
                background: STUDIO_COLORS.diffDelBg,
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 12,
                color: STUDIO_COLORS.diffDelFg,
                textDecoration: 'line-through',
              }}
            >
              {selection.text}
            </div>
            <div
              data-testid="compose-bubble-replacement"
              style={{
                background: STUDIO_COLORS.diffAddBg,
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 12,
                color: STUDIO_COLORS.diffAddFg,
              }}
            >
              {state.replacement}
            </div>
            {state.rationale ? (
              <div
                style={{
                  fontSize: 10.5,
                  ...attributedStyle('ai'),
                  fontStyle: 'italic',
                }}
              >
                {state.rationale}
              </div>
            ) : null}
          </div>
        )}

        {/* Validator / error */}
        {state.phase === 'validator-error' && (
          <div
            data-testid="compose-bubble-error"
            role="alert"
            style={{
              background: STUDIO_COLORS.warnBg,
              color: STUDIO_COLORS.warnFg,
              borderLeft: `2px solid ${STUDIO_COLORS.warnFg}`,
              borderRadius: 4,
              padding: '6px 8px',
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            {state.message}
          </div>
        )}

        {/* Loading */}
        {state.phase === 'loading' && (
          <div
            role="status"
            aria-label="Composing"
            style={{
              fontSize: 12,
              color: STUDIO_COLORS.inkMuted,
              fontStyle: 'italic',
            }}
          >
            Composing…
          </div>
        )}

        {/* Instruction input — shown in idle, validator-error, or after redo */}
        {(state.phase === 'idle' || state.phase === 'validator-error') && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={inputRef}
              data-testid="compose-bubble-input"
              type="text"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              placeholder="Ask or tell the agent about this span…"
              aria-label="Instruction for selected text"
              style={{
                flex: 1,
                fontSize: 12,
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                borderRadius: 5,
                padding: '5px 8px',
                outline: 'none',
                color: STUDIO_COLORS.ink,
              }}
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!instruction.trim()}
              data-testid="compose-bubble-submit"
              aria-label="Submit instruction"
              style={{
                background: STUDIO_COLORS.accent,
                color: '#fff',
                border: 'none',
                borderRadius: 5,
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 500,
                cursor: instruction.trim() ? 'pointer' : 'not-allowed',
                opacity: instruction.trim() ? 1 : 0.5,
                flexShrink: 0,
              }}
            >
              Go
            </button>
          </div>
        )}

        {/* Action row for result state */}
        {state.phase === 'showing-result' && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {canRedo && (
              <button
                type="button"
                data-testid="compose-bubble-redo"
                aria-label={`Redo (${MAX_REDOS - redoCount} left)`}
                onClick={handleRedo}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'transparent',
                  border: `1px solid ${STUDIO_COLORS.hairline}`,
                  borderRadius: 5,
                  padding: '4px 8px',
                  fontSize: 11.5,
                  color: STUDIO_COLORS.inkMuted,
                  cursor: 'pointer',
                }}
              >
                <RotateCcw size={12} />
                Redo {redoCount > 0 ? `(${MAX_REDOS - redoCount} left)` : ''}
              </button>
            )}
            <button
              type="button"
              data-testid="compose-bubble-dismiss-result"
              aria-label="Dismiss"
              onClick={onDismiss}
              style={{
                background: 'transparent',
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                borderRadius: 5,
                padding: '4px 8px',
                fontSize: 11.5,
                color: STUDIO_COLORS.inkMuted,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
            <button
              type="button"
              data-testid="compose-bubble-accept"
              aria-label="Accept replacement"
              onClick={handleAccept}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: STUDIO_COLORS.ink,
                border: 'none',
                borderRadius: 5,
                padding: '4px 10px',
                fontSize: 11.5,
                fontWeight: 500,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              <Check size={12} />
              Accept
            </button>
          </div>
        )}

        {/* Retry after error */}
        {state.phase === 'validator-error' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={handleRetry}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                fontSize: 11,
                color: STUDIO_COLORS.inkMuted,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Try again
            </button>
          </div>
        )}

        {/* Redo counter label */}
        {redoCount > 0 && state.phase !== 'showing-result' && (
          <div style={{ fontSize: 10.5, color: STUDIO_COLORS.inkSubtle }}>
            Redo {redoCount}/{MAX_REDOS} — refine your instruction above
          </div>
        )}
      </div>
    </div>
  )
}
