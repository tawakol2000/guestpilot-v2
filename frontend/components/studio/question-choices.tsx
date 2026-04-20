'use client'

/**
 * Sprint 046 Session B — Question Choices card.
 *
 * Renders a `data-question-choices` SSE part: one question headline +
 * 2–5 choice buttons (the recommended option styled filled-ink, the
 * rest as ghost buttons) + an optional "or type something else…" row.
 *
 * Per Response Contract rule 4: the agent must emit this card whenever
 * it would otherwise ask an open-ended prose question.
 */
import { useState } from 'react'
import { STUDIO_COLORS } from './tokens'

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
}

export function QuestionChoicesCard(props: QuestionChoicesCardProps) {
  const [chosen, setChosen] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function pick(id: string) {
    if (chosen || submitting) return
    setSubmitting(true)
    try {
      await props.onChoose?.(id)
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
      await props.onCustomAnswer?.(text)
      setChosen(`__custom__:${text}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <article
      data-studio-card="question-choices"
      style={{
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 8,
        background: STUDIO_COLORS.surfaceRaised,
        padding: 16,
        marginTop: 8,
      }}
    >
      <p
        style={{
          margin: 0,
          color: STUDIO_COLORS.ink,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.5,
        }}
      >
        {props.question}
      </p>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          marginTop: 12,
        }}
      >
        {props.options.map((opt) => {
          const isRecommended = opt.recommended === true
          const isChosen = chosen === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              disabled={submitting || chosen !== null}
              onClick={() => pick(opt.id)}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: isRecommended ? 600 : 500,
                borderRadius: 6,
                border: `1px solid ${isRecommended ? STUDIO_COLORS.ink : STUDIO_COLORS.hairline}`,
                background: isRecommended
                  ? STUDIO_COLORS.ink
                  : isChosen
                    ? STUDIO_COLORS.accentSoft
                    : STUDIO_COLORS.surfaceRaised,
                color: isRecommended
                  ? '#FFFFFF'
                  : isChosen
                    ? STUDIO_COLORS.accent
                    : STUDIO_COLORS.ink,
                cursor: submitting || chosen ? 'default' : 'pointer',
                opacity: chosen && !isChosen ? 0.55 : 1,
                transition: 'opacity 120ms ease',
              }}
            >
              {opt.label}
              {isRecommended && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 500,
                    opacity: 0.75,
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                  }}
                >
                  · recommended
                </span>
              )}
            </button>
          )
        })}
      </div>
      {props.allowCustomInput && (
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendCustom()
            }}
            disabled={submitting || chosen !== null}
            placeholder="Or type something else…"
            style={{
              flex: 1,
              padding: '7px 10px',
              fontSize: 13,
              border: `1px solid ${STUDIO_COLORS.hairline}`,
              borderRadius: 6,
              background: STUDIO_COLORS.surfaceRaised,
              color: STUDIO_COLORS.ink,
            }}
          />
          <button
            type="button"
            disabled={submitting || chosen !== null || !customText.trim()}
            onClick={sendCustom}
            style={{
              padding: '7px 12px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
              border: '1px solid transparent',
              background:
                customText.trim() && !submitting && !chosen
                  ? STUDIO_COLORS.ink
                  : STUDIO_COLORS.surfaceSunken,
              color:
                customText.trim() && !submitting && !chosen
                  ? '#FFFFFF'
                  : STUDIO_COLORS.inkSubtle,
              cursor: customText.trim() && !submitting && !chosen ? 'pointer' : 'not-allowed',
            }}
          >
            Send
          </button>
        </div>
      )}
    </article>
  )
}
