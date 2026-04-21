'use client'

/**
 * Sprint 057-A F1 — Collapsed tool-chain summary per agent message.
 *
 * Renders a single-line summary of all tool calls in a message's parts
 * array. Collapsed by default: shows up to 5 verb labels + "… +N more"
 * overflow. Expanding reveals the full ToolCallChip row in temporal order.
 *
 * Props:
 *   parts           — the message's parts array (Record<string, any>[])
 *   onOpenToolDrawer — passed through to each ToolCallChip
 *
 * Renders nothing when there are no tool-call parts (graceful degradation).
 */
import { useState } from 'react'
import { STUDIO_COLORS } from './tokens'
import { toolVerb } from './tool-verbs'
import type { ToolCallDrawerPart } from './tool-call-drawer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolChainSummaryProps {
  parts: Array<Record<string, any>>
  onOpenToolDrawer?: (part: ToolCallDrawerPart, origin: HTMLElement | null) => void
  /** Called whenever the expanded state changes (used by MessageRow to show/hide the standalone chip row). */
  onExpandedChange?: (expanded: boolean) => void
}

interface ToolEntry {
  toolCallId: string
  toolName: string
  type: string
  state: string
  input?: unknown
  output?: unknown
  providerMetadata?: Record<string, unknown>
  errorText?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_COLLAPSED = 5

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectToolEntries(parts: Array<Record<string, any>>): ToolEntry[] {
  const seen = new Set<string>()
  const entries: ToolEntry[] = []

  for (const p of parts) {
    if (typeof p?.type !== 'string') continue
    if (!p.type.startsWith('tool-')) continue

    // Deduplicate by toolCallId (fall back to toolName+index position)
    const id: string =
      typeof p.toolCallId === 'string' && p.toolCallId
        ? p.toolCallId
        : `${p.toolName ?? p.type}:${entries.length}`

    if (seen.has(id)) continue
    seen.add(id)

    entries.push({
      toolCallId: id,
      toolName: (typeof p.toolName === 'string' && p.toolName) ? p.toolName : p.type.slice('tool-'.length),
      type: p.type,
      state: typeof p.state === 'string' ? p.state : 'input-available',
      input: p.input,
      output: p.output,
      providerMetadata: p.providerMetadata,
      errorText: typeof p.errorText === 'string' ? p.errorText : undefined,
    })
  }

  return entries
}

function isRunning(state: string): boolean {
  return state === 'call' || state === 'partial-call' || state === 'input-available' || state === 'input-start'
}

function isErrored(state: string): boolean {
  return state === 'output-error'
}

// ─── Inline chip row (replicates ToolCallChip from studio-chat.tsx) ──────────

function SummaryChip({
  entry,
  onOpenToolDrawer,
}: {
  entry: ToolEntry
  onOpenToolDrawer?: (part: ToolCallDrawerPart, origin: HTMLElement | null) => void
}) {
  const short = entry.toolName.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')
  const running = isRunning(entry.state)
  const err = isErrored(entry.state)

  return (
    <button
      type="button"
      onClick={(e) =>
        onOpenToolDrawer?.(
          {
            type: entry.type,
            toolName: entry.toolName,
            state: entry.state,
            input: entry.input,
            output: entry.output,
            providerMetadata: entry.providerMetadata,
            errorText: entry.errorText,
          },
          e.currentTarget,
        )
      }
      aria-label={`Tool call details: ${short}`}
      className="inline-flex items-center gap-1.5 self-start rounded-full border-0 px-2.5 py-0.5 text-[11px] font-medium"
      style={{
        background: err
          ? STUDIO_COLORS.dangerBg
          : running
            ? STUDIO_COLORS.surfaceSunken
            : STUDIO_COLORS.surfaceSunken,
        color: err
          ? STUDIO_COLORS.dangerFg
          : running
            ? STUDIO_COLORS.inkMuted
            : STUDIO_COLORS.inkMuted,
        cursor: onOpenToolDrawer ? 'pointer' : 'default',
      }}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: err
            ? STUDIO_COLORS.dangerFg
            : running
              ? STUDIO_COLORS.accent
              : STUDIO_COLORS.successFg,
          opacity: running ? 0.7 : 1,
        }}
      />
      {short}
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ToolChainSummary({ parts, onOpenToolDrawer, onExpandedChange }: ToolChainSummaryProps) {
  const [expanded, setExpanded] = useState(false)

  function toggle() {
    setExpanded((v) => {
      const next = !v
      onExpandedChange?.(next)
      return next
    })
  }

  const entries = collectToolEntries(parts)
  if (entries.length === 0) return null

  // Build the collapsed summary line
  const visible = entries.slice(0, MAX_COLLAPSED)
  const overflowCount = entries.length - MAX_COLLAPSED

  return (
    <div className="mb-1.5">
      {/* ── Toggle row ── */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse tool calls' : 'Expand tool calls'}
          onClick={toggle}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px]"
          style={{
            color: STUDIO_COLORS.inkSubtle,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▸
        </button>

        {/* Summary line — hidden when expanded */}
        {!expanded && (
          <span
            className="flex flex-wrap items-center gap-x-1 text-[11.5px]"
            style={{ color: STUDIO_COLORS.inkSubtle }}
            aria-hidden
          >
            {visible.map((entry, idx) => {
              const running = isRunning(entry.state)
              const err = isErrored(entry.state)
              const verb = toolVerb(
                entry.toolName,
                typeof entry.input === 'object' && entry.input !== null
                  ? (entry.input as Record<string, unknown>)
                  : undefined,
              )
              return (
                <span key={entry.toolCallId} className="inline-flex items-center gap-0.5">
                  {idx > 0 && (
                    <span
                      aria-hidden
                      style={{
                        color: err ? STUDIO_COLORS.dangerFg : STUDIO_COLORS.inkSubtle,
                        marginRight: 2,
                      }}
                    >
                      {err ? '•' : '·'}
                    </span>
                  )}
                  <span
                    style={{
                      color: err
                        ? STUDIO_COLORS.dangerFg
                        : running
                          ? STUDIO_COLORS.inkMuted
                          : STUDIO_COLORS.inkSubtle,
                    }}
                  >
                    {verb}
                  </span>
                  {running && (
                    <span
                      aria-label="running"
                      className="ml-0.5 inline-block"
                      style={{ color: STUDIO_COLORS.accent, fontSize: 10 }}
                    >
                      ⟳
                    </span>
                  )}
                </span>
              )
            })}
            {overflowCount > 0 && (
              <span style={{ color: STUDIO_COLORS.inkSubtle }}>… +{overflowCount} more</span>
            )}
          </span>
        )}

        {/* Compact count when expanded */}
        {expanded && (
          <span
            className="text-[11px]"
            style={{ color: STUDIO_COLORS.inkSubtle }}
            aria-hidden
          >
            {entries.length} tool {entries.length === 1 ? 'call' : 'calls'}
          </span>
        )}
      </div>

      {/* ── Expanded chip row ── */}
      {expanded && (
        <div
          className="mt-1.5 flex flex-wrap gap-1.5 pl-6"
          role="list"
          aria-label="Tool calls"
        >
          {entries.map((entry) => (
            <div key={entry.toolCallId} role="listitem">
              <SummaryChip entry={entry} onOpenToolDrawer={onOpenToolDrawer} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
