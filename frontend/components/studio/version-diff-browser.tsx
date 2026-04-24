'use client'

/**
 * Sprint 046 — Version Diff Browser card.
 *
 * Renders a `data-version-diff-browser` SSE part when the agent calls
 * `get_version_history`. Shows a side-by-side diff between two
 * historical versions of the same artifact plus a "Rollback to
 * this version" primary CTA. Requested by the agent in the
 * operator's own Studio session ("Version diff browser — right now I
 * can call get_version_history but there's no card to render a
 * side-by-side diff").
 *
 * Shape is intentionally generic so the agent can pick any two
 * versions of any artifact type; the visual language is shared with
 * the inline diff card and the artifact drawer's diff view.
 */

import { useState } from 'react'
import { STUDIO_TOKENS_V2 } from './tokens'

export type VersionDiffArtifactKind =
  | 'system_prompt'
  | 'sop'
  | 'faq'
  | 'tool_definition'
  | 'property_override'

export interface VersionDiffVersion {
  /** Opaque version id (e.g. `AiConfigVersion.id`). */
  versionId: string
  /** Operator-facing label — usually `v{n}` or a date stamp. */
  label: string
  /** ISO timestamp. Optional — renders as a subtitle when present. */
  createdAt?: string
  /** Optional committer name / "AI" / "Operator". */
  author?: string
  /** The artifact body at this version. */
  body: string
}

export interface VersionDiffBrowserCardProps {
  artifact: VersionDiffArtifactKind
  artifactId?: string
  /** Optional human label for the artifact (e.g. "Coordinator prompt"). */
  artifactTitle?: string
  /** Pair of versions — before/after. Agent picks the pair. */
  before: VersionDiffVersion
  after: VersionDiffVersion
  /** Called when the operator clicks "Rollback to {after.label}". */
  onRollback?: (targetVersionId: string) => void | Promise<void>
  /** Called when the operator clicks "Open in drawer". */
  onOpenInDrawer?: () => void
}

const ARTIFACT_LABEL: Record<VersionDiffArtifactKind, string> = {
  system_prompt: 'System prompt',
  sop: 'SOP',
  faq: 'FAQ',
  tool_definition: 'Tool',
  property_override: 'Property override',
}

type RollbackState = 'idle' | 'rolling' | 'rolled-back' | 'error'

export function VersionDiffBrowserCard(props: VersionDiffBrowserCardProps) {
  const { artifact, artifactTitle, before, after, onRollback, onOpenInDrawer } = props
  const [state, setState] = useState<RollbackState>('idle')

  async function handleRollback() {
    if (!onRollback || state !== 'idle') return
    setState('rolling')
    try {
      await onRollback(after.versionId)
      setState('rolled-back')
    } catch {
      setState('error')
    }
  }

  const beforeLines = before.body.split('\n')
  const afterLines = after.body.split('\n')

  return (
    <article
      data-studio-card="version-diff-browser"
      style={{
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.bg,
        marginTop: 8,
        overflow: 'hidden',
        boxShadow: STUDIO_TOKENS_V2.shadowSm,
      }}
    >
      <header
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Version diff
        </span>
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: STUDIO_TOKENS_V2.ink,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={artifactTitle ?? ARTIFACT_LABEL[artifact]}
        >
          {artifactTitle ?? ARTIFACT_LABEL[artifact]}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            padding: '2px 8px',
            background: STUDIO_TOKENS_V2.surface2,
            color: STUDIO_TOKENS_V2.muted,
            borderRadius: 99,
            fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
          }}
        >
          {before.label} → {after.label}
        </span>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
        }}
      >
        <DiffColumn
          role="before"
          label={before.label}
          subtitle={formatSubtitle(before)}
          lines={beforeLines}
        />
        <DiffColumn
          role="after"
          label={after.label}
          subtitle={formatSubtitle(after)}
          lines={afterLines}
          highlight
        />
      </div>

      <footer
        style={{
          padding: '10px 16px',
          borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
          background: STUDIO_TOKENS_V2.surface,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        {state === 'error' && (
          <span style={{ fontSize: 12, color: STUDIO_TOKENS_V2.red, marginRight: 'auto' }}>
            Rollback failed. Try again.
          </span>
        )}
        {onOpenInDrawer ? (
          <button
            type="button"
            onClick={onOpenInDrawer}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              color: STUDIO_TOKENS_V2.ink2,
              background: STUDIO_TOKENS_V2.bg,
              border: `1px solid ${STUDIO_TOKENS_V2.border}`,
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              cursor: 'pointer',
            }}
          >
            Open in drawer
          </button>
        ) : null}
        {onRollback ? (
          <button
            type="button"
            onClick={handleRollback}
            disabled={state !== 'idle'}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              color: '#FFFFFF',
              background:
                state === 'rolled-back' ? STUDIO_TOKENS_V2.green : STUDIO_TOKENS_V2.blue,
              border: 'none',
              borderRadius: STUDIO_TOKENS_V2.radiusSm,
              cursor: state === 'idle' ? 'pointer' : 'default',
              opacity: state === 'rolling' ? 0.7 : 1,
            }}
          >
            {state === 'rolling'
              ? 'Rolling back…'
              : state === 'rolled-back'
                ? `Rolled back to ${after.label}`
                : `Rollback to ${after.label}`}
          </button>
        ) : null}
      </footer>
    </article>
  )
}

function formatSubtitle(v: VersionDiffVersion): string {
  const parts: string[] = []
  if (v.author) parts.push(v.author)
  if (v.createdAt) {
    const d = new Date(v.createdAt)
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleString())
  }
  return parts.join(' · ')
}

function DiffColumn({
  role,
  label,
  subtitle,
  lines,
  highlight,
}: {
  role: 'before' | 'after'
  label: string
  subtitle: string
  lines: string[]
  highlight?: boolean
}) {
  return (
    <section
      aria-label={`Version ${label} (${role})`}
      style={{
        borderLeft: role === 'after' ? `1px solid ${STUDIO_TOKENS_V2.border}` : 'none',
        background: highlight ? STUDIO_TOKENS_V2.blueTint : STUDIO_TOKENS_V2.bg,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <header
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
          background: STUDIO_TOKENS_V2.surface,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          {role === 'before' ? 'Before' : 'After'} · {label}
        </span>
        {subtitle ? (
          <span style={{ fontSize: 11, color: STUDIO_TOKENS_V2.muted2 }}>{subtitle}</span>
        ) : null}
      </header>
      <pre
        style={{
          margin: 0,
          padding: 12,
          fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
          fontSize: 12,
          lineHeight: 1.55,
          color: STUDIO_TOKENS_V2.ink2,
          overflow: 'auto',
          maxHeight: 420,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {lines.join('\n')}
      </pre>
    </section>
  )
}
