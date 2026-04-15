'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  apiGetProperties,
  apiListToolDefinitions,
  apiListTuningSuggestions,
  type ApiProperty,
  type TuningSuggestion,
  type ToolDefinitionSummary,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { TuningQueue } from '@/components/tuning/queue'
import { DetailPanel } from '@/components/tuning/detail-panel'
import { DashboardsPanel } from '@/components/tuning/dashboards'
import { ConversationList } from '@/components/tuning/conversation-list'
import { ChatPanel } from '@/components/tuning/chat-panel'

function DashboardsToggleWrapper({
  children,
}: {
  children: (open: boolean, setOpen: (v: boolean) => void) => React.ReactNode
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    if (window.innerWidth < 1024) return false
    const saved = localStorage.getItem('gp_tuning_dashboards_open')
    if (saved === null) return true
    return saved === '1'
  })
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('gp_tuning_dashboards_open', open ? '1' : '0')
    }
  }, [open])
  return <>{children(open, setOpen)}</>
}

function TuningPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [suggestions, setSuggestions] = useState<TuningSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [tools, setTools] = useState<ToolDefinitionSummary[]>([])

  const selectedId = searchParams.get('suggestionId')
  const conversationId = searchParams.get('conversationId')
  const selected = useMemo(
    () => suggestions.find((s) => s.id === selectedId) ?? null,
    [suggestions, selectedId],
  )

  const setConversation = useCallback(
    (id: string | null) => {
      const qs = new URLSearchParams(Array.from(searchParams.entries()))
      if (id) qs.set('conversationId', id)
      else qs.delete('conversationId')
      router.replace(`/tuning${qs.toString() ? `?${qs.toString()}` : ''}`, { scroll: false })
    },
    [router, searchParams],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiListTuningSuggestions({ status: 'PENDING', limit: 100 })
      setSuggestions(res.suggestions)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Properties + tools are needed for the dispatch dialogs. Both endpoints
  // degrade silently — missing data just means the select boxes are empty.
  useEffect(() => {
    apiGetProperties().then(setProperties).catch(() => setProperties([]))
    apiListToolDefinitions().then(setTools).catch(() => setTools([]))
  }, [])

  const setSelected = useCallback(
    (id: string | null) => {
      const qs = new URLSearchParams(Array.from(searchParams.entries()))
      if (id) qs.set('suggestionId', id)
      else qs.delete('suggestionId')
      router.replace(`/tuning${qs.toString() ? `?${qs.toString()}` : ''}`, { scroll: false })
    },
    [router, searchParams],
  )

  // Keyboard nav: j/k through the queue, Enter focuses detail.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return
      if (target?.isContentEditable) return
      if (suggestions.length === 0) return
      const idx = Math.max(0, suggestions.findIndex((s) => s.id === selectedId))
      if (ev.key === 'j') {
        const next = suggestions[Math.min(suggestions.length - 1, idx + 1)]
        if (next) setSelected(next.id)
      } else if (ev.key === 'k') {
        const prev = suggestions[Math.max(0, idx - 1)]
        if (prev) setSelected(prev.id)
      } else if (ev.key === 'Enter') {
        const main = document.getElementById('tuning-detail-main')
        if (main) main.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [suggestions, selectedId, setSelected])

  // Auto-select the first item when nothing is selected.
  useEffect(() => {
    if (!loading && !selectedId && suggestions.length > 0) {
      setSelected(suggestions[0].id)
    }
  }, [loading, selectedId, suggestions, setSelected])

  const handleMutated = useCallback(async () => {
    // After accept/reject, refresh and select the next pending item if any.
    const currentId = selectedId
    await refresh()
    // state update is async; setTimeout lets next render happen first
    setTimeout(() => {
      setSuggestions((list) => {
        const remaining = list.filter((s) => s.id !== currentId)
        if (remaining.length > 0) setSelected(remaining[0].id)
        else setSelected(null)
        return list
      })
    }, 0)
  }, [refresh, selectedId, setSelected])

  return (
    <div className="flex min-h-dvh flex-col">
      <TuningTopNav />
      <div className="flex flex-1 overflow-hidden">
        {/* Left rail — queue + reserved chat seam */}
        <aside className="hidden w-[300px] shrink-0 flex-col border-r border-[#E7E5E4] bg-[#FAFAF9] md:flex">
          <div className="border-b border-[#E7E5E4] px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
              Pending suggestions
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-[#A8A29E]">
              {loading ? '…' : `${suggestions.length} open`}
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <TuningQueue
              suggestions={suggestions}
              loading={loading}
              selectedId={selectedId}
              onSelect={setSelected}
            />
          </div>
          {/* Sprint 04 — chat history browser */}
          <div className="border-t border-[#E7E5E4]">
            <ConversationList
              selectedId={conversationId}
              onSelect={setConversation}
              onCreated={setConversation}
            />
          </div>
        </aside>

        {/* Center — detail panel, or chat when a conversation is selected */}
        <main
          id="tuning-detail-main"
          tabIndex={-1}
          className="flex-1 overflow-hidden bg-[#FAFAF9] outline-none"
        >
          {conversationId ? (
            <div className="flex h-full flex-col">
              <div
                className="flex items-center gap-2 border-b border-[#E7E5E4] bg-white px-4 py-2"
              >
                <button
                  type="button"
                  onClick={() => setConversation(null)}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-[#1E3A8A] hover:bg-[#EEF2FF]"
                >
                  ← Back to queue
                </button>
                <span className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
                  Tuning chat
                </span>
              </div>
              <div className="flex-1 overflow-hidden">
                <ChatPanel
                  conversationId={conversationId}
                  suggestionId={selectedId}
                />
              </div>
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <DetailPanel
                suggestion={selected}
                properties={properties}
                tools={tools}
                onMutated={handleMutated}
              />
            </div>
          )}
        </main>

        {/* Right rail — dashboards */}
        <DashboardsToggleWrapper>
          {(open, setOpen) => (
            <DashboardsPanel open={open} onToggle={() => setOpen(!open)} />
          )}
        </DashboardsToggleWrapper>
      </div>
    </div>
  )
}

export default function TuningPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-[#FAFAF9]">
          <span className="text-sm text-[#A8A29E]">Loading…</span>
        </div>
      }
    >
      <TuningAuthGate>
        <TuningPageInner />
      </TuningAuthGate>
    </Suspense>
  )
}
