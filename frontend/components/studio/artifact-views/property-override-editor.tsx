'use client'

/**
 * Sprint 055-A F2 — inline Property Override editor.
 *
 * Property overrides are stored as plain text (`content: string`).
 * Renders the same JSON textarea pattern as `ToolEditor` for cases
 * where the shape deviates, but prefers a simple textarea when the
 * `content` key is a string (the normal case).
 */
import { useState } from 'react'
import { STUDIO_COLORS } from '../tokens'

export function PropertyOverrideEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const isContentBased = typeof value.content === 'string'
  const [raw, setRaw] = useState(() =>
    isContentBased
      ? (value.content as string)
      : JSON.stringify(value, null, 2),
  )
  const [jsonError, setJsonError] = useState<string | null>(null)

  if (isContentBased) {
    return (
      <textarea
        data-testid="property-override-editor-textarea"
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
          minHeight: 180,
        }}
        rows={12}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value)
          onChange({ ...value, content: e.target.value })
        }}
      />
    )
  }

  // JSON fallback for non-content shapes.
  function handleJsonChange(text: string) {
    setRaw(text)
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setJsonError(null)
        onChange(parsed as Record<string, unknown>)
      } else {
        setJsonError('Must be a JSON object')
      }
    } catch {
      setJsonError('Invalid JSON')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        data-testid="property-override-editor-textarea"
        style={{
          width: '100%',
          resize: 'vertical',
          borderRadius: 5,
          border: `1px solid ${jsonError ? STUDIO_COLORS.dangerFg : '#d1d5db'}`,
          padding: '8px',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 11.5,
          lineHeight: 1.55,
          minHeight: 200,
        }}
        rows={14}
        value={raw}
        onChange={(e) => handleJsonChange(e.target.value)}
        spellCheck={false}
      />
      {jsonError ? (
        <div
          data-testid="property-override-editor-json-error"
          style={{
            fontSize: 11.5,
            color: STUDIO_COLORS.dangerFg,
            fontWeight: 500,
          }}
        >
          {jsonError}
        </div>
      ) : null}
    </div>
  )
}
