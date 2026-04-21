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
 *
 * Sprint 055-A F2 — inline edit mode for the preview pane. When
 * pendingBody is present and a preview has been fetched, a pencil-icon
 * toggle switches the preview pane to an editable form. Edits debounce
 * re-preview at 400ms. Apply submits the edited body.
 *
 * Sprint 055-A F3 — operator rationale prompt. When the edit is
 * material (>10 char diff) and Apply is clicked, an inline textarea
 * appears for an optional "why did you change this?" note. The
 * rationale is forwarded to the history row via metadata.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Pencil } from 'lucide-react'
import {
  apiApplyArtifact,
  apiGetBuildArtifact,
  BuildArtifactNotFoundError,
  type ApplyArtifactResult,
  type BuildArtifactDetail,
  type BuildArtifactType,
} from '@/lib/build-api'
import { ApiError } from '@/lib/api'
import { slug as slugify } from '@/lib/slug'
import { STUDIO_COLORS } from './tokens'
import { resolveArtifactDeepLink, type SessionArtifact } from './session-artifacts'
import { SopView } from './artifact-views/sop-view'
import { FaqView } from './artifact-views/faq-view'
import { SystemPromptView } from './artifact-views/system-prompt-view'
import { ToolView } from './artifact-views/tool-view'
import { PropertyOverrideView } from './artifact-views/property-override-view'
import {
  RationaleCard,
  extractRationale,
  extractEditProvenance,
} from './artifact-views/rationale-card'
// Sprint 055-A F2 — inline editor components
import { SopEditor } from './artifact-views/sop-editor'
import { FaqEditor } from './artifact-views/faq-editor'
import { SystemPromptEditor } from './artifact-views/system-prompt-editor'
import { ToolEditor } from './artifact-views/tool-editor'
import { PropertyOverrideEditor } from './artifact-views/property-override-editor'
import type { BuildArtifactHistoryRow } from '@/lib/build-api'

export interface ArtifactDrawerTarget {
  artifact: BuildArtifactType
  artifactId: string
  /** A1 pending grammar — session plan not yet approved. */
  isPending?: boolean
  /** B3 optional — scroll to a section heading after open. */
  scrollToSection?: string | null
  /** Passed to the row, used to derive deep-link + display title fallback. */
  sessionArtifact?: SessionArtifact | null
  /**
   * Sprint 054-A F2 — when the drawer was opened from a write-ledger row,
   * carry the row so we can render the rationale card above the diff.
   * Absent when opened from session-artifacts rail / deep links.
   */
  historyRow?: BuildArtifactHistoryRow | null
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
  /**
   * Sprint 053-A D3 — agent-proposed update payload for this artifact.
   * When set, the drawer footer renders Preview (primary) + Apply
   * (subordinate, disabled until preview). Preview calls the apply
   * endpoint with dryRun:true; Apply calls it with dryRun:false.
   */
  pendingBody?: Record<string, unknown> | null
  /** Conversation threaded into apply calls for the write-ledger rail. */
  conversationId?: string | null
  /** Called after a successful Apply. Drawer auto-closes. */
  onApplied?: (artifact: BuildArtifactType, id: string) => void
}

const TYPE_LABEL: Record<BuildArtifactType, string> = {
  sop: 'SOP',
  faq: 'FAQ',
  system_prompt: 'System prompt',
  tool: 'Tool',
  property_override: 'Property override',
}

/**
 * Sprint 055-A F3 — edit-distance helper. Returns true when the operator
 * edit is "material" (more than 10 character diff). Uses a fast length
 * check first; only walks individual chars when the strings are similar
 * in length. Capped at 50 characters of difference for performance.
 */
function isMaterialEdit(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (Math.abs(sa.length - sb.length) > 10) return true
  if (sa.includes('\n') !== sb.includes('\n')) return true
  // Simple char-distance approximation
  let diff = 0
  const maxLen = Math.max(sa.length, sb.length)
  void maxLen // used implicitly via min loop
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) diff++
    if (diff > 10) return true
  }
  return diff + Math.abs(sa.length - sb.length) > 10
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
    pendingBody,
    conversationId,
    onApplied,
  } = props

  const panelRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<BuildArtifactDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [showFullSensitive, setShowFullSensitive] = useState(false)
  const contentBodyRef = useRef<HTMLDivElement>(null)
  // D3: preview/apply state. `previewResult` holds the dryRun response
  // once a preview has been fetched; `previewError` holds the inline
  // validation error surfaced by the backend.
  const [previewResult, setPreviewResult] = useState<ApplyArtifactResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  // Sprint 055-A F2 — inline edit state.
  const [editMode, setEditMode] = useState(false)
  const [editedBody, setEditedBody] = useState<Record<string, unknown> | null>(null)
  // Sprint 055-A F3 — operator rationale state.
  const [operatorRationale, setOperatorRationale] = useState('')
  // Debounce timer for re-preview on edit.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    // D3 — reset preview state whenever the target changes.
    setPreviewResult(null)
    setPreviewError(null)
    setPreviewLoading(false)
    setApplying(false)
    // 055-A F2/F3 — reset inline edit state on target change.
    setEditMode(false)
    setEditedBody(null)
    setOperatorRationale('')
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

  // Sprint 055-A F2 — the "active" body: edited version when present, else
  // the agent-proposed pendingBody. This is what Preview and Apply submit.
  const activeBody = editedBody ?? pendingBody ?? null

  // Sprint 055-A F2 — debounced re-preview on edit. Fires 400ms after the
  // last edit when preview is already loaded (editMode active + previewOK).
  useEffect(() => {
    if (!editMode || !editedBody || !target || !pendingBody) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const res = await apiApplyArtifact(target.artifact, target.artifactId, {
          dryRun: true,
          body: editedBody,
          conversationId: conversationId ?? null,
        })
        if (res.ok) {
          setPreviewResult(res)
        } else {
          setPreviewError(res.error ?? 'Validation failed')
          setPreviewResult(null)
        }
      } catch {
        // Silently drop debounce errors — user can still manually Preview.
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedBody])

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
  const hasPendingBody = !!pendingBody && Object.keys(pendingBody).length > 0
  const previewActive = hasPendingBody && previewResult != null && previewResult.ok
  // Sprint 055-A F3 — rationale prompt shown when edit is material.
  const showRationalePrompt =
    editedBody !== null &&
    pendingBody !== null &&
    pendingBody !== undefined &&
    isMaterialEdit(pendingBody, editedBody)

  async function handlePreviewClick() {
    if (!target || !activeBody) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await apiApplyArtifact(target.artifact, target.artifactId, {
        dryRun: true,
        body: activeBody,
        conversationId: conversationId ?? null,
      })
      if (res.ok) {
        setPreviewResult(res)
      } else {
        setPreviewError(res.error ?? 'Validation failed')
        setPreviewResult(null)
      }
    } catch (err) {
      if (err instanceof ApiError && err.data && typeof err.data === 'object') {
        setPreviewError((err.data as any).error ?? err.message)
      } else {
        setPreviewError(err instanceof Error ? err.message : String(err))
      }
      setPreviewResult(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleApplyClick() {
    if (!target || !activeBody) return
    setApplying(true)
    try {
      // Sprint 055-A F3 — include operator metadata when an edit was made.
      const applyMetadata: Record<string, unknown> | null =
        editedBody !== null
          ? {
              rationalePrefix: 'edited-by-operator',
              ...(operatorRationale ? { operatorRationale } : {}),
            }
          : null
      const res = await apiApplyArtifact(target.artifact, target.artifactId, {
        dryRun: false,
        body: activeBody,
        conversationId: conversationId ?? null,
        ...(applyMetadata ? { metadata: applyMetadata } : {}),
      })
      if (res.ok) {
        // Dev-time parity assertion (055-A F2 spec).
        if (process.env.NODE_ENV === 'development' && editedBody !== null) {
          console.assert(
            (previewResult as any)?.sanitizedBody !== undefined,
            '[055-parity] sanitizedBody absent in previewResult — drift check skipped',
          )
        }
        if (onApplied) onApplied(target.artifact, target.artifactId)
        onClose()
      } else {
        setPreviewError(res.error ?? 'Apply failed')
      }
    } catch (err) {
      if (err instanceof ApiError && err.data && typeof err.data === 'object') {
        setPreviewError((err.data as any).error ?? err.message)
      } else {
        setPreviewError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setApplying(false)
    }
  }

  function clearPreview() {
    setPreviewResult(null)
    setPreviewError(null)
  }

  // Synthesize a preview detail by overlaying the preview body onto the
  // loaded artifact. Keeps the existing per-type views unmodified.
  const renderDetail: BuildArtifactDetail | null =
    previewActive && detail
      ? synthesizePreviewDetail(detail, previewResult)
      : detail
  const renderShowDiff = previewActive ? true : showDiff
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Sprint 055-A F2 — pencil toggle: only shown when pendingBody + previewActive */}
            {hasPendingBody && previewActive ? (
              <button
                type="button"
                onClick={() => {
                  if (editMode) {
                    // Leaving edit mode — keep editedBody (do NOT reset)
                    setEditMode(false)
                  } else {
                    setEditMode(true)
                    // Seed editedBody from current activeBody on first edit
                    if (editedBody === null) {
                      setEditedBody({ ...(pendingBody ?? {}) })
                    }
                  }
                }}
                aria-label="Toggle inline edit"
                aria-pressed={editMode}
                title={editMode ? 'Exit edit mode' : 'Edit draft inline'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: `1px solid ${editMode ? STUDIO_COLORS.accent : STUDIO_COLORS.hairline}`,
                  borderRadius: 5,
                  padding: 4,
                  color: editMode ? STUDIO_COLORS.accent : STUDIO_COLORS.inkMuted,
                  cursor: 'pointer',
                }}
              >
                <Pencil size={14} />
              </button>
            ) : null}
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
          </div>
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
          {previewActive ? <PreviewBanner onClear={clearPreview} /> : null}
          {previewError ? <PreviewErrorBanner message={previewError} /> : null}
          {/* 054-A F2 — history view: surface the rationale above the diff.
              The card renders even when rationale is missing, so pre-F1
              rows get a consistent "No rationale recorded" instead of a
              layout shift. Non-history drawer opens omit the card entirely. */}
          {target?.historyRow ? (
            <div
              data-testid="artifact-drawer-rationale-slot"
              style={{ marginBottom: 12 }}
            >
              <RationaleCard
                variant="drawer"
                rationale={extractRationale(target.historyRow.metadata)}
                {...extractEditProvenance(target.historyRow.metadata)}
              />
            </div>
          ) : null}
          {renderDetail ? (
            editMode && activeBody ? (
              <>
                <EditorSwitch
                  type={target.artifact}
                  value={activeBody}
                  onChange={(v) => setEditedBody(v)}
                />
                {/* Sprint 055-A F2 — Reset to agent draft */}
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    aria-label="Reset to agent draft"
                    onClick={() => {
                      setEditedBody(null)
                      setEditMode(false)
                      setOperatorRationale('')
                    }}
                    style={{
                      fontSize: 11.5,
                      color: STUDIO_COLORS.inkMuted,
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    Reset to agent draft
                  </button>
                </div>
              </>
            ) : (
              <ViewSwitch
                artifact={renderDetail}
                type={target.artifact}
                isAdmin={isAdmin}
                traceViewEnabled={traceViewEnabled}
                rawPromptEditorEnabled={rawPromptEditorEnabled}
                showDiff={renderShowDiff}
                showFullSensitive={showFullSensitive}
                isPending={isPending}
                scrollToSectionSlug={
                  target.scrollToSection
                    ? slugify(target.scrollToSection)
                    : null
                }
              />
            )
          ) : null}
          {/* 054-A F4 — in history view, surface the stored verification
              result below the diff so the user can see the verdict + judge
              reasoning without having to scroll the chat back. */}
          {target?.historyRow ? (
            <VerificationSection row={target.historyRow} />
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
          {hasPendingBody ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', width: '100%' }}>
              {/* Sprint 055-A F3 — rationale prompt for material edits */}
              {showRationalePrompt ? (
                <div style={{ width: '100%' }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: STUDIO_COLORS.inkMuted,
                      marginBottom: 4,
                    }}
                  >
                    Why did you change this? (optional, helps the agent learn)
                  </label>
                  <textarea
                    data-testid="operator-rationale-input"
                    rows={2}
                    maxLength={200}
                    value={operatorRationale}
                    onChange={(e) => setOperatorRationale(e.target.value)}
                    placeholder="e.g. Fixed a typo, adjusted tone…"
                    style={{
                      width: '100%',
                      fontSize: 11.5,
                      borderRadius: 4,
                      border: `1px solid ${STUDIO_COLORS.hairline}`,
                      padding: '4px 8px',
                      resize: 'none',
                      color: STUDIO_COLORS.ink,
                    }}
                  />
                </div>
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={handlePreviewClick}
                  disabled={previewLoading || applying}
                  aria-label="Preview change"
                  style={footerButtonStyle(previewActive ? 'ghost' : 'primary', previewLoading)}
                >
                  {previewLoading ? 'Previewing…' : previewActive ? 'Re-preview' : 'Preview'}
                </button>
                <button
                  type="button"
                  onClick={handleApplyClick}
                  disabled={!previewActive || applying}
                  aria-label="Apply change"
                  style={footerButtonStyle('apply', applying)}
                >
                  {applying ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          ) : null}
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

/**
 * Sprint 055-A F2 — editor routing. Maps artifact type to its editor.
 */
function EditorSwitch({
  type,
  value,
  onChange,
}: {
  type: BuildArtifactType
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  switch (type) {
    case 'sop':
      return <SopEditor value={value} onChange={onChange} />
    case 'faq':
      return <FaqEditor value={value} onChange={onChange} />
    case 'system_prompt':
      return <SystemPromptEditor value={value} onChange={onChange} />
    case 'tool':
      return <ToolEditor value={value} onChange={onChange} />
    case 'property_override':
      return <PropertyOverrideEditor value={value} onChange={onChange} />
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

/**
 * D3: amber "preview — not saved yet" banner with a Clear link. Kept
 * inline (not in a token for now) because Studio's warning token may
 * or may not exist per-theme; this pass uses a stable hex that reads
 * as distinct from the notFound/error banners.
 */
function PreviewBanner({ onClear }: { onClear: () => void }) {
  return (
    <div
      role="status"
      data-testid="preview-banner"
      style={{
        padding: 10,
        background: '#FFF5E4',
        color: '#7A4A05',
        borderLeft: '2px solid #D48A1B',
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.5,
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ flex: 1, fontWeight: 500 }}>Preview — not saved yet</span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear preview"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#7A4A05',
          fontSize: 11.5,
          fontWeight: 500,
          textDecoration: 'underline',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        Clear preview
      </button>
    </div>
  )
}

function PreviewErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      data-testid="preview-error"
      style={{
        padding: 10,
        background: STUDIO_COLORS.dangerBg,
        color: STUDIO_COLORS.dangerFg,
        borderLeft: `2px solid ${STUDIO_COLORS.dangerFg}`,
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.5,
        marginBottom: 12,
      }}
    >
      {message}
    </div>
  )
}

function footerButtonStyle(
  variant: 'primary' | 'apply' | 'ghost',
  busy: boolean,
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    padding: '5px 10px',
    borderRadius: 5,
    cursor: busy ? 'progress' : 'pointer',
    lineHeight: 1.3,
  }
  if (variant === 'primary') {
    return {
      ...base,
      background: STUDIO_COLORS.accent,
      color: '#fff',
      border: `1px solid ${STUDIO_COLORS.accent}`,
    }
  }
  if (variant === 'apply') {
    return {
      ...base,
      background: STUDIO_COLORS.ink,
      color: '#fff',
      border: `1px solid ${STUDIO_COLORS.ink}`,
      opacity: busy ? 0.6 : 1,
    }
  }
  return {
    ...base,
    background: 'transparent',
    color: STUDIO_COLORS.ink,
    border: `1px solid ${STUDIO_COLORS.hairline}`,
  }
}

/**
 * Overlay the preview payload onto the loaded artifact detail so the
 * existing per-type view renders the proposed body with `showDiff`
 * flipped on. `prevBody` becomes the current saved body; `body` becomes
 * the preview body. Fields that don't apply to a type are ignored.
 */
function synthesizePreviewDetail(
  base: BuildArtifactDetail,
  preview: ApplyArtifactResult | null,
): BuildArtifactDetail {
  if (!preview || !preview.preview || typeof preview.preview !== 'object') {
    return base
  }
  const p = preview.preview as Record<string, unknown>
  const nextBody =
    typeof p.content === 'string'
      ? p.content
      : typeof p.text === 'string'
      ? p.text
      : typeof p.answer === 'string'
      ? p.answer
      : typeof p.description === 'string'
      ? p.description
      : base.body
  return {
    ...base,
    body: nextBody,
    prevBody: base.body,
  }
}

// ─── Sprint 054-A F4 — Verification section in drawer history view ──────
//
// Reads metadata.testResult that F3 writes back to the triggering
// history row, renders a compact verdict-first card identical in
// shape to the chat renderer but rooted in the drawer for persistent
// reference. Renders nothing when no result is stored.

interface StoredVerificationVariant {
  triggerMessage: string
  pipelineOutput: string
  verdict: 'passed' | 'failed'
  judgeReasoning: string
  judgePromptVersion: string
  ranAt: string
}
interface StoredVerificationResult {
  variants: StoredVerificationVariant[]
  aggregateVerdict: 'all_passed' | 'partial' | 'all_failed'
  ritualVersion: string
}

function extractStoredVerification(
  metadata: Record<string, unknown> | null | undefined,
): StoredVerificationResult | null {
  if (!metadata || typeof metadata !== 'object') return null
  const tr = (metadata as { testResult?: unknown }).testResult
  if (!tr || typeof tr !== 'object') return null
  const trObj = tr as Record<string, unknown>
  const variants = Array.isArray(trObj.variants)
    ? (trObj.variants as StoredVerificationVariant[])
    : []
  const agg = trObj.aggregateVerdict
  if (agg !== 'all_passed' && agg !== 'partial' && agg !== 'all_failed') return null
  const ritualVersion = typeof trObj.ritualVersion === 'string' ? trObj.ritualVersion : ''
  return { variants, aggregateVerdict: agg, ritualVersion }
}

function VerificationSection({
  row,
}: {
  row: import('@/lib/build-api').BuildArtifactHistoryRow
}) {
  const result = extractStoredVerification(row.metadata)
  if (!result) return null
  const passed = result.variants.filter((v) => v.verdict === 'passed').length
  const total = result.variants.length
  const headline =
    result.aggregateVerdict === 'all_passed'
      ? `${total}/${total} passed`
      : result.aggregateVerdict === 'all_failed'
      ? `0/${total} passed`
      : `${passed}/${total} passed — ${total - passed} failed`
  const color =
    result.aggregateVerdict === 'all_passed'
      ? STUDIO_COLORS.successFg
      : result.aggregateVerdict === 'all_failed'
      ? STUDIO_COLORS.dangerFg
      : STUDIO_COLORS.warnFg
  return (
    <section
      id="verification"
      data-testid="artifact-drawer-verification-section"
      data-aggregate={result.aggregateVerdict}
      style={{
        marginTop: 14,
        padding: 12,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 6,
        background: STUDIO_COLORS.surfaceRaised,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          color: STUDIO_COLORS.inkSubtle,
          marginBottom: 6,
        }}
      >
        Verification
      </div>
      <div
        data-testid="artifact-drawer-verification-headline"
        style={{ fontSize: 14, fontWeight: 700, color }}
      >
        {headline}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {result.variants.map((v, i) => (
          <li
            key={i}
            style={{
              fontSize: 12,
              color: STUDIO_COLORS.inkMuted,
              borderLeft:
                v.verdict === 'failed'
                  ? `3px solid ${STUDIO_COLORS.warnFg}`
                  : 'none',
              paddingLeft: v.verdict === 'failed' ? 8 : 0,
            }}
          >
            <span
              style={{
                fontWeight: 600,
                marginRight: 6,
                color:
                  v.verdict === 'passed'
                    ? STUDIO_COLORS.successFg
                    : STUDIO_COLORS.warnFg,
              }}
            >
              {v.verdict === 'passed' ? 'Passed.' : "Didn't work."}
            </span>
            {v.judgeReasoning}
          </li>
        ))}
      </ul>
      {result.ritualVersion ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 10.5,
            fontFamily: 'monospace',
            color: STUDIO_COLORS.inkSubtle,
          }}
        >
          ritual {result.ritualVersion}
        </div>
      ) : null}
    </section>
  )
}

