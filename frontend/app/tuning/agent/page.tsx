'use client'

/**
 * Feature 041 sprint 07 expanded — /tuning/agent
 *
 * The flagship "agent configuration" surface. Modelled on OpenAI
 * Platform's Prompt Editor: a system-prompt editor up top + a
 * read-only "Knowledge & tools" panel that deep-links to the full
 * editors under /dashboard for CRUD. Also exposes the template
 * variables as insertion chips.
 *
 * Uses only existing API wrappers (no backend changes, no new deps).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ExternalLink,
  FlaskConical,
  MessageSquareText,
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react'
import {
  apiGetAIConfig,
  apiGetAiConfigVersions,
  apiGetPromptHistory,
  apiGetSopDefinitions,
  apiGetTemplateVariables,
  apiGetTenantAiConfig,
  apiGetTools,
  apiResetSystemPrompts,
  apiUpdateTenantAiConfig,
  type AiConfig,
  type AiConfigVersion,
  type ApiToolDefinition,
  type PromptHistoryEntry,
  type SopDefinitionData,
  type TemplateVariableInfo,
  type TenantAiConfig,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { RelativeTime } from '@/components/tuning/relative-time'
import { TUNING_COLORS } from '@/components/tuning/tokens'

type Scope = 'coordinator' | 'screening'

const SCOPE_OPTIONS: Array<{ value: Scope; label: string; desc: string }> = [
  {
    value: 'coordinator',
    label: 'Coordinator',
    desc: 'The main guest-facing AI that answers inquiries, coordinates stays, and escalates.',
  },
  {
    value: 'screening',
    label: 'Screening',
    desc: 'The eligibility screener that vets inquiry-stage guests before handoff.',
  },
]

function AgentPageInner() {
  const [scope, setScope] = useState<Scope>('coordinator')
  const [tenantCfg, setTenantCfg] = useState<TenantAiConfig | null>(null)
  const [aiCfg, setAiCfg] = useState<AiConfig | null>(null)
  const [versions, setVersions] = useState<AiConfigVersion[]>([])
  const [sopDefs, setSopDefs] = useState<SopDefinitionData[]>([])
  const [tools, setTools] = useState<ApiToolDefinition[]>([])
  const [templateVars, setTemplateVars] = useState<TemplateVariableInfo[]>([])
  // Per-scope drafts so switching personas doesn't silently discard unsaved
  // edits on the other persona (sprint-07 bug fix).
  const [drafts, setDrafts] = useState<Record<Scope, string>>({
    coordinator: '',
    screening: '',
  })
  const draft = drafts[scope]
  const setDraft = useCallback(
    (next: string | ((prev: string) => string)) => {
      setDrafts((d) => {
        const resolved = typeof next === 'function' ? next(d[scope]) : next
        return { ...d, [scope]: resolved }
      })
    },
    [scope],
  )
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [promptHistory, setPromptHistory] = useState<PromptHistoryEntry[] | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [cfg, ai, versionsRes, sopRes, toolsList, history] = await Promise.allSettled([
        apiGetTenantAiConfig(),
        apiGetAIConfig(),
        apiGetAiConfigVersions(),
        apiGetSopDefinitions(),
        apiGetTools(),
        apiGetPromptHistory(),
      ])
      if (cfg.status === 'fulfilled') setTenantCfg(cfg.value)
      else setError(cfg.reason instanceof Error ? cfg.reason.message : 'Unable to load tenant config')
      if (ai.status === 'fulfilled') setAiCfg(ai.value)
      if (versionsRes.status === 'fulfilled') setVersions(versionsRes.value)
      if (sopRes.status === 'fulfilled') setSopDefs(sopRes.value.definitions)
      if (toolsList.status === 'fulfilled') setTools(toolsList.value)
      if (history.status === 'fulfilled') setPromptHistory(history.value.history)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Reload template variables when scope changes — different personas expose different content blocks.
  useEffect(() => {
    apiGetTemplateVariables(scope)
      .then(setTemplateVars)
      .catch(() => setTemplateVars([]))
  }, [scope])

  // Seed both per-scope drafts from the server whenever tenant config
  // (re)loads. Use a functional update so we only fill a scope's draft on
  // first load — subsequent loads (e.g. after save) MUST NOT clobber a
  // manager's unsaved edits on the *other* scope.
  const seededRef = useRef<Record<Scope, boolean>>({ coordinator: false, screening: false })
  useEffect(() => {
    if (!tenantCfg) return
    setDrafts((d) => {
      const next = { ...d }
      if (!seededRef.current.coordinator) {
        next.coordinator = tenantCfg.systemPromptCoordinator ?? ''
        seededRef.current.coordinator = true
      }
      if (!seededRef.current.screening) {
        next.screening = tenantCfg.systemPromptScreening ?? ''
        seededRef.current.screening = true
      }
      // After a save, ALWAYS refresh the *currently-viewed* scope to the
      // server's canonical version so the dirty comparison lines up. The
      // other scope's unsaved edits are preserved.
      next[scope] =
        scope === 'coordinator'
          ? tenantCfg.systemPromptCoordinator ?? ''
          : tenantCfg.systemPromptScreening ?? ''
      return next
    })
    // Intentionally omit `scope` from deps — we only want to resync when
    // tenantCfg changes. Switching scopes should NOT overwrite drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantCfg])

  const storedPrompt = useMemo(() => {
    if (!tenantCfg) return null
    return scope === 'coordinator'
      ? tenantCfg.systemPromptCoordinator
      : tenantCfg.systemPromptScreening
  }, [scope, tenantCfg])

  const dirty = (storedPrompt ?? '') !== draft

  const save = useCallback(async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const updates =
        scope === 'coordinator'
          ? { systemPromptCoordinator: draft }
          : { systemPromptScreening: draft }
      const updated = await apiUpdateTenantAiConfig(updates)
      setTenantCfg(updated)
      toast.success('System prompt saved', {
        description: `New version v${updated.systemPromptVersion}.`,
      })
    } catch (e) {
      toast.error('Could not save', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSaving(false)
    }
  }, [draft, dirty, saving, scope])

  const discard = useCallback(() => {
    setDraft(storedPrompt ?? '')
  }, [storedPrompt])

  const resetDefaults = useCallback(async () => {
    if (resetting) return
    const confirmed = window.confirm(
      'Reset BOTH the coordinator and screening system prompts to their defaults? This creates a new version and discards any unsaved edits on either persona.',
    )
    if (!confirmed) return
    setResetting(true)
    try {
      const updated = await apiResetSystemPrompts()
      setTenantCfg(updated)
      // Reset explicitly clears BOTH personas server-side; mirror that on
      // the client so the user's unsaved edits on the other scope don't
      // stick around as phantom "dirty" state after the reset toast.
      setDrafts({
        coordinator: updated.systemPromptCoordinator ?? '',
        screening: updated.systemPromptScreening ?? '',
      })
      toast.success('Reset to defaults', {
        description: `Version bumped to v${updated.systemPromptVersion}.`,
      })
    } catch (e) {
      toast.error('Could not reset', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setResetting(false)
    }
  }, [resetting])

  const insertVariable = useCallback(
    (token: string) => {
      const el = textareaRef.current
      if (!el) {
        setDraft((d) => `${d}{${token}}`)
        return
      }
      const start = el.selectionStart ?? draft.length
      const end = el.selectionEnd ?? draft.length
      const next = `${draft.slice(0, start)}{${token}}${draft.slice(end)}`
      setDraft(next)
      // Restore selection just after the inserted token on next tick.
      setTimeout(() => {
        el.focus()
        const pos = start + token.length + 2
        el.setSelectionRange(pos, pos)
      }, 0)
    },
    [draft],
  )

  // Prefer the prompt-history endpoint (which tracks system-prompt versions
  // specifically) over apiGetAiConfigVersions (which tracks all ai-config
  // versions — model, temperature, etc. — and would mislabel the "last
  // edit" timestamp for unrelated AI-config changes).
  const latestPromptEdit = promptHistory?.[0] ?? null
  void versions // keep versions loaded for future compare features

  return (
    <div className="flex min-h-dvh flex-col">
      <TuningTopNav />
      <main className="mx-auto w-full max-w-5xl px-6 py-10 md:px-8">
        {/* Header */}
        <header className="space-y-3">
          <div className="text-xs font-medium text-[#6B7280]">Agent</div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
              Your AI&rsquo;s configuration
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/tuning/playground?scope=${scope}`}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-xs font-medium text-[#1A1A1A] transition-colors duration-200 hover:bg-[#F3F4F6]"
                style={{ borderColor: TUNING_COLORS.hairline }}
              >
                <FlaskConical size={14} strokeWidth={2} aria-hidden />
                <span>Test it</span>
              </Link>
              <Link
                href="/tuning/history"
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A]"
              >
                <span>Version history</span>
                <ExternalLink size={12} strokeWidth={2} aria-hidden />
              </Link>
            </div>
          </div>
          <p className="max-w-prose text-sm leading-6 text-[#6B7280]">
            This is what your main AI is told to do. Edits are versioned —
            the tuning queue still proposes targeted changes, but this page
            is for direct authoring.
          </p>
        </header>

        {/* Scope selector */}
        <section
          className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2"
          role="radiogroup"
          aria-label="Agent scope"
        >
          {SCOPE_OPTIONS.map((s) => {
            const active = scope === s.value
            return (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setScope(s.value)}
                className="group flex flex-col gap-1 rounded-xl border p-4 text-left transition-all duration-200 hover:border-[#D6D3FF] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
                style={{
                  background: active ? TUNING_COLORS.accentSoft : TUNING_COLORS.surfaceRaised,
                  borderColor: active ? TUNING_COLORS.accentMuted : TUNING_COLORS.hairline,
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-sm font-semibold"
                    style={{ color: active ? TUNING_COLORS.accent : TUNING_COLORS.ink }}
                  >
                    {s.label}
                  </span>
                  {active ? (
                    <span className="rounded-full bg-[#6C5CE7] px-1.5 py-0.5 text-[10px] font-medium text-white">
                      Selected
                    </span>
                  ) : null}
                </div>
                <p className="text-xs leading-5 text-[#6B7280]">{s.desc}</p>
              </button>
            )
          })}
        </section>

        {error ? (
          <div
            className="mt-5 rounded-lg border-l-2 px-4 py-3 text-sm"
            style={{
              background: TUNING_COLORS.dangerBg,
              borderLeftColor: TUNING_COLORS.dangerFg,
              color: TUNING_COLORS.dangerFg,
            }}
          >
            {error}
          </div>
        ) : null}

        {/* System prompt editor */}
        <section
          className="mt-6 overflow-hidden rounded-xl bg-white"
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)' }}
        >
          <div
            className="flex flex-wrap items-center gap-2 border-b px-5 py-3"
            style={{ borderColor: TUNING_COLORS.hairlineSoft, background: TUNING_COLORS.surfaceSunken }}
          >
            <MessageSquareText size={14} strokeWidth={2} className="text-[#6B7280]" aria-hidden />
            <span className="text-sm font-semibold text-[#1A1A1A]">System prompt</span>
            {tenantCfg ? (
              <span className="font-mono text-xs text-[#9CA3AF]">
                v{tenantCfg.systemPromptVersion}
              </span>
            ) : null}
            {latestPromptEdit ? (
              <span className="text-xs text-[#9CA3AF]">
                Last edit <RelativeTime iso={latestPromptEdit.timestamp} />
              </span>
            ) : null}
            <span className="ml-auto" />
            <button
              type="button"
              onClick={resetDefaults}
              disabled={resetting}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[#6B7280] transition-colors duration-150 hover:bg-white hover:text-[#1A1A1A] disabled:opacity-50"
              title="Reset both prompts to defaults"
            >
              <RotateCcw size={12} strokeWidth={2} aria-hidden />
              <span>Reset defaults</span>
            </button>
          </div>

          {templateVars.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1.5 border-b px-5 py-3"
              style={{ borderColor: TUNING_COLORS.hairlineSoft }}
            >
              <span className="mr-1 text-xs font-medium text-[#6B7280]">Variables</span>
              {templateVars.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => insertVariable(v.name)}
                  className="inline-flex items-center gap-1 rounded-full border bg-white px-2 py-0.5 font-mono text-[11px] font-medium text-[#1A1A1A] transition-all duration-150 hover:border-[#D6D3FF] hover:bg-[#F0EEFF] hover:text-[#6C5CE7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
                  style={{ borderColor: TUNING_COLORS.hairline }}
                  title={`${v.description}${v.essential ? ' (essential)' : ''}${v.propertyBound ? ' · needs property' : ''}`}
                >
                  <span>{`{${v.name}}`}</span>
                  {v.essential ? (
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: TUNING_COLORS.accent }}
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          <div className="px-5 py-4">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              placeholder={
                tenantCfg
                  ? 'This persona has no saved prompt — it falls back to the built-in default.'
                  : 'Loading…'
              }
              spellCheck={false}
              disabled={!tenantCfg}
              aria-label={`${scope} system prompt`}
              className="w-full resize-y rounded-lg border bg-[#F9FAFB] px-4 py-3 font-mono text-[13px] leading-6 text-[#1A1A1A] outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
              style={{ borderColor: TUNING_COLORS.hairline, minHeight: 360 }}
            />
          </div>

          <footer
            className="flex flex-wrap items-center gap-3 border-t px-5 py-3"
            style={{ borderColor: TUNING_COLORS.hairlineSoft }}
          >
            <span className="font-mono text-xs tabular-nums text-[#9CA3AF]">
              {draft.length.toLocaleString()} chars · {draft.split(/\s+/).filter(Boolean).length.toLocaleString()} words
            </span>
            <span className="ml-auto" />
            <button
              type="button"
              onClick={discard}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-[#6B7280] transition-all duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center rounded-lg bg-[#6C5CE7] px-5 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-[#5B4CDB] hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
            >
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </footer>
        </section>

        {/* Knowledge & tools summary */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Knowledge &amp; tools</h2>
          <p className="mt-1 max-w-prose text-xs leading-5 text-[#6B7280]">
            These feed the main AI as retrievable knowledge. Click through to
            edit the full content.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <KnowledgeCard
              icon={<BookOpen size={14} strokeWidth={2} aria-hidden />}
              title="SOPs"
              count={sopDefs.filter((s) => s.enabled).length}
              total={sopDefs.length}
              previews={sopDefs.slice(0, 3).map((s) => formatCategory(s.category))}
              href="/"
              hrefLabel="Edit in SOP editor"
            />
            <KnowledgeCard
              icon={<Sparkles size={14} strokeWidth={2} aria-hidden />}
              title="FAQs"
              // FAQ count lives under a separate endpoint — rendered as "—" for now
              // rather than 0 to avoid a misleading zero state.
              countText="Browse"
              previews={['Open the FAQ page to search and edit entries.']}
              href="/"
              hrefLabel="Open FAQ"
            />
            <KnowledgeCard
              icon={<Wrench size={14} strokeWidth={2} aria-hidden />}
              title="Tools"
              count={tools.filter((t) => t.enabled).length}
              total={tools.length}
              previews={tools.slice(0, 3).map((t) => t.displayName || t.name)}
              href="/"
              hrefLabel="Edit tools"
            />
          </div>
        </section>

        {/* Advanced */}
        <section className="mt-8">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold text-[#1A1A1A] transition-colors duration-150 hover:bg-[#F3F4F6]"
            aria-expanded={advancedOpen}
          >
            <ChevronDown
              size={14}
              strokeWidth={2}
              className="transition-transform duration-200"
              style={{ transform: advancedOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />
            <span>Advanced</span>
          </button>
          {advancedOpen ? (
            <div
              className="mt-3 overflow-hidden rounded-xl bg-white"
              style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
            >
              <dl className="divide-y" style={{ borderColor: TUNING_COLORS.hairlineSoft }}>
                <ConfigRow
                  label="Model"
                  value={tenantCfg?.model ?? '—'}
                />
                <ConfigRow
                  label="Temperature"
                  value={
                    tenantCfg ? tenantCfg.temperature.toFixed(2) : '—'
                  }
                />
                <ConfigRow
                  label="Max tokens"
                  value={tenantCfg ? tenantCfg.maxTokens.toLocaleString() : '—'}
                />
                <ConfigRow
                  label="Debounce"
                  value={
                    tenantCfg
                      ? `${(tenantCfg.debounceDelayMs / 1000).toFixed(0)}s${tenantCfg.adaptiveDebounce ? ' · adaptive' : ''}`
                      : '—'
                  }
                />
                <ConfigRow
                  label="Shadow mode"
                  value={
                    tenantCfg ? (tenantCfg.shadowModeEnabled ? 'On' : 'Off') : '—'
                  }
                />
                <ConfigRow
                  label="Escalation threshold"
                  value={
                    aiCfg?.escalation
                      ? `confidence < ${aiCfg.escalation.confidenceThreshold.toFixed(2)}`
                      : '—'
                  }
                />
              </dl>
              <div
                className="flex items-start gap-2 border-t px-5 py-3 text-xs"
                style={{ borderColor: TUNING_COLORS.hairlineSoft, color: TUNING_COLORS.inkMuted }}
              >
                <AlertTriangle size={12} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  To change any of these, open the full configuration editor at{' '}
                  <Link href="/" className="text-[#6C5CE7] hover:underline">
                    Dashboard → AI config
                  </Link>
                  .
                </span>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  )
}

function KnowledgeCard({
  icon,
  title,
  count,
  total,
  countText,
  previews,
  href,
  hrefLabel,
}: {
  icon: React.ReactNode
  title: string
  count?: number
  total?: number
  countText?: string
  previews: string[]
  href: string
  hrefLabel: string
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl bg-white p-4"
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#6C5CE7]" style={{ background: TUNING_COLORS.surfaceSunken }}>
          {icon}
        </span>
        <span className="text-sm font-semibold text-[#1A1A1A]">{title}</span>
        <span className="ml-auto font-mono text-xs tabular-nums text-[#6B7280]">
          {countText ??
            (typeof count === 'number'
              ? total !== undefined
                ? `${count} / ${total}`
                : String(count)
              : '—')}
        </span>
      </div>
      <ul className="space-y-1 text-xs leading-5 text-[#6B7280]">
        {previews.length > 0 ? (
          previews.map((p, i) => (
            <li key={i} className="truncate">
              · {p}
            </li>
          ))
        ) : (
          <li className="italic text-[#9CA3AF]">Nothing configured yet.</li>
        )}
      </ul>
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-xs font-medium text-[#6C5CE7] transition-colors duration-150 hover:text-[#5B4CDB]"
      >
        <span>{hrefLabel}</span>
        <ExternalLink size={10} strokeWidth={2} aria-hidden />
      </Link>
    </div>
  )
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="grid grid-cols-[160px_1fr] items-baseline gap-4 px-5 py-3"
      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
    >
      <dt className="text-xs font-medium text-[#6B7280]">{label}</dt>
      <dd className="font-mono text-sm tabular-nums text-[#1A1A1A]">{value}</dd>
    </div>
  )
}

function formatCategory(cat: string): string {
  return cat.replace(/^sop-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function AgentPage() {
  return (
    <TuningAuthGate>
      <AgentPageInner />
    </TuningAuthGate>
  )
}
