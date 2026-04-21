/**
 * Sprint 051 A B1 — artifact reader for the Studio drawer.
 *
 * Single read seam for the five artifact types the drawer can render:
 *   - sop                → SopVariant (joined with SopDefinition)
 *   - faq                → FaqEntry
 *   - system_prompt      → TenantAiConfig (per variant: coordinator/screening)
 *   - tool               → ToolDefinition
 *   - property_override  → SopPropertyOverride (joined with SopDefinition + Property)
 *
 * All lookups are tenant-scoped. A cross-tenant id returns NOT_FOUND,
 * never 500 — this is the backstop behind the drawer's "missing
 * artifact" banner (brief §2: graceful degradation on missing data).
 *
 * B2 extends this file with a prior-version lookup reading from
 * SopVariantHistory / FaqEntryHistory.
 */
import { PrismaClient } from '@prisma/client';

export type BuildArtifactType =
  | 'sop'
  | 'faq'
  | 'system_prompt'
  | 'tool'
  | 'property_override';

export interface BuildArtifactDetail {
  type: BuildArtifactType;
  id: string;
  title: string;
  body: string;
  /** Arbitrary per-type metadata — viewer component picks what to render. */
  meta: Record<string, unknown>;
  /**
   * Tool-view only — raw webhook config (if any) needs frontend
   * sanitisation before render. Always absent for non-tool artifacts.
   */
  webhookConfig?: Record<string, unknown>;
}

export interface BuildArtifactNotFound {
  notFound: true;
}

export type BuildArtifactResult = BuildArtifactDetail | BuildArtifactNotFound;

export async function getBuildArtifact(
  prisma: PrismaClient,
  tenantId: string,
  type: BuildArtifactType,
  id: string,
): Promise<BuildArtifactResult> {
  switch (type) {
    case 'sop':
      return loadSop(prisma, tenantId, id);
    case 'faq':
      return loadFaq(prisma, tenantId, id);
    case 'system_prompt':
      return loadSystemPrompt(prisma, tenantId, id);
    case 'tool':
      return loadTool(prisma, tenantId, id);
    case 'property_override':
      return loadPropertyOverride(prisma, tenantId, id);
  }
}

async function loadSop(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<BuildArtifactResult> {
  const variant = await prisma.sopVariant.findFirst({
    where: { id, sopDefinition: { tenantId } },
    include: { sopDefinition: true },
  });
  if (!variant) return { notFound: true };
  return {
    type: 'sop',
    id: variant.id,
    title: `${variant.sopDefinition.category} · ${variant.status}`,
    body: variant.content,
    meta: {
      category: variant.sopDefinition.category,
      status: variant.status,
      enabled: variant.enabled,
      toolDescription: variant.sopDefinition.toolDescription,
      sopDefinitionId: variant.sopDefinitionId,
      updatedAt: variant.updatedAt.toISOString(),
      createdAt: variant.createdAt.toISOString(),
      buildTransactionId: variant.buildTransactionId,
    },
  };
}

async function loadFaq(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<BuildArtifactResult> {
  const faq = await prisma.faqEntry.findFirst({
    where: { id, tenantId },
    include: { property: { select: { id: true, name: true } } },
  });
  if (!faq) return { notFound: true };
  return {
    type: 'faq',
    id: faq.id,
    title: truncate(faq.question, 96),
    body: faq.answer,
    meta: {
      question: faq.question,
      category: faq.category,
      scope: faq.scope,
      status: faq.status,
      source: faq.source,
      usageCount: faq.usageCount,
      lastUsedAt: faq.lastUsedAt?.toISOString() ?? null,
      propertyId: faq.propertyId,
      propertyName: faq.property?.name ?? null,
      updatedAt: faq.updatedAt.toISOString(),
      buildTransactionId: faq.buildTransactionId,
    },
  };
}

async function loadSystemPrompt(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<BuildArtifactResult> {
  const variant = id === 'coordinator' || id === 'screening' ? id : null;
  if (!variant) return { notFound: true };
  const config = await prisma.tenantAiConfig.findUnique({
    where: { tenantId },
    select: {
      systemPromptCoordinator: true,
      systemPromptScreening: true,
      systemPromptVersion: true,
      updatedAt: true,
    },
  });
  if (!config) return { notFound: true };
  const body =
    variant === 'coordinator'
      ? config.systemPromptCoordinator
      : config.systemPromptScreening;
  if (body == null) return { notFound: true };
  return {
    type: 'system_prompt',
    id: variant,
    title: `System prompt · ${variant}`,
    body,
    meta: {
      variant,
      version: config.systemPromptVersion,
      updatedAt: config.updatedAt.toISOString(),
    },
  };
}

async function loadTool(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<BuildArtifactResult> {
  const tool = await prisma.toolDefinition.findFirst({
    where: { id, tenantId },
  });
  if (!tool) return { notFound: true };
  // Webhook config carries the URL and timeout — secrets land here for
  // custom tools. Pass through to the frontend so the sanitiser runs at
  // the same seam as the tool-call drawer's payload view.
  const webhookConfig =
    tool.type === 'custom' && tool.webhookUrl
      ? {
          webhookUrl: tool.webhookUrl,
          webhookTimeout: tool.webhookTimeout,
        }
      : undefined;
  return {
    type: 'tool',
    id: tool.id,
    title: tool.displayName || tool.name,
    body: tool.description,
    meta: {
      name: tool.name,
      displayName: tool.displayName,
      agentScope: tool.agentScope,
      toolType: tool.type,
      enabled: tool.enabled,
      parameters: tool.parameters,
      defaultDescription: tool.defaultDescription,
      updatedAt: tool.updatedAt.toISOString(),
      buildTransactionId: tool.buildTransactionId,
    },
    webhookConfig,
  };
}

async function loadPropertyOverride(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<BuildArtifactResult> {
  const override = await prisma.sopPropertyOverride.findFirst({
    where: { id, sopDefinition: { tenantId } },
    include: {
      sopDefinition: { select: { category: true } },
      property: { select: { id: true, name: true } },
    },
  });
  if (!override) return { notFound: true };
  return {
    type: 'property_override',
    id: override.id,
    title: `${override.sopDefinition.category} · ${override.property.name ?? override.propertyId} · ${override.status}`,
    body: override.content,
    meta: {
      category: override.sopDefinition.category,
      status: override.status,
      enabled: override.enabled,
      sopDefinitionId: override.sopDefinitionId,
      propertyId: override.propertyId,
      propertyName: override.property.name ?? null,
      updatedAt: override.updatedAt.toISOString(),
      buildTransactionId: override.buildTransactionId,
    },
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ─── B2 prior-version lookup ─────────────────────────────────────────────
//
// Cheap "oldest version touched this session" signal: SopVariantHistory
// and FaqEntryHistory both index by targetId + editedAt. We take the
// oldest row whose editedAt ≥ session start as the pre-session body.
// Callers pass sessionStart as an ISO string; if no history row exists
// for that window, fall back to the artifact's current body (no diff).

export interface BuildArtifactPrevBody {
  prevBody: string | null;
  /** Explicit reason when prevBody is null, for the frontend to reason about. */
  reason?:
    | 'no-history-in-window'
    | 'unsupported-type'
    | 'artifact-missing';
}

export async function getBuildArtifactPrevBody(
  prisma: PrismaClient,
  tenantId: string,
  type: BuildArtifactType,
  id: string,
  sessionStartIso: string,
): Promise<BuildArtifactPrevBody> {
  const since = new Date(sessionStartIso);
  if (Number.isNaN(since.getTime())) {
    return { prevBody: null, reason: 'no-history-in-window' };
  }

  if (type === 'sop') {
    const row = await prisma.sopVariantHistory.findFirst({
      where: { tenantId, targetId: id, editedAt: { gte: since } },
      orderBy: { editedAt: 'asc' },
    });
    const prev = extractSopPrevContent(row?.previousContent);
    if (prev == null) return { prevBody: null, reason: 'no-history-in-window' };
    return { prevBody: prev };
  }
  if (type === 'faq') {
    const row = await prisma.faqEntryHistory.findFirst({
      where: { tenantId, targetId: id, editedAt: { gte: since } },
      orderBy: { editedAt: 'asc' },
    });
    const prev = extractFaqPrevAnswer(row?.previousContent);
    if (prev == null) return { prevBody: null, reason: 'no-history-in-window' };
    return { prevBody: prev };
  }
  if (type === 'system_prompt') {
    // Sprint 053-A D2 — retire the AiConfigVersion read in favor of the
    // unified BuildArtifactHistory table. AiConfigVersion is still written
    // by the tenant-config service for its own purposes; we just stop
    // reading it here.
    if (id !== 'coordinator' && id !== 'screening') {
      return { prevBody: null, reason: 'artifact-missing' };
    }
    const row = await prisma.buildArtifactHistory.findFirst({
      where: {
        tenantId,
        artifactType: 'system_prompt',
        artifactId: id,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
    });
    const prev = extractSystemPromptPrevFromHistory(row?.prevBody);
    if (prev == null) return { prevBody: null, reason: 'no-history-in-window' };
    return { prevBody: prev };
  }
  if (type === 'tool') {
    // Sprint 053-A D2 — tool_definition rows are now available from the
    // shared history table. The caller (controller) splits prevParameters
    // and prevWebhookConfig out onto the detail payload so the 052-A
    // JSON-diff toggle has fields to diff against.
    const row = await prisma.buildArtifactHistory.findFirst({
      where: {
        tenantId,
        artifactType: 'tool_definition',
        artifactId: id,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
    });
    // We return prevBody: null here (tool artifact bodies are the
    // description string; diff is on the JSON fields). The caller reads
    // the raw row separately when it wants prevParameters.
    return { prevBody: null, reason: 'unsupported-type' };
  }
  return { prevBody: null, reason: 'unsupported-type' };
}

/**
 * Sprint 053-A D2 — fetch the most recent pre-session tool_definition
 * history row so the drawer can surface prevParameters + prevWebhookConfig
 * for the 052-A JSON-diff toggle.
 */
export interface ToolPrevJsonFields {
  prevParameters?: unknown;
  prevWebhookConfig?: unknown;
}

export async function getToolArtifactPrevJson(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
  sessionStartIso: string,
): Promise<ToolPrevJsonFields | null> {
  const since = new Date(sessionStartIso);
  if (Number.isNaN(since.getTime())) return null;
  const row = await prisma.buildArtifactHistory.findFirst({
    where: {
      tenantId,
      artifactType: 'tool_definition',
      artifactId: id,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'asc' },
  });
  const prev = row?.prevBody;
  if (!prev || typeof prev !== 'object') return null;
  const obj = prev as Record<string, unknown>;
  const out: ToolPrevJsonFields = {};
  if ('parameters' in obj) out.prevParameters = obj.parameters;
  if ('webhookUrl' in obj || 'webhookTimeout' in obj || 'webhookAuth' in obj) {
    out.prevWebhookConfig = {
      webhookUrl: obj.webhookUrl,
      webhookTimeout: obj.webhookTimeout,
      webhookAuth: obj.webhookAuth,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractSystemPromptPrevFromHistory(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const text = obj.text;
  return typeof text === 'string' ? text : null;
}

function extractSopPrevContent(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const content = obj.content;
  return typeof content === 'string' ? content : null;
}

function extractFaqPrevAnswer(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const answer = obj.answer;
  return typeof answer === 'string' ? answer : null;
}

function extractSystemPromptFromConfig(
  raw: unknown,
  variant: 'coordinator' | 'screening',
): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const key =
    variant === 'coordinator'
      ? 'systemPromptCoordinator'
      : 'systemPromptScreening';
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}
