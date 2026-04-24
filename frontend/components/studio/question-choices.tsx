'use client'

/**
 * Sprint 046 — Question Choices card.
 *
 * Redesign per operator screenshot (2026-04-24):
 *   - Large question headline in the card header
 *   - Numbered options (1, 2, 3…) with gray number-chip on the left,
 *     label in the middle, arrow-right hover/active indicator on right
 *   - Selected / keyboard-active row highlighted with --surface-2
 *   - Dividers between options
 *   - "Something else" free-text row with a pencil icon + Skip button
 *   - Footer: "↑ ↓ to navigate · Enter to select · Esc to skip"
 *   - Recommended option rendered with a subtle RECOMMENDED pill
 *
 * Backwards-compatible with the existing `data-question-choices` SSE
 * part: same props, same callbacks, same lock-on-select behavior.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'

export interface QuestionOption {
  id: string
  label: string
  recommended?: boolean
}

export interface QuestionChoicesCardProps {
  question: string
  options: QuestionOption[]
  allowCustomInput: boolean
  onChoose?: (optionId: string) => void | Promise<void>
  onCustomAnswer?: (text: string) => void | Promise<void>
  /** Optional — called when the operator skips the question (Esc or
   *  the Skip button). Host can re-ask or advance. */
  onSkip?: () => void
}

export function QuestionChoicesCard(props: QuestionChoicesCardProps) {
  const { options, allowCustomInput, question, onChoose, onCustomAnswer, onSkip } = props

  const [chosen, setChosen] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [customActive, setCustomActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Active-row for keyboard navigation. Defaults to the recommended
  // option's index, else 0.
  const recommendedIdx = useMemo(() => {
    const i = options.findIndex((o) => o.recommended === true)
    return i < 0 ? 0 : i
  }, [options])
  const [activeIdx, setActiveIdx] = useState(recommendedIdx)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const customInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setActiveIdx(recommendedIdx)
  }, [recommendedIdx])

  async function pick(id: string) {
    if (chosen || submitting) return
    setSubmitting(true)
    try {
      await onChoose?.(id)
      setChosen(id)
    } finally {
      setSubmitting(false)
    }
  }

  async function sendCustom() {
    const text = customText.trim()
    if (!text || chosen || submitting) return
    setSubmitting(true)
    try {
      await onCustomAnswer?.(text)
      setChosen(`__custom__:${text}`)
    } finally {
      setSubmitting(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (chosen) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(options.length - 1 + (allowCustomInput ? 1 : 0), i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIdx < options.length) {
        pick(options[activeIdx].id)
      } else if (allowCustomInput) {
        setCustomActive(true)
        customInputRef.current?.focus()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onSkip?.()
    } else if (/^[1-9]$/.test(e.key)) {
      const n = parseInt(e.key, 10) - 1
      if (n < options.length) {
        e.preventDefault()
        pick(options[n].id)
      }
    }
  }

  // Focus the active row for screen-reader + keyboard-user parity.
  useEffect(() => {
    if (chosen) return
    const btn = rowRefs.current[activeIdx]
    if (btn && document.activeElement !== btn) {
      // Only auto-focus if the user is already inside the card, so we
      // don't steal focus from whatever they were doing.
      const within = document.activeElement && (btn.closest('[data-studio-card="question-choices"]')?.contains(document.activeElement) ?? false)
      if (within) btn.focus()
    }
  }, [activeIdx, chosen])

  return (
    <article
      data-studio-card="question-choices"
      role="group"
      aria-label={question}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      style={{
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.bg,
        boxShadow: STUDIO_TOKENS_V2.shadowSm,
        padding: 20,
        marginTop: 4,
        maxWidth: 680,
      }}
    >
      {/* Header row — question + close/skip */}
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 14,
        }}
      >
        <h3
          style={{
            margin: 0,
            flex: 1,
            fontSize: 17,
            lineHeight: 1.35,
            fontWeight: 500,
            color: STUDIO_TOKENS_V2.ink,
            letterSpacing: '-0.01em',
          }}
        >
          {question}
        </h3>
        {onSkip ? (
          <button
            type="button"
            aria-label="Skip question"
            onClick={() => {
              if (chosen) return
              onSkip()
            }}
            disabled={chosen !== null}
            style={{
              flexShrink: 0,
              width: 26,
              height: 26,
              border: 'none',
              background: 'transparent',
              color: STUDIO_TOKENS_V2.muted2,
              cursor: chosen ? 'default' : 'pointer',
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
            }}
          >
            <XIcon />
          </button>
        ) : null}
      </header>

      {/* Options list */}
      <ol
        role="listbox"
        aria-label="Choices"
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
        }}
      >
        {options.map((opt, idx) => {
          const isChosen = chosen === opt.id
          const isActive = !chosen && activeIdx === idx
          const isRecommended = opt.recommended === true
          const faded = chosen !== null && !isChosen
          return (
            <li
              key={opt.id}
              style={{
                borderBottom:
                  idx === options.length - 1 && !allowCustomInput
                    ? 'none'
                    : `1px solid ${STUDIO_TOKENS_V2.border}`,
              }}
            >
              <button
                ref={(el) => {
                  rowRefs.current[idx] = el
                }}
                type="button"
                role="option"
                aria-selected={isChosen}
                disabled={submitting || chosen !== null}
                onMouseEnter={() => {
                  if (!chosen) setActiveIdx(idx)
                }}
                onClick={() => pick(opt.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  width: '100%',
                  padding: '14px 10px',
                  background: isActive || isChosen ? STUDIO_TOKENS_V2.surface2 : 'transparent',
                  border: 'none',
                  cursor: submitting || chosen ? 'default' : 'pointer',
                  opacity: faded ? 0.45 : 1,
                  transition: 'opacity 120ms ease, background 120ms ease',
                  textAlign: 'left',
                }}
              >
                {/* Number chip */}
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 28,
                    height: 28,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: STUDIO_TOKENS_V2.radiusSm,
                    background: isActive || isChosen ? STUDIO_TOKENS_V2.surface3 : STUDIO_TOKENS_V2.surface,
                    color: isActive || isChosen ? STUDIO_TOKENS_V2.ink : STUDIO_TOKENS_V2.muted2,
                    fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
                    fontSize: 13,
                  }}
                >
                  {idx + 1}
                </span>
                {/* Label */}
                <span
                  style={{
                    flex: 1,
                    fontSize: 15,
                    lineHeight: 1.4,
                    fontWeight: isActive || isChosen ? 500 : 400,
                    color: STUDIO_TOKENS_V2.ink,
                  }}
                >
                  {opt.label}
                </span>
                {/* Recommended pill */}
                {isRecommended ? (
                  <span
                    aria-label="Recommended"
                    style={{
                      flexShrink: 0,
                      padding: '2px 8px',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: STUDIO_TOKENS_V2.blue,
                      background: STUDIO_TOKENS_V2.blueSoft,
                      borderRadius: 99,
                    }}
                  >
                    Recommended
                  </span>
                ) : null}
                {/* Arrow-right indicator on active/chosen */}
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 20,
                    height: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: STUDIO_TOKENS_V2.muted2,
                    opacity: isActive || isChosen ? 1 : 0,
                    transition: 'opacity 120ms ease',
                  }}
                >
                  <ArrowRightIcon />
                </span>
              </button>
            </li>
          )
        })}

        {/* Custom-answer row */}
        {allowCustomInput ? (
          <li>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                width: '100%',
                padding: '12px 10px',
                background:
                  !chosen && (customActive || activeIdx === options.length)
                    ? STUDIO_TOKENS_V2.surface2
                    : 'transparent',
                opacity: chosen ? 0.45 : 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: STUDIO_TOKENS_V2.radiusSm,
                  background: STUDIO_TOKENS_V2.surface,
                  color: STUDIO_TOKENS_V2.muted2,
                }}
              >
                <PencilIcon />
              </span>
              <input
                ref={customInputRef}
                type="text"
                aria-label="Something else"
                placeholder="Something else"
                value={customText}
                disabled={submitting || chosen !== null}
                onFocus={() => {
                  setCustomActive(true)
                  setActiveIdx(options.length)
                }}
                onBlur={() => setCustomActive(false)}
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    sendCustom()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    onSkip?.()
                  }
                }}
                style={{
                  flex: 1,
                  padding: '4px 0',
                  fontSize: 15,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: STUDIO_TOKENS_V2.ink,
                }}
              />
              {onSkip ? (
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={chosen !== null}
                  style={{
                    flexShrink: 0,
                    padding: '5px 14px',
                    fontSize: 13,
                    fontWeight: 500,
                    color: STUDIO_TOKENS_V2.ink2,
                    background: STUDIO_TOKENS_V2.bg,
                    border: `1px solid ${STUDIO_TOKENS_V2.border}`,
                    borderRadius: STUDIO_TOKENS_V2.radiusSm,
                    cursor: chosen ? 'default' : 'pointer',
                  }}
                >
                  Skip
                </button>
              ) : (
                <button
                  type="button"
                  onClick={sendCustom}
                  disabled={chosen !== null || !customText.trim() || submitting}
                  style={{
                    flexShrink: 0,
                    padding: '5px 14px',
                    fontSize: 13,
                    fontWeight: 500,
                    color: customText.trim() ? STUDIO_TOKENS_V2.ink2 : STUDIO_TOKENS_V2.muted2,
                    background: STUDIO_TOKENS_V2.bg,
                    border: `1px solid ${STUDIO_TOKENS_V2.border}`,
                    borderRadius: STUDIO_TOKENS_V2.radiusSm,
                    cursor: customText.trim() && !chosen ? 'pointer' : 'default',
                  }}
                >
                  Send
                </button>
              )}
            </div>
          </li>
        ) : null}
      </ol>

      {/* Keyboard hints footer */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          marginTop: 10,
          fontSize: 11.5,
          color: STUDIO_TOKENS_V2.muted2,
        }}
      >
        <span>↑ ↓ to navigate</span>
        <span aria-hidden>·</span>
        <span>Enter to select</span>
        <span aria-hidden>·</span>
        <span>Esc to skip</span>
      </footer>
    </article>
  )
}

// ─── Inline icons ──────────────────────────────────────────────────────

function XIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6l12 12" />
      <path d="M6 18L18 6" />
    </svg>
  )
}

function ArrowRightIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h4l10.5-10.5a2 2 0 00-2.83-2.83L5 17.17V20z" />
      <path d="M13 7l4 4" />
    </svg>
  )
}
