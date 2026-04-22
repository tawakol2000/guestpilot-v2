/**
 * Sprint 053-A D3 — per-type UPDATE executor backing the admin-only
 * `POST /api/build/artifacts/:type/:id/apply` endpoint.
 *
 * Mirrors the dry-run seam posture from the agent write tools:
 *   - dryRun: true → validate + return { ok, dryRun: true, preview, diff }
 *   - dryRun: false (or absent) → update + emit history + return result
 *
 * History emission is best-effort (same invariant as D2 write tools).
 * tool_definition previews + history rows are sanitised via the shared
 * sanitiseArtifactPayload helper.
 *
 * Scope: this executor handles UPDATE semantics for an artifact that
 * already exists. It deliberately does NOT re-implement the CREATE
 * tools' validation (kebab-case categories, unique-name collisions,
 * transaction linkage) — those stay in the agent write tools.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { invalidateSopCache } from '../../services/sop.service';
import { invalidateToolCache } from '../../services/tool-definition.service';
import { invalidateTenantConfigCache } from '../../services/tenant-config.service';
import { emitArtifactHistory } from './artifact-history';
import { sanitiseArtifactPayload } from './sanitise-artifact-payload';

/**
 * Upper-bound char cap on system-prompt writes at the admin-apply seam.
 * Mirrors `suggestion_action` / `EDIT_SYSTEM_PROMPT` (which enforces ≤50k
 * chars). The agent write tool (`write_system_prompt`) uses a tighter
 * 10k cap because it generates from a template; the admin drawer lets
 * managers paste longer hand-authored text, but 50k is still a hard
 * sanity ceiling — it prevents a rogue paste of the whole tenant docs
 * library from blowing up cache size and token budgets.
 */
const SYSTEM_PROMPT_MAX_CHARS = 50_000;

/**
 * Cap on the `systemPromptHistory` JSON array. Same ring buffer as
 * `write_system_prompt` (last 10 snapshots retained).
 */
const SYSTEM_PROMPT_HISTORY_CAP = 10;

export type ApplyArtifactType =
  | 'sop'
  | 'faq'
  | 'system_prompt'
  | 'tool'
  | 'property_override';

export interface ApplyInput {
  tenantId: string;
  type: ApplyArtifactType;
  id: string;
  dryRun: boolean;
  body: Record<string, unknown>;
  actorUserId?: string | null;
  actorEmail?: string | null;
  conversationId?: string | null;
  /** Sprint 055-A F3 — operator-edit metadata (rationalePrefix, operatorRationale). */
  metadata?: Record<string, unknown> | null;
}

export interface ApplyResult {
  ok: boolean;
  dryRun: boolean;
  artifactType: ApplyArtifactType;
  artifactId: string;
  preview?: unknown;
  diff?: unknown;
  error?: string;
}

export async function applyArtifactUpdate(
  prisma: PrismaClient,
  input: ApplyInput,
): Promise<ApplyResult> {
  try {
    switch (input.type) {
      case 'sop':
        return await applySop(prisma, input);
      case 'faq':
        return await applyFaq(prisma, input);
      case 'system_prompt':
        return await applySystemPrompt(prisma, input);
      case 'tool':
        return await applyTool(prisma, input);
      case 'property_override':
        return await applyPropertyOverride(prisma, input);
    }
  } catch (err: any) {
    return {
      ok: false,
      dryRun: input.dryRun,
      artifactType: input.type,
      artifactId: input.id,
      error: err?.message ?? String(err),
    };
  }
}

async function applySop(prisma: PrismaClient, input: ApplyInput): Promise<ApplyResult> {
  const content = asString(input.body.content);
  if (!content || content.length < 20) {
    return error(input, 'body.content must be a non-empty string (≥20 chars)');
  }
  const variant = await prisma.sopVariant.findFirst({
    where: { id: input.id, sopDefinition: { tenantId: input.tenantId } },
    include: { sopDefinition: { select: { category: true } } },
  });
  if (!variant) return error(input, 'sop variant not found');
  const preview = {
    content,
    prevContent: variant.content,
    sopCategory: variant.sopDefinition.category,
    status: variant.status,
  };
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      artifactType: 'sop',
      artifactId: input.id,
      preview,
      diff: { kind: 'update', field: 'content', length: content.length },
    };
  }
  await prisma.sopVariant.update({
    where: { id: input.id },
    data: { content },
  });
  invalidateSopCache(input.tenantId);
  await emitArtifactHistory(prisma, {
    tenantId: input.tenantId,
    artifactType: 'sop',
    artifactId: input.id,
    operation: 'UPDATE',
    prevBody: { content: variant.content, sopCategory: variant.sopDefinition.category, status: variant.status },
    newBody: { content, sopCategory: variant.sopDefinition.category, status: variant.status },
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    conversationId: input.conversationId,
    metadata: input.metadata ?? null,
  });
  return { ok: true, dryRun: false, artifactType: 'sop', artifactId: input.id };
}

async function applyFaq(prisma: PrismaClient, input: ApplyInput): Promise<ApplyResult> {
  const question = asString(input.body.question);
  const answer = asString(input.body.answer);
  if (!question && !answer) {
    return error(input, 'body.question or body.answer required');
  }
  const faq = await prisma.faqEntry.findFirst({
    where: { id: input.id, tenantId: input.tenantId },
  });
  if (!faq) return error(input, 'faq not found');
  const nextQuestion = question ?? faq.question;
  const nextAnswer = answer ?? faq.answer;
  const preview = {
    question: nextQuestion,
    answer: nextAnswer,
    prevQuestion: faq.question,
    prevAnswer: faq.answer,
    category: faq.category,
  };
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      artifactType: 'faq',
      artifactId: input.id,
      preview,
      diff: { kind: 'update' },
    };
  }
  await prisma.faqEntry.update({
    where: { id: input.id },
    data: {
      ...(question != null ? { question: nextQuestion } : {}),
      ...(answer != null ? { answer: nextAnswer } : {}),
    },
  });
  await emitArtifactHistory(prisma, {
    tenantId: input.tenantId,
    artifactType: 'faq',
    artifactId: input.id,
    operation: 'UPDATE',
    prevBody: { question: faq.question, answer: faq.answer, category: faq.category },
    newBody: { question: nextQuestion, answer: nextAnswer, category: faq.category },
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    conversationId: input.conversationId,
    metadata: input.metadata ?? null,
  });
  return { ok: true, dryRun: false, artifactType: 'faq', artifactId: input.id };
}

async function applySystemPrompt(
  prisma: PrismaClient,
  input: ApplyInput,
): Promise<ApplyResult> {
  if (input.id !== 'coordinator' && input.id !== 'screening') {
    return error(input, 'system_prompt id must be "coordinator" or "screening"');
  }
  const text = asString(input.body.text);
  if (!text || text.length < 100) {
    return error(input, 'body.text must be a non-empty string (≥100 chars)');
  }
  // Bugfix (2026-04-22): previously no upper-bound check, so a pathological
  // paste (e.g. the whole tenant handbook) could slip through and blow up
  // cache size + token budgets. Mirror the suggestion-action ceiling.
  if (text.length > SYSTEM_PROMPT_MAX_CHARS) {
    return error(
      input,
      `body.text exceeds ${SYSTEM_PROMPT_MAX_CHARS} chars (${text.length})`,
    );
  }
  const config = await prisma.tenantAiConfig.findUnique({
    where: { tenantId: input.tenantId },
  });
  const field =
    input.id === 'coordinator' ? 'systemPromptCoordinator' : 'systemPromptScreening';
  const prev = config ? ((config as any)[field] as string | null) : null;
  const preview = { text, variant: input.id, prevText: prev };
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      artifactType: 'system_prompt',
      artifactId: input.id,
      preview,
      diff: { kind: 'update', field, length: text.length },
    };
  }

  // Bugfix (2026-04-22): snapshot the outgoing prompt into
  // `systemPromptHistory` so the rollback tool
  // (`rollback(artifactType:'SYSTEM_PROMPT')`) can see admin-drawer writes.
  // Previously, admin applies through this path left no breadcrumb and were
  // invisible to the rollback surface — only `write_system_prompt` and
  // `suggestion_action` updated the history JSON. Same ring-buffer cap
  // (10) as those paths.
  const history: any[] = Array.isArray(config?.systemPromptHistory)
    ? [...(config!.systemPromptHistory as any[])]
    : [];
  if (config && prev) {
    history.push({
      version: config.systemPromptVersion,
      timestamp: new Date().toISOString(),
      [input.id]: prev,
      note: 'Superseded by admin artifact-apply',
    });
    while (history.length > SYSTEM_PROMPT_HISTORY_CAP) history.shift();
  }

  await prisma.tenantAiConfig.upsert({
    where: { tenantId: input.tenantId },
    update: {
      [field]: text,
      systemPromptVersion: { increment: 1 },
      systemPromptHistory: history as Prisma.InputJsonValue,
    },
    create: { tenantId: input.tenantId, [field]: text } as any,
  });

  // Bugfix (2026-04-22): invalidate the tenant-config cache so the main AI
  // picks up the new prompt on the next turn rather than serving a stale
  // cached version for up to 60s. Sibling applyTool / applySop already
  // invalidate their respective caches; this path silently skipped parity.
  invalidateTenantConfigCache(input.tenantId);

  await emitArtifactHistory(prisma, {
    tenantId: input.tenantId,
    artifactType: 'system_prompt',
    artifactId: input.id,
    operation: prev ? 'UPDATE' : 'CREATE',
    prevBody: prev ? { text: prev, variant: input.id } : null,
    newBody: { text, variant: input.id },
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    conversationId: input.conversationId,
    metadata: input.metadata ?? null,
  });
  return { ok: true, dryRun: false, artifactType: 'system_prompt', artifactId: input.id };
}

async function applyTool(prisma: PrismaClient, input: ApplyInput): Promise<ApplyResult> {
  const tool = await prisma.toolDefinition.findFirst({
    where: { id: input.id, tenantId: input.tenantId },
  });
  if (!tool) return error(input, 'tool not found');
  const description = asString(input.body.description);
  const webhookUrl = asString(input.body.webhookUrl);
  const parameters = (input.body.parameters ?? undefined) as any;
  const webhookTimeout = asNumber(input.body.webhookTimeout);
  const enabled = asBool(input.body.enabled);
  const prevRaw = {
    description: tool.description,
    parameters: tool.parameters,
    webhookUrl: tool.webhookUrl,
    webhookTimeout: tool.webhookTimeout,
    enabled: tool.enabled,
  };
  const nextRaw = {
    description: description ?? tool.description,
    parameters: parameters ?? tool.parameters,
    webhookUrl: webhookUrl ?? tool.webhookUrl,
    webhookTimeout: webhookTimeout ?? tool.webhookTimeout,
    enabled: enabled ?? tool.enabled,
  };
  const preview = sanitiseArtifactPayload({ prev: prevRaw, next: nextRaw });
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      artifactType: 'tool',
      artifactId: input.id,
      preview,
      diff: { kind: 'update' },
    };
  }
  await prisma.toolDefinition.update({
    where: { id: input.id },
    data: {
      ...(description != null ? { description } : {}),
      ...(parameters != null ? { parameters } : {}),
      ...(webhookUrl != null ? { webhookUrl } : {}),
      ...(webhookTimeout != null ? { webhookTimeout } : {}),
      ...(enabled != null ? { enabled } : {}),
    },
  });
  invalidateToolCache(input.tenantId);
  await emitArtifactHistory(prisma, {
    tenantId: input.tenantId,
    artifactType: 'tool_definition',
    artifactId: input.id,
    operation: 'UPDATE',
    prevBody: prevRaw,
    newBody: nextRaw,
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    conversationId: input.conversationId,
    metadata: input.metadata ?? null,
  });
  return { ok: true, dryRun: false, artifactType: 'tool', artifactId: input.id };
}

async function applyPropertyOverride(
  prisma: PrismaClient,
  input: ApplyInput,
): Promise<ApplyResult> {
  const content = asString(input.body.content);
  if (!content || content.length < 20) {
    return error(input, 'body.content must be a non-empty string (≥20 chars)');
  }
  const override = await prisma.sopPropertyOverride.findFirst({
    where: { id: input.id, sopDefinition: { tenantId: input.tenantId } },
    include: { sopDefinition: { select: { category: true } } },
  });
  if (!override) return error(input, 'property_override not found');
  const preview = {
    content,
    prevContent: override.content,
    sopCategory: override.sopDefinition.category,
    status: override.status,
    propertyId: override.propertyId,
  };
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      artifactType: 'property_override',
      artifactId: input.id,
      preview,
      diff: { kind: 'update', field: 'content', length: content.length },
    };
  }
  await prisma.sopPropertyOverride.update({
    where: { id: input.id },
    data: { content },
  });
  invalidateSopCache(input.tenantId);
  await emitArtifactHistory(prisma, {
    tenantId: input.tenantId,
    artifactType: 'property_override',
    artifactId: input.id,
    operation: 'UPDATE',
    prevBody: { content: override.content, sopCategory: override.sopDefinition.category, status: override.status, propertyId: override.propertyId },
    newBody: { content, sopCategory: override.sopDefinition.category, status: override.status, propertyId: override.propertyId },
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    conversationId: input.conversationId,
    metadata: input.metadata ?? null,
  });
  return { ok: true, dryRun: false, artifactType: 'property_override', artifactId: input.id };
}

function error(input: ApplyInput, message: string): ApplyResult {
  return {
    ok: false,
    dryRun: input.dryRun,
    artifactType: input.type,
    artifactId: input.id,
    error: message,
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
