'use client'

import { useCallback, useEffect, useState } from 'react'
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

function HistoryRow({
  entry,
  onRollback,
}: {
  entry: VersionHistoryEntry & { rollbackSupported?: boolean }
  onRollback: (entry: VersionHistoryEntry) => void
}) {
  const [open, setOpen] = useState(false)
  const supportsRollback = (entry as any).rollbackSupported !== false
  return (
    <li className="border-b border-[#E7E5E4] py-4">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[#A8A29E]">
          {ARTIFACT_LABEL[entry.artifactType]}
        </span>
        <span className="text-[15px] text-[#0C0A09]">{entry.artifactLabel}</span>
        {entry.version !== null ? (
          <span className="font-mono text-[11px] text-[#57534E]">v{entry.version}</span>
        ) : null}
        <span className="ml-auto text-[11px] text-[#A8A29E]">
          <RelativeTime iso={entry.createdAt} />
        </span>
      </div>
      {entry.note ? (
        <div className="mt-1 text-[12px] text-[#57534E]">{entry.note}</div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
        {entry.diffPreview ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-[#1E3A8A] hover:underline"
          >
            {open ? 'Hide diff' : 'Show diff'}
          </button>
        ) : null}
        {entry.sourceSuggestionId ? (
          <a
            href={`/tuning?suggestionId=${entry.sourceSuggestionId}`}
            className="text-[#57534E] hover:text-[#0C0A09]"
          >
            Source suggestion ↗
          </a>
        ) : null}
        <span className="ml-auto" />
        {supportsRollback ? (
          <button
            type="button"
            onClick={() => onRollback(entry)}
            className="rounded-md border border-[#E7E5E4] px-2.5 py-1 text-[12px] text-[#0C0A09] hover:bg-[#F5F4F1]"
          >
            Roll back
          </button>
        ) : (
          <span className="text-[11px] italic text-[#A8A29E]">
            Rollback not supported in V1
          </span>
        )}
      </div>
      {open && entry.diffPreview ? (
        <div className="mt-2">
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
      <main className="mx-auto w-full max-w-3xl px-8 py-10">
        <header className="space-y-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
            Version history
          </div>
          <h1 className="font-[family-name:var(--font-playfair)] text-3xl text-[#0C0A09]">
            Recent edits
          </h1>
          <p className="max-w-prose text-[14px] text-[#57534E]">
            The last 50 changes to system prompts, SOPs, FAQs, and tool
            definitions. Roll back to restore a previous version — rollbacks
            create a new version rather than overwriting the current one.
          </p>
        </header>

        {actionMessage ? (
          <div
            className="mt-4 rounded-md border border-[#E7E5E4] bg-white px-3 py-2 text-[12px] text-[#0C0A09]"
            role="status"
          >
            {actionMessage}
          </div>
        ) : null}

        <ul className="mt-6 border-t border-[#E7E5E4]">
          {loading ? (
            <li className="py-6 text-sm text-[#A8A29E]">Loading…</li>
          ) : entries.length === 0 ? (
            <li className="py-10 text-center">
              <p className="font-[family-name:var(--font-playfair)] text-base italic text-[#57534E]">
                No edits yet.
              </p>
              <p className="mt-1 text-xs text-[#A8A29E]">
                Accept a tuning suggestion to start the history.
              </p>
            </li>
          ) : (
            entries.map((e) => <HistoryRow key={e.id} entry={e} onRollback={setConfirmEntry} />)
          )}
        </ul>

        {confirmEntry ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
            <div className="w-[min(440px,90vw)] rounded-md border border-[#E7E5E4] bg-white p-5 shadow-xl">
              <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">
                Confirm rollback
              </div>
              <p className="mt-2 text-[14px] leading-6 text-[#0C0A09]">
                Rolling back restores the previous version of{' '}
                <span className="font-medium">{confirmEntry.artifactLabel}</span>{' '}
                verbatim. Any suggestions accepted since will remain in history
                but won&rsquo;t be re-applied.
              </p>
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmEntry(null)}
                  className="rounded-md px-3 py-1.5 text-sm text-[#57534E] hover:bg-[#F5F4F1]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={doRollback}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                  style={{ background: TUNING_COLORS.accent }}
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
