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
import { PrismaClient, Prisma } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { invalidateTenantConfigCache } from '../services/tenant-config.service';
import { invalidateSopCache } from '../services/sop.service';
import { invalidateToolCache } from '../services/tool-definition.service';
import {
  snapshotFaqEntry,
  snapshotSopVariant,
} from '../services/tuning/artifact-history.service';

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
        // Each snapshot stores the OLD prompt content right before a write.
        // To produce a diff for entry N: pair its content with the next
        // chronological entry of the same variant (its content was the new
        // value at the time), or fall back to the live prompt if N is the
        // most recent snapshot.
        const cfg = await prisma.tenantAiConfig.findUnique({
          where: { tenantId },
          select: {
            systemPromptHistory: true,
            systemPromptVersion: true,
            systemPromptCoordinator: true,
            systemPromptScreening: true,
          },
        });
        const spHistory: any[] = Array.isArray(cfg?.systemPromptHistory)
          ? (cfg!.systemPromptHistory as any[])
          : [];
        // Sort oldest→newest so the next-entry-of-same-variant lookup is linear.
        const spSorted = spHistory
          .filter((h) => h && typeof h === 'object')
          .map((h, idx) => ({ h, idx, ts: typeof h.timestamp === 'string' ? h.timestamp : '' }))
          .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.idx - b.idx));
        for (let i = 0; i < spSorted.length; i++) {
          const { h, ts: tsRaw } = spSorted[i];
          const version = typeof h.version === 'number' ? h.version : null;
          const ts = tsRaw || new Date().toISOString();
          // Robust variant detection: pick whichever known key holds string
          // content. The legacy heuristic returned 'unknown' when the prior
          // prompt value was empty string OR when the snapshot wrote under a
          // non-canonical key.
          const beforeText = pickPromptText(h);
          const which = beforeText.variant ?? 'unknown';
          // Find the next snapshot of the same variant for after-text. If
          // none, the change landed on the live prompt.
          let afterContent = '';
          for (let j = i + 1; j < spSorted.length; j++) {
            const next = pickPromptText(spSorted[j].h)
            if (next.variant === which) { afterContent = next.text; break }
          }
          if (!afterContent) {
            afterContent =
              which === 'coordinator'
                ? (cfg?.systemPromptCoordinator ?? '')
                : which === 'screening'
                  ? (cfg?.systemPromptScreening ?? '')
                  : ''
          }
          entries.push({
            id: `sp:${version ?? 'x'}:${ts}`,
            artifactType: 'SYSTEM_PROMPT',
            artifactId: which,
            artifactLabel: `${which} prompt`,
            version,
            authorUserId: null,
            note: typeof h.note === 'string' ? h.note : null,
            sourceSuggestionId: parseSuggestionIdFromNote(h.note),
            diffPreview:
              beforeText.text || afterContent
                ? { before: beforeText.text || null, after: afterContent || null }
                : null,
            createdAt: ts,
            rollbackSupported: true,
          });
        }

        // ── SOP variant / override snapshots (sprint 05 §2 / C17) ──────────
        // Each snapshot row stores the artifact's content RIGHT BEFORE the
        // next write, so for THIS row's diff:
        //   BEFORE = this row's previousContent.content
        //   AFTER  = the next chronological snapshot (same artifact)'s
        //            previousContent.content, OR the live artifact text if
        //            this row is the most recent snapshot for that artifact.
        const sopHistory = await prisma.sopVariantHistory.findMany({
          where: { tenantId },
          orderBy: { editedAt: 'desc' },
          take: 60,
        });
        // Decorate with the SopDefinition.category for the human label.
        const sopDefIds = Array.from(
          new Set(
            sopHistory
              .map(h => (h.previousContent as any)?.sopDefinitionId as string | undefined)
              .filter((x): x is string => !!x)
          )
        );
        const sopDefs = sopDefIds.length
          ? await prisma.sopDefinition.findMany({
              where: { tenantId, id: { in: sopDefIds } },
              select: { id: true, category: true },
            })
          : [];
        const sopDefById = new Map(sopDefs.map(d => [d.id, d.category]));

        // Batch-fetch live variants + overrides for all sopDefIds so the
        // most-recent snapshot per artifact can pair with the live AFTER.
        const liveVariants = sopDefIds.length
          ? await prisma.sopVariant.findMany({
              where: { sopDefinitionId: { in: sopDefIds } },
              select: { sopDefinitionId: true, status: true, content: true },
            })
          : [];
        const liveVariantByKey = new Map<string, string>();
        for (const v of liveVariants) {
          liveVariantByKey.set(`${v.sopDefinitionId}|${v.status}|`, v.content);
        }
        const liveOverrides = sopDefIds.length
          ? await prisma.sopPropertyOverride.findMany({
              where: { sopDefinitionId: { in: sopDefIds } },
              select: { sopDefinitionId: true, status: true, propertyId: true, content: true },
            })
          : [];
        const liveOverrideByKey = new Map<string, string>();
        for (const o of liveOverrides) {
          liveOverrideByKey.set(`${o.sopDefinitionId}|${o.status}|${o.propertyId}`, o.content);
        }

        // Group SOP snapshots by artifact key + sort each group asc so we
        // can pair row[i].before with row[i+1].before for the after-text.
        type SopRow = (typeof sopHistory)[number];
        const sopGroups = new Map<string, SopRow[]>();
        for (const h of sopHistory) {
          const pc = h.previousContent as any;
          const key = `${pc?.sopDefinitionId ?? ''}|${pc?.status ?? ''}|${pc?.propertyId ?? ''}`;
          const arr = sopGroups.get(key) ?? [];
          arr.push(h);
          sopGroups.set(key, arr);
        }
        for (const arr of sopGroups.values()) {
          arr.sort((a, b) => a.editedAt.getTime() - b.editedAt.getTime());
        }
        for (const h of sopHistory) {
          const pc = h.previousContent as any;
          const category = sopDefById.get(pc?.sopDefinitionId) ?? 'unknown';
          const status: string = pc?.status ?? '?';
          const propertyId: string | undefined = pc?.propertyId;
          const key = `${pc?.sopDefinitionId ?? ''}|${status}|${propertyId ?? ''}`;
          const group = sopGroups.get(key) ?? [];
          const idx = group.findIndex((g) => g.id === h.id);
          const next = idx >= 0 && idx < group.length - 1 ? group[idx + 1] : null;
          const before: string = typeof pc?.content === 'string' ? pc.content : '';
          let after = '';
          if (next) {
            const nextPc = next.previousContent as any;
            after = typeof nextPc?.content === 'string' ? nextPc.content : '';
          } else {
            after = propertyId
              ? liveOverrideByKey.get(`${pc?.sopDefinitionId}|${status}|${propertyId}`) ?? ''
              : liveVariantByKey.get(`${pc?.sopDefinitionId}|${status}|`) ?? '';
          }
          entries.push({
            id: `svh:${h.id}`,
            artifactType: 'SOP_VARIANT',
            artifactId: h.targetId,
            artifactLabel: `${category} (${status})${propertyId ? ' \u2014 override' : ''}`,
            version: null,
            authorUserId: h.editedByUserId,
            note: pc?.kind === 'override' ? 'property override snapshot' : 'variant snapshot',
            sourceSuggestionId: h.triggeringSuggestionId,
            diffPreview: before || after ? { before: before || null, after: after || null } : null,
            createdAt: h.editedAt.toISOString(),
            rollbackSupported: true,
          });
        }

        // ── FAQ entry snapshots ────────────────────────────────────────────
        // Same pairing as SOPs. Diff focuses on the answer text — that's
        // where the actual edit lives 99% of the time. If the question
        // changed too, the artifactLabel already shows it.
        const faqHistory = await prisma.faqEntryHistory.findMany({
          where: { tenantId },
          orderBy: { editedAt: 'desc' },
          take: 60,
        });
        const faqIds = Array.from(new Set(faqHistory.map((h) => h.targetId)));
        const liveFaqs = faqIds.length
          ? await prisma.faqEntry.findMany({
              where: { tenantId, id: { in: faqIds } },
              select: { id: true, answer: true },
            })
          : [];
        const liveFaqAnswerById = new Map(liveFaqs.map((f) => [f.id, f.answer]));
        type FaqRow = (typeof faqHistory)[number];
        const faqGroups = new Map<string, FaqRow[]>();
        for (const h of faqHistory) {
          const arr = faqGroups.get(h.targetId) ?? [];
          arr.push(h);
          faqGroups.set(h.targetId, arr);
        }
        for (const arr of faqGroups.values()) {
          arr.sort((a, b) => a.editedAt.getTime() - b.editedAt.getTime());
        }
        for (const h of faqHistory) {
          const pc = h.previousContent as any;
          const q = typeof pc?.question === 'string' ? pc.question : '(unknown question)';
          const before: string = typeof pc?.answer === 'string' ? pc.answer : '';
          const group = faqGroups.get(h.targetId) ?? [];
          const idx = group.findIndex((g) => g.id === h.id);
          const next = idx >= 0 && idx < group.length - 1 ? group[idx + 1] : null;
          let after = '';
          if (next) {
            const nextPc = next.previousContent as any;
            after = typeof nextPc?.answer === 'string' ? nextPc.answer : '';
          } else {
            after = liveFaqAnswerById.get(h.targetId) ?? '';
          }
          entries.push({
            id: `feh:${h.id}`,
            artifactType: 'FAQ_ENTRY',
            artifactId: h.targetId,
            artifactLabel: q.length > 80 ? q.slice(0, 77) + '\u2026' : q,
            version: null,
            authorUserId: h.editedByUserId,
            note: null,
            sourceSuggestionId: h.triggeringSuggestionId,
            diffPreview: before || after ? { before: before || null, after: after || null } : null,
            createdAt: h.editedAt.toISOString(),
            rollbackSupported: true,
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
          // Hotfix — earlier the rollback only checked `target.coordinator`
          // and `target.screening` (lowercase canonical keys). Snapshots
          // written via `tuning-suggestion.controller.ts` use whatever string
          // the diagnostic put in `suggestion.systemPromptVariant`, which is
          // often capitalized ('SystemPromptScreening'), so the lookup
          // returned empty content and the rollback failed with
          // ROLLBACK_CONTENT_EMPTY. `pickPromptText` walks every long string
          // value on the snapshot and tags it as coordinator/screening using
          // a substring sniff, recovering the prior content reliably.
          const picked = pickPromptText(target);
          const variant: 'coordinator' | 'screening' = picked.variant ?? 'coordinator';
          const prevContent: string = picked.text;
          if (!prevContent) {
            res.status(400).json({ error: 'ROLLBACK_CONTENT_EMPTY' });
            return;
          }
          // Mirror the 100-char floor / 50k ceiling from tenant-config.service.
          // Without this guard a historical snapshot written before the
          // validator existed (or via a code path that skipped it) can
          // restore an unusably short prompt that defeats the `|| SEED`
          // consumer fallback in ai.service.ts.
          if (prevContent.length < 100 || prevContent.length > 50000) {
            res.status(400).json({
              error: 'ROLLBACK_INVALID_LENGTH',
              detail: `Snapshot length ${prevContent.length} is outside the 100–50,000 char range. Rollback refused to prevent a broken prompt.`,
            });
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

        if (artifactType === 'SOP_VARIANT') {
          // versionId format: `svh:<historyRowId>`. Loads the snapshot, snapshots
          // current content first (so the rollback itself is reversible), then
          // writes the snapshot back. Same pattern as AiConfigVersion: never
          // destroy, always append (sprint 05 §2 / C17).
          const historyId = versionId.startsWith('svh:') ? versionId.slice(4) : versionId;
          const snap = await prisma.sopVariantHistory.findFirst({
            where: { id: historyId, tenantId },
          });
          if (!snap) {
            res.status(404).json({ error: 'VERSION_NOT_FOUND' });
            return;
          }
          const pc = snap.previousContent as any;
          const kind: 'variant' | 'override' = pc?.kind === 'override' ? 'override' : 'variant';
          const sopDefinitionId: string | undefined = pc?.sopDefinitionId;
          const status: string | undefined = pc?.status;
          const content: string | undefined = pc?.content;
          const propertyId: string | undefined = pc?.propertyId;
          if (!sopDefinitionId || !status || typeof content !== 'string') {
            res.status(400).json({ error: 'SNAPSHOT_INCOMPLETE' });
            return;
          }
          if (kind === 'override') {
            if (!propertyId) {
              res.status(400).json({ error: 'SNAPSHOT_INCOMPLETE' });
              return;
            }
            const current = await prisma.sopPropertyOverride.findUnique({
              where: {
                sopDefinitionId_propertyId_status: {
                  sopDefinitionId,
                  propertyId,
                  status,
                },
              },
              select: { id: true, content: true },
            });
            if (current) {
              await snapshotSopVariant(prisma, {
                tenantId,
                targetId: current.id,
                kind: 'override',
                sopDefinitionId,
                status,
                content: current.content,
                propertyId,
                editedByUserId: (req as any).userId ?? null,
                triggeringSuggestionId: snap.triggeringSuggestionId ?? null,
                metadata: { rolledBackFrom: snap.id },
              });
            }
            const restored = await prisma.sopPropertyOverride.upsert({
              where: {
                sopDefinitionId_propertyId_status: {
                  sopDefinitionId,
                  propertyId,
                  status,
                },
              },
              update: { content },
              create: { sopDefinitionId, propertyId, status, content },
              select: { id: true },
            });
            // Main AI reads SOP content through a 5-min cache; rollback
            // would take up to 5 min to reach live guests otherwise.
            invalidateSopCache(tenantId);
            res.json({ ok: true, artifactType: 'SOP_VARIANT', kind: 'override', targetId: restored.id });
            return;
          }
          // kind === 'variant'
          const current = await prisma.sopVariant.findUnique({
            where: { sopDefinitionId_status: { sopDefinitionId, status } },
            select: { id: true, content: true },
          });
          if (current) {
            await snapshotSopVariant(prisma, {
              tenantId,
              targetId: current.id,
              kind: 'variant',
              sopDefinitionId,
              status,
              content: current.content,
              editedByUserId: (req as any).userId ?? null,
              triggeringSuggestionId: snap.triggeringSuggestionId ?? null,
              metadata: { rolledBackFrom: snap.id },
            });
          }
          const restored = await prisma.sopVariant.upsert({
            where: { sopDefinitionId_status: { sopDefinitionId, status } },
            update: { content },
            create: { sopDefinitionId, status, content },
            select: { id: true },
          });
          invalidateSopCache(tenantId);
          res.json({ ok: true, artifactType: 'SOP_VARIANT', kind: 'variant', targetId: restored.id });
          return;
        }

        if (artifactType === 'FAQ_ENTRY') {
          const historyId = versionId.startsWith('feh:') ? versionId.slice(4) : versionId;
          const snap = await prisma.faqEntryHistory.findFirst({
            where: { id: historyId, tenantId },
          });
          if (!snap) {
            res.status(404).json({ error: 'VERSION_NOT_FOUND' });
            return;
          }
          const pc = snap.previousContent as any;
          if (
            typeof pc?.question !== 'string' ||
            typeof pc?.answer !== 'string' ||
            typeof pc?.category !== 'string'
          ) {
            res.status(400).json({ error: 'SNAPSHOT_INCOMPLETE' });
            return;
          }
          // Snapshot current state first (reversibility).
          const current = await prisma.faqEntry.findFirst({
            where: { id: snap.targetId, tenantId },
          });
          if (current) {
            await snapshotFaqEntry(prisma, {
              tenantId,
              targetId: current.id,
              question: current.question,
              answer: current.answer,
              category: current.category,
              scope: String(current.scope),
              propertyId: current.propertyId ?? null,
              status: String(current.status),
              editedByUserId: (req as any).userId ?? null,
              triggeringSuggestionId: snap.triggeringSuggestionId ?? null,
              metadata: { rolledBackFrom: snap.id },
            });
            await prisma.faqEntry.update({
              where: { id: current.id },
              data: {
                question: pc.question,
                answer: pc.answer,
                category: pc.category,
                ...(pc.scope ? { scope: pc.scope as any } : {}),
                ...(pc.status ? { status: pc.status as any } : {}),
                propertyId: pc.propertyId ?? null,
              },
            });
            res.json({ ok: true, artifactType: 'FAQ_ENTRY', targetId: current.id });
            return;
          }
          // Row was deleted — recreate it from the snapshot.
          const recreated = await prisma.faqEntry.create({
            data: {
              tenantId,
              question: pc.question,
              answer: pc.answer,
              category: pc.category,
              scope: pc.scope ?? 'PROPERTY',
              status: pc.status ?? 'ACTIVE',
              propertyId: pc.propertyId ?? null,
              source: 'MANUAL',
            },
            select: { id: true },
          });
          res.json({ ok: true, artifactType: 'FAQ_ENTRY', targetId: recreated.id, recreated: true });
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
          // Tool schema is cached by tool-definition.service for 5 minutes.
          // Busting it here means the rolled-back description reaches the
          // next main-AI call instead of waiting out the TTL. Also bust the
          // tenant config cache for symmetry with the accept path.
          invalidateToolCache(tenantId);
          invalidateTenantConfigCache(tenantId);
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

function pickPromptText(h: any): { variant: 'coordinator' | 'screening' | null; text: string } {
  // Robust read of which variant the snapshot stored. Suggestion-controller
  // writes the key dynamically (`[suggestion.systemPromptVariant]`), so the
  // key may be 'coordinator', 'screening', or any other string the diagnostic
  // produced ('Screening', 'SystemPromptScreening', 'screening_agent', …).
  // Walk every string-valued key longer than 50 chars (i.e. actual prompt
  // text) and best-effort tag it as coordinator/screening using a substring
  // sniff on the key name.
  if (!h || typeof h !== 'object') return { variant: null, text: '' }
  const keys = Object.keys(h)
  for (const k of keys) {
    const v = (h as any)[k]
    if (typeof v !== 'string' || v.length < 50) continue
    if (k === 'coordinator' || k === 'screening') return { variant: k, text: v }
    const lower = k.toLowerCase()
    if (lower.includes('screen')) return { variant: 'screening', text: v }
    if (lower.includes('coord')) return { variant: 'coordinator', text: v }
  }
  return { variant: null, text: '' }
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
