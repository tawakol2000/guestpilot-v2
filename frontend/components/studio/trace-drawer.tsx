'use client'

/**
 * Sprint 047 Session B — admin-only BuildToolCallLog trace drawer.
 *
 * Right-side slide-over rendered from the Studio right-rail gear menu.
 * Lists every tool call for the current conversation, newest first,
 * with explicit "Load older" pagination (no infinite scroll — admins
 * page deliberately).
 *
 * Gating: the gear icon that opens this drawer only renders when both
 * `traceViewEnabled` (env flag) and `isAdmin` (tenant role) are true.
 * The server enforces the same gates on the data endpoint; this
 * component assumes both have been checked upstream.
 */

import { useCallback, useEffect, useState } from 'react'
import { apiListBuildTraces, type BuildTraceRow } from '@/lib/build-api'
import { STUDIO_COLORS } from './tokens'

export interface TraceDrawerProps {
  open: boolean
  onClose: () => void
  conversationId: string
}

export function TraceDrawer(props: TraceDrawerProps) {
  const { open, onClose, conversationId } = props
  const [rows, setRows] = useState<BuildTraceRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const loadFirstPage = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await apiListBuildTraces({ conversationId, limit: 50 })
      setRows(page.rows)
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  const loadOlder = useCallback(async () => {
    if (!nextCursor) return
    setLoading(true)
    setError(null)
    try {
      const page = await apiListBuildTraces({
        conversationId,
        cursor: nextCursor,
        limit: 50,
      })
      setRows((prev) => [...prev, ...page.rows])
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [conversationId, nextCursor])

  useEffect(() => {
    if (!open) return
    setRows([])
    setNextCursor(null)
    setExpanded({})
    loadFirstPage()
  }, [open, loadFirstPage])

  if (!open) return null

  return (
    <>
      <button
        type="button"
        aria-label="Close trace drawer"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10, 10, 10, 0.25)',
          zIndex: 90,
          border: 'none',
          padding: 0,
          cursor: 'default',
        }}
      />
      <aside
        role="dialog"
        aria-label="Agent trace"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 460,
          maxWidth: '100vw',
          background: STUDIO_COLORS.canvas,
          borderLeft: `1px solid ${STUDIO_COLORS.hairline}`,
          boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.08)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${STUDIO_COLORS.hairline}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: 'uppercase',
                color: STUDIO_COLORS.inkMuted,
              }}
            >
              Admin
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: STUDIO_COLORS.ink,
                marginTop: 2,
              }}
            >
              Agent trace
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: `1px solid ${STUDIO_COLORS.hairline}`,
              borderRadius: 5,
              padding: '4px 10px',
              fontSize: 11,
              color: STUDIO_COLORS.inkMuted,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </header>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 16px 16px',
          }}
        >
          {loading && rows.length === 0 ? (
            <div style={{ fontSize: 12, color: STUDIO_COLORS.inkSubtle, padding: '12px 0' }}>
              Loading…
            </div>
          ) : null}
          {error ? (
            <div style={{ fontSize: 12, color: STUDIO_COLORS.dangerFg, padding: '12px 0' }}>
              {error}
            </div>
          ) : null}
          {!loading && rows.length === 0 && !error ? (
            <div style={{ fontSize: 12, color: STUDIO_COLORS.inkSubtle, padding: '12px 0' }}>
              No tool calls recorded for this conversation yet.
            </div>
          ) : null}

          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.map((row) => {
              const isExpanded = expanded[row.id] === true
              return (
                <li
                  key={row.id}
                  style={{
                    borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
                    padding: '8px 0',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [row.id]: !isExpanded }))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      aria-label={row.success ? 'success' : 'error'}
                      title={row.success ? 'success' : 'error'}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: row.success
                          ? STUDIO_COLORS.successFg
                          : STUDIO_COLORS.dangerFg,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10.5,
                        color: STUDIO_COLORS.inkSubtle,
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        width: 36,
                        textAlign: 'right',
                      }}
                    >
                      T{row.turn}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        fontWeight: 500,
                        color: STUDIO_COLORS.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      }}
                    >
                      {row.tool}
                    </span>
                    <span style={{ fontSize: 11, color: STUDIO_COLORS.inkMuted }}>
                      {row.durationMs}ms
                    </span>
                  </button>
                  {isExpanded ? (
                    <div
                      style={{
                        marginTop: 6,
                        padding: '8px 10px',
                        background: STUDIO_COLORS.surfaceSunken,
                        borderRadius: 5,
                        fontSize: 11,
                        color: STUDIO_COLORS.inkMuted,
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        lineHeight: 1.5,
                      }}
                    >
                      <div>at {new Date(row.createdAt).toLocaleString()}</div>
                      <div>paramsHash {row.paramsHash}</div>
                      <div>id {row.id}</div>
                      {row.errorMessage ? (
                        <div style={{ color: STUDIO_COLORS.dangerFg, marginTop: 4 }}>
                          {row.errorMessage}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {nextCursor ? (
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={loadOlder}
                disabled={loading}
                style={{
                  padding: '6px 12px',
                  fontSize: 11,
                  fontWeight: 500,
                  border: `1px solid ${STUDIO_COLORS.hairline}`,
                  background: STUDIO_COLORS.surfaceRaised,
                  color: STUDIO_COLORS.inkMuted,
                  borderRadius: 5,
                  cursor: loading ? 'wait' : 'pointer',
                }}
              >
                {loading ? 'Loading…' : 'Load older'}
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  )
}
