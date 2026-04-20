/**
 * Tenant-scoped memory CRUD against the `AgentMemory` Prisma table. Called by
 * the `memory` MCP tool and by the runtime's PreCompact / session-start
 * preference injection.
 *
 * See ./README.md for the key-namespacing convention.
 */
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';

export interface MemoryRecord {
  key: string;
  value: unknown;
  source: string | null;
  updatedAt: string;
}

export async function viewMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string
): Promise<MemoryRecord | null> {
  const row = await prisma.agentMemory.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  if (!row) return null;
  return {
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string,
  value: unknown,
  source?: string
): Promise<{ ok: true } | { ok: false; error: 'ALREADY_EXISTS' }> {
  try {
    await prisma.agentMemory.create({
      data: {
        tenantId,
        key,
        value: value as Prisma.InputJsonValue,
        source: source ?? null,
      },
    });
    return { ok: true };
  } catch (err: any) {
    if (err?.code === 'P2002') return { ok: false, error: 'ALREADY_EXISTS' };
    throw err;
  }
}

export async function updateMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string,
  value: unknown,
  source?: string
): Promise<MemoryRecord> {
  const row = await prisma.agentMemory.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: {
      value: value as Prisma.InputJsonValue,
      ...(source ? { source } : {}),
    },
    create: {
      tenantId,
      key,
      value: value as Prisma.InputJsonValue,
      source: source ?? null,
    },
  });
  return {
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deleteMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string
): Promise<{ ok: true; deleted: boolean }> {
  try {
    await prisma.agentMemory.delete({
      where: { tenantId_key: { tenantId, key } },
    });
    return { ok: true, deleted: true };
  } catch (err: any) {
    if (err?.code === 'P2025') return { ok: true, deleted: false };
    throw err;
  }
}

// ─── Session-scoped rejection memory (sprint 046 Session D) ─────────────
//
// Per plan §4.4 + NEXT.md §2.3 a dismissed suggested_fix writes to
// `session/{conversationId}/rejected/{fixHash}` so a subsequent
// propose_suggestion in the same conversation can skip re-proposing a
// semantically-equivalent fix. Cross-session memory is deferred to
// sprint 047; this layer is session-scoped only.
//
// fixHash = sha1(artifactId + '|' + (target.sectionId||target.slotKey||'') + '|' + semanticIntent)

export interface RejectionIntent {
  /** Primary artifact id (or empty string when only category-level targeting). */
  artifactId: string;
  /** section id OR slot key — whichever targets the fix more specifically. */
  sectionOrSlotKey: string;
  /**
   * A short, semantically-stable description of what the fix wanted to change.
   * Callers should normalise (lowercase + trim) before hashing.
   */
  semanticIntent: string;
}

/** Compute the stable fixHash used for rejection-memory keys. */
export function computeRejectionFixHash(intent: RejectionIntent): string {
  const canonical = `${intent.artifactId}|${intent.sectionOrSlotKey}|${intent.semanticIntent
    .toLowerCase()
    .trim()}`;
  return crypto.createHash('sha1').update(canonical).digest('hex');
}

function rejectionKey(conversationId: string, fixHash: string): string {
  return `session/${conversationId}/rejected/${fixHash}`;
}

/**
 * Persist a session-scoped rejection entry. Idempotent — upserts on the
 * composite unique `(tenantId, key)` index. Stores the fix intent + a
 * timestamp so diagnostic tooling can later show "rejected at" without
 * replaying the whole session.
 */
export async function writeRejectionMemory(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  fixHash: string,
  intent: RejectionIntent
): Promise<void> {
  const key = rejectionKey(conversationId, fixHash);
  const payload = {
    fixHash,
    intent,
    rejectedAt: new Date().toISOString(),
  };
  await prisma.agentMemory.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: {
      value: payload as unknown as Prisma.InputJsonValue,
      source: 'propose_suggestion.reject',
    },
    create: {
      tenantId,
      key,
      value: payload as unknown as Prisma.InputJsonValue,
      source: 'propose_suggestion.reject',
    },
  });
}

/**
 * List every fixHash a manager has rejected in this conversation. The
 * propose_suggestion tool consults this set before emitting to avoid
 * re-proposing a semantically-equivalent fix.
 */
export async function listRejectionHashes(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string
): Promise<Set<string>> {
  const prefix = `session/${conversationId}/rejected/`;
  const rows = await prisma.agentMemory.findMany({
    where: { tenantId, key: { startsWith: prefix } },
    select: { key: true },
  });
  return new Set(
    rows
      .map((r) => r.key.slice(prefix.length))
      .filter((h) => h.length > 0)
  );
}

/**
 * Used by the runtime's session-start preference injection and by the
 * PreCompact hook. Returns rows whose key starts with `prefix` (typically
 * `"preferences/"`). Capped at `limit` entries by most-recent update.
 */
export async function listMemoryByPrefix(
  prisma: PrismaClient,
  tenantId: string,
  prefix: string,
  limit = 50
): Promise<MemoryRecord[]> {
  const rows = await prisma.agentMemory.findMany({
    where: { tenantId, key: { startsWith: prefix } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
