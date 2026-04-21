'use client'

/**
 * Sprint 050 A3 — Session artifacts right-rail card.
 *
 * Auto-populates as the operator approves build plans and accepts
 * suggested fixes. One row per artifact touched in the current
 * session: icon, title, state chip ("created · 30 sec ago"), deep-link
 * anchor to the existing tuning page (unified drawer is Bundle B).
 *
 * Deep-link routes are intentionally coarse. The drawer in Bundle B
 * replaces this map; nothing in the current feature set depends on
 * these exact paths.
 */
import { useEffect, useState } from 'react'
import {
  BookOpen,
  FileText,
  MessageSquare,
  Settings,
  Home,
  RotateCcw,
  CheckCircle2,
  Pencil,
} from 'lucide-react'
import { STUDIO_COLORS } from './tokens'

export type SessionArtifactType =
  | 'sop'
  | 'faq'
  | 'system_prompt'
  | 'tool'
  | 'property_override'

export type SessionArtifactAction = 'created' | 'modified' | 'reverted'

export interface SessionArtifact {
  /** Stable key — artifactId + subsection. Callers upsert by this. */
  id: string
  artifact: SessionArtifactType
  artifactId: string
  /** Human label — e.g. "SOP: early-checkin · CONFIRMED". */
  title: string
  action: SessionArtifactAction
  at: string // ISO
  /** Optional explicit deep-link; if absent, derived from the artifact map. */
  deepLink?: string
}

const TYPE_ICON: Record<SessionArtifactType, typeof BookOpen> = {
  sop: BookOpen,
  faq: MessageSquare,
  system_prompt: FileText,
  tool: Settings,
  property_override: Home,
}

const TYPE_LABEL: Record<SessionArtifactType, string> = {
  sop: 'SOP',
  faq: 'FAQ',
  system_prompt: 'Prompt',
  tool: 'Tool',
  property_override: 'Property',
}

const ACTION_ICON: Record<SessionArtifactAction, typeof CheckCircle2> = {
  created: CheckCircle2,
  modified: Pencil,
  reverted: RotateCcw,
}

const ACTION_STYLE: Record<SessionArtifactAction, { bg: string; fg: string }> = {
  created: { bg: STUDIO_COLORS.successBg, fg: STUDIO_COLORS.successFg },
  modified: { bg: STUDIO_COLORS.accentSoft, fg: STUDIO_COLORS.accent },
  reverted: { bg: STUDIO_COLORS.warnBg, fg: STUDIO_COLORS.warnFg },
}

/** Resolve a deep-link for an artifact. Coarse on purpose — Bundle B drawer supersedes. */
export function resolveArtifactDeepLink(a: SessionArtifact): string | undefined {
  if (a.deepLink) return a.deepLink
  switch (a.artifact) {
    case 'sop':
      return `/tuning/sops/${encodeURIComponent(a.artifactId)}`
    case 'faq':
      return `/tuning/faqs/${encodeURIComponent(a.artifactId)}`
    case 'tool':
      return `/tools/${encodeURIComponent(a.artifactId)}`
    case 'system_prompt':
      return `/configure-ai?section=${encodeURIComponent(a.artifactId)}`
    case 'property_override':
      return `/properties/${encodeURIComponent(a.artifactId)}#overrides`
    default:
      return undefined
  }
}

/**
 * Upsert helper used by the surface-level reducer. Newer action wins;
 * "reverted" overrides an earlier create/modify so the rail tells the
 * truth about the current state of the artifact.
 */
export function upsertSessionArtifact(
  prev: SessionArtifact[],
  next: SessionArtifact,
): SessionArtifact[] {
  const idx = prev.findIndex((a) => a.id === next.id)
  if (idx === -1) return [next, ...prev]
  const merged = [...prev]
  merged.splice(idx, 1)
  return [next, ...merged]
}

function formatRelative(fromIso: string, now: number): string {
  const then = Date.parse(fromIso)
  if (!Number.isFinite(then)) return ''
  const delta = Math.max(0, now - then)
  const sec = Math.round(delta / 1000)
  if (sec < 45) return `${sec || 1} sec ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const days = Math.round(hr / 24)
  return `${days} d ago`
}

export interface SessionArtifactsCardProps {
  artifacts: SessionArtifact[]
  /**
   * Sprint 051 A B1 — primary click target is the drawer, not the
   * deep-link. Deep-link stays available via the drawer's footer
   * "Open in tuning" button.
   */
  onOpen?: (artifact: SessionArtifact) => void
}

export function SessionArtifactsCard({
  artifacts,
  onOpen,
}: SessionArtifactsCardProps) {
  // Ticks the relative-time labels without re-rendering the caller.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (artifacts.length === 0) return
    const h = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(h)
  }, [artifacts.length])

  const empty = artifacts.length === 0
  return (
    <section
      aria-label="Session artifacts"
      style={{
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 6,
        background: STUDIO_COLORS.surfaceRaised,
        padding: 12,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            color: STUDIO_COLORS.inkMuted,
          }}
        >
          Session artifacts
        </span>
        {!empty && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10.5,
              color: STUDIO_COLORS.inkSubtle,
            }}
          >
            {artifacts.length}
          </span>
        )}
      </header>

      {empty ? (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: STUDIO_COLORS.inkSubtle,
          }}
        >
          No artifacts touched in this session yet.
        </p>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' }}>
          {artifacts.map((a) => (
            <SessionArtifactRow key={a.id} artifact={a} now={now} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SessionArtifactRow({
  artifact,
  now,
  onOpen,
}: {
  artifact: SessionArtifact
  now: number
  onOpen?: (a: SessionArtifact) => void
}) {
  const TypeIcon = TYPE_ICON[artifact.artifact]
  const ActionIcon = ACTION_ICON[artifact.action]
  const style = ACTION_STYLE[artifact.action]
  const href = resolveArtifactDeepLink(artifact)
  const rel = formatRelative(artifact.at, now)
  const body = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 8,
        alignItems: 'center',
        padding: '6px 8px',
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        background: STUDIO_COLORS.canvas,
        color: STUDIO_COLORS.ink,
        textDecoration: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          height: 22,
          width: 22,
          alignItems: 'center',
          justifyContent: 'center',
          background: STUDIO_COLORS.surfaceSunken,
          color: STUDIO_COLORS.inkMuted,
          borderRadius: 4,
        }}
      >
        <TypeIcon size={12} strokeWidth={2.25} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: STUDIO_COLORS.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={artifact.title}
        >
          {artifact.title}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
            fontSize: 10.5,
            color: STUDIO_COLORS.inkSubtle,
          }}
        >
          <span
            data-action={artifact.action}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '0 5px',
              borderRadius: 3,
              background: style.bg,
              color: style.fg,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.2,
            }}
          >
            <ActionIcon size={9} strokeWidth={2.5} aria-hidden />
            {artifact.action}
          </span>
          <span style={{ color: STUDIO_COLORS.inkSubtle }}>·</span>
          <span>{TYPE_LABEL[artifact.artifact]}</span>
          {rel && (
            <>
              <span style={{ color: STUDIO_COLORS.inkSubtle }}>·</span>
              <span>{rel}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
  // Sprint 051 A B1 — primary click target is the drawer when a handler
  // is wired. Right-click "open in tab" still works via the fallback
  // <a> below: we render a transparent anchor behind the button so
  // middle-click / cmd-click / right-click land on a real href. The
  // button sits on top and intercepts the primary click.
  return (
    <li data-artifact-id={artifact.id} style={{ position: 'relative' }}>
      {onOpen ? (
        <>
          {href ? (
            <a
              href={href}
              aria-hidden
              tabIndex={-1}
              style={{
                position: 'absolute',
                inset: 0,
                textDecoration: 'none',
                pointerEvents: 'auto',
                zIndex: 0,
              }}
            />
          ) : null}
          <button
            type="button"
            onClick={() => onOpen(artifact)}
            aria-label={`Open ${artifact.title}`}
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'block',
              width: '100%',
              padding: 0,
              border: 0,
              background: 'transparent',
              textAlign: 'left',
              cursor: 'pointer',
              color: 'inherit',
              font: 'inherit',
            }}
          >
            {body}
          </button>
        </>
      ) : href ? (
        <a
          href={href}
          aria-label={`Open ${artifact.title}`}
          style={{ textDecoration: 'none', display: 'block' }}
        >
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  )
}
