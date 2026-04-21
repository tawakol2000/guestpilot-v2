'use client'

/**
 * Sprint 055-A F2 — inline Tool definition editor.
 *
 * Tool definitions are JSON-heavy. Renders a full JSON textarea.
 * Only calls `onChange` when the JSON is valid; shows an inline
 * "Invalid JSON" warning otherwise.
 */
import { useState } from 'react'
import { STUDIO_COLORS } from '../tokens'

export function ToolEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)

  function handleChange(text: string) {
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
        data-testid="tool-editor-textarea"
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
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
      />
      {jsonError ? (
        <div
          data-testid="tool-editor-json-error"
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
