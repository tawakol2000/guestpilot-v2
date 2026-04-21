'use client'

/**
 * Sprint 055-A F2 — inline System-Prompt body editor.
 *
 * `SystemPromptView` renders `artifact.body` (which maps to `content`
 * in the stored SOP/FAQ style, but system prompts use `text` on the
 * wire). We try `value.text` first (write-tool shape), then
 * `value.content` (legacy/override shape), then fall back to
 * JSON serialisation.
 */

export function SystemPromptEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const isTextBased = typeof value.text === 'string'
  const bodyText =
    typeof value.text === 'string'
      ? value.text
      : typeof value.content === 'string'
      ? value.content
      : JSON.stringify(value, null, 2)

  function handleChange(raw: string) {
    if (isTextBased) {
      onChange({ ...value, text: raw })
    } else {
      onChange({ ...value, content: raw })
    }
  }

  return (
    <textarea
      data-testid="system-prompt-editor-textarea"
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
        minHeight: 220,
      }}
      rows={14}
      value={bodyText}
      onChange={(e) => handleChange(e.target.value)}
    />
  )
}
