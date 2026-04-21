'use client'

/**
 * Sprint 055-A F2 — inline FAQ entry editor.
 *
 * FAQ artifacts have `{ question: string, answer: string }` at the top
 * level. Renders one input for the question and one textarea for the
 * answer. Falls back to a full JSON textarea when the shape is unknown.
 */
import { STUDIO_COLORS } from '../tokens'

export function FaqEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const hasKnownShape =
    typeof value.question === 'string' || typeof value.answer === 'string'

  if (!hasKnownShape) {
    // Unknown shape — fall back to raw JSON textarea.
    return <JsonFallback value={value} onChange={onChange} />
  }

  const question = typeof value.question === 'string' ? value.question : ''
  const answer = typeof value.answer === 'string' ? value.answer : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label
          style={{
            display: 'block',
            fontSize: 10.5,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            color: STUDIO_COLORS.inkSubtle,
            marginBottom: 4,
          }}
        >
          Question
        </label>
        <input
          data-testid="faq-editor-question"
          type="text"
          style={{
            width: '100%',
            borderRadius: 5,
            border: '1px solid #d1d5db',
            padding: '6px 8px',
            fontSize: 13,
            fontWeight: 500,
            color: STUDIO_COLORS.ink,
          }}
          value={question}
          onChange={(e) => onChange({ ...value, question: e.target.value })}
        />
      </div>
      <div>
        <label
          style={{
            display: 'block',
            fontSize: 10.5,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            color: STUDIO_COLORS.inkSubtle,
            marginBottom: 4,
          }}
        >
          Answer
        </label>
        <textarea
          data-testid="faq-editor-answer"
          style={{
            width: '100%',
            resize: 'vertical',
            borderRadius: 5,
            border: '1px solid #d1d5db',
            padding: '8px',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.55,
            minHeight: 120,
          }}
          rows={8}
          value={answer}
          onChange={(e) => onChange({ ...value, answer: e.target.value })}
        />
      </div>
    </div>
  )
}

function JsonFallback({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const text = JSON.stringify(value, null, 2)
  return (
    <textarea
      data-testid="faq-editor-json-fallback"
      style={{
        width: '100%',
        resize: 'vertical',
        borderRadius: 5,
        border: '1px solid #d1d5db',
        padding: '8px',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.55,
        minHeight: 160,
      }}
      rows={10}
      value={text}
      onChange={(e) => {
        try {
          const parsed = JSON.parse(e.target.value)
          if (parsed && typeof parsed === 'object') onChange(parsed)
        } catch {
          // ignore invalid JSON while typing
        }
      }}
    />
  )
}
