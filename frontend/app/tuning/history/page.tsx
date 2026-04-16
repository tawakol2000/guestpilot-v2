'use client'

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  apiListTuningHistory,
  apiRollbackVersion,
  type VersionHistoryEntry,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { DiffViewer } from '@/components/tuning/diff-viewer'
import { RelativeTime } from '@/components/tuning/relative-time'
import { TUNING_COLORS } from '@/components/tuning/tokens'

const ARTIFACT_LABEL: Record<VersionHistoryEntry['artifactType'], string> = {
  SYSTEM_PROMPT: 'System prompt',
  SOP_VARIANT: 'SOP variant',
  FAQ_ENTRY: 'FAQ entry',
  TOOL_DEFINITION: 'Tool definition',
}

const ARTIFACT_ACCENT: Record<VersionHistoryEntry['artifactType'], string> = {
  SYSTEM_PROMPT: '#3B82F6',
  SOP_VARIANT: '#CA8A04',
  FAQ_ENTRY: '#14B8A6',
  TOOL_DEFINITION: '#8B5CF6',
}

function HistoryRow({
  entry,
  onRollback,
}: {
  entry: VersionHistoryEntry & { rollbackSupported?: boolean }
  onRollback: (entry: VersionHistoryEntry) => void
}) {
  const [open, setOpen] = useState(false)
  const supportsRollback = (entry as any).rollbackSupported !== false
  const accent = ARTIFACT_ACCENT[entry.artifactType]
  return (
    <li
      className="relative py-5 pl-6"
      style={{ borderBottom: `1px solid ${TUNING_COLORS.hairlineSoft}` }}
    >
      <span
        aria-hidden
        className="absolute left-0 top-6 h-2 w-2 rounded-full"
        style={{ background: accent }}
      />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-[#6B7280]">
          {ARTIFACT_LABEL[entry.artifactType]}
        </span>
        <span className="text-sm font-medium text-[#1A1A1A]">{entry.artifactLabel}</span>
        {entry.version !== null ? (
          <span className="font-mono text-xs tabular-nums text-[#9CA3AF]">
            v{entry.version}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-[#9CA3AF]">
          <RelativeTime iso={entry.createdAt} />
        </span>
      </div>
      {entry.note ? (
        <div className="mt-1.5 text-sm leading-6 text-[#6B7280]">{entry.note}</div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        {entry.diffPreview ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[#6C5CE7] transition-colors duration-150 hover:bg-[#F0EEFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
          >
            {open ? 'Hide diff' : 'Show diff'}
          </button>
        ) : null}
        {entry.sourceSuggestionId ? (
          <a
            href={`/tuning?suggestionId=${entry.sourceSuggestionId}`}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[#6B7280] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#1A1A1A]"
          >
            <span>Source suggestion</span>
            <ExternalLink size={11} strokeWidth={2} aria-hidden />
          </a>
        ) : null}
        <span className="ml-auto" />
        {supportsRollback ? (
          <button
            type="button"
            onClick={() => onRollback(entry)}
            className="inline-flex items-center justify-center rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#1A1A1A] transition-all duration-200 hover:bg-[#F3F4F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
          >
            Roll back
          </button>
        ) : (
          <span className="text-xs italic text-[#9CA3AF]">Rollback not supported in V1</span>
        )}
      </div>
      {open && entry.diffPreview ? (
        <div className="mt-3">
          <DiffViewer before={entry.diffPreview.before} after={entry.diffPreview.after} />
        </div>
      ) : null}
    </li>
  )
}

function HistoryPageInner() {
  const [entries, setEntries] = useState<VersionHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmEntry, setConfirmEntry] = useState<VersionHistoryEntry | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiListTuningHistory(50)
      setEntries(res.entries)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  async function doRollback() {
    if (!confirmEntry) return
    try {
      const res = await apiRollbackVersion(confirmEntry.artifactType, confirmEntry.id)
      setActionMessage(
        res.newVersion
          ? `Rolled back. New version v${res.newVersion}.`
          : 'Reset to default.',
      )
      setConfirmEntry(null)
      await load()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Rollback failed')
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TuningTopNav />
      <main className="mx-auto w-full max-w-3xl px-6 py-10 md:px-8">
        <header className="space-y-2">
          <div className="text-xs font-medium text-[#6B7280]">Version history</div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
            Recent edits
          </h1>
          <p className="max-w-prose text-sm leading-6 text-[#6B7280]">
            The last 50 changes to system prompts, SOPs, FAQs, and tool
            definitions. Roll back to restore a previous version — rollbacks
            create a new version rather than overwriting the current one.
          </p>
        </header>

        {actionMessage ? (
          <div
            className="mt-5 rounded-lg border-l-2 px-4 py-3 text-sm"
            style={{
              background: TUNING_COLORS.accentSoft,
              borderLeftColor: TUNING_COLORS.accent,
              color: TUNING_COLORS.ink,
            }}
            role="status"
          >
            {actionMessage}
          </div>
        ) : null}

        <ul className="mt-8">
          {loading ? (
            <li className="py-6 text-sm text-[#9CA3AF]">Loading…</li>
          ) : entries.length === 0 ? (
            <li className="py-10 text-center">
              <p className="text-base font-medium text-[#6B7280]">No edits yet</p>
              <p className="mt-1 text-sm text-[#9CA3AF]">
                Accept a tuning suggestion to start the history.
              </p>
            </li>
          ) : (
            entries.map((e) => <HistoryRow key={e.id} entry={e} onRollback={setConfirmEntry} />)
          )}
        </ul>

        {confirmEntry ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setConfirmEntry(null)}
          >
            <div
              className="w-[min(460px,90vw)] rounded-xl bg-white p-6 shadow-2xl animate-in zoom-in-95 duration-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-xs font-medium text-[#6B7280]">Confirm rollback</div>
              <p className="mt-2 text-sm leading-6 text-[#1A1A1A]">
                Rolling back restores the previous version of{' '}
                <span className="font-medium">{confirmEntry.artifactLabel}</span>{' '}
                verbatim. Any suggestions accepted since will remain in history
                but won&rsquo;t be re-applied.
              </p>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmEntry(null)}
                  className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={doRollback}
                  className="inline-flex items-center justify-center rounded-lg bg-[#6C5CE7] px-5 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-[#5B4CDB] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
                >
                  Roll back
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  )
}

export default function HistoryPage() {
  return (
    <TuningAuthGate>
      <HistoryPageInner />
    </TuningAuthGate>
  )
}
