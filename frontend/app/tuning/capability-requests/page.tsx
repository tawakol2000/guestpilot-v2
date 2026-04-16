'use client'

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  apiListCapabilityRequests,
  apiUpdateCapabilityRequest,
  type CapabilityRequest,
  type CapabilityRequestStatus,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { RelativeTime } from '@/components/tuning/relative-time'
import { TUNING_COLORS } from '@/components/tuning/tokens'

const STATUS_OPTIONS: CapabilityRequestStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX']

const STATUS_STYLE: Record<CapabilityRequestStatus, { bg: string; fg: string; label: string }> = {
  OPEN:        { bg: '#FFEDD5', fg: '#9A3412', label: 'Open' },
  IN_PROGRESS: { bg: '#DBEAFE', fg: '#1E40AF', label: 'In progress' },
  RESOLVED:    { bg: '#CCFBF1', fg: '#0F766E', label: 'Resolved' },
  WONT_FIX:    { bg: '#F3F4F6', fg: '#6B7280', label: "Won't fix" },
}

function CapabilityRow({
  req,
  onChange,
}: {
  req: CapabilityRequest
  onChange: () => void
}) {
  const [status, setStatus] = useState<CapabilityRequestStatus>(req.status)
  const [saving, setSaving] = useState(false)
  const style = STATUS_STYLE[status]

  async function save(next: CapabilityRequestStatus) {
    setSaving(true)
    try {
      await apiUpdateCapabilityRequest(req.id, next)
      setStatus(next)
      onChange()
    } catch {
      // silent — UI keeps prior state
    } finally {
      setSaving(false)
    }
  }

  return (
    <li
      className="py-5"
      style={{ borderBottom: `1px solid ${TUNING_COLORS.hairlineSoft}` }}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-2.5 py-0.5 text-xs font-medium"
              style={{ background: style.bg, color: style.fg }}
            >
              {style.label}
            </span>
            <span className="text-xs text-[#9CA3AF]">
              <RelativeTime iso={req.createdAt} />
            </span>
          </div>
          <h3 className="mt-2 text-base font-semibold tracking-tight text-[#1A1A1A]">
            {req.title}
          </h3>
          <p className="mt-1 text-sm leading-6 text-[#6B7280]">{req.description}</p>
          {req.rationale ? (
            <p className="mt-1 text-xs italic leading-5 text-[#9CA3AF]">{req.rationale}</p>
          ) : null}
          {req.sourceConversationId ? (
            <a
              href={`/?conversationId=${req.sourceConversationId}`}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-[#6C5CE7] transition-colors duration-150 hover:bg-[#F0EEFF]"
            >
              <span>Source conversation</span>
              <ExternalLink size={11} strokeWidth={2} aria-hidden />
            </a>
          ) : null}
        </div>
        <div className="shrink-0">
          <select
            value={status}
            disabled={saving}
            onChange={(e) => save(e.target.value as CapabilityRequestStatus)}
            className="rounded-lg border bg-white px-2.5 py-1.5 text-xs font-medium text-[#1A1A1A] outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF] disabled:opacity-60"
            style={{ borderColor: TUNING_COLORS.hairline }}
            aria-label="Change status"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_STYLE[s].label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </li>
  )
}

function CapabilityRequestsInner() {
  const [requests, setRequests] = useState<CapabilityRequest[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiListCapabilityRequests()
      setRequests(res.requests)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex min-h-dvh flex-col">
      <TuningTopNav />
      <main className="mx-auto w-full max-w-3xl px-6 py-10 md:px-8">
        <header className="space-y-2">
          <div className="text-xs font-medium text-[#6B7280]">Capability requests</div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
            What the AI wished it had
          </h1>
          <p className="max-w-prose text-sm leading-6 text-[#6B7280]">
            Suggestions tagged <em className="not-italic font-medium">missing capability</em>{' '}
            route here instead of becoming artifact edits. They&rsquo;re a
            backlog for engineering — not something the tuning agent can fix
            on its own.
          </p>
        </header>

        <ul className="mt-8">
          {loading ? (
            <li className="py-6 text-sm text-[#9CA3AF]">Loading…</li>
          ) : requests.length === 0 ? (
            <li className="py-10 text-center">
              <p className="text-base font-medium text-[#6B7280]">No requests yet</p>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                The diagnostic pipeline files one here when the AI needs a tool
                that doesn&rsquo;t exist.
              </p>
            </li>
          ) : (
            requests.map((r) => <CapabilityRow key={r.id} req={r} onChange={load} />)
          )}
        </ul>
      </main>
    </div>
  )
}

export default function CapabilityRequestsPage() {
  return (
    <TuningAuthGate>
      <CapabilityRequestsInner />
    </TuningAuthGate>
  )
}
