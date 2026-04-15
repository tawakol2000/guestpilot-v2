'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  apiListCapabilityRequests,
  apiUpdateCapabilityRequest,
  type CapabilityRequest,
  type CapabilityRequestStatus,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { RelativeTime } from '@/components/tuning/relative-time'

const STATUS_OPTIONS: CapabilityRequestStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX']

const STATUS_STYLE: Record<CapabilityRequestStatus, { bg: string; fg: string }> = {
  OPEN:        { bg: '#FFF7ED', fg: '#9A3412' },
  IN_PROGRESS: { bg: '#EFF6FF', fg: '#1E40AF' },
  RESOLVED:    { bg: '#F0FDFA', fg: '#115E59' },
  WONT_FIX:    { bg: '#F5F4F1', fg: '#57534E' },
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
    <li className="border-b border-[#E7E5E4] py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]"
              style={{ background: style.bg, color: style.fg }}
            >
              {status.replace('_', ' ')}
            </span>
            <span className="text-[11px] text-[#A8A29E]">
              <RelativeTime iso={req.createdAt} />
            </span>
          </div>
          <h3 className="mt-1 text-[16px] font-medium text-[#0C0A09]">{req.title}</h3>
          <p className="mt-1 text-[13px] leading-6 text-[#57534E]">
            {req.description}
          </p>
          {req.rationale ? (
            <p className="mt-1 text-[12px] italic leading-5 text-[#A8A29E]">
              {req.rationale}
            </p>
          ) : null}
          {req.sourceConversationId ? (
            <a
              href={`/?conversationId=${req.sourceConversationId}`}
              className="mt-2 inline-block text-[12px] text-[#1E3A8A] hover:underline"
            >
              Source conversation ↗
            </a>
          ) : null}
        </div>
        <div className="shrink-0">
          <select
            value={status}
            disabled={saving}
            onChange={(e) => save(e.target.value as CapabilityRequestStatus)}
            className="rounded-md border border-[#E7E5E4] bg-white px-2 py-1 text-[12px]"
            aria-label="Change status"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
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
      <main className="mx-auto w-full max-w-3xl px-8 py-10">
        <header className="space-y-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
            Capability requests
          </div>
          <h1 className="font-[family-name:var(--font-playfair)] text-3xl text-[#0C0A09]">
            What the AI wished it had
          </h1>
          <p className="max-w-prose text-[14px] text-[#57534E]">
            Suggestions tagged <em>missing capability</em> route here instead of
            becoming artifact edits. They&rsquo;re a backlog for engineering —
            not something the tuning agent can fix on its own.
          </p>
        </header>

        <ul className="mt-6 border-t border-[#E7E5E4]">
          {loading ? (
            <li className="py-6 text-sm text-[#A8A29E]">Loading…</li>
          ) : requests.length === 0 ? (
            <li className="py-10 text-center">
              <p className="font-[family-name:var(--font-playfair)] text-base italic text-[#57534E]">
                No requests yet.
              </p>
              <p className="mt-1 text-xs text-[#A8A29E]">
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
