'use client'

/**
 * Sprint 055-A F2 — inline SOP body editor.
 *
 * SOP body is stored as `content: string`. Renders a single resizable
 * textarea bound to `value.content`. Falls back to JSON serialisation
 * when the value shape is unexpected (future-proofing).
 */

export function SopEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const content =
    typeof value.content === 'string'
      ? value.content
      : JSON.stringify(value, null, 2)
  return (
    <textarea
      data-testid="sop-editor-textarea"
      className="w-full resize-y rounded border p-2 font-mono text-sm"
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
      value={content}
      onChange={(e) => onChange({ ...value, content: e.target.value })}
    />
  )
}
