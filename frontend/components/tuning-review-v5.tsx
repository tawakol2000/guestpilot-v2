/**
 * Feature 040: Copilot Shadow Mode — Tuning Review tab.
 *
 * Lists analyzer-generated tuning suggestions grouped by source preview.
 * Each card shows the action type, root-cause rationale, before/proposed diff
 * (for EDIT actions) or proposed new-artifact fields (for CREATE actions),
 * and Accept / Edit & Accept / Reject buttons.
 *
 * Subscribes to 'tuning_suggestion_created' and 'tuning_suggestion_updated'
 * socket events for live updates.
 */
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  apiListTuningSuggestions,
  apiAcceptTuningSuggestion,
  apiRejectTuningSuggestion,
  apiGetTenantAiConfig,
  type TuningSuggestion,
  type TuningSuggestionStatus,
  type TuningAcceptBody,
} from '@/lib/api'
import { socket } from '../lib/socket'

const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706' },
  border: { default: '#E7E5E4', strong: '#1C1917' },
  shadow: {
    sm: '0 1px 2px rgba(12,10,9,0.04)',
    md: '0 4px 6px -1px rgba(12,10,9,0.06), 0 2px 4px -2px rgba(12,10,9,0.04)',
    lg: '0 10px 25px -5px rgba(12,10,9,0.08), 0 4px 10px -5px rgba(12,10,9,0.03)',
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

type Filter = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'ALL'

const ACTION_LABELS: Record<TuningSuggestion['actionType'], string> = {
  EDIT_SYSTEM_PROMPT: 'Edit system prompt',
  EDIT_SOP_CONTENT: 'Edit SOP content',
  EDIT_SOP_ROUTING: 'Fix SOP routing',
  EDIT_FAQ: 'Edit FAQ entry',
  CREATE_SOP: 'Create new SOP',
  CREATE_FAQ: 'Create new FAQ',
}

const ACTION_COLORS: Record<TuningSuggestion['actionType'], string> = {
  EDIT_SYSTEM_PROMPT: '#2563EB',
  EDIT_SOP_CONTENT: '#7C3AED',
  EDIT_SOP_ROUTING: '#DB2777',
  EDIT_FAQ: '#0891B2',
  CREATE_SOP: '#16A34A',
  CREATE_FAQ: '#EA580C',
}

function targetRefLabel(s: TuningSuggestion): string {
  switch (s.actionType) {
    case 'EDIT_SYSTEM_PROMPT':
      return s.systemPromptVariant === 'screening' ? 'Screening prompt' : 'Coordinator prompt'
    case 'EDIT_SOP_CONTENT':
      return `SOP ${s.sopCategory} @ ${s.sopStatus}${s.sopPropertyId ? ` / property ${s.sopPropertyId}` : ''}`
    case 'EDIT_SOP_ROUTING':
      return `SOP ${s.sopCategory} (classifier routing)`
    case 'EDIT_FAQ':
      return `FAQ entry ${s.faqEntryId}`
    case 'CREATE_SOP':
      return `New SOP: ${s.sopCategory} @ ${s.sopStatus}`
    case 'CREATE_FAQ':
      return `New FAQ in ${s.faqCategory} (${s.faqScope})`
  }
}

export function TuningReviewV5(): React.ReactElement {
  const [suggestions, setSuggestions] = useState<TuningSuggestion[]>([])
  const [filter, setFilter] = useState<Filter>('PENDING')
  const [loading, setLoading] = useState(true)
  const [shadowModeEnabled, setShadowModeEnabled] = useState<boolean>(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState<TuningAcceptBody>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  function showToast(type: 'success' | 'error', message: string): void {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
  }

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const res = await apiListTuningSuggestions({ status: filter, limit: 100 })
      setSuggestions(res.suggestions)
    } catch (err) {
      console.error('[TuningReview] list failed:', err)
      showToast('error', 'Failed to load suggestions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    apiGetTenantAiConfig()
      .then(cfg => setShadowModeEnabled(Boolean(cfg.shadowModeEnabled)))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // Socket subscriptions for live updates.
  // The socket is already connected by inbox-v5.tsx (the parent page); we only
  // attach listeners here — no need to call connectSocket() a second time.
  useEffect(() => {
    const onCreated = (data: any): void => {
      if (filter !== 'PENDING' && filter !== 'ALL') return
      // Simple approach: refetch. The response is small.
      load()
    }
    const onUpdated = (data: any): void => {
      setSuggestions(prev =>
        prev.map(s => (s.id === data.suggestionId ? { ...s, status: data.status as TuningSuggestionStatus } : s))
      )
    }
    socket.on('tuning_suggestion_created', onCreated)
    socket.on('tuning_suggestion_updated', onUpdated)
    return () => {
      socket.off('tuning_suggestion_created', onCreated)
      socket.off('tuning_suggestion_updated', onUpdated)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  async function handleAccept(s: TuningSuggestion, editPayload?: TuningAcceptBody): Promise<void> {
    setBusyId(s.id)
    try {
      await apiAcceptTuningSuggestion(s.id, editPayload ?? {})
      setEditingId(null)
      setEditBuffer({})
      showToast('success', 'Applied')
      // Refetch or optimistically update
      setSuggestions(prev => prev.map(x => (x.id === s.id ? { ...x, status: 'ACCEPTED' } : x)))
    } catch (err: any) {
      console.error('[TuningReview] accept failed:', err)
      showToast('error', err?.body?.error || 'Accept failed')
    } finally {
      setBusyId(null)
    }
  }

  async function handleReject(s: TuningSuggestion): Promise<void> {
    setBusyId(s.id)
    try {
      await apiRejectTuningSuggestion(s.id)
      showToast('success', 'Rejected')
      setSuggestions(prev => prev.map(x => (x.id === s.id ? { ...x, status: 'REJECTED' } : x)))
    } catch (err: any) {
      console.error('[TuningReview] reject failed:', err)
      showToast('error', 'Reject failed')
    } finally {
      setBusyId(null)
    }
  }

  // Group by sourceMessageId
  const grouped = useMemo(() => {
    const groups = new Map<string, TuningSuggestion[]>()
    for (const s of suggestions) {
      if (!groups.has(s.sourceMessageId)) groups.set(s.sourceMessageId, [])
      groups.get(s.sourceMessageId)!.push(s)
    }
    return Array.from(groups.entries())
  }, [suggestions])

  return (
    <div style={{ padding: 20, maxWidth: 960, margin: '0 auto', fontFamily: T.font.sans }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: T.text.primary, margin: 0 }}>Tuning Suggestions</h2>
          <p style={{ fontSize: 13, color: T.text.secondary, margin: '4px 0 0' }}>
            AI-generated proposals from edited shadow previews. Accept, reject, or edit-then-accept each one.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['PENDING', 'ACCEPTED', 'REJECTED', 'ALL'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                color: filter === f ? '#fff' : T.text.secondary,
                background: filter === f ? T.accent : T.bg.secondary,
                border: `1px solid ${filter === f ? T.accent : T.border.default}`,
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* US4: banner when Shadow Mode is off */}
      {!shadowModeEnabled && (
        <div
          style={{
            padding: '10px 14px',
            background: T.status.amber + '14',
            border: `1px solid ${T.status.amber + '55'}`,
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13,
            color: T.text.primary,
          }}
        >
          Shadow Mode is currently <strong>off</strong>. Historical suggestions remain actionable below.
        </div>
      )}

      {toast && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
            color: '#fff',
            background: toast.type === 'success' ? T.status.green : T.status.red,
          }}
        >
          {toast.message}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: T.text.secondary, padding: 20, textAlign: 'center' }}>Loading…</div>
      ) : grouped.length === 0 ? (
        <div
          style={{
            fontSize: 13,
            color: T.text.secondary,
            padding: 40,
            textAlign: 'center',
            background: T.bg.secondary,
            border: `1px dashed ${T.border.default}`,
            borderRadius: 8,
          }}
        >
          No {filter.toLowerCase()} suggestions. {filter === 'PENDING' && 'Send an edited preview to generate some.'}
        </div>
      ) : (
        grouped.map(([sourceMessageId, group]) => (
          <div
            key={sourceMessageId}
            style={{
              marginBottom: 20,
              padding: 14,
              background: T.bg.primary,
              border: `1px solid ${T.border.default}`,
              borderRadius: 10,
              boxShadow: T.shadow.sm,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: T.text.tertiary,
                fontFamily: T.font.mono,
                marginBottom: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}
            >
              Source preview {sourceMessageId.substring(0, 10)} · {group.length} suggestion{group.length > 1 ? 's' : ''}
            </div>

            {group.map(s => {
              const isEditing = editingId === s.id
              const isBusy = busyId === s.id
              const isActionable = s.status === 'PENDING'
              return (
                <div
                  key={s.id}
                  style={{
                    marginBottom: 10,
                    padding: 12,
                    background: T.bg.secondary,
                    border: `1px solid ${T.border.default}`,
                    borderRadius: 8,
                    opacity: isActionable ? 1 : 0.7,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                        color: '#fff',
                        background: ACTION_COLORS[s.actionType],
                        padding: '3px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {ACTION_LABELS[s.actionType]}
                    </span>
                    <span style={{ fontSize: 12, color: T.text.secondary, fontFamily: T.font.mono }}>
                      {targetRefLabel(s)}
                    </span>
                    {s.status !== 'PENDING' && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: 0.3,
                          color: s.status === 'ACCEPTED' ? T.status.green : T.status.red,
                        }}
                      >
                        {s.status}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 13, color: T.text.primary, marginBottom: 8, lineHeight: 1.5 }}>
                    <strong style={{ color: T.text.secondary }}>Why:</strong> {s.rationale}
                  </div>

                  {/* EDIT actions — show before/proposed diff */}
                  {(s.actionType === 'EDIT_SYSTEM_PROMPT' ||
                    s.actionType === 'EDIT_SOP_CONTENT' ||
                    s.actionType === 'EDIT_SOP_ROUTING' ||
                    s.actionType === 'EDIT_FAQ') && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                          Before
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 8,
                            fontSize: 12,
                            fontFamily: T.font.mono,
                            background: T.status.red + '0D',
                            border: `1px solid ${T.status.red + '40'}`,
                            borderRadius: 4,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            color: T.text.primary,
                            maxHeight: 200,
                            overflow: 'auto',
                          }}
                        >
                          {s.beforeText || s.sopToolDescription || '(empty)'}
                        </pre>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                          Proposed
                        </div>
                        {isEditing ? (
                          <textarea
                            value={editBuffer.editedText ?? (s.proposedText || s.sopToolDescription || '')}
                            onChange={e => setEditBuffer({ ...editBuffer, editedText: e.target.value })}
                            rows={8}
                            style={{
                              width: '100%',
                              padding: 8,
                              fontSize: 12,
                              fontFamily: T.font.mono,
                              border: `1px solid ${T.status.green + '60'}`,
                              borderRadius: 4,
                              resize: 'vertical',
                              outline: 'none',
                              boxSizing: 'border-box',
                            }}
                          />
                        ) : (
                          <pre
                            style={{
                              margin: 0,
                              padding: 8,
                              fontSize: 12,
                              fontFamily: T.font.mono,
                              background: T.status.green + '0D',
                              border: `1px solid ${T.status.green + '40'}`,
                              borderRadius: 4,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color: T.text.primary,
                              maxHeight: 200,
                              overflow: 'auto',
                            }}
                          >
                            {s.proposedText || s.sopToolDescription || '(empty)'}
                          </pre>
                        )}
                      </div>
                    </div>
                  )}

                  {/* CREATE_SOP fields */}
                  {s.actionType === 'CREATE_SOP' && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: T.text.secondary, marginBottom: 4 }}>
                        Category: <code>{s.sopCategory}</code> · Status: <code>{s.sopStatus}</code>
                      </div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginTop: 6, marginBottom: 3, textTransform: 'uppercase' }}>
                        Tool description (classifier)
                      </div>
                      {isEditing ? (
                        <textarea
                          value={editBuffer.editedToolDescription ?? s.sopToolDescription ?? ''}
                          onChange={e => setEditBuffer({ ...editBuffer, editedToolDescription: e.target.value })}
                          rows={2}
                          style={{ width: '100%', padding: 8, fontSize: 12, fontFamily: T.font.mono, border: `1px solid ${T.border.default}`, borderRadius: 4, outline: 'none', boxSizing: 'border-box' }}
                        />
                      ) : (
                        <pre style={{ margin: 0, padding: 8, fontSize: 12, fontFamily: T.font.mono, background: T.bg.primary, border: `1px solid ${T.border.default}`, borderRadius: 4, whiteSpace: 'pre-wrap' }}>{s.sopToolDescription}</pre>
                      )}
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginTop: 6, marginBottom: 3, textTransform: 'uppercase' }}>
                        Content
                      </div>
                      {isEditing ? (
                        <textarea
                          value={editBuffer.editedContent ?? s.proposedText ?? ''}
                          onChange={e => setEditBuffer({ ...editBuffer, editedContent: e.target.value })}
                          rows={6}
                          style={{ width: '100%', padding: 8, fontSize: 12, fontFamily: T.font.mono, border: `1px solid ${T.border.default}`, borderRadius: 4, outline: 'none', boxSizing: 'border-box' }}
                        />
                      ) : (
                        <pre style={{ margin: 0, padding: 8, fontSize: 12, fontFamily: T.font.mono, background: T.bg.primary, border: `1px solid ${T.border.default}`, borderRadius: 4, whiteSpace: 'pre-wrap' }}>{s.proposedText}</pre>
                      )}
                    </div>
                  )}

                  {/* CREATE_FAQ fields */}
                  {s.actionType === 'CREATE_FAQ' && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: T.text.secondary, marginBottom: 4 }}>
                        Category: <code>{s.faqCategory}</code> · Scope: <code>{s.faqScope}</code>
                      </div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginTop: 6, marginBottom: 3, textTransform: 'uppercase' }}>
                        Question
                      </div>
                      {isEditing ? (
                        <textarea
                          value={editBuffer.editedQuestion ?? s.faqQuestion ?? ''}
                          onChange={e => setEditBuffer({ ...editBuffer, editedQuestion: e.target.value })}
                          rows={2}
                          style={{ width: '100%', padding: 8, fontSize: 13, border: `1px solid ${T.border.default}`, borderRadius: 4, outline: 'none', boxSizing: 'border-box' }}
                        />
                      ) : (
                        <div style={{ padding: 8, fontSize: 13, background: T.bg.primary, border: `1px solid ${T.border.default}`, borderRadius: 4 }}>{s.faqQuestion}</div>
                      )}
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.text.tertiary, marginTop: 6, marginBottom: 3, textTransform: 'uppercase' }}>
                        Answer
                      </div>
                      {isEditing ? (
                        <textarea
                          value={editBuffer.editedAnswer ?? s.faqAnswer ?? ''}
                          onChange={e => setEditBuffer({ ...editBuffer, editedAnswer: e.target.value })}
                          rows={4}
                          style={{ width: '100%', padding: 8, fontSize: 13, border: `1px solid ${T.border.default}`, borderRadius: 4, outline: 'none', boxSizing: 'border-box' }}
                        />
                      ) : (
                        <div style={{ padding: 8, fontSize: 13, background: T.bg.primary, border: `1px solid ${T.border.default}`, borderRadius: 4 }}>{s.faqAnswer}</div>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  {isActionable && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        disabled={isBusy}
                        onClick={() => handleAccept(s, isEditing ? editBuffer : undefined)}
                        style={{
                          padding: '5px 14px',
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#fff',
                          background: isBusy ? T.bg.tertiary : T.status.green,
                          border: 'none',
                          borderRadius: 5,
                          cursor: isBusy ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isBusy ? 'Applying…' : isEditing ? 'Accept edited' : 'Accept'}
                      </button>
                      {!isEditing && (
                        <button
                          onClick={() => {
                            setEditingId(s.id)
                            setEditBuffer({})
                          }}
                          style={{
                            padding: '5px 14px',
                            fontSize: 12,
                            fontWeight: 600,
                            color: T.text.primary,
                            background: T.bg.primary,
                            border: `1px solid ${T.border.default}`,
                            borderRadius: 5,
                            cursor: 'pointer',
                          }}
                        >
                          Edit & Accept
                        </button>
                      )}
                      {isEditing && (
                        <button
                          onClick={() => {
                            setEditingId(null)
                            setEditBuffer({})
                          }}
                          style={{
                            padding: '5px 14px',
                            fontSize: 12,
                            fontWeight: 600,
                            color: T.text.secondary,
                            background: 'transparent',
                            border: `1px solid ${T.border.default}`,
                            borderRadius: 5,
                            cursor: 'pointer',
                          }}
                        >
                          Cancel edit
                        </button>
                      )}
                      <button
                        disabled={isBusy}
                        onClick={() => handleReject(s)}
                        style={{
                          padding: '5px 14px',
                          fontSize: 12,
                          fontWeight: 600,
                          color: T.status.red,
                          background: 'transparent',
                          border: `1px solid ${T.status.red + '55'}`,
                          borderRadius: 5,
                          cursor: isBusy ? 'not-allowed' : 'pointer',
                          marginLeft: 'auto',
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
}

export default TuningReviewV5
