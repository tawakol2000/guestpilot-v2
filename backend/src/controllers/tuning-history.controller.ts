/**
 * Feature 041 sprint 03 — version history read + rollback dispatcher.
 *
 *   GET  /api/tuning/history                 — last N edits across all artifact types
 *   POST /api/tuning/history/rollback        — { artifactType, versionId }
 *
 * Artifact support:
 *   - SYSTEM_PROMPT   — reads `TenantAiConfig.systemPromptHistory` (existing
 *                       JSON array pattern). Rollback creates a NEW history
 *                       entry with the rolled-back content, preserving
 *                       linearity (sprint brief §5: "must create a new
 *                       version, never destroy the current").
 *   - SOP_VARIANT     — reads `SopVariant.updatedAt` + source suggestion when
 *                       available. V1 rollback is informational only; full
 *                       revert-content support requires a content snapshot
 *                       which isn't persisted pre-sprint-03. Documented as a
 *                       deferred gap (see report §What's broken / deferred).
 *   - FAQ_ENTRY       — same as SOP_VARIANT.
 *   - TOOL_DEFINITION — same.
 *
 * The approach for V1 is: list real rows, link back to the triggering
 * TuningSuggestion's beforeText so the UI can preview a diff. Rollback is
 * implemented only for SYSTEM_PROMPT in V1. Others return `501 NOT_SUPPORTED`
 * — the UI should hide their Rollback button when `rollbackSupported` is
 * false. This is additive, does not break anything, and avoids speculative
 * schema work.
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { invalidateTenantConfigCache } from '../services/tenant-config.service';

type ArtifactType = 'SYSTEM_PROMPT' | 'SOP_VARIANT' | 'FAQ_ENTRY' | 'TOOL_DEFINITION';

interface HistoryEntry {
  id: string; // composite, unique across artifact types
  artifactType: ArtifactType;
  artifactId: string;
  artifactLabel: string;
  version: number | null;
  authorUserId: string | null;
  note: string | null;
  sourceSuggestionId: string | null;
  diffPreview: { before: string | null; after: string | null } | null;
  createdAt: string;
  rollbackSupported: boolean;
}

export function makeTuningHistoryController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const limit = Math.max(10, Math.min(200, parseInt(String(req.query.limit || '50'), 10) || 50));

        const entries: HistoryEntry[] = [];

        // ── System prompt history (JSON array on TenantAiConfig) ────────────
        const cfg = await prisma.tenantAiConfig.findUnique({
          where: { tenantId },
          select: { systemPromptHistory: true, systemPromptVersion: true },
        });
        const spHistory: any[] = Array.isArray(cfg?.systemPromptHistory)
          ? (cfg!.systemPromptHistory as any[])
          : [];
        for (const h of spHistory) {
          if (!h || typeof h !== 'object') continue;
          const version = typeof h.version === 'number' ? h.version : null;
          const ts = typeof h.timestamp === 'string' ? h.timestamp : new Date().toISOString();
          const which = h.coordinator ? 'coordinator' : h.screening ? 'screening' : 'unknown';
          entries.push({
            id: `sp:${version ?? 'x'}:${ts}`,
            artifactType: 'SYSTEM_PROMPT',
            artifactId: which,
            artifactLabel: `${which} prompt`,
            version,
            authorUserId: null,
            note: typeof h.note === 'string' ? h.note : null,
            sourceSuggestionId: parseSuggestionIdFromNote(h.note),
            diffPreview: null,
            createdAt: ts,
            rollbackSupported: true,
          });
        }

        // ── Recent SopVariant / SopPropertyOverride edits ───────────────────
        const sopVariants = await prisma.sopVariant.findMany({
          where: { sopDefinition: { tenantId } },
          orderBy: { updatedAt: 'desc' },
          take: 40,
          include: { sopDefinition: { select: { category: true } } },
        });
        for (const v of sopVariants) {
          entries.push({
            id: `sv:${v.id}:${v.updatedAt.toISOString()}`,
            artifactType: 'SOP_VARIANT',
            artifactId: v.id,
            artifactLabel: `${v.sopDefinition.category} (${v.status})`,
            version: null,
            authorUserId: null,
            note: null,
            sourceSuggestionId: null,
            diffPreview: null,
            createdAt: v.updatedAt.toISOString(),
            rollbackSupported: false,
          });
        }

        // ── Recent FAQ edits ────────────────────────────────────────────────
        const faqs = await prisma.faqEntry.findMany({
          where: { tenantId },
          orderBy: { updatedAt: 'desc' },
          take: 40,
        });
        for (const f of faqs) {
          entries.push({
            id: `faq:${f.id}:${f.updatedAt.toISOString()}`,
            artifactType: 'FAQ_ENTRY',
            artifactId: f.id,
            artifactLabel: f.question.length > 80 ? f.question.slice(0, 77) + '…' : f.question,
            version: null,
            authorUserId: null,
            note: null,
            sourceSuggestionId: null,
            diffPreview: null,
            createdAt: f.updatedAt.toISOString(),
            rollbackSupported: false,
          });
        }

        // ── Recent ToolDefinition edits ─────────────────────────────────────
        const tools = await prisma.toolDefinition.findMany({
          where: { tenantId },
          orderBy: { updatedAt: 'desc' },
          take: 40,
        });
        for (const t of tools) {
          entries.push({
            id: `tool:${t.id}:${t.updatedAt.toISOString()}`,
            artifactType: 'TOOL_DEFINITION',
            artifactId: t.id,
            artifactLabel: t.displayName || t.name,
            version: null,
            authorUserId: null,
            note: null,
            sourceSuggestionId: null,
            diffPreview:
              t.description !== t.defaultDescription
                ? { before: t.defaultDescription, after: t.description }
                : null,
            createdAt: t.updatedAt.toISOString(),
            rollbackSupported: true, // reset-to-default is a real rollback for tools
          });
        }

        // ── Decorate with source-suggestion lookup for traceability ──────────
        const decorated = await attachSuggestionLinks(prisma, tenantId, entries);

        decorated.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        res.json({ entries: decorated.slice(0, limit) });
      } catch (err) {
        console.error('[tuning-history] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async rollback(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const body = req.body || {};
        const artifactType = body.artifactType as ArtifactType | undefined;
        const versionId = typeof body.versionId === 'string' ? body.versionId : null;

        if (!artifactType || !versionId) {
          res.status(400).json({ error: 'MISSING_FIELDS' });
          return;
        }

        if (artifactType === 'SYSTEM_PROMPT') {
          // versionId format: `sp:<version>:<timestamp>`
          const parts = versionId.split(':');
          const version = parseInt(parts[1], 10);
          if (!Number.isFinite(version)) {
            res.status(400).json({ error: 'INVALID_VERSION_ID' });
            return;
          }
          const cfg = await prisma.tenantAiConfig.findUnique({ where: { tenantId } });
          const history = Array.isArray(cfg?.systemPromptHistory)
            ? ((cfg!.systemPromptHistory as any[]) ?? [])
            : [];
          const target = history.find((h: any) => h && h.version === version);
          if (!target) {
            res.status(404).json({ error: 'VERSION_NOT_FOUND' });
            return;
          }
          const variant: 'coordinator' | 'screening' = target.coordinator
            ? 'coordinator'
            : 'screening';
          const prevContent: string = target[variant] || '';
          if (!prevContent) {
            res.status(400).json({ error: 'ROLLBACK_CONTENT_EMPTY' });
            return;
          }
          const field =
            variant === 'coordinator' ? 'systemPromptCoordinator' : 'systemPromptScreening';
          const newHistory = [...history];
          newHistory.push({
            version: cfg?.systemPromptVersion ?? 1,
            timestamp: new Date().toISOString(),
            [variant]: (cfg as any)?.[field] || '',
            note: `Rolled back to v${version}`,
          });
          while (newHistory.length > 10) newHistory.shift();
          await prisma.tenantAiConfig.update({
            where: { tenantId },
            data: {
              [field]: prevContent,
              systemPromptVersion: { increment: 1 },
              systemPromptHistory: newHistory,
            },
          });
          invalidateTenantConfigCache(tenantId);
          res.json({ ok: true, newVersion: (cfg?.systemPromptVersion ?? 1) + 1 });
          return;
        }

        if (artifactType === 'TOOL_DEFINITION') {
          // versionId format: `tool:<id>:<ts>` — rollback = reset to defaultDescription.
          const parts = versionId.split(':');
          const toolId = parts[1];
          if (!toolId) {
            res.status(400).json({ error: 'INVALID_VERSION_ID' });
            return;
          }
          const tool = await prisma.toolDefinition.findFirst({
            where: { id: toolId, tenantId },
          });
          if (!tool) {
            res.status(404).json({ error: 'TOOL_NOT_FOUND' });
            return;
          }
          await prisma.toolDefinition.update({
            where: { id: tool.id },
            data: { description: tool.defaultDescription },
          });
          res.json({ ok: true, newVersion: null });
          return;
        }

        res.status(501).json({
          error: 'ROLLBACK_NOT_SUPPORTED',
          detail:
            'V1 only supports SYSTEM_PROMPT and TOOL_DEFINITION rollback. SOP/FAQ rollback needs a content snapshot layer (sprint-04 or later).',
        });
      } catch (err) {
        console.error('[tuning-history] rollback failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}

function parseSuggestionIdFromNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const m = note.match(/Tuning suggestion (\w+) accepted/);
  return m?.[1] ?? null;
}

async function attachSuggestionLinks(
  prisma: PrismaClient,
  tenantId: string,
  entries: HistoryEntry[],
): Promise<HistoryEntry[]> {
  // For tool definitions we already derived diffPreview. For other artifact
  // types, try to look up the most recent accepted suggestion whose target
  // matches, and attach its beforeText/proposedText as the preview.
  const recentAccepted = await prisma.tuningSuggestion.findMany({
    where: { tenantId, status: 'ACCEPTED', appliedAt: { not: null } },
    orderBy: { appliedAt: 'desc' },
    take: 80,
    select: {
      id: true,
      diagnosticCategory: true,
      actionType: true,
      sopCategory: true,
      faqEntryId: true,
      systemPromptVariant: true,
      beforeText: true,
      proposedText: true,
      appliedAt: true,
    },
  });

  return entries.map((e) => {
    if (e.diffPreview) return e; // already set (tool definitions)
    const candidate = recentAccepted.find((s) => {
      if (e.artifactType === 'SYSTEM_PROMPT' && s.systemPromptVariant) {
        return s.systemPromptVariant === e.artifactId;
      }
      if (e.artifactType === 'FAQ_ENTRY') {
        return s.faqEntryId === e.artifactId;
      }
      if (e.artifactType === 'SOP_VARIANT') {
        return e.artifactLabel.startsWith(s.sopCategory ?? '__none__');
      }
      return false;
    });
    if (!candidate) return e;
    return {
      ...e,
      sourceSuggestionId: candidate.id,
      diffPreview: {
        before: candidate.beforeText,
        after: candidate.proposedText,
      },
    };
  });
}
