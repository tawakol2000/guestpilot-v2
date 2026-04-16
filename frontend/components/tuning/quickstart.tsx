'use client'

/**
 * Feature 041 sprint 07 — Quickstart welcome view.
 *
 * Renders when the manager lands on /tuning with nothing selected — either
 * because the queue is empty or the user has cleared their selection. The
 * surface mirrors Claude Console's Managed Agents Quickstart: a calm
 * "What do you want to tune?" hero above a 2-column grid of template
 * cards, each a single click into the corresponding workflow.
 *
 * No backend schema changes — every card hits an existing endpoint or
 * pushes the user to an existing page.
 */

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowRight,
  BarChart3,
  History,
  Inbox,
  MessageCircle,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { apiCreateTuningConversation } from '@/lib/api'
import { TUNING_COLORS } from './tokens'

type Template = {
  icon: React.ReactNode
  title: string
  description: string
  onRun: () => void | Promise<void>
  pending?: boolean
  disabled?: boolean
}

export function Quickstart({
  pendingCount,
  loading = false,
  onOpenConversation,
}: {
  pendingCount: number
  /**
   * True while the queue is still loading — avoids the "queue is empty right
   * now" copy flashing on first paint before apiListTuningSuggestions
   * resolves. Bug fix: previously showed a misleading empty-state during
   * load.
   */
  loading?: boolean
  onOpenConversation: (id: string) => void
}) {
  const router = useRouter()
  const [starting, setStarting] = useState(false)

  const startChat = useCallback(async () => {
    if (starting) return
    setStarting(true)
    try {
      const { conversation } = await apiCreateTuningConversation({ triggerType: 'MANUAL' })
      onOpenConversation(conversation.id)
    } catch (e) {
      // Bug fix — previously the catch was empty and failures produced a
      // silent "spinner stops, nothing happens" state. Surface via toast
      // so the manager knows something went wrong and can retry.
      toast.error('Could not start a tuning chat', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setStarting(false)
    }
  }, [onOpenConversation, starting])

  const templates: Template[] = [
    {
      icon: <MessageCircle size={16} strokeWidth={1.75} aria-hidden />,
      title: 'Chat with your tuner',
      description:
        'Open a manual conversation. Ask the agent to summarize recent edits or surface patterns across messages.',
      onRun: startChat,
      pending: starting,
    },
    {
      icon: <Inbox size={16} strokeWidth={1.75} aria-hidden />,
      title: 'Review the queue',
      description: loading
        ? 'Checking the queue for new suggestions…'
        : pendingCount > 0
          ? `${pendingCount} suggestion${pendingCount === 1 ? '' : 's'} waiting — pick one and apply, edit, or dismiss.`
          : 'The queue is empty right now. Check back after the next batch of AI replies.',
      onRun: () => router.push('/tuning'),
      // Disable only when we know the queue is truly empty (not while loading).
      disabled: !loading && pendingCount === 0,
    },
    {
      icon: <Wand2 size={16} strokeWidth={1.75} aria-hidden />,
      title: 'Request a capability',
      description:
        'What did the AI wish it could do? File a capability request the engineers pick up from the backlog.',
      onRun: () => router.push('/tuning/capability-requests'),
    },
    {
      icon: <History size={16} strokeWidth={1.75} aria-hidden />,
      title: 'Browse version history',
      description:
        'See every prompt, SOP, FAQ, and tool description change — with one-click rollback to any prior version.',
      onRun: () => router.push('/tuning/history'),
    },
  ]

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12 md:px-8 md:py-16">
      <header className="space-y-3">
        <div className="inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs font-medium text-[#6B7280]" style={{ borderColor: TUNING_COLORS.hairline }}>
          <Sparkles size={11} strokeWidth={2} className="text-[#6C5CE7]" aria-hidden />
          <span>Tuning workspace</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-[#1A1A1A] md:text-4xl">
          What do you want to tune?
        </h1>
        <p className="max-w-prose text-base leading-7 text-[#6B7280]">
          Your tuner pairs with the main AI to catch drift, route misses, and
          missing context. Pick a template below, or select a suggestion from
          the queue to start.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map((t) => (
          <button
            key={t.title}
            type="button"
            onClick={() => {
              if (t.disabled || t.pending) return
              t.onRun()
            }}
            disabled={t.disabled || t.pending}
            className="group relative flex flex-col gap-2 overflow-hidden rounded-xl border bg-white p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#D6D3FF] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:border-[#E5E7EB] disabled:hover:shadow-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            style={{
              borderColor: TUNING_COLORS.hairline,
              boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
            }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{
                background: `radial-gradient(circle, ${TUNING_COLORS.accentSoft} 0%, transparent 70%)`,
              }}
            />
            <div className="flex items-center gap-2.5">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#6C5CE7] transition-colors duration-200 group-hover:bg-[#F0EEFF]"
                style={{ background: TUNING_COLORS.surfaceSunken }}
              >
                {t.pending ? (
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
                  />
                ) : (
                  t.icon
                )}
              </span>
              <span className="text-sm font-semibold text-[#1A1A1A]">{t.title}</span>
              <ArrowRight
                size={14}
                strokeWidth={2}
                className="ml-auto shrink-0 text-[#9CA3AF] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#6C5CE7]"
                aria-hidden
              />
            </div>
            <p className="relative text-sm leading-6 text-[#6B7280]">
              {t.description}
            </p>
          </button>
        ))}
      </div>

      <footer className="flex items-center gap-2 text-xs text-[#9CA3AF]">
        <BarChart3 size={12} strokeWidth={2} aria-hidden />
        <span>Press</span>
        <kbd
          className="inline-flex h-5 min-w-[18px] items-center justify-center rounded border bg-white px-1 font-mono text-[11px] font-medium text-[#6B7280]"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          ?
        </kbd>
        <span>to see keyboard shortcuts · use</span>
        <kbd
          className="inline-flex h-5 min-w-[18px] items-center justify-center rounded border bg-white px-1 font-mono text-[11px] font-medium text-[#6B7280]"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          J
        </kbd>
        <kbd
          className="inline-flex h-5 min-w-[18px] items-center justify-center rounded border bg-white px-1 font-mono text-[11px] font-medium text-[#6B7280]"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          K
        </kbd>
        <span>to navigate</span>
      </footer>
    </div>
  )
}
