'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type {
  ApiProperty,
  TuningApplyMode,
  TuningSuggestion,
  ToolDefinitionSummary,
} from '@/lib/api'
import {
  apiAcceptToolConfigSuggestion,
  apiAcceptTuningSuggestion,
  apiRejectTuningSuggestion,
} from '@/lib/api'
import { TUNING_COLORS } from './tokens'
import { DiffViewer } from './diff-viewer'

type Mode = 'idle' | 'dispatch' | 'edit' | 'reject' | 'saving'

const SOP_STATUSES = ['DEFAULT', 'INQUIRY', 'CONFIRMED', 'CHECKED_IN'] as const

export function AcceptControls({
  suggestion,
  properties,
  tools,
  sourceConversationPropertyId,
  sourceConversationPropertyName,
  onMutated,
  onError,
}: {
  suggestion: TuningSuggestion
  properties: ApiProperty[]
  tools: ToolDefinitionSummary[]
  /** PropertyId of the conversation that triggered this suggestion, if any.
   *  Used as the default when the suggestion needs a new PROPERTY-scoped FAQ. */
  sourceConversationPropertyId?: string | null
  /** Human-readable property name for the same — purely UX. */
  sourceConversationPropertyName?: string | null
  onMutated: () => void
  onError: (message: string) => void
}) {
  const [mode, setMode] = useState<Mode>('idle')
  const [applyMode, setApplyMode] = useState<TuningApplyMode>('IMMEDIATE')
  const [sopStatus, setSopStatus] = useState<string>(suggestion.sopStatus ?? 'DEFAULT')
  const [sopPropertyId, setSopPropertyId] = useState<string>(suggestion.sopPropertyId ?? '')
  const [toolId, setToolId] = useState<string>(
    // best-effort pre-select by tool name from sub-label / rationale
    tools[0]?.id ?? '',
  )
  const [editedText, setEditedText] = useState<string>(suggestion.proposedText ?? '')
  const [editedToolDescription, setEditedToolDescription] = useState<string>('')
  const [rejectReason, setRejectReason] = useState<string>('')

  const category = suggestion.diagnosticCategory
  const needsSopDispatch = category === 'SOP_CONTENT' || category === 'SOP_ROUTING' || category === 'PROPERTY_OVERRIDE'
  const needsToolDispatch = category === 'TOOL_CONFIG'
  // Round-3 follow-up — when a FAQ suggestion has no faqEntryId, the backend
  // auto-creates a new FAQ. The manager needs to confirm GLOBAL vs PROPERTY
  // scope (and which property) before apply; otherwise the resolver infers
  // PROPERTY from the source conversation, which may not match intent.
  const needsFaqDispatch = category === 'FAQ' && !suggestion.faqEntryId
  // Default scope: if the suggestion was triggered by a conversation tied to
  // a specific property AND the tenant owns more than one property, default
  // to PROPERTY scoped to that one. If there's no source property, default
  // to GLOBAL. Manager can override either way.
  const defaultFaqScope: 'GLOBAL' | 'PROPERTY' = sourceConversationPropertyId
    ? 'PROPERTY'
    : 'GLOBAL'
  const [faqScope, setFaqScope] = useState<'GLOBAL' | 'PROPERTY'>(defaultFaqScope)
  const [faqPropertyId, setFaqPropertyId] = useState<string>(
    sourceConversationPropertyId ?? properties[0]?.id ?? '',
  )

  async function runAccept(opts: { edited?: boolean; applyMode?: TuningApplyMode } = {}) {
    // Sprint 07 bug fix — the Queue button calls setApplyMode('QUEUED') then
    // synchronously calls runAccept(), but React's state update is async so
    // runAccept would capture the stale 'IMMEDIATE' value from this render's
    // closure. Allow the caller to pass the intended applyMode explicitly;
    // update the state as a side effect so the UI's footer hint reflects it.
    //
    // Round-9 bug fix — guard against re-entry while a previous call is
    // still in flight. Without this, a rapid double-click could fire two
    // identical PUT requests in parallel.
    if (mode === 'saving') return
    const effectiveApplyMode: TuningApplyMode = opts.applyMode ?? applyMode
    if (opts.applyMode && opts.applyMode !== applyMode) {
      setApplyMode(opts.applyMode)
    }
    setMode('saving')
    try {
      if (needsToolDispatch) {
        if (!toolId) {
          onError('Pick a tool to update.')
          setMode('dispatch')
          return
        }
        const target = tools.find((t) => t.id === toolId)
        await apiAcceptToolConfigSuggestion(suggestion.id, {
          toolDefinitionId: toolId,
          editedDescription: editedToolDescription || (opts.edited ? editedText : undefined) ||
            suggestion.proposedText || target?.description,
          applyMode: effectiveApplyMode,
          editedFromOriginal: !!opts.edited,
        })
      } else {
        const body: Parameters<typeof apiAcceptTuningSuggestion>[1] = {
          applyMode: effectiveApplyMode,
          editedFromOriginal: !!opts.edited,
        }
        if (opts.edited) body.editedText = editedText
        if (needsSopDispatch) {
          body.sopStatus = sopStatus
          if (sopPropertyId) body.sopPropertyId = sopPropertyId
        }
        if (needsFaqDispatch) {
          body.faqScope = faqScope
          if (faqScope === 'PROPERTY') {
            if (!faqPropertyId) {
              onError('Pick a property for this FAQ, or switch to Global.')
              setMode('dispatch')
              return
            }
            body.faqPropertyId = faqPropertyId
          }
        }
        await apiAcceptTuningSuggestion(suggestion.id, body)
      }
      setMode('idle')
      toast.success(
        effectiveApplyMode === 'QUEUED' ? 'Queued for review' : 'Applied',
        {
          description: opts.edited
            ? 'Saved your edit as a preference pair.'
            : 'Change is live on the next reply.',
        },
      )
      onMutated()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Accept failed'
      // 429/409 from the cooldown path is shown calmly as a banner, not a modal.
      onError(msg)
      toast.error('Could not apply', { description: msg })
      setMode('idle')
    }
  }

  async function runReject() {
    // Round-9 bug fix — same re-entry guard as runAccept.
    if (mode === 'saving') return
    // Round-14 bug fix — trim rejectReason so a user who typed only
    // whitespace (or accidentally hit space before submitting) doesn't
    // send "   " as the reason, which would store as a non-null but
    // meaningless string on the server.
    const trimmedReason = rejectReason.trim()
    setMode('saving')
    try {
      await apiRejectTuningSuggestion(suggestion.id, trimmedReason || undefined)
      setMode('idle')
      toast('Dismissed', {
        description: trimmedReason ? `Reason: ${trimmedReason}` : undefined,
      })
      onMutated()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Reject failed'
      onError(msg)
      toast.error('Could not dismiss', { description: msg })
      setMode('idle')
    }
  }

  if (suggestion.status !== 'PENDING') {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm"
        style={{
          background: TUNING_COLORS.surfaceSunken,
          color: TUNING_COLORS.inkMuted,
        }}
      >
        This suggestion is {suggestion.status.toLowerCase()} and can&rsquo;t be changed.
      </div>
    )
  }

  if (mode === 'edit') {
    return (
      <div
        className="space-y-4 rounded-xl p-5"
        style={{
          background: TUNING_COLORS.surfaceSunken,
        }}
      >
        <h3 className="text-sm font-semibold text-[#1A1A1A]">Edit proposed text</h3>
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          rows={8}
          className="w-full resize-y rounded-lg border bg-white px-4 py-3 font-mono text-[13px] leading-6 text-[#1A1A1A] shadow-inner outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
          style={{ borderColor: TUNING_COLORS.hairline }}
          aria-label="Edit proposed text"
        />
        <DiffViewer
          before={suggestion.proposedText ?? ''}
          after={editedText}
          title="Your edit vs proposed"
        />
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={() => runAccept({ edited: true })} disabled={!editedText}>
            Apply edited
          </PrimaryButton>
          <GhostButton onClick={() => setMode('idle')}>Cancel</GhostButton>
          <span className="ml-auto text-xs text-[#9CA3AF]">
            Saves a preference pair so future suggestions lean toward this phrasing.
          </span>
        </div>
      </div>
    )
  }

  if (mode === 'reject') {
    return (
      <div
        className="space-y-4 rounded-xl p-5"
        style={{ background: TUNING_COLORS.surfaceSunken }}
      >
        <h3 className="text-sm font-semibold text-[#1A1A1A]">
          Reject — reason optional
        </h3>
        <input
          type="text"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="e.g. doesn't generalize, cosmetic preference"
          className="w-full rounded-lg border bg-white px-4 py-2.5 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
          style={{ borderColor: TUNING_COLORS.hairline }}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runReject}
            className="rounded-lg border px-4 py-2 text-sm font-medium text-[#B91C1C] transition-all duration-200 hover:bg-[#FEF2F2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEE2E2]"
            style={{ borderColor: TUNING_COLORS.hairline }}
          >
            Dismiss suggestion
          </button>
          <GhostButton onClick={() => setMode('idle')}>Cancel</GhostButton>
        </div>
      </div>
    )
  }

  if (mode === 'dispatch') {
    return (
      <div
        className="space-y-4 rounded-xl p-5"
        style={{ background: TUNING_COLORS.surfaceSunken }}
      >
        <h3 className="text-sm font-semibold text-[#1A1A1A]">
          Confirm target before apply
        </h3>

        {needsSopDispatch ? (
          <div className="space-y-3">
            <FieldLabel>Reservation status</FieldLabel>
            <SelectInput
              value={sopStatus}
              onChange={(e) => setSopStatus(e.target.value)}
            >
              {SOP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </SelectInput>

            <FieldLabel>Property override — optional</FieldLabel>
            <SelectInput
              value={sopPropertyId}
              onChange={(e) => setSopPropertyId(e.target.value)}
            >
              <option value="">Global (all properties)</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </div>
        ) : null}

        {needsToolDispatch ? (
          <div className="space-y-3">
            <FieldLabel>Tool to update</FieldLabel>
            <SelectInput
              value={toolId}
              onChange={(e) => setToolId(e.target.value)}
            >
              {tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName || t.name} {t.type === 'custom' ? '(custom)' : ''}
                </option>
              ))}
            </SelectInput>

            <FieldLabel>New description — leave blank to use the proposed text</FieldLabel>
            <textarea
              value={editedToolDescription}
              onChange={(e) => setEditedToolDescription(e.target.value)}
              rows={4}
              placeholder={suggestion.proposedText ?? tools.find((t) => t.id === toolId)?.description ?? ''}
              className="w-full rounded-lg border bg-white p-3 font-mono text-xs leading-5 outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
              style={{ borderColor: TUNING_COLORS.hairline }}
            />
          </div>
        ) : null}

        {needsFaqDispatch ? (
          <div className="space-y-3">
            <p className="text-xs text-[#6B7280]">
              This is a new FAQ entry. Pick whether it should apply globally
              (every property) or to a specific property only.
              {sourceConversationPropertyName ? (
                <>
                  {' '}The triggering conversation is at{' '}
                  <span className="font-medium text-[#1A1A1A]">
                    {sourceConversationPropertyName}
                  </span>
                  .
                </>
              ) : null}
            </p>

            <FieldLabel>Scope</FieldLabel>
            <div className="grid grid-cols-2 gap-2">
              {(['PROPERTY', 'GLOBAL'] as const).map((scope) => {
                const active = faqScope === scope
                const label = scope === 'PROPERTY' ? 'This property only' : 'Global (all properties)'
                const desc =
                  scope === 'PROPERTY'
                    ? 'Only served when a guest at the selected property asks.'
                    : 'Served for every guest across every property.'
                return (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setFaqScope(scope)}
                    className="flex flex-col gap-1 rounded-lg border p-3 text-left transition-all duration-150"
                    style={{
                      background: active ? TUNING_COLORS.accentSoft : '#ffffff',
                      borderColor: active ? TUNING_COLORS.accentMuted : TUNING_COLORS.hairline,
                    }}
                    aria-pressed={active}
                  >
                    <span
                      className="text-sm font-semibold"
                      style={{ color: active ? TUNING_COLORS.accent : TUNING_COLORS.ink }}
                    >
                      {label}
                    </span>
                    <span className="text-xs leading-5 text-[#6B7280]">{desc}</span>
                  </button>
                )
              })}
            </div>

            {faqScope === 'PROPERTY' ? (
              <>
                <FieldLabel>Property</FieldLabel>
                <SelectInput
                  value={faqPropertyId}
                  onChange={(e) => setFaqPropertyId(e.target.value)}
                >
                  {properties.length === 0 ? (
                    <option value="">No properties available</option>
                  ) : (
                    properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))
                  )}
                </SelectInput>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-3 pt-1">
          <PrimaryButton onClick={() => runAccept()}>Apply now</PrimaryButton>
          <GhostButton onClick={() => setMode('idle')}>Cancel</GhostButton>
        </div>
      </div>
    )
  }

  // Idle — primary + secondary actions.
  // Bug fix (round 9) — previously the `mode === 'saving'` state had no
  // dedicated branch and fell through to the idle UI with every button
  // still clickable. A quick double-click on Apply would fire two PUTs
  // in parallel. The `isSaving` flag below disables every action while
  // the request is in flight.
  const requiresDispatch = needsSopDispatch || needsToolDispatch || needsFaqDispatch
  const isSaving = mode === 'saving'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <PrimaryButton
        onClick={() => (requiresDispatch ? setMode('dispatch') : runAccept())}
        data-testid="apply-now"
        disabled={isSaving}
      >
        {isSaving ? 'Applying…' : 'Apply now'}
      </PrimaryButton>
      <SecondaryButton
        onClick={() => {
          // Round-14 bug fix — previously this called setApplyMode('QUEUED')
          // AND runAccept({applyMode:'QUEUED'}), which ALSO calls
          // setApplyMode internally. Two redundant setState calls.
          // The dispatch-mode branch still needs setApplyMode so the
          // dispatch UI's subsequent "Apply now" button reads QUEUED
          // from state when it calls runAccept() with no opts.
          if (requiresDispatch) {
            setApplyMode('QUEUED')
            setMode('dispatch')
          } else {
            runAccept({ applyMode: 'QUEUED' })
          }
        }}
        disabled={isSaving}
        title="Save as queued; still applies on confirm, but marks applyMode=QUEUED for later review batching."
      >
        Queue
      </SecondaryButton>
      <GhostButton
        onClick={() => setMode('edit')}
        disabled={!suggestion.proposedText || isSaving}
      >
        Edit proposal
      </GhostButton>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={() => setMode('reject')}
        disabled={isSaving}
        className="rounded-lg px-3 py-2 text-sm text-[#6B7280] transition-all duration-200 hover:bg-[#FEF2F2] hover:text-[#B91C1C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEE2E2] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Dismiss
      </button>
    </div>
  )
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  ...rest
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg bg-[#6C5CE7] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-[#5B4CDB] hover:shadow-md active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
      {...rest}
    >
      {children}
    </button>
  )
}

function SecondaryButton({
  children,
  onClick,
  disabled,
  ...rest
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-sm font-medium text-[#1A1A1A] transition-all duration-200 hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
      {...rest}
    >
      {children}
    </button>
  )
}

function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-[#6B7280] transition-all duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
    >
      {children}
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-[#6B7280]">{children}</label>
}

function SelectInput({
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
      style={{ borderColor: TUNING_COLORS.hairline }}
    >
      {children}
    </select>
  )
}
