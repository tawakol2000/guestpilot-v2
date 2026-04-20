'use client'

import { useEffect, useState } from 'react'
import { Pin } from 'lucide-react'
import {
  apiGetConversation,
  apiGetFaqEntries,
  apiGetSopDefinitions,
  apiGetSopPropertyOverrides,
  apiGetTenantAiConfig,
  apiTuningGraduationMetrics,
  type ApiConversationDetail,
  type ApiMessage,
  type ApiProperty,
  type FaqEntry,
  type SopDefinitionData,
  type SopPropertyOverrideData,
  type TenantAiConfig,
  type TuningDiagnosticCategory,
  type TuningGraduationMetrics,
  type TuningSuggestion,
  type ToolDefinitionSummary,
} from '@/lib/api'
import { AcceptControls } from './accept-controls'
import { CategoryPill } from './category-pill'
import { ConfidenceBar } from './confidence-bar'
import { DiffViewer } from './diff-viewer'
import { DiscussButton } from './discuss-button'
import { EvidencePane } from './evidence-pane'
import { RelativeTime } from './relative-time'
import { TUNING_COLORS, triggerLabel } from '../studio/tokens'

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
  // Sprint 08 §4 — per-category gating state for the low-acceptance banner.
  const [gradMetrics, setGradMetrics] = useState<TuningGraduationMetrics | null>(null)
  useEffect(() => {
    let cancelled = false
    apiTuningGraduationMetrics()
      .then((m) => !cancelled && setGradMetrics(m))
      .catch(() => {
        /* banner just won't render — not fatal */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!suggestion?.sourceConversationId) {
      setConvo(null)
      setConvoLoading(false)
      return
    }
    let cancelled = false
    // Bug fix — clear the previous convo state on id change so the panel
    // doesn't briefly render the PREVIOUS suggestion's transcript while
    // the new one is in flight. anchorMessage.find() would otherwise
    // produce an accidental match on shared message ids.
    setConvo(null)
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
    // clear error + close any open evidence pane when switching suggestions —
    // otherwise a pane opened for suggestion A stays open over suggestion B,
    // refetching B's bundle unexpectedly.
    setError(null)
    setEvidenceOpen(false)
  }, [suggestion?.id])

  const isLegacy = !suggestion.diagnosticCategory
  const anchorMessage = convo?.messages.find((m) => m.id === suggestion.sourceMessageId) ?? null
  const context = contextAround(convo?.messages ?? [], anchorMessage?.id)
  const title = titleFor(suggestion)

  // ── Section ① data: the message edit that triggered the suggestion ──
  // Prefer the anchor message's actual fields (most accurate). Fall back to
  // the suggestion's `beforeText` snapshot only when the anchor isn't loaded
  // yet or for legacy rows where originalAiText wasn't captured.
  const aiDraft =
    anchorMessage?.originalAiText ??
    (suggestion.triggerType === 'EDIT_TRIGGERED' || suggestion.triggerType === 'REJECT_TRIGGERED'
      ? suggestion.beforeText
      : null)
  const sentText = anchorMessage?.content ?? null
  const showReplyDiff = !!aiDraft && !!sentText && aiDraft !== sentText

  // ── Section ② data: the proposed change to the AI flow ──
  const artifact = useArtifactDiff(suggestion)

  return (
    // Compact outer gutters (px-6→5, py-8→5) and tighter card padding
    // (p-6/md:p-8 → p-5/md:p-6). Saves ~48px of vertical space on the
    // opened suggestion view without losing the card breathing room.
    <article className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-5 md:px-6 md:py-6">
      <div
        className="flex flex-col gap-5 rounded-xl p-5 md:p-6"
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
            {title}
          </h1>
        </header>

        {(() => {
          // Sprint 08 §4 — inline warning banner for suggestions whose
          // category is currently gated (acceptance <30% over 30d with
          // ≥5 samples). Lets the manager know the diagnostic quality
          // here is under scrutiny before they accept/reject.
          if (!suggestion.diagnosticCategory || !gradMetrics?.categoryConfidenceGating) return null
          const gating = gradMetrics.categoryConfidenceGating[suggestion.diagnosticCategory]
          if (!gating?.gated) return null
          const rate = gating.acceptanceRate === null ? '—' : `${Math.round(gating.acceptanceRate * 100)}%`
          return (
            <div
              className="rounded-lg px-4 py-3 text-sm"
              style={{
                background: TUNING_COLORS.warnBg,
                color: TUNING_COLORS.warnFg,
              }}
              role="status"
            >
              <strong className="font-semibold">Low acceptance</strong> — consider
              reviewing diagnostic quality for{' '}
              <span className="font-medium">
                {suggestion.diagnosticCategory.toLowerCase().replace(/_/g, ' ')}
              </span>
              . 30d rate: {rate} over {gating.sampleSize} decisions.
            </div>
          )
        })()}

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
                      {/* Bug fix — sentence-case role label rather than raw
                          uppercase enum value (GUEST / HOST / AI_PRIVATE), to
                          match the rest of the /tuning chrome. */}
                      <span className="font-medium text-[#6B7280]">
                        {m.role === 'AI'
                          ? 'AI'
                          : m.role === 'AI_PRIVATE'
                            ? 'AI draft'
                            : m.role === 'GUEST'
                              ? 'Guest'
                              : m.role === 'HOST'
                                ? 'Host'
                                : m.role === 'MANAGER_PRIVATE'
                                  ? 'Manager note'
                                  : String(m.role).toLowerCase()}
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

        {/* ① The edit that triggered this — only when there actually was an
            edit. Suggestions from THUMBS_DOWN / COMPLAINT have no draft to
            compare against, so this section is hidden in those cases. */}
        {showReplyDiff ? (
          <section>
            <h2 className="text-sm font-semibold text-[#1A1A1A]">
              <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#F3F4F6] text-[11px] font-semibold text-[#6B7280]">
                1
              </span>
              The edit that triggered this
            </h2>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              What the AI proposed sending vs. what you actually sent to the guest.
            </p>
            <div className="mt-3">
              <DiffViewer
                plain
                before={aiDraft}
                after={sentText}
                title="Reply"
                leftLabel="AI drafted"
                rightLabel="You sent"
                leftAccent="red"
                rightAccent="green"
              />
            </div>
          </section>
        ) : null}

        {/* ② Proposed change to the AI flow — current artifact text vs the
            tuner's proposed replacement. For categories where there isn't a
            single comparable "current" block (SYSTEM_PROMPT, TOOL_CONFIG),
            the left pane shows a placeholder explaining the apply scope. */}
        <section>
          <h2 className="text-sm font-semibold text-[#1A1A1A]">
            <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#F3F4F6] text-[11px] font-semibold text-[#6B7280]">
              2
            </span>
            Proposed change to the AI flow
          </h2>
          <p className="mt-1 text-xs text-[#9CA3AF]">{artifact.subtitle}</p>
          <div className="mt-3 space-y-3">
            {artifact.loading ? (
              <div
                className="h-20 animate-pulse rounded-lg"
                style={{ background: TUNING_COLORS.surfaceSunken }}
              />
            ) : (
              <DiffViewer
                plain
                before={artifact.currentText}
                after={suggestion.proposedText ?? ''}
                title={artifact.targetLabel}
                leftLabel="Current"
                rightLabel="Proposed"
                leftAccent="muted"
                rightAccent="green"
                leftPlaceholder={artifact.leftPlaceholder}
              />
            )}
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
          {/*
           * Bug fix: key by suggestion.id so <AcceptControls/> remounts on
           * suggestion change. Without this, its internal state (sopStatus,
           * sopPropertyId, toolId, editedText, rejectReason) stays seeded
           * from the PREVIOUS suggestion — users could click Apply and
           * submit dispatch choices that belonged to a different suggestion.
           */}
          <AcceptControls
            key={suggestion.id}
            suggestion={suggestion}
            properties={properties}
            tools={tools}
            sourceConversationPropertyId={convo?.property?.id ?? null}
            sourceConversationPropertyName={convo?.property?.name ?? null}
            onMutated={onMutated}
            onError={setError}
          />
          <div className="mt-3 flex items-center gap-2 border-t pt-3" style={{ borderColor: TUNING_COLORS.hairlineSoft }}>
            <span className="text-xs text-[#9CA3AF]">Not sure?</span>
            <DiscussButton suggestion={suggestion} title={title} />
          </div>
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

// ──────────────────────────────────────────────────────────────────────────
// Section ② data resolver
// Different categories pull "current artifact text" from different sources.
// All loads are best-effort; failures fall back to a placeholder so the
// proposed text is always shown.
// ──────────────────────────────────────────────────────────────────────────

interface ArtifactDiff {
  loading: boolean
  /** Heading shown above the diff (e.g. "Check-in SOP — Confirmed"). */
  targetLabel: string
  /** Sub-caption under the section heading. */
  subtitle: string
  /** Current artifact text. Empty string when unavailable. */
  currentText: string
  /** Italic placeholder for the left pane when currentText is empty. */
  leftPlaceholder?: string
}

function useArtifactDiff(suggestion: TuningSuggestion): ArtifactDiff {
  const [loading, setLoading] = useState(true)
  const [currentText, setCurrentText] = useState<string>('')
  const [targetLabel, setTargetLabel] = useState<string>('Proposed change')
  const [subtitle, setSubtitle] = useState<string>(
    'How the tuner wants to update the AI flow to prevent this in future.'
  )
  const [leftPlaceholder, setLeftPlaceholder] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setCurrentText('')
    setLeftPlaceholder(undefined)
    const category = suggestion.diagnosticCategory
    const fetcher = resolveArtifact(suggestion, category)

    fetcher
      .then((res) => {
        if (cancelled) return
        setCurrentText(res.currentText)
        setTargetLabel(res.targetLabel)
        setSubtitle(res.subtitle)
        setLeftPlaceholder(res.leftPlaceholder)
      })
      .catch(() => {
        if (cancelled) return
        setLeftPlaceholder('Could not load the current text — showing the proposed change only.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion.id])

  return { loading, targetLabel, subtitle, currentText, leftPlaceholder }
}

interface ArtifactResolution {
  targetLabel: string
  subtitle: string
  currentText: string
  leftPlaceholder?: string
}

async function resolveArtifact(
  s: TuningSuggestion,
  category: TuningDiagnosticCategory | null
): Promise<ArtifactResolution> {
  switch (category) {
    case 'SOP_CONTENT':
      return resolveSopContent(s, false)
    case 'SOP_ROUTING':
      return resolveSopRouting(s)
    case 'PROPERTY_OVERRIDE':
      return resolveSopContent(s, true)
    case 'FAQ':
      return resolveFaq(s)
    case 'SYSTEM_PROMPT':
      return resolveSystemPrompt(s)
    case 'TOOL_CONFIG':
      return {
        targetLabel: 'Tool configuration',
        subtitle: 'How the tuner wants to update the AI flow to prevent this in future.',
        currentText: '',
        leftPlaceholder:
          'Tool config edits don\u2019t have a single comparable block. Apply will route this to the matching tool.',
      }
    default:
      // Legacy / unknown — best-effort use beforeText so something sensible renders.
      return {
        targetLabel: 'Proposed change',
        subtitle: 'How the tuner wants to update the AI flow to prevent this in future.',
        currentText: s.beforeText ?? '',
        leftPlaceholder: s.beforeText ? undefined : 'No prior text recorded.',
      }
  }
}

async function resolveSopContent(s: TuningSuggestion, isOverride: boolean): Promise<ArtifactResolution> {
  if (!s.sopCategory) {
    return {
      targetLabel: 'SOP',
      subtitle: 'How the tuner wants to update the AI flow to prevent this in future.',
      currentText: '',
      leftPlaceholder: 'No SOP category attached to this suggestion.',
    }
  }
  const status = (s.sopStatus ?? 'DEFAULT').toUpperCase()
  const defs = await apiGetSopDefinitions()
  const def = defs.definitions.find((d: SopDefinitionData) => d.category === s.sopCategory)
  const variant = def?.variants.find((v) => v.status.toUpperCase() === status)
  const friendly = humanizeCategory(s.sopCategory)

  if (isOverride && s.sopPropertyId) {
    const propName = defs.properties.find((p) => p.id === s.sopPropertyId)?.name ?? 'this property'
    let overrideText = ''
    try {
      const overrides: SopPropertyOverrideData[] = await apiGetSopPropertyOverrides(s.sopPropertyId)
      const match = overrides.find(
        (o) => o.sopDefinitionId === def?.id && o.status.toUpperCase() === status
      )
      overrideText = match?.content ?? ''
    } catch {
      // Fall back to base variant if overrides endpoint fails.
    }
    const current = overrideText || variant?.content || ''
    const noteWhich = overrideText
      ? `existing ${propName} override`
      : `falling back to base ${humanizeStatus(status)} variant`
    return {
      targetLabel: `${friendly} \u00b7 ${humanizeStatus(status)} \u00b7 scoped to ${propName}`,
      subtitle: `Property-scoped override (${noteWhich}).`,
      currentText: current,
      leftPlaceholder: current
        ? undefined
        : `No existing override or base variant. Apply will create one for ${propName}.`,
    }
  }

  return {
    targetLabel: `${friendly} \u00b7 ${humanizeStatus(status)}`,
    subtitle: 'Edit to the SOP content — applies to every reservation in this status.',
    currentText: variant?.content ?? '',
    leftPlaceholder: variant ? undefined : 'No existing variant for this status. Apply will create one.',
  }
}

async function resolveSopRouting(s: TuningSuggestion): Promise<ArtifactResolution> {
  if (!s.sopCategory) {
    return {
      targetLabel: 'SOP routing',
      subtitle: 'How the tuner wants to update the AI flow to prevent this in future.',
      currentText: '',
      leftPlaceholder: 'No SOP category attached to this suggestion.',
    }
  }
  const defs = await apiGetSopDefinitions()
  const def = defs.definitions.find((d) => d.category === s.sopCategory)
  return {
    targetLabel: `${humanizeCategory(s.sopCategory)} \u00b7 tool description`,
    subtitle:
      'Edit to the SOP\u2019s tool description — affects when the AI picks this SOP for a reply.',
    currentText: def?.toolDescription ?? '',
    leftPlaceholder: def ? undefined : 'SOP not found.',
  }
}

async function resolveFaq(s: TuningSuggestion): Promise<ArtifactResolution> {
  if (!s.faqEntryId) {
    return {
      targetLabel: 'FAQ entry',
      subtitle: 'New FAQ entry — no existing answer to compare against.',
      currentText: '',
      leftPlaceholder: 'This is a new FAQ entry. Apply will create it.',
    }
  }
  const res = await apiGetFaqEntries({})
  const entry = res.entries.find((e: FaqEntry) => e.id === s.faqEntryId)
  return {
    targetLabel: entry ? `FAQ \u00b7 ${entry.question}` : 'FAQ entry',
    subtitle: 'Edit to the existing FAQ answer.',
    currentText: entry?.answer ?? s.faqAnswer ?? '',
    leftPlaceholder: entry ? undefined : 'FAQ entry not found.',
  }
}

async function resolveSystemPrompt(s: TuningSuggestion): Promise<ArtifactResolution> {
  // Post-hotfix the diagnostic produces a complete revised prompt, not a
  // free-floating clause. Show the actual before/after so the manager can see
  // exactly what changed. The merge service still falls back to append-with-
  // marker for old fragment-style suggestions still in the queue, so for
  // those rows the "Proposed" pane will look short next to "Current" — that's
  // intentional, surfaces the legacy fragment for review.
  let variantLabel = s.systemPromptVariant ?? 'Coordinator'
  let cfg: TenantAiConfig | null = null
  try {
    cfg = await apiGetTenantAiConfig()
  } catch {
    /* swallow — we still render the proposed text */
  }
  const variantKey = (variantLabel || '').toLowerCase().includes('coord')
    ? 'coordinator'
    : 'screening'
  const wholePrompt =
    (variantKey === 'screening'
      ? cfg?.systemPromptScreening
      : cfg?.systemPromptCoordinator) ?? ''
  variantLabel = variantKey.charAt(0).toUpperCase() + variantKey.slice(1)
  const proposedLen = (s.proposedText ?? '').length
  const currentLen = wholePrompt.length
  // Replicate the merge-service auto heuristic so the subtitle accurately
  // describes what apply will do — replace vs append-with-marker.
  const willReplace = currentLen === 0 || proposedLen / currentLen >= 0.5
  return {
    targetLabel: `System prompt \u00b7 ${variantLabel} (${currentLen.toLocaleString()} chars current)`,
    subtitle: willReplace
      ? `Full ${variantLabel.toLowerCase()} prompt rewrite. Apply will replace the entire prompt with the proposed text (a snapshot is kept in history for rollback).`
      : `Legacy fragment-style proposal — apply will append the clause inside marker comments at the end of the prompt rather than replacing it (the prior diagnostic produced clauses; the new one produces full rewrites).`,
    currentText: wholePrompt,
    leftPlaceholder: wholePrompt
      ? undefined
      : 'No current prompt configured for this variant.',
  }
}

function humanizeCategory(slug: string): string {
  return slug
    .replace(/^sop-/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function humanizeStatus(status: string): string {
  switch (status.toUpperCase()) {
    case 'DEFAULT':
      return 'Default'
    case 'INQUIRY':
      return 'Inquiry'
    case 'CONFIRMED':
      return 'Confirmed'
    case 'CHECKED_IN':
      return 'Checked-in'
    default:
      return status
  }
}
