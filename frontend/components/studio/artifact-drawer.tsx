'use client'

/**
 * Sprint 051 A B1 — unified artifact drawer.
 *
 * One 480px slide-out that replaces the A3 session-artifacts deep-link
 * anchors. Accepts `{ artifact, artifactId }` plus an optional pending
 * flag (for A1-grammar-as-extended-to-the-drawer) and optional
 * `sessionStartIso` (B2: requests pre-session body so the toggle has
 * something to diff against). Routes internally to five view
 * components — one per artifact type.
 *
 * Keyboard: Esc closes; click-outside closes; focus moves to the panel
 * on open and returns to the opener on close (stored as a ref by
 * `StudioSurface`).
 *
 * Graceful degradation: a 404 renders a "missing artifact" banner, not
 * a crash. The session-artifacts rail can still show a row for an
 * artifact that got rolled back between approval and drawer-open.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  apiGetBuildArtifact,
  BuildArtifactNotFoundError,
  type BuildArtifactDetail,
  type BuildArtifactType,
} from '@/lib/build-api'
import { slug as slugify } from '@/lib/slug'
import { STUDIO_COLORS } from './tokens'
import { resolveArtifactDeepLink, type SessionArtifact } from './session-artifacts'
import { SopView } from './artifact-views/sop-view'
import { FaqView } from './artifact-views/faq-view'
import { SystemPromptView } from './artifact-views/system-prompt-view'
import { ToolView } from './artifact-views/tool-view'
import { PropertyOverrideView } from './artifact-views/property-override-view'

export interface ArtifactDrawerTarget {
  artifact: BuildArtifactType
  artifactId: string
  /** A1 pending grammar — session plan not yet approved. */
  isPending?: boolean
  /** B3 optional — scroll to a section heading after open. */
  scrollToSection?: string | null
  /** Passed to the row, used to derive deep-link + display title fallback. */
  sessionArtifact?: SessionArtifact | null
}

export interface ArtifactDrawerProps {
  open: boolean
  target: ArtifactDrawerTarget | null
  onClose: () => void
  /** Admin-gated full-output + body toggles. */
  isAdmin: boolean
  traceViewEnabled: boolean
  rawPromptEditorEnabled: boolean
  /** B2 — ISO timestamp that delimits "this session" for the prev-body lookup. */
  sessionStartIso?: string | null
}

const TYPE_LABEL: Record<BuildArtifactType, string> = {
  sop: 'SOP',
  faq: 'FAQ',
  system_prompt: 'System prompt',
  tool: 'Tool',
  property_override: 'Property override',
}

export function ArtifactDrawer(props: ArtifactDrawerProps) {
  const {
    open,
    target,
    onClose,
    isAdmin,
    traceViewEnabled,
    rawPromptEditorEnabled,
    sessionStartIso,
  } = props

  const panelRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<BuildArtifactDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [showFullSensitive, setShowFullSensitive] = useState(false)
  const contentBodyRef = useRef<HTMLDivElement>(null)

  // Load the artifact whenever the target changes. Guarded by `open` to
  // avoid eager fetches when the drawer isn't mounted visibly.
  useEffect(() => {
    if (!open || !target) return
    let cancelled = false
    setDetail(null)
    setNotFound(false)
    setError(null)
    setShowDiff(false)
    setShowFullSensitive(false)
    setLoading(true)
    apiGetBuildArtifact(target.artifact, target.artifactId, {
      prevSince: sessionStartIso ?? undefined,
    })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof BuildArtifactNotFoundError) {
          setNotFound(true)
        } else {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, target, sessionStartIso])

  // Focus the panel on open; Esc + focus-trap. `panelRef` uses tabIndex
  // -1 so the initial programmatic focus lands somewhere reasonable
  // without stealing focus from inner interactive elements.
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        // Simple focus trap — cycle focusables inside the panel only.
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // B3/C1: scroll-to-section is delegated to `MarkdownBody` (which owns
  // the rendered body + slug rule). The drawer retains a fallback scroll
  // for non-markdown views and for the diff branch — if the body is
  // rendered raw, we still try a best-effort DOM walk so the feature
  // degrades instead of silently doing nothing. Stale fragments no-op.
  useEffect(() => {
    if (!detail || !target?.scrollToSection) return
    const root = contentBodyRef.current
    if (!root) return
    const sectionSlug = slugify(target.scrollToSection)
    const frame = requestAnimationFrame(() => {
      const headings = root.querySelectorAll<HTMLElement>(
        'h1, h2, h3, [data-section]',
      )
      const match = Array.from(headings).find((h) => {
        const s = h.dataset?.section ?? slugify(h.textContent ?? '')
        return s === sectionSlug
      })
      if (match) match.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [detail, target?.scrollToSection])

  const hasPrev = useMemo(
    () =>
      typeof detail?.prevBody === 'string' &&
      detail.prevBody !== detail.body,
    [detail],
  )
  // 052-C3: JSON diff eligibility — any prev-schema payload present on
  // the tool artifact enables the toggle. Sanitisation happens inside
  // `JsonDiffBody`; the drawer just decides whether to render the toggle.
  const hasPrevJson = useMemo(() => {
    if (!detail) return false
    return (
      detail.prevParameters !== undefined ||
      detail.prevWebhookConfig !== undefined
    )
  }, [detail])
  const showDiffToggleVisible = showDiffToggle(
    target?.artifact ?? 'sop',
    hasPrev,
    hasPrevJson,
    isAdmin,
    rawPromptEditorEnabled,
  )

  if (!open || !target) return null

  const headerTitle = detail?.title ?? target.sessionArtifact?.title ?? 'Artifact'
  const typeLabel = TYPE_LABEL[target.artifact]
  const deepLink =
    target.sessionArtifact && resolveArtifactDeepLink(target.sessionArtifact)
  const isPending = Boolean(target.isPending)
  const adminGated = isAdmin && traceViewEnabled
  const showFullAffordance =
    target.artifact === 'tool' && adminGated && Boolean(detail?.webhookConfig)

  return (
    <>
      <button
        type="button"
        aria-label="Close artifact drawer"
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
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`${typeLabel} · ${headerTitle}`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '100vw',
          background: STUDIO_COLORS.canvas,
          borderLeft: `1px solid ${STUDIO_COLORS.hairline}`,
          boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.08)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
        }}
      >
        <header
          style={{
            padding: '14px 16px',
            borderBottom: `1px solid ${STUDIO_COLORS.hairline}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: 'uppercase',
                color: STUDIO_COLORS.inkMuted,
              }}
            >
              {typeLabel}
              {isPending ? ' · pending' : ''}
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: STUDIO_COLORS.ink,
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={headerTitle}
            >
              {headerTitle}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: `1px solid ${STUDIO_COLORS.hairline}`,
              borderRadius: 5,
              padding: 4,
              color: STUDIO_COLORS.inkMuted,
              cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </header>

        <div
          ref={contentBodyRef}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '14px 16px',
          }}
        >
          {loading ? <Skeleton /> : null}
          {notFound ? (
            <MissingBanner
              artifactId={target.artifactId}
              typeLabel={typeLabel}
            />
          ) : null}
          {error ? <ErrorBanner message={error} /> : null}
          {detail ? (
            <ViewSwitch
              artifact={detail}
              type={target.artifact}
              isAdmin={isAdmin}
              traceViewEnabled={traceViewEnabled}
              rawPromptEditorEnabled={rawPromptEditorEnabled}
              showDiff={showDiff}
              showFullSensitive={showFullSensitive}
              isPending={isPending}
              scrollToSectionSlug={
                target.scrollToSection
                  ? slugify(target.scrollToSection)
                  : null
              }
            />
          ) : null}
        </div>

        <footer
          style={{
            borderTop: `1px solid ${STUDIO_COLORS.hairline}`,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: STUDIO_COLORS.surfaceRaised,
          }}
        >
          {showDiffToggleVisible ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: STUDIO_COLORS.inkMuted,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={showDiff}
                onChange={(e) => setShowDiff(e.currentTarget.checked)}
                aria-label="Show changes this session"
              />
              View changes
            </label>
          ) : null}
          {showFullAffordance ? (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: STUDIO_COLORS.inkMuted,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={showFullSensitive}
                onChange={(e) => setShowFullSensitive(e.currentTarget.checked)}
                aria-label="Show full webhook config (admin)"
              />
              Show full (admin)
            </label>
          ) : null}
          <div style={{ flex: 1 }} />
          {deepLink ? (
            <a
              href={deepLink}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 11.5,
                color: STUDIO_COLORS.accent,
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              Open in tuning ↗
            </a>
          ) : null}
        </footer>
      </aside>
    </>
  )
}

/**
 * 052-C2/C3: centralise the footer-toggle visibility rule. Shows when:
 *  - sop/faq: prevBody string differs from current (existing B2 rule).
 *  - system_prompt: prevBody differs AND the viewer can see the body
 *    (admin + rawPromptEditorEnabled); otherwise the diff is moot.
 *  - tool: prevParameters or prevWebhookConfig is present (C3 JSON diff).
 */
function showDiffToggle(
  type: BuildArtifactType,
  hasPrev: boolean,
  hasPrevJson: boolean,
  isAdmin: boolean,
  rawPromptEditorEnabled: boolean,
): boolean {
  if (type === 'sop' || type === 'faq') return hasPrev
  if (type === 'system_prompt') {
    return hasPrev && isAdmin && rawPromptEditorEnabled
  }
  if (type === 'tool') return hasPrevJson
  return false
}

function ViewSwitch(props: {
  artifact: BuildArtifactDetail
  type: BuildArtifactType
  isAdmin: boolean
  traceViewEnabled: boolean
  rawPromptEditorEnabled: boolean
  showDiff: boolean
  showFullSensitive: boolean
  isPending: boolean
  scrollToSectionSlug: string | null
}) {
  const {
    artifact,
    type,
    isAdmin,
    traceViewEnabled,
    rawPromptEditorEnabled,
    showDiff,
    showFullSensitive,
    isPending,
    scrollToSectionSlug,
  } = props
  switch (type) {
    case 'sop':
      return (
        <SopView
          artifact={artifact}
          showDiff={showDiff}
          isPending={isPending}
          scrollToSectionSlug={scrollToSectionSlug}
        />
      )
    case 'faq':
      return (
        <FaqView
          artifact={artifact}
          showDiff={showDiff}
          isPending={isPending}
          scrollToSectionSlug={scrollToSectionSlug}
        />
      )
    case 'system_prompt':
      return (
        <SystemPromptView
          artifact={artifact}
          isAdmin={isAdmin}
          rawPromptEditorEnabled={rawPromptEditorEnabled}
          isPending={isPending}
          showDiff={showDiff}
          scrollToSectionSlug={scrollToSectionSlug}
        />
      )
    case 'tool':
      return (
        <ToolView
          artifact={artifact}
          isAdmin={isAdmin}
          traceViewEnabled={traceViewEnabled}
          showFullSensitive={showFullSensitive}
          isPending={isPending}
          showDiff={showDiff}
        />
      )
    case 'property_override':
      return <PropertyOverrideView artifact={artifact} isPending={isPending} />
  }
}

function Skeleton() {
  return (
    <div
      role="status"
      aria-busy
      aria-label="Loading artifact"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {[48, 120, 28, 160].map((h, i) => (
        <div
          key={i}
          style={{
            height: h,
            background: STUDIO_COLORS.surfaceRaised,
            border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
            borderRadius: 5,
          }}
        />
      ))}
    </div>
  )
}

function MissingBanner({
  artifactId,
  typeLabel,
}: {
  artifactId: string
  typeLabel: string
}) {
  return (
    <div
      role="alert"
      style={{
        padding: 12,
        background: STUDIO_COLORS.warnBg,
        color: STUDIO_COLORS.warnFg,
        borderLeft: `2px solid ${STUDIO_COLORS.warnFg}`,
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      This {typeLabel.toLowerCase()} <code>{artifactId}</code> couldn’t
      be found. It may have been rolled back or deleted since this
      session recorded it.
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        padding: 12,
        background: STUDIO_COLORS.dangerBg,
        color: STUDIO_COLORS.dangerFg,
        borderLeft: `2px solid ${STUDIO_COLORS.dangerFg}`,
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      Failed to load artifact: {message}
    </div>
  )
}

