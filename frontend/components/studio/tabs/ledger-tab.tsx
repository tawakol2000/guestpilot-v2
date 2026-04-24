'use client'

// Sprint 046 — Studio design overhaul (plan T038 + FR-036).
//
// Admin-only Ledger tab. Thin visual wrapper around the existing
// WriteLedgerCard — logic unchanged. Row click still opens the
// artifact drawer at `scrollToSection: 'verification'`; row revert
// still runs the two-step dry-run + confirm flow.

import { STUDIO_TOKENS_V2 } from '../tokens'
import { WriteLedgerCard } from '../write-ledger'
import type { BuildArtifactHistoryRow } from '@/lib/build-api'

export interface LedgerTabProps {
  conversationId: string | null
  refreshKey: number
  onOpenRow: (row: BuildArtifactHistoryRow) => void
  onRevertRow: (row: BuildArtifactHistoryRow) => void | Promise<void>
}

export function LedgerTab({
  conversationId,
  refreshKey,
  onOpenRow,
  onRevertRow,
}: LedgerTabProps) {
  return (
    <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          Write ledger
        </span>
        <span style={{ fontSize: 13, color: STUDIO_TOKENS_V2.muted }}>Admin · per-session</span>
      </header>
      <WriteLedgerCard
        visible
        conversationId={conversationId}
        refreshKey={refreshKey}
        onOpenRow={onOpenRow}
        onRevertRow={onRevertRow}
      />
    </div>
  )
}
