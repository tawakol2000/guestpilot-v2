'use client'

// Feature 043 — Settings section for editing per-tenant reply templates.
//
// Lists every (escalationType, decision) pair the system supports, with an
// editable textarea. Save upserts the row; Revert deletes it (falling back
// to the system default). isDefault pill indicates unedited rows.
import { useCallback, useEffect, useState } from 'react'
import {
  apiListReplyTemplates,
  apiUpdateReplyTemplate,
  apiDeleteReplyTemplate,
  type ReplyTemplate,
} from '@/lib/api'

const VARIABLE_HINTS = [
  '{GUEST_FIRST_NAME}',
  '{REQUESTED_TIME}',
  '{PROPERTY_NAME}',
  '{CHECK_IN_TIME}',
  '{CHECK_OUT_TIME}',
]

function humanType(type: string): string {
  switch (type) {
    case 'late_checkout_request':
      return 'Late checkout'
    case 'early_checkin_request':
      return 'Early check-in'
    default:
      return type.replace(/_/g, ' ')
  }
}

function humanDecision(decision: string): string {
  return decision === 'approve' ? 'Approval' : 'Rejection'
}

export default function AutomatedRepliesSection(): React.ReactElement {
  const [templates, setTemplates] = useState<ReplyTemplate[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    apiListReplyTemplates()
      .then((res) => {
        setTemplates(res.templates)
        const d: Record<string, string> = {}
        for (const t of res.templates) {
          d[`${t.escalationType}::${t.decision}`] = t.body
        }
        setDrafts(d)
      })
      .catch((err: any) => setError(err?.message || 'Failed to load templates'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onSave(t: ReplyTemplate) {
    const key = `${t.escalationType}::${t.decision}`
    const body = (drafts[key] ?? '').trim()
    if (!body) {
      setError('Template body cannot be empty')
      return
    }
    setSaving((s) => ({ ...s, [key]: true }))
    setError(null)
    try {
      await apiUpdateReplyTemplate(t.escalationType, t.decision, body)
      setSaved((s) => ({ ...s, [key]: true }))
      setTimeout(() => setSaved((s) => ({ ...s, [key]: false })), 2000)
      load()
    } catch (err: any) {
      setError(err?.message || 'Failed to save')
    } finally {
      setSaving((s) => ({ ...s, [key]: false }))
    }
  }

  async function onRevert(t: ReplyTemplate) {
    const key = `${t.escalationType}::${t.decision}`
    setSaving((s) => ({ ...s, [key]: true }))
    setError(null)
    try {
      await apiDeleteReplyTemplate(t.escalationType, t.decision)
      load()
    } catch (err: any) {
      setError(err?.message || 'Failed to revert')
    } finally {
      setSaving((s) => ({ ...s, [key]: false }))
    }
  }

  if (!templates) {
    return <div style={{ fontSize: 13, color: '#999' }}>Loading automated replies…</div>
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 1.5 }}>
        Edit the messages sent to guests when the AI auto-accepts or when you click Accept / Reject
        on an escalation card. Variables in curly braces substitute at send time.
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: '#fee', color: '#c00', fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ fontSize: 11, color: '#999', marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>Variables:</span>{' '}
        {VARIABLE_HINTS.map((v) => (
          <code key={v} style={{ marginRight: 8, fontSize: 11, background: '#f5f5f4', padding: '1px 4px', borderRadius: 3 }}>
            {v}
          </code>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        {templates.map((t) => {
          const key = `${t.escalationType}::${t.decision}`
          const draft = drafts[key] ?? ''
          const dirty = draft !== t.body
          return (
            <div
              key={key}
              style={{
                border: '1px solid #e5e5e5',
                borderRadius: 8,
                padding: 12,
                background: '#fff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {humanType(t.escalationType)} — {humanDecision(t.decision)}
                </span>
                {t.isDefault && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: '#999',
                      background: '#f5f5f4',
                      padding: '1px 6px',
                      borderRadius: 4,
                    }}
                  >
                    Default
                  </span>
                )}
                {!t.isDefault && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: '#2563EB',
                      background: '#2563EB1A',
                      padding: '1px 6px',
                      borderRadius: 4,
                    }}
                  >
                    Edited
                  </span>
                )}
              </div>

              <textarea
                value={draft}
                onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                rows={3}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: 8,
                  border: '1px solid #e5e5e5',
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.5,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />

              <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                <button
                  onClick={() => onSave(t)}
                  disabled={!dirty || saving[key]}
                  style={{
                    padding: '5px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    border: 'none',
                    borderRadius: 6,
                    background: !dirty || saving[key] ? '#e5e5e5' : '#1D4ED8',
                    color: !dirty || saving[key] ? '#999' : '#fff',
                    cursor: !dirty || saving[key] ? 'not-allowed' : 'pointer',
                  }}
                >
                  {saving[key] ? 'Saving…' : 'Save'}
                </button>
                {!t.isDefault && (
                  <button
                    onClick={() => onRevert(t)}
                    disabled={saving[key]}
                    style={{
                      padding: '5px 12px',
                      fontSize: 12,
                      fontWeight: 500,
                      border: '1px solid #e5e5e5',
                      borderRadius: 6,
                      background: 'transparent',
                      color: '#666',
                      cursor: saving[key] ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Revert to default
                  </button>
                )}
                {saved[key] && <span style={{ fontSize: 11, color: '#15803D' }}>Saved</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
