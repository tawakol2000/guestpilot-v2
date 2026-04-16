'use client'

import { useEffect, useState } from 'react'
import { Pin } from 'lucide-react'
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
  // Sprint 07: the null-state of this panel moved to <Quickstart/> so the
  // empty center column no longer looks like "nothing happened". This
  // component now always renders an actual suggestion.
  suggestion: TuningSuggestion
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
    <article className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8 md:px-8">
      <div
        className="flex flex-col gap-6 rounded-xl p-6 md:p-8"
        style={{
          background: TUNING_COLORS.surfaceRaised,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryPill category={suggestion.diagnosticCategory} subLabel={null} />
            {suggestion.diagnosticSubLabel ? (
              <span className="text-xs text-[#6B7280]">
                {suggestion.diagnosticSubLabel.replace(/[-_]/g, ' ')}
              </span>
            ) : null}
            {suggestion.confidence !== null ? (
              <ConfidenceBar value={suggestion.confidence} />
            ) : null}
            <span className="text-xs text-[#9CA3AF]">
              <RelativeTime iso={suggestion.createdAt} />
            </span>
            <span className="text-xs text-[#9CA3AF]">·</span>
            <span className="text-xs text-[#6B7280]">
              {triggerLabel(suggestion.triggerType)}
            </span>
            {suggestion.applyMode ? (
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  background: TUNING_COLORS.surfaceSunken,
                  color: TUNING_COLORS.inkMuted,
                }}
              >
                {suggestion.applyMode.toLowerCase()}
              </span>
            ) : null}
          </div>
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-[#1A1A1A]">
            {titleFor(suggestion)}
          </h1>
        </header>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border-l-2 px-4 py-3 text-sm"
            style={{
              background: TUNING_COLORS.dangerBg,
              borderLeftColor: TUNING_COLORS.dangerFg,
              color: TUNING_COLORS.dangerFg,
            }}
          >
            {error}
          </div>
        ) : null}

        {isLegacy ? (
          <p
            className="rounded-lg px-4 py-3 text-sm leading-6"
            style={{
              background: TUNING_COLORS.surfaceSunken,
              color: TUNING_COLORS.inkMuted,
            }}
          >
            This is a legacy suggestion written by the old analyzer. Rationale and
            evidence were not captured for it. Accept or dismiss still work; the
            editor below lets you adjust the proposed text before applying.
          </p>
        ) : (
          <section>
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Rationale</h2>
            <p className="mt-2 max-w-none text-sm leading-7 text-[#1A1A1A]">
              {suggestion.rationale}
            </p>
          </section>
        )}

        {context.length > 0 ? (
          <section>
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Conversation context</h2>
            <ol className="mt-3 space-y-2">
              {context.map((m) => {
                const isAnchor = m.id === suggestion.sourceMessageId
                const isAi = m.role === 'AI'
                return (
                  <li
                    key={m.id}
                    className="rounded-xl px-4 py-3 text-sm leading-6 transition-colors duration-150"
                    style={{
                      background: isAnchor
                        ? TUNING_COLORS.accentSoft
                        : isAi
                          ? TUNING_COLORS.surfaceSunken
                          : TUNING_COLORS.surfaceRaised,
                      border: isAnchor
                        ? `1px solid ${TUNING_COLORS.accentMuted}`
                        : isAi
                          ? 'none'
                          : `1px solid ${TUNING_COLORS.hairlineSoft}`,
                    }}
                  >
                    <div className="flex items-center gap-2 text-xs text-[#9CA3AF]">
                      <span className="font-medium text-[#6B7280]">
                        {isAi ? 'AI' : m.role}
                      </span>
                      <span aria-hidden>·</span>
                      <span>
                        <RelativeTime iso={m.sentAt} />
                      </span>
                      {isAnchor ? (
                        <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#6B7280]">
                          <Pin size={10} strokeWidth={2} aria-hidden />
                          <span>anchor</span>
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-[#1A1A1A]">{m.content}</div>
                  </li>
                )
              })}
            </ol>
          </section>
        ) : convoLoading ? (
          <div
            className="h-20 animate-pulse rounded-lg"
            style={{ background: TUNING_COLORS.surfaceSunken }}
          />
        ) : null}

        <section>
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Proposed change</h2>
          <div className="mt-3 space-y-3">
            <DiffViewer
              before={beforeText ?? ''}
              after={afterText ?? ''}
              title={
                suggestion.diagnosticCategory === 'SOP_ROUTING'
                  ? 'Tool description'
                  : suggestion.diagnosticCategory === 'TOOL_CONFIG'
                    ? 'Tool description'
                    : 'Draft → Proposed'
              }
            />
            {suggestion.evidenceBundleId ? (
              <button
                type="button"
                onClick={() => setEvidenceOpen(true)}
                className="group inline-flex items-center gap-1 text-sm font-medium text-[#6C5CE7] transition-colors duration-150 hover:text-[#5B4CDB]"
              >
                <span>View evidence bundle</span>
                <span
                  aria-hidden
                  className="transition-transform duration-200 group-hover:translate-x-0.5"
                >
                  →
                </span>
              </button>
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
      </div>

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
