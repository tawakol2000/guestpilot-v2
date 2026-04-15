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
      <div className="rounded-md border border-[#E7E5E4] bg-[#F5F4F1] px-4 py-3 text-sm text-[#57534E]">
        This suggestion is {suggestion.status.toLowerCase()} and can&rsquo;t be changed.
      </div>
    )
  }

  if (mode === 'edit') {
    return (
      <div className="space-y-3 rounded-md border border-[#E7E5E4] bg-white p-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
          Edit proposed text
        </div>
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          rows={8}
          className="w-full resize-y rounded-md border border-[#E7E5E4] bg-[#FAFAF9] p-3 font-mono text-[13px] leading-6 text-[#0C0A09] outline-none focus:border-[#1E3A8A]"
          aria-label="Edit proposed text"
        />
        <DiffViewer
          before={suggestion.proposedText ?? ''}
          after={editedText}
          title="Your edit vs proposed"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => runAccept({ edited: true })}
            disabled={!editedText}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
            style={{ background: TUNING_COLORS.accent }}
          >
            Apply edited
          </button>
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="rounded-md px-3 py-1.5 text-sm text-[#57534E] hover:bg-[#F5F4F1]"
          >
            Cancel
          </button>
          <span className="ml-auto text-[11px] italic text-[#A8A29E]">
            Saves a preference pair so future suggestions lean toward this phrasing.
          </span>
        </div>
      </div>
    )
  }

  if (mode === 'reject') {
    return (
      <div className="space-y-3 rounded-md border border-[#E7E5E4] bg-white p-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
          Reject — reason optional
        </div>
        <input
          type="text"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="e.g. doesn't generalize, cosmetic preference"
          className="w-full rounded-md border border-[#E7E5E4] bg-[#FAFAF9] px-3 py-2 text-sm outline-none focus:border-[#1E3A8A]"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runReject}
            className="rounded-md border border-[#E7E5E4] px-3 py-1.5 text-sm text-[#9F1239] hover:bg-[#FEF2F2]"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="rounded-md px-3 py-1.5 text-sm text-[#57534E] hover:bg-[#F5F4F1]"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (mode === 'dispatch') {
    return (
      <div className="space-y-3 rounded-md border border-[#E7E5E4] bg-white p-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
          Confirm target before apply
        </div>

        {needsSopDispatch ? (
          <div className="space-y-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[#57534E]">Reservation status</span>
              <select
                value={sopStatus}
                onChange={(e) => setSopStatus(e.target.value)}
                className="rounded-md border border-[#E7E5E4] bg-[#FAFAF9] px-3 py-2 text-sm"
              >
                {SOP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[#57534E]">
                Property override — optional, leave blank for global
              </span>
              <select
                value={sopPropertyId}
                onChange={(e) => setSopPropertyId(e.target.value)}
                className="rounded-md border border-[#E7E5E4] bg-[#FAFAF9] px-3 py-2 text-sm"
              >
                <option value="">— Global (all properties) —</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {needsToolDispatch ? (
          <div className="space-y-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[#57534E]">Tool to update</span>
              <select
                value={toolId}
                onChange={(e) => setToolId(e.target.value)}
                className="rounded-md border border-[#E7E5E4] bg-[#FAFAF9] px-3 py-2 text-sm"
              >
                {tools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName || t.name} {t.type === 'custom' ? '(custom)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[#57534E]">
                New description (leave blank to use the proposed text)
              </span>
              <textarea
                value={editedToolDescription}
                onChange={(e) => setEditedToolDescription(e.target.value)}
                rows={4}
                placeholder={suggestion.proposedText ?? tools.find((t) => t.id === toolId)?.description ?? ''}
                className="rounded-md border border-[#E7E5E4] bg-[#FAFAF9] p-2 font-mono text-[12px] leading-5"
              />
            </label>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => runAccept()}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: TUNING_COLORS.accent }}
          >
            Apply now
          </button>
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="rounded-md px-3 py-1.5 text-sm text-[#57534E] hover:bg-[#F5F4F1]"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // Idle — primary + secondary actions.
  const requiresDispatch = needsSopDispatch || needsToolDispatch

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => (requiresDispatch ? setMode('dispatch') : runAccept())}
          className="rounded-md px-3.5 py-2 text-sm font-medium text-white transition-shadow hover:shadow-sm"
          style={{ background: TUNING_COLORS.accent }}
          data-testid="apply-now"
        >
          Apply now
        </button>
        <button
          type="button"
          onClick={() => {
            setApplyMode('QUEUED')
            if (requiresDispatch) setMode('dispatch')
            else runAccept()
          }}
          className="rounded-md border border-[#E7E5E4] px-3.5 py-2 text-sm text-[#0C0A09] hover:bg-[#F5F4F1]"
          title="Save as queued; still applies on confirm, but marks applyMode=QUEUED for later review batching."
        >
          Queue
        </button>
        <button
          type="button"
          onClick={() => setMode('edit')}
          className="rounded-md px-3.5 py-2 text-sm text-[#57534E] hover:bg-[#F5F4F1]"
          disabled={!suggestion.proposedText}
        >
          Edit proposal
        </button>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => setMode('reject')}
          className="rounded-md px-3.5 py-2 text-sm text-[#9F1239] hover:bg-[#FEF2F2]"
        >
          Dismiss
        </button>
      </div>

      <div className="text-[11px] text-[#A8A29E]">
        Apply mode: <span className="font-mono">{applyMode}</span>
      </div>
    </div>
  )
}
