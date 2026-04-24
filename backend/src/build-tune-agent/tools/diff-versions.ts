/**
 * Sprint 046 — diff_versions tool.
 *
 * Complements `get_version_history` (lists entries) by rendering a
 * side-by-side before/after diff as a `data-version-diff-browser`
 * card. Takes the artifact type + two version ids from the history
 * list, loads both bodies, and emits the card.
 *
 * Version-id parsing mirrors the `versionId` format used by
 * `get_version_history`:
 *   - System prompt:  `sp:{version}:{timestamp}`
 *   - Tool:           `tool:{id}:{updatedAt}`
 *   - SOP variant:    `svh:{sopVariantHistoryId}`
 *   - FAQ entry:      `feh:{faqEntryHistoryId}`
 *
 * A "CURRENT" sentinel (`versionId: "CURRENT"`) resolves to the live
 * value of the artifact so operators can compare any historical
 * version against the version that is live today.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { DATA_PART_TYPES, type VersionDiffBrowserData } from '../data-parts';
import { asCallToolResult, asError, type ToolContext } from './types';

const ARTIFACT = [
  'system_prompt',
  'sop',
  'faq',
  'tool_definition',
  'property_override',
] as const;

type ArtifactKind = (typeof ARTIFACT)[number];

interface ResolvedVersion {
  versionId: string;
  label: string;
  createdAt?: string;
  author?: string;
  body: string;
}

export function buildDiffVersionsTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'diff_versions',
    'Show a side-by-side before/after diff of an artifact at two points in time. Pass `artifact`, `beforeVersionId`, `afterVersionId` (both from `get_version_history`, or the sentinel "CURRENT" for the live version). Emits a `data-version-diff-browser` card the operator can rollback from with one click. Use whenever describing a version diff would otherwise require prose.',
    {
      artifact: z.enum(ARTIFACT),
      artifactId: z.string().optional(),
      artifactTitle: z.string().optional(),
      beforeVersionId: z.string().min(1),
      afterVersionId: z.string().min(1),
    },
    async (args) => {
      const c = ctx();
      try {
        const before = await resolveVersion(
          c,
          args.artifact,
          args.artifactId ?? null,
          args.beforeVersionId,
        );
        const after = await resolveVersion(
          c,
          args.artifact,
          args.artifactId ?? null,
          args.afterVersionId,
        );
        if (!before || !after) {
          return asError(
            !before
              ? `Could not resolve beforeVersionId=${args.beforeVersionId}`
              : `Could not resolve afterVersionId=${args.afterVersionId}`,
          );
        }
        const data: VersionDiffBrowserData = {
          artifact: args.artifact,
          artifactId: args.artifactId ?? undefined,
          artifactTitle: args.artifactTitle ?? undefined,
          before,
          after,
        };
        c.emitDataPart?.({
          type: DATA_PART_TYPES.version_diff_browser,
          data,
        });
        return asCallToolResult({
          ok: true,
          emitted: DATA_PART_TYPES.version_diff_browser,
          beforeVersionId: before.versionId,
          afterVersionId: after.versionId,
        });
      } catch (err: any) {
        return asError(String(err?.message ?? err));
      }
    },
  );
}

async function resolveVersion(
  c: ToolContext,
  artifact: ArtifactKind,
  artifactId: string | null,
  versionId: string,
): Promise<ResolvedVersion | null> {
  if (versionId === 'CURRENT') {
    return resolveCurrent(c, artifact, artifactId);
  }
  // Dispatch on the versionId prefix used by get_version_history.
  if (versionId.startsWith('sp:')) {
    return resolveSystemPrompt(c, versionId);
  }
  if (versionId.startsWith('tool:')) {
    return resolveTool(c, versionId);
  }
  if (versionId.startsWith('svh:')) {
    return resolveSopVariantHistory(c, versionId);
  }
  if (versionId.startsWith('feh:')) {
    return resolveFaqEntryHistory(c, versionId);
  }
  return null;
}

async function resolveCurrent(
  c: ToolContext,
  artifact: ArtifactKind,
  artifactId: string | null,
): Promise<ResolvedVersion | null> {
  const now = new Date().toISOString();
  if (artifact === 'system_prompt') {
    const cfg = await c.prisma.tenantAiConfig.findUnique({
      where: { tenantId: c.tenantId },
      select: { systemPromptCoordinator: true, systemPromptScreening: true },
    });
    if (!cfg) return null;
    const variant = artifactId === 'screening' ? 'screening' : 'coordinator';
    const body =
      variant === 'screening'
        ? cfg.systemPromptScreening ?? ''
        : cfg.systemPromptCoordinator ?? '';
    return { versionId: 'CURRENT', label: 'Current', createdAt: now, body };
  }
  if (artifact === 'tool_definition' && artifactId) {
    const t = await c.prisma.toolDefinition.findFirst({
      where: { tenantId: c.tenantId, id: artifactId },
      select: { id: true, description: true, updatedAt: true, name: true },
    });
    if (!t) return null;
    return {
      versionId: 'CURRENT',
      label: 'Current',
      createdAt: t.updatedAt.toISOString(),
      body: t.description,
    };
  }
  if (artifact === 'sop' && artifactId) {
    // SopVariant has no direct tenantId — scope through its parent
    // SopDefinition.
    const v = await c.prisma.sopVariant.findFirst({
      where: { id: artifactId, sopDefinition: { tenantId: c.tenantId } },
      select: { content: true, updatedAt: true, status: true },
    });
    if (!v) return null;
    return {
      versionId: 'CURRENT',
      label: 'Current',
      createdAt: v.updatedAt.toISOString(),
      body: v.content,
    };
  }
  if (artifact === 'faq' && artifactId) {
    const f = await c.prisma.faqEntry.findFirst({
      where: { tenantId: c.tenantId, id: artifactId },
      select: { question: true, answer: true, updatedAt: true },
    });
    if (!f) return null;
    return {
      versionId: 'CURRENT',
      label: 'Current',
      createdAt: f.updatedAt.toISOString(),
      body: `Q: ${f.question}\n\nA: ${f.answer}`,
    };
  }
  return null;
}

async function resolveSystemPrompt(
  c: ToolContext,
  versionId: string,
): Promise<ResolvedVersion | null> {
  const cfg = await c.prisma.tenantAiConfig.findUnique({
    where: { tenantId: c.tenantId },
    select: { systemPromptHistory: true },
  });
  const history: any[] = Array.isArray(cfg?.systemPromptHistory)
    ? (cfg!.systemPromptHistory as any[])
    : [];
  // versionId format: `sp:{version}:{timestamp}`
  const [, versionPart, timestampPart] = versionId.split(':');
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const versionMatches = String(h.version ?? '') === versionPart;
    const timestampMatches = String(h.timestamp ?? '') === timestampPart;
    if (!versionMatches || !timestampMatches) continue;
    const body = typeof h.coordinator === 'string'
      ? h.coordinator
      : typeof h.screening === 'string'
        ? h.screening
        : '';
    return {
      versionId,
      label: `v${versionPart}`,
      createdAt: timestampPart || undefined,
      author: typeof h.editedBy === 'string' ? h.editedBy : undefined,
      body,
    };
  }
  return null;
}

async function resolveTool(
  c: ToolContext,
  versionId: string,
): Promise<ResolvedVersion | null> {
  // versionId format: `tool:{id}:{updatedAt}` — current snapshot.
  const [, id] = versionId.split(':');
  if (!id) return null;
  const t = await c.prisma.toolDefinition.findFirst({
    where: { tenantId: c.tenantId, id },
    select: { id: true, description: true, defaultDescription: true, updatedAt: true, name: true },
  });
  if (!t) return null;
  return {
    versionId,
    label: t.name,
    createdAt: t.updatedAt.toISOString(),
    body: t.description,
  };
}

async function resolveSopVariantHistory(
  c: ToolContext,
  versionId: string,
): Promise<ResolvedVersion | null> {
  // versionId format: `svh:{id}`
  const [, id] = versionId.split(':');
  if (!id) return null;
  const row = await c.prisma.sopVariantHistory.findFirst({
    where: { id, tenantId: c.tenantId },
    select: { id: true, previousContent: true, editedAt: true, editedByUserId: true },
  });
  if (!row) return null;
  const pc = row.previousContent as any;
  const body = typeof pc?.content === 'string' ? pc.content : JSON.stringify(pc ?? {}, null, 2);
  return {
    versionId,
    label: `svh:${row.id.slice(0, 6)}`,
    createdAt: row.editedAt.toISOString(),
    author: typeof row.editedByUserId === 'string' ? row.editedByUserId : undefined,
    body,
  };
}

async function resolveFaqEntryHistory(
  c: ToolContext,
  versionId: string,
): Promise<ResolvedVersion | null> {
  // versionId format: `feh:{id}`
  const [, id] = versionId.split(':');
  if (!id) return null;
  const row = await c.prisma.faqEntryHistory.findFirst({
    where: { id, tenantId: c.tenantId },
    select: { id: true, previousContent: true, editedAt: true, editedByUserId: true },
  });
  if (!row) return null;
  const pc = row.previousContent as any;
  const q = typeof pc?.question === 'string' ? pc.question : '';
  const a = typeof pc?.answer === 'string' ? pc.answer : '';
  const body = q || a ? `Q: ${q}\n\nA: ${a}` : JSON.stringify(pc ?? {}, null, 2);
  return {
    versionId,
    label: `feh:${row.id.slice(0, 6)}`,
    createdAt: row.editedAt.toISOString(),
    author: typeof row.editedByUserId === 'string' ? row.editedByUserId : undefined,
    body,
  };
}
