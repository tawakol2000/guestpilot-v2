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
  // Bugfix (2026-04-23): was unbounded. A manager who rejects many
  // suggested-fixes in one long session could accumulate thousands
  // of rejection hashes; reading them all every turn burns memory
  // and DB time. 500 is ~10× the realistic upper bound for a single
  // session and matches the prefix-list cap pattern used elsewhere.
  const rows = await prisma.agentMemory.findMany({
    where: { tenantId, key: { startsWith: prefix } },
    select: { key: true },
    take: 500,
  });
  return new Set(
    rows
      .map((r) => r.key.slice(prefix.length))
      .filter((h) => h.length > 0)
  );
}

// ─── Cross-session rejection memory (sprint 047 Session C) ──────────────
//
// Durable equivalent of the session-scoped rejection above. A fix the
// manager rejected in conversation A is still suppressed (or at least
// surfaced with a prior-rejection signal) when the same intent is
// proposed in conversation B, same tenant, within the TTL.
//
// Cardinality: per-(tenantId, artifact, fixHash).
// TTL: 90 days — stamped at write time into `expiresAt` so a later
// retention sweep can filter cheaply by a single indexed column.
// See specs/045-build-mode/cross-session-rejection-memory.md for the
// design narrative.

const CROSS_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface CrossSessionRejection {
  artifact: string;
  fixHash: string;
  artifactId: string;
  sectionOrSlotKey: string;
  semanticIntent: string;
  rationale: string | null;
  category: string | null;
  subLabel: string | null;
  sourceConversationId: string | null;
  rejectedAt: string;
  expiresAt: string;
}

export interface WriteCrossSessionArgs {
  artifact: string; // FixTarget.artifact or '' when untargeted
  fixHash: string;
  intent: RejectionIntent;
  category?: string | null;
  subLabel?: string | null;
  rationale?: string | null;
  sourceConversationId?: string | null;
  /** Optional override for tests; defaults to now. */
  now?: Date;
}

/**
 * Upsert a durable rejection. Re-rejecting the same fix refreshes
 * `rejectedAt`, `expiresAt`, and any new rationale/source —
 * intentionally, so a repeated rejection extends the TTL rather than
 * leaving a stale record that's about to expire.
 */
export async function writeCrossSessionRejection(
  prisma: PrismaClient,
  tenantId: string,
  args: WriteCrossSessionArgs
): Promise<void> {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CROSS_SESSION_TTL_MS);
  await prisma.rejectionMemory.upsert({
    where: {
      tenantId_artifact_fixHash: {
        tenantId,
        artifact: args.artifact,
        fixHash: args.fixHash,
      },
    },
    update: {
      rejectedAt: now,
      expiresAt,
      rationale: args.rationale ?? null,
      category: args.category ?? null,
      subLabel: args.subLabel ?? null,
      sourceConversationId: args.sourceConversationId ?? null,
      artifactId: args.intent.artifactId,
      sectionOrSlotKey: args.intent.sectionOrSlotKey,
      semanticIntent: args.intent.semanticIntent,
    },
    create: {
      tenantId,
      artifact: args.artifact,
      fixHash: args.fixHash,
      artifactId: args.intent.artifactId,
      sectionOrSlotKey: args.intent.sectionOrSlotKey,
      semanticIntent: args.intent.semanticIntent,
      rationale: args.rationale ?? null,
      category: args.category ?? null,
      subLabel: args.subLabel ?? null,
      sourceConversationId: args.sourceConversationId ?? null,
      rejectedAt: now,
      expiresAt,
    },
  });
}

/**
 * Look up a single cross-session rejection by (artifact, fixHash).
 * Returns `null` when the row is absent OR expired — callers never
 * need to check `expiresAt` themselves. Graceful on DB errors: the
 * propose_suggestion precheck treats a thrown error as "not
 * rejected", per NEXT.md §3 "missing memory ≠ no-suggestion".
 */
export async function lookupCrossSessionRejection(
  prisma: PrismaClient,
  tenantId: string,
  artifact: string,
  fixHash: string,
  now: Date = new Date()
): Promise<CrossSessionRejection | null> {
  const row = await prisma.rejectionMemory.findUnique({
    where: {
      tenantId_artifact_fixHash: { tenantId, artifact, fixHash },
    },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return {
    artifact: row.artifact,
    fixHash: row.fixHash,
    artifactId: row.artifactId,
    sectionOrSlotKey: row.sectionOrSlotKey,
    semanticIntent: row.semanticIntent,
    rationale: row.rationale,
    category: row.category,
    subLabel: row.subLabel,
    sourceConversationId: row.sourceConversationId,
    rejectedAt: row.rejectedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
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
