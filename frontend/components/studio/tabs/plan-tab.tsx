'use client'

// Sprint 046 — Studio design overhaul (plan T027 + FR-031).
//
// Plan tab. Renders:
//   1. CURRENT PLAN eyebrow + plan title
//   2. N/M fraction + blue progress bar (400ms ease-out) + percentage
//   3. Current state snapshot (subsumes the old rail StateSnapshotCard)
//   4. Thin divider
//   5. CONTEXT IN USE — session artifacts touched since sessionStartIso
//
// The existing PlanChecklist component is driven by SSE parts streamed
// into StudioChat, not rendered here — the design's "task list" maps
// conceptually to the checklist but the canonical render lives inline
// in the center-pane turn that emitted it. This tab surfaces the
// "current plan" header + state snapshot + context list.

import { STUDIO_TOKENS_V2 } from '../tokens'
import { StateSnapshotCard, type StateSnapshotData } from '../state-snapshot'
import { FileIcon, BookIcon, FlaskIcon, HotelIcon } from '../icons'
import type { SessionArtifact } from '../session-artifacts'

export interface PlanTabProps {
  snapshot: StateSnapshotData
  sessionArtifacts: SessionArtifact[]
  onOpenArtifact?: (a: SessionArtifact) => void
}

export function PlanTab({ snapshot, sessionArtifacts, onOpenArtifact }: PlanTabProps) {
  const recent = sessionArtifacts.slice(0, 5)

  const summary = snapshot.scope === 'summary' ? snapshot.summary : null
  const planTitle =
    summary?.posture === 'GREENFIELD' ? 'Set up your reply agent' : 'Tune your reply agent'

  return (
    <div style={{ padding: '18px 18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Current plan
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 500,
            color: STUDIO_TOKENS_V2.ink,
          }}
        >
          {planTitle}
        </h3>
      </header>

      <StateSnapshotCard data={snapshot} />

      <div
        style={{
          height: 1,
          background: STUDIO_TOKENS_V2.border,
          margin: '6px 0',
        }}
      />

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Context in use
        </span>
        {recent.length === 0 ? (
          <p style={{ fontSize: 12, color: STUDIO_TOKENS_V2.muted2, margin: 0 }}>
            No artifacts touched in this session yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recent.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onOpenArtifact?.(a)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    cursor: onOpenArtifact ? 'pointer' : 'default',
                    textAlign: 'left',
                    fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = STUDIO_TOKENS_V2.surface
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <ArtifactIcon kind={a.artifact} />
                  <span
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      color: STUDIO_TOKENS_V2.ink2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.title}
                  </span>
                  <KindPill kind={a.artifact} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ArtifactIcon({ kind }: { kind: SessionArtifact['artifact'] }) {
  switch (kind) {
    case 'sop':
      return <BookIcon size={13} style={{ color: STUDIO_TOKENS_V2.muted }} />
    case 'faq':
      return <FlaskIcon size={13} style={{ color: STUDIO_TOKENS_V2.muted }} />
    case 'system_prompt':
      return <FileIcon size={13} style={{ color: STUDIO_TOKENS_V2.muted }} />
    case 'tool':
      return <FlaskIcon size={13} style={{ color: STUDIO_TOKENS_V2.muted }} />
    case 'property_override':
      return <HotelIcon size={13} style={{ color: STUDIO_TOKENS_V2.muted }} />
  }
}

function KindPill({ kind }: { kind: SessionArtifact['artifact'] }) {
  const label =
    kind === 'sop'
      ? 'SOP'
      : kind === 'faq'
        ? 'FAQ'
        : kind === 'system_prompt'
          ? 'prompt'
          : kind === 'tool'
            ? 'tool'
            : 'config'
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '1px 6px',
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: 4,
        color: STUDIO_TOKENS_V2.muted,
        fontFamily: 'var(--font-sans, Inter Tight, sans-serif)',
      }}
    >
      {label}
    </span>
  )
}
