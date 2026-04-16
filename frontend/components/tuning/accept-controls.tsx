'use client'

import { useState } from 'react'
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
  onMutated,
  onError,
}: {
  suggestion: TuningSuggestion
  properties: ApiProperty[]
  tools: ToolDefinitionSummary[]
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

  async function runAccept(opts: { edited?: boolean } = {}) {
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
          applyMode,
          editedFromOriginal: !!opts.edited,
        })
      } else {
        const body: Parameters<typeof apiAcceptTuningSuggestion>[1] = {
          applyMode,
          editedFromOriginal: !!opts.edited,
        }
        if (opts.edited) body.editedText = editedText
        if (needsSopDispatch) {
          body.sopStatus = sopStatus
          if (sopPropertyId) body.sopPropertyId = sopPropertyId
        }
        await apiAcceptTuningSuggestion(suggestion.id, body)
      }
      setMode('idle')
      onMutated()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Accept failed'
      // 429/409 from the cooldown path is shown calmly as a banner, not a modal.
      onError(msg)
      setMode('idle')
    }
  }

  async function runReject() {
    setMode('saving')
    try {
      await apiRejectTuningSuggestion(suggestion.id, rejectReason || undefined)
      setMode('idle')
      onMutated()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Reject failed')
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

        <div className="flex items-center gap-3 pt-1">
          <PrimaryButton onClick={() => runAccept()}>Apply now</PrimaryButton>
          <GhostButton onClick={() => setMode('idle')}>Cancel</GhostButton>
        </div>
      </div>
    )
  }

  // Idle — primary + secondary actions.
  const requiresDispatch = needsSopDispatch || needsToolDispatch

  return (
    <div className="flex flex-wrap items-center gap-2">
      <PrimaryButton
        onClick={() => (requiresDispatch ? setMode('dispatch') : runAccept())}
        data-testid="apply-now"
      >
        Apply now
      </PrimaryButton>
      <SecondaryButton
        onClick={() => {
          setApplyMode('QUEUED')
          if (requiresDispatch) setMode('dispatch')
          else runAccept()
        }}
        title="Save as queued; still applies on confirm, but marks applyMode=QUEUED for later review batching."
      >
        Queue
      </SecondaryButton>
      <GhostButton
        onClick={() => setMode('edit')}
        disabled={!suggestion.proposedText}
      >
        Edit proposal
      </GhostButton>
      <span className="ml-auto" />
      <button
        type="button"
        onClick={() => setMode('reject')}
        className="rounded-lg px-3 py-2 text-sm text-[#6B7280] transition-all duration-200 hover:bg-[#FEF2F2] hover:text-[#B91C1C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEE2E2]"
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
