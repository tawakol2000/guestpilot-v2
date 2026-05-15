'use client'

// Feature 044 — Settings section for WhatsApp check-in doc-handoff.
//
// Configures the two recipient numbers (manager + security), the two send
// times (reminder + handoff), and the master enabled toggle. Below the form,
// a read-only "Recent sends" table surfaces the last 20 handoff-state rows
// for the tenant so operators can audit what went out and when.
import { useCallback, useEffect, useState } from 'react'
import {
  apiGetDocHandoffConfig,
  apiPutDocHandoffConfig,
  apiListDocHandoffSends,
  apiTestSendDocHandoff,
  type DocHandoffConfig,
  type DocHandoffSendItem,
  type DocHandoffTestSendResult,
} from '@/lib/api'

function statusTone(status: string): string {
  if (status === 'SENT') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (status === 'FAILED') return 'bg-rose-50 text-rose-700 border-rose-200'
  if (status === 'SCHEDULED' || status === 'DEFERRED') return 'bg-blue-50 text-blue-700 border-blue-200'
  return 'bg-neutral-50 text-neutral-600 border-neutral-200'
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function DocHandoffSection(): React.ReactElement {
  const [config, setConfig] = useState<DocHandoffConfig | null>(null)
  const [draft, setDraft] = useState<DocHandoffConfig | null>(null)
  const [sends, setSends] = useState<DocHandoffSendItem[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  const [testRecipient, setTestRecipient] = useState<'manager' | 'security' | 'custom'>('manager')
  const [testTo, setTestTo] = useState('')
  const [testText, setTestText] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<DocHandoffTestSendResult | null>(null)

  const load = useCallback(() => {
    apiGetDocHandoffConfig()
      .then((cfg) => {
        setConfig(cfg)
        setDraft(cfg)
      })
      .catch((err: any) => setError(err?.message || 'Failed to load settings'))
    apiListDocHandoffSends(20)
      .then((r) => setSends(r.items))
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onTestSend() {
    setTesting(true)
    setTestResult(null)
    try {
      const payload: Parameters<typeof apiTestSendDocHandoff>[0] = {}
      if (testRecipient === 'custom') {
        payload.to = testTo.trim()
      } else {
        payload.recipient = testRecipient
      }
      if (testText.trim()) payload.text = testText.trim()
      const result = await apiTestSendDocHandoff(payload)
      setTestResult(result)
      load()
    } catch (err: any) {
      // ApiError carries the JSON body in err.data; surface diagnostics if present.
      const body = err?.data
      if (body && typeof body === 'object' && 'diagnostics' in body) {
        setTestResult(body as DocHandoffTestSendResult)
      } else {
        setTestResult({
          ok: false,
          error: err?.message || 'Test send failed',
          diagnostics: {
            envEnabled: false,
            baseUrl: '',
            timeoutMs: 0,
            recipientResolved: null,
            recipientSource: null,
            recipientValid: false,
            attempted: false,
            ok: false,
            providerMessageId: null,
            errorKind: 'network',
            errorStatus: err?.status ?? null,
            errorMessage: err?.message || 'Network error',
            responseBody: null,
            durationMs: 0,
          },
        })
      }
    } finally {
      setTesting(false)
    }
  }

  async function onSave() {
    if (!draft) return
    setSaving(true)
    setError(null)
    setFieldError(null)
    try {
      const saved = await apiPutDocHandoffConfig(draft)
      setConfig(saved)
      setDraft(saved)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err: any) {
      const field = err?.field ? ` (${err.field})` : ''
      setError((err?.message || 'Failed to save') + field)
      setFieldError(err?.field || null)
    } finally {
      setSaving(false)
    }
  }

  if (!draft || !config) {
    return (
      <section className="p-6 rounded-lg border border-neutral-200 bg-white">
        <h2 className="text-lg font-semibold mb-2">WhatsApp Document Handoff</h2>
        <p className="text-sm text-neutral-500">{error || 'Loading…'}</p>
      </section>
    )
  }

  const dirty =
    draft.enabled !== config.enabled ||
    (draft.managerRecipient ?? '') !== (config.managerRecipient ?? '') ||
    (draft.securityRecipient ?? '') !== (config.securityRecipient ?? '') ||
    draft.reminderTime !== config.reminderTime ||
    draft.handoffTime !== config.handoffTime

  return (
    <section className="p-6 rounded-lg border border-neutral-200 bg-white space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">WhatsApp Document Handoff</h2>
          <p className="text-sm text-neutral-500 mt-1">
            Automatically send document status to your manager the day before check-in, and
            guest documents to security on check-in day.
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-sm font-medium">{draft.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-neutral-700">Manager WhatsApp number</span>
          <input
            type="text"
            placeholder="+971501234567 or 1234-5678@g.us"
            value={draft.managerRecipient ?? ''}
            onChange={(e) => setDraft({ ...draft, managerRecipient: e.target.value || null })}
            className={`mt-1 w-full border rounded px-3 py-2 text-sm ${fieldError === 'managerRecipient' ? 'border-rose-400' : 'border-neutral-300'}`}
          />
          <span className="text-xs text-neutral-500 mt-1 block">E.164 format or WhatsApp group JID</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-neutral-700">Security WhatsApp number / group</span>
          <input
            type="text"
            placeholder="+971509999999 or group-jid@g.us"
            value={draft.securityRecipient ?? ''}
            onChange={(e) => setDraft({ ...draft, securityRecipient: e.target.value || null })}
            className={`mt-1 w-full border rounded px-3 py-2 text-sm ${fieldError === 'securityRecipient' ? 'border-rose-400' : 'border-neutral-300'}`}
          />
          <span className="text-xs text-neutral-500 mt-1 block">Receives unit + dates + document images on check-in day</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-neutral-700">Reminder time (day before check-in)</span>
          <input
            type="text"
            placeholder="22:00"
            value={draft.reminderTime}
            onChange={(e) => setDraft({ ...draft, reminderTime: e.target.value })}
            className={`mt-1 w-full border rounded px-3 py-2 text-sm font-mono ${fieldError === 'reminderTime' ? 'border-rose-400' : 'border-neutral-300'}`}
          />
          <span className="text-xs text-neutral-500 mt-1 block">HH:MM, Africa/Cairo timezone</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-neutral-700">Handoff time (check-in day)</span>
          <input
            type="text"
            placeholder="10:00"
            value={draft.handoffTime}
            onChange={(e) => setDraft({ ...draft, handoffTime: e.target.value })}
            className={`mt-1 w-full border rounded px-3 py-2 text-sm font-mono ${fieldError === 'handoffTime' ? 'border-rose-400' : 'border-neutral-300'}`}
          />
          <span className="text-xs text-neutral-500 mt-1 block">HH:MM, Africa/Cairo timezone</span>
        </label>
      </div>

      {error ? <p className="text-sm text-rose-600">{error}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded bg-black text-white text-sm font-medium disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved ? <span className="text-sm text-emerald-600">Saved</span> : null}
      </div>

      <div className="pt-4 border-t border-neutral-100 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Test send</h3>
          <p className="text-xs text-neutral-500 mt-1">
            Send a one-off WhatsApp message via WAsender to verify the integration is working.
            Bypasses scheduling — fires immediately.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-neutral-700">Recipient</span>
            <select
              value={testRecipient}
              onChange={(e) => setTestRecipient(e.target.value as 'manager' | 'security' | 'custom')}
              className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm"
            >
              <option value="manager">Manager (saved number)</option>
              <option value="security">Security (saved number/group)</option>
              <option value="custom">Custom…</option>
            </select>
          </label>

          {testRecipient === 'custom' ? (
            <label className="block md:col-span-2">
              <span className="text-xs font-medium text-neutral-700">Custom recipient</span>
              <input
                type="text"
                placeholder="+971501234567 or group-jid@g.us"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm font-mono"
              />
            </label>
          ) : (
            <label className="block md:col-span-2">
              <span className="text-xs font-medium text-neutral-700">Override text (optional)</span>
              <input
                type="text"
                placeholder="GuestPilot test message — ..."
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm"
              />
            </label>
          )}
        </div>

        {testRecipient === 'custom' ? (
          <label className="block">
            <span className="text-xs font-medium text-neutral-700">Override text (optional)</span>
            <input
              type="text"
              placeholder="GuestPilot test message — ..."
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              className="mt-1 w-full border border-neutral-300 rounded px-3 py-2 text-sm"
            />
          </label>
        ) : null}

        <div>
          <button
            type="button"
            onClick={onTestSend}
            disabled={testing || (testRecipient === 'custom' && !testTo.trim())}
            className="px-4 py-2 rounded border border-neutral-300 bg-white text-sm font-medium hover:bg-neutral-50 disabled:opacity-40"
          >
            {testing ? 'Sending…' : 'Send test message'}
          </button>
        </div>

        {testResult ? (
          <div
            className={`rounded border p-3 text-xs space-y-2 ${
              testResult.ok
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            <div className="font-semibold">
              {testResult.ok ? '✓ Sent' : '✗ Failed'}
              {testResult.error ? <span className="font-normal"> — {testResult.error}</span> : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
              <dt className="text-neutral-600">WASENDER_API_KEY set</dt>
              <dd>{testResult.diagnostics.envEnabled ? 'yes' : 'NO'}</dd>
              <dt className="text-neutral-600">base URL</dt>
              <dd className="truncate">{testResult.diagnostics.baseUrl}</dd>
              <dt className="text-neutral-600">timeout</dt>
              <dd>{testResult.diagnostics.timeoutMs}ms</dd>
              <dt className="text-neutral-600">recipient</dt>
              <dd className="truncate">{testResult.diagnostics.recipientResolved || '(none)'}</dd>
              <dt className="text-neutral-600">recipient source</dt>
              <dd>{testResult.diagnostics.recipientSource || '—'}</dd>
              <dt className="text-neutral-600">recipient valid</dt>
              <dd>{testResult.diagnostics.recipientValid ? 'yes' : 'no'}</dd>
              <dt className="text-neutral-600">attempted</dt>
              <dd>{testResult.diagnostics.attempted ? 'yes' : 'no'}</dd>
              <dt className="text-neutral-600">duration</dt>
              <dd>{testResult.diagnostics.durationMs}ms</dd>
              {testResult.diagnostics.providerMessageId ? (
                <>
                  <dt className="text-neutral-600">msgId</dt>
                  <dd className="truncate">{testResult.diagnostics.providerMessageId}</dd>
                </>
              ) : null}
              {testResult.diagnostics.errorKind ? (
                <>
                  <dt className="text-neutral-600">error kind</dt>
                  <dd>{testResult.diagnostics.errorKind}</dd>
                </>
              ) : null}
              {testResult.diagnostics.errorStatus !== null ? (
                <>
                  <dt className="text-neutral-600">HTTP status</dt>
                  <dd>{testResult.diagnostics.errorStatus}</dd>
                </>
              ) : null}
            </dl>
            {testResult.diagnostics.responseBody ? (
              <details>
                <summary className="cursor-pointer text-neutral-700">Provider response</summary>
                <pre className="mt-1 text-[10px] whitespace-pre-wrap break-all bg-white/60 p-2 rounded border border-neutral-200">
                  {JSON.stringify(testResult.diagnostics.responseBody, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="pt-4 border-t border-neutral-100">
        <h3 className="text-sm font-semibold mb-2">Recent sends</h3>
        {sends.length === 0 ? (
          <p className="text-sm text-neutral-500">No sends yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-neutral-500 border-b">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Recipient</th>
                  <th className="py-2 pr-3">Body</th>
                  <th className="py-2 pr-3">Images</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-neutral-600">
                      {formatTs(s.sentAt ?? s.scheduledFireAt)}
                    </td>
                    <td className="py-2 pr-3">{s.messageType === 'REMINDER' ? 'Reminder' : 'Handoff'}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded border ${statusTone(s.status)}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{s.recipientUsed || '—'}</td>
                    <td className="py-2 pr-3 text-xs text-neutral-700 max-w-xs truncate">
                      {s.messageBodyUsed || (s.lastError ? <span className="text-rose-600">err: {s.lastError}</span> : '—')}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{s.imageUrlCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
