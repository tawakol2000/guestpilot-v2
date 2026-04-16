'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  apiGetProperties,
  apiListToolDefinitions,
  apiListTuningSuggestions,
  getToken,
  type ApiProperty,
  type TuningSuggestion,
  type ToolDefinitionSummary,
} from '@/lib/api'
import { connectSocket, socket } from '@/lib/socket'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { TuningQueue } from '@/components/tuning/queue'
import { DetailPanel } from '@/components/tuning/detail-panel'
import { DashboardsPanel } from '@/components/tuning/dashboards'
import { ConversationList } from '@/components/tuning/conversation-list'
import { ChatPanel } from '@/components/tuning/chat-panel'
import { Quickstart } from '@/components/tuning/quickstart'
import { categoryAccent, CATEGORY_STYLES } from '@/components/tuning/tokens'
import type { TuningDiagnosticCategory } from '@/lib/api'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

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
  const [queueError, setQueueError] = useState<string | null>(null)
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
    setQueueError(null)
    try {
      const res = await apiListTuningSuggestions({ status: 'PENDING', limit: 100 })
      setSuggestions(res.suggestions)
    } catch (e) {
      // Sprint-07 bug fix — previously the error was swallowed silently and
      // the UI fell through to the "All caught up" empty state, which is
      // misleading when the API is unreachable. Surface the failure in the
      // left-rail header with a retry.
      setQueueError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Sprint 05 §5 (C20): live queue refresh. Backend broadcasts
  // `tuning_suggestion_updated` to the tenant room on every accept/reject/
  // tool-config edit. We subscribe and refetch — debounced to ≤1/s so a burst
  // of accepts in another tab doesn't hammer the list endpoint.
  useEffect(() => {
    const token = getToken()
    if (!token) return
    connectSocket(token)
    let lastRefetch = 0
    let pending: ReturnType<typeof setTimeout> | null = null
    const onUpdate = () => {
      const now = Date.now()
      const since = now - lastRefetch
      if (since >= 1000) {
        lastRefetch = now
        refresh()
      } else if (!pending) {
        pending = setTimeout(() => {
          lastRefetch = Date.now()
          pending = null
          refresh()
        }, 1000 - since)
      }
    }
    socket.on('tuning_suggestion_updated', onUpdate)
    return () => {
      socket.off('tuning_suggestion_updated', onUpdate)
      if (pending) clearTimeout(pending)
    }
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

  // Auto-select the first item when nothing is selected, OR when the
  // currently-pinned selectedId no longer exists in the queue (e.g.
  // another tab accepted/dismissed it via SSE).
  //
  // Bug fix (round 5): earlier this fired only when `!selectedId`, so if
  // another tab accepted the current suggestion the URL still pinned a
  // dead id and we'd render <Quickstart/> even though there were still
  // pending suggestions to review.
  useEffect(() => {
    if (loading) return
    if (suggestions.length === 0) return
    const stillExists = !!selectedId && suggestions.some((s) => s.id === selectedId)
    if (!stillExists) setSelected(suggestions[0].id)
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

  // Sprint 05 §6 (C18): mobile drawer for left rail below 768px. Same content
  // as the desktop aside; trigger lives in the top nav. Auto-close on select
  // so a tap-through doesn't leave the drawer open over the detail panel.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const leftRailContent = (
    <>
      <div className="border-b border-[#E5E7EB] px-5 py-4">
        <div className="flex items-baseline justify-between">
          <div className="text-sm font-semibold text-[#1A1A1A]">Pending suggestions</div>
          <div className="text-xs font-medium text-[#9CA3AF]">
            {loading ? '…' : queueError ? '—' : `${suggestions.length}`}
          </div>
        </div>
        <CompositionStrip suggestions={suggestions} loading={loading} />
      </div>
      <div className="flex-1 overflow-auto">
        {queueError ? (
          <div className="mx-3 mt-3 rounded-lg bg-white p-4 text-center">
            <p className="text-xs text-[#6B7280]">Couldn&rsquo;t load suggestions.</p>
            <p className="mt-1 truncate text-[10px] font-mono text-[#9CA3AF]" title={queueError}>
              {queueError}
            </p>
            <button
              type="button"
              onClick={refresh}
              className="mt-2 rounded-md px-2 py-1 text-xs font-medium text-[#6C5CE7] transition-colors hover:bg-[#F0EEFF]"
            >
              Retry
            </button>
          </div>
        ) : (
          <TuningQueue
            suggestions={suggestions}
            loading={loading}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelected(id)
              setDrawerOpen(false)
            }}
          />
        )}
      </div>
      <div className="border-t border-[#E5E7EB]">
        <ConversationList
          selectedId={conversationId}
          onSelect={(id) => {
            setConversation(id)
            setDrawerOpen(false)
          }}
          onCreated={(id) => {
            setConversation(id)
            setDrawerOpen(false)
          }}
        />
      </div>
    </>
  )

  return (
    <div className="flex min-h-dvh flex-col">
      <TuningTopNav onOpenDrawer={() => setDrawerOpen(true)} />
      {/* Mobile drawer — visible only below md (handled by the trigger
          rendering md:hidden in TuningTopNav). Sheet portals to body so the
          aside flex layout below is unaffected. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="top"
          className="flex h-[85vh] w-full max-w-full flex-col overflow-hidden bg-[#F9FAFB] p-0"
        >
          <SheetTitle className="sr-only">Pending suggestions</SheetTitle>
          <div
            aria-hidden
            className="mx-auto mt-2 mb-1 h-1 w-10 rounded-full"
            style={{ background: '#D1D5DB' }}
          />
          {leftRailContent}
        </SheetContent>
      </Sheet>
      <div className="flex flex-1 overflow-hidden">
        {/* Left rail — queue + reserved chat seam (desktop only) */}
        <aside className="hidden w-[320px] shrink-0 flex-col border-r border-[#E5E7EB] bg-[#F9FAFB] md:flex">
          {leftRailContent}
        </aside>

        {/* Center — detail panel, or chat when a conversation is selected */}
        <main
          id="tuning-detail-main"
          tabIndex={-1}
          className="flex-1 overflow-hidden bg-[#F9FAFB] outline-none"
        >
          {conversationId ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-3 border-b border-[#E5E7EB] bg-white px-5 py-3">
                <button
                  type="button"
                  onClick={() => setConversation(null)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A]"
                >
                  <span aria-hidden>←</span>
                  <span>Back to queue</span>
                </button>
                <span className="text-sm font-medium text-[#1A1A1A]">Tuning chat</span>
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
              {selected ? (
                <DetailPanel
                  suggestion={selected}
                  properties={properties}
                  tools={tools}
                  onMutated={handleMutated}
                />
              ) : (
                <Quickstart
                  pendingCount={suggestions.length}
                  loading={loading}
                  onOpenConversation={setConversation}
                />
              )}
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

/**
 * Sprint 07 — a thin stacked composition strip under the queue header.
 * One segment per diagnostic category, width proportional to count,
 * colored by the CATEGORY_ACCENT hue. Legacy/null-category items fall
 * into the shared "Legacy" slot at the end. Hovering a segment shows
 * "{label} · {count}" as a native tooltip so we don't ship a bespoke
 * tooltip primitive for this.
 */
function CompositionStrip({
  suggestions,
  loading,
}: {
  suggestions: TuningSuggestion[]
  loading: boolean
}) {
  if (loading || suggestions.length === 0) {
    return (
      <div
        className="mt-3 h-1.5 w-full rounded-full"
        style={{ background: '#F3F4F6' }}
        aria-hidden
      />
    )
  }
  type Bucket = { key: string; label: string; count: number; color: string }
  const buckets = new Map<string, Bucket>()
  for (const s of suggestions) {
    const cat = s.diagnosticCategory as TuningDiagnosticCategory | null
    const key = cat ?? 'LEGACY'
    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    buckets.set(key, {
      key,
      label: cat ? CATEGORY_STYLES[cat]?.label ?? cat : 'Legacy',
      count: 1,
      color: categoryAccent(cat),
    })
  }
  const ordered = Array.from(buckets.values()).sort((a, b) => b.count - a.count)
  const total = suggestions.length
  return (
    <div
      className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full"
      role="img"
      aria-label={`Queue composition: ${ordered.map((b) => `${b.count} ${b.label}`).join(', ')}`}
    >
      {ordered.map((b, i) => {
        const pct = (b.count / total) * 100
        return (
          <span
            key={b.key}
            title={`${b.label} · ${b.count}`}
            className="h-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{
              width: `${pct}%`,
              background: b.color,
              marginLeft: i === 0 ? 0 : 1,
            }}
          />
        )
      })}
    </div>
  )
}

export default function TuningPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-[#F9FAFB]">
          <span className="text-sm text-[#9CA3AF]">Loading…</span>
        </div>
      }
    >
      <TuningAuthGate>
        <TuningPageInner />
      </TuningAuthGate>
    </Suspense>
  )
}
