'use client'

/**
 * Sprint 051 A B1 — tool definition viewer.
 *
 * Webhook config passes through the tool-call sanitiser (same seam the
 * tool-call drawer uses) — a custom tool that persists an api key or
 * bearer token in `webhookUrl`'s query string would otherwise leak.
 * The 050-A tighten-up regex catches arbitrary-named custom fields;
 * here we just feed the payload through.
 *
 * Admin-gated runtime flag affordance is a placeholder for the edit
 * path — this sprint remains viewer-only (brief §2 non-negotiable).
 */
import { useMemo } from 'react'
import type { BuildArtifactDetail } from '@/lib/build-api'
import { sanitiseToolPayload } from '@/lib/tool-call-sanitise'
import { STUDIO_COLORS } from '../tokens'
import { ArtifactMetaGrid } from './meta-grid'
import { PendingBadge } from './pending-badge'
import { PreBody, SectionHeading } from './sop-view'

export interface ToolViewProps {
  artifact: BuildArtifactDetail
  isAdmin: boolean
  traceViewEnabled: boolean
  showFullSensitive: boolean
  isPending: boolean
}

export function ToolView({
  artifact,
  isAdmin,
  traceViewEnabled,
  showFullSensitive,
  isPending,
}: ToolViewProps) {
  const meta = artifact.meta as {
    name?: string
    displayName?: string
    agentScope?: string
    toolType?: string
    enabled?: boolean
    parameters?: unknown
    updatedAt?: string
    buildTransactionId?: string | null
  }
  const adminGated = isAdmin && traceViewEnabled
  const tier = adminGated && showFullSensitive ? 'admin' : 'operator'
  const sanitisedConfig = useMemo(() => {
    if (!artifact.webhookConfig) return null
    return sanitiseToolPayload(artifact.webhookConfig, { tier }) as Record<
      string,
      unknown
    >
  }, [artifact.webhookConfig, tier])
  const sanitisedParameters = useMemo(() => {
    return sanitiseToolPayload(meta.parameters, { tier })
  }, [meta.parameters, tier])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isPending && <PendingBadge />}
      <ArtifactMetaGrid
        rows={[
          { label: 'Name', value: meta.name ?? '—' },
          { label: 'Display name', value: meta.displayName ?? '—' },
          { label: 'Agent scope', value: meta.agentScope ?? '—' },
          { label: 'Type', value: meta.toolType ?? '—' },
          { label: 'Enabled', value: meta.enabled === false ? 'no' : 'yes' },
          { label: 'Last updated', value: formatDate(meta.updatedAt) },
          meta.buildTransactionId
            ? { label: 'Source plan', value: meta.buildTransactionId }
            : null,
        ].filter(Boolean) as { label: string; value: string }[]}
      />
      <div>
        <SectionHeading>Description</SectionHeading>
        <PreBody body={artifact.body} isPending={isPending} />
      </div>
      <div>
        <SectionHeading>Parameters (JSON schema)</SectionHeading>
        <JsonBlock value={sanitisedParameters} />
      </div>
      {sanitisedConfig ? (
        <div>
          <SectionHeading>
            Webhook config{' '}
            <span
              style={{
                fontSize: 10,
                color: STUDIO_COLORS.inkSubtle,
                textTransform: 'none',
                letterSpacing: 0,
                fontWeight: 500,
              }}
            >
              ({tier} view)
            </span>
          </SectionHeading>
          <JsonBlock value={sanitisedConfig} />
        </div>
      ) : null}
    </div>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  let text = ''
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: STUDIO_COLORS.surfaceSunken,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        fontSize: 11.5,
        lineHeight: 1.55,
        color: STUDIO_COLORS.ink,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      }}
    >
      {text}
    </pre>
  )
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
