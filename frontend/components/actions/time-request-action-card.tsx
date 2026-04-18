'use client'

// Feature 043 — TimeRequestActionCard.
//
// Generic Accept/Reject → editable preview → Send/Cancel UI for action-card
// escalations that carry a requested time in Task.metadata (late_checkout /
// early_checkin at launch; any future type with the same shape reuses this).
import { useCallback, useState } from 'react'
import { Check, X as XIcon, Send as SendIcon, AlertTriangle, Loader2 } from 'lucide-react'
import {
  apiPreviewTaskReply,
  apiAcceptTask,
  apiRejectTask,
  type ApiTask,
} from '@/lib/api'
import type { ActionCardProps } from './action-card-registry'

function friendlyTime(time: string | null | undefined): string {
  if (!time) return ''
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return time
  let h = parseInt(m[1], 10)
  const min = m[2]
  if (Number.isNaN(h) || h < 0 || h > 23) return time
  const period = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${min} ${period}`
}

function titleFor(task: ApiTask): string {
  const kind = task.metadata?.kind
  const t = friendlyTime(task.metadata?.requestedTime)
  if (kind === 'check_out') return `Late checkout · ${t || 'time pending'}`
  if (kind === 'check_in') return `Early check-in · ${t || 'time pending'}`
  // Fallback for future types reusing this card.
  return `${task.type.replace(/_/g, ' ')} · ${t || 'pending'}`
}

type Stage = 'idle' | 'preview-approve' | 'preview-reject' | 'sending'

const T = {
  bg: { primary: '#FFFFFF', secondary: '#F2F2F2', tertiary: '#E8E8E8' },
  text: { primary: '#0A0A0A', secondary: '#666666', tertiary: '#999999' },
  accent: '#0070F3',
  status: { green: '#30A46C', red: '#E5484D', amber: '#FFB224' },
  border: { default: '#E5E5E5' },
} as const

export default function TimeRequestActionCard({
  task,
  onResolved,
  onReservationUpdated,
}: ActionCardProps) {
  const [stage, setStage] = useState<Stage>('idle')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const openPreview = useCallback(
    async (decision: 'approve' | 'reject') => {
      setError(null)
      setLoading(true)
      try {
        const res = await apiPreviewTaskReply(task.id, decision)
        setDraft(res.body || '')
        setStage(decision === 'approve' ? 'preview-approve' : 'preview-reject')
      } catch (err: any) {
        setError(err?.message || 'Failed to load template')
      } finally {
        setLoading(false)
      }
    },
    [task.id]
  )

  const cancelPreview = useCallback(() => {
    setStage('idle')
    setDraft('')
    setError(null)
  }, [])

  const send = useCallback(async () => {
    if (!draft.trim()) {
      setError('Message cannot be empty')
      return
    }
    setError(null)
    setStage('sending')
    try {
      const decision = stage === 'preview-approve' ? 'approve' : 'reject'
      const api = decision === 'approve' ? apiAcceptTask : apiRejectTask
      const res = await api(task.id, draft.trim())
      if (decision === 'approve' && res.reservation) {
        onReservationUpdated?.(res.reservation)
      }
      onResolved(task.id)
    } catch (err: any) {
      setError(err?.message || 'Failed to send')
      // Keep the preview open so the manager can retry without retyping.
      setStage(stage)
    }
  }, [draft, stage, task.id, onResolved, onReservationUpdated])

  const inPreview = stage === 'preview-approve' || stage === 'preview-reject' || stage === 'sending'

  return (
    <div
      style={{
        background: T.bg.primary,
        border: `1px solid ${T.border.default}`,
        borderRadius: 8,
        marginBottom: 8,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border.default}`, fontSize: 12, fontWeight: 600, color: T.text.primary }}>
        {titleFor(task)}
      </div>

      <div style={{ padding: 12 }}>
        {error && (
          <div
            style={{
              marginBottom: 8,
              padding: '6px 10px',
              borderRadius: 6,
              background: T.status.red + '14',
              color: T.status.red,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <AlertTriangle size={13} />
            {error}
          </div>
        )}

        {!inPreview && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => openPreview('approve')}
              disabled={loading}
              style={primaryBtn(T.status.green)}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Accept
            </button>
            <button
              onClick={() => openPreview('reject')}
              disabled={loading}
              style={primaryBtn(T.status.red)}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <XIcon size={12} />}
              Reject
            </button>
          </div>
        )}

        {inPreview && (
          <div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              disabled={stage === 'sending'}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: 8,
                border: `1px solid ${T.border.default}`,
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.5,
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button
                onClick={send}
                disabled={stage === 'sending' || !draft.trim()}
                style={primaryBtn(stage === 'preview-approve' ? T.status.green : T.status.red)}
              >
                {stage === 'sending' ? <Loader2 size={12} className="animate-spin" /> : <SendIcon size={12} />}
                Send
              </button>
              <button
                onClick={cancelPreview}
                disabled={stage === 'sending'}
                style={secondaryBtn()}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function primaryBtn(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 10px',
    borderRadius: 6,
    border: `1px solid ${color}`,
    background: color + '14',
    color,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  }
}

function secondaryBtn(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #E5E5E5',
    background: 'transparent',
    color: '#666666',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  }
}
