'use client'

/**
 * DiscussButton — opens a tuning chat pinned to the current suggestion.
 *
 * Behavior: creates a fresh TuningConversation anchored to the suggestion's
 * source message id (so the agent can pull the same evidence bundle the
 * detail panel is showing) and routes to /tuning?conversationId=…&suggestionId=…
 * so the page swaps the center pane to <ChatPanel/>.
 *
 * V1 always creates a new conversation. Reuse-by-suggestion is intentionally
 * deferred — the conversation list rail in the bottom-left already makes it
 * easy to return to prior discussions, and reuse semantics ("which prior
 * thread?") are ambiguous when a suggestion has been discussed twice.
 */
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  apiCreateTuningConversation,
  type TuningSuggestion,
} from '@/lib/api'
import { TUNING_COLORS } from '../studio/tokens'

export function DiscussButton({
  suggestion,
  title,
}: {
  suggestion: TuningSuggestion
  title: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [busy, setBusy] = useState(false)

  async function open() {
    if (busy) return
    setBusy(true)
    try {
      const { conversation } = await apiCreateTuningConversation({
        anchorMessageId: suggestion.sourceMessageId,
        triggerType: suggestion.triggerType ?? 'MANUAL',
        title: `Discuss: ${title}`,
      })
      const qs = new URLSearchParams(Array.from(searchParams.entries()))
      qs.set('conversationId', conversation.id)
      qs.set('suggestionId', suggestion.id)
      router.replace(`/tuning?${qs.toString()}`, { scroll: false })
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not start a discussion thread.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-xs font-medium transition-colors duration-150 hover:bg-[#F0EEFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] disabled:opacity-60"
      style={{
        borderColor: TUNING_COLORS.accentMuted,
        color: '#6C5CE7',
      }}
    >
      <MessageSquarePlus size={14} strokeWidth={2} aria-hidden />
      <span>{busy ? 'Opening…' : 'Discuss with tuner'}</span>
    </button>
  )
}
