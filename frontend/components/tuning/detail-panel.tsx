'use client'

import { useEffect, useState } from 'react'
import {
  apiGetConversation,
  type ApiConversationDetail,
  type ApiMessage,
  type ApiProperty,
  type TuningSuggestion,
  type ToolDefinitionSummary,
} from '@/lib/api'
import { AcceptControls } from './accept-controls'
import { CategoryPill } from './category-pill'
import { ConfidenceBar } from './confidence-bar'
import { DiffViewer } from './diff-viewer'
import { EvidencePane } from './evidence-pane'
import { RelativeTime } from './relative-time'
import { TUNING_COLORS, triggerLabel } from './tokens'

export function DetailPanel({
  suggestion,
  properties,
  tools,
  onMutated,
}: {
  suggestion: TuningSuggestion | null
  properties: ApiProperty[]
  tools: ToolDefinitionSummary[]
  onMutated: () => void
}) {
  const [convo, setConvo] = useState<ApiConversationDetail | null>(null)
  const [convoLoading, setConvoLoading] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!suggestion?.sourceConversationId) {
      setConvo(null)
      return
    }
    let cancelled = false
    setConvoLoading(true)
    apiGetConversation(suggestion.sourceConversationId)
      .then((d) => !cancelled && setConvo(d))
      .catch(() => {
        /* silent — conversation may be inaccessible on legacy rows */
      })
      .finally(() => !cancelled && setConvoLoading(false))
    return () => {
      cancelled = true
    }
  }, [suggestion?.sourceConversationId])

  useEffect(() => {
    // clear error when switching suggestions
    setError(null)
  }, [suggestion?.id])

  if (!suggestion) {
    return (
      <div className="flex h-full items-center justify-center px-10 py-16 text-center">
        <div>
          <div className="font-[family-name:var(--font-playfair)] text-2xl text-[#57534E]">
            Select a suggestion
          </div>
          <p className="mt-2 text-sm text-[#A8A29E]">
            Pick an item from the queue to see its evidence and proposed change.
          </p>
        </div>
      </div>
    )
  }

  const isLegacy = !suggestion.diagnosticCategory
  const anchorMessage = convo?.messages.find((m) => m.id === suggestion.sourceMessageId) ?? null
  const context = contextAround(convo?.messages ?? [], anchorMessage?.id)

  // For the diff, we prefer (originalAiText || beforeText) vs (sent text || proposedText).
  const beforeText =
    anchorMessage?.originalAiText ??
    suggestion.beforeText ??
    (anchorMessage?.role === 'AI' ? anchorMessage.content : '')
  const afterText =
    suggestion.proposedText ??
    (anchorMessage?.role !== 'AI' ? null : anchorMessage.content)

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-10">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CategoryPill
            category={suggestion.diagnosticCategory}
            subLabel={suggestion.diagnosticSubLabel}
          />
          {suggestion.confidence !== null ? (
            <ConfidenceBar value={suggestion.confidence} />
          ) : null}
          <span className="text-[11px] text-[#A8A29E]">
            <RelativeTime iso={suggestion.createdAt} />
          </span>
          <span className="text-[11px] text-[#A8A29E]">
            {triggerLabel(suggestion.triggerType)}
          </span>
          {suggestion.applyMode ? (
            <span className="rounded-full border border-[#E7E5E4] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[#57534E]">
              {suggestion.applyMode}
            </span>
          ) : null}
        </div>
        <h1 className="font-[family-name:var(--font-playfair)] text-2xl leading-snug text-[#0C0A09]">
          {titleFor(suggestion)}
        </h1>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          {error}
        </div>
      ) : null}

      {isLegacy ? (
        <p className="rounded-md border border-[#E7E5E4] bg-[#F5F4F1] px-4 py-3 text-sm leading-6 text-[#57534E]">
          This is a legacy suggestion written by the old analyzer. Rationale and
          evidence were not captured for it. Accept or dismiss still work; the
          editor below lets you adjust the proposed text before applying.
        </p>
      ) : (
        <section>
          <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">Rationale</div>
          <p
            className="prose prose-stone mt-2 max-w-none text-[15px] leading-7 text-[#0C0A09]"
            style={{ fontFamily: 'inherit' }}
          >
            {suggestion.rationale}
          </p>
        </section>
      )}

      {context.length > 0 ? (
        <section>
          <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
            Conversation context
          </div>
          <ol className="mt-2 space-y-2">
            {context.map((m) => (
              <li
                key={m.id}
                className={
                  'rounded-md border px-3 py-2 text-[13px] leading-6 ' +
                  (m.id === suggestion.sourceMessageId
                    ? 'border-[#1E3A8A]/30 bg-[#EEF2FF]'
                    : 'border-[#E7E5E4] bg-white')
                }
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[#A8A29E]">
                  <span>{m.role}</span>
                  <span>·</span>
                  <span>
                    <RelativeTime iso={m.sentAt} />
                  </span>
                  {m.id === suggestion.sourceMessageId ? (
                    <span className="text-[#1E3A8A]">anchor</span>
                  ) : null}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-[#0C0A09]">{m.content}</div>
              </li>
            ))}
          </ol>
        </section>
      ) : convoLoading ? (
        <div className="h-20 animate-pulse rounded-md bg-[#F5F4F1]" />
      ) : null}

      <section>
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
          Proposed change
        </div>
        <div className="mt-2 space-y-2">
          <DiffViewer
            before={beforeText ?? ''}
            after={afterText ?? ''}
            title={
              suggestion.diagnosticCategory === 'SOP_ROUTING'
                ? 'Tool description'
                : suggestion.diagnosticCategory === 'TOOL_CONFIG'
                  ? 'Tool description'
                  : 'AI draft → proposed'
            }
          />
          {suggestion.evidenceBundleId ? (
            <div>
              <button
                type="button"
                onClick={() => setEvidenceOpen(true)}
                className="text-sm text-[#1E3A8A] underline-offset-2 hover:underline"
              >
                View evidence bundle →
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <AcceptControls
          suggestion={suggestion}
          properties={properties}
          tools={tools}
          onMutated={onMutated}
          onError={setError}
        />
      </section>

      <EvidencePane
        open={evidenceOpen}
        onClose={() => setEvidenceOpen(false)}
        bundleId={suggestion.evidenceBundleId}
      />
    </article>
  )
}

function titleFor(s: TuningSuggestion): string {
  if (s.diagnosticSubLabel) return s.diagnosticSubLabel.replace(/[-_]/g, ' ')
  if (s.sopCategory) return s.sopCategory.replace(/^sop-/, '').replace(/-/g, ' ')
  if (s.faqQuestion) return s.faqQuestion
  if (s.systemPromptVariant) return `${s.systemPromptVariant} prompt`
  return 'Proposed change'
}

function contextAround(all: ApiMessage[], anchorId: string | undefined): ApiMessage[] {
  if (!anchorId || all.length === 0) return []
  const idx = all.findIndex((m) => m.id === anchorId)
  if (idx === -1) return all.slice(Math.max(0, all.length - 6))
  const start = Math.max(0, idx - 4)
  const end = Math.min(all.length, idx + 2)
  return all.slice(start, end)
}
