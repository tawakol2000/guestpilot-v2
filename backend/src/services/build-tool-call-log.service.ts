/**
 * BuildToolCallLog service (sprint 046 Session A).
 *
 * Writes one row per tool invocation from the BUILD/TUNE agent runtime.
 * Used for post-hoc trace review (was the agent calling the right tools?
 * how slow was it? did it error?) and as the substrate for the output-
 * linter's synthetic `__lint__` entries.
 *
 * CRITICAL: every public entry point is fire-and-forget. An insertion
 * failure NEVER blocks the turn. Callers should `logToolCall(...).catch(
 * () => {})` or equivalent — the function itself already swallows errors,
 * but the Promise it returns resolves to void in all cases so `await`
 * callers never see a rejection either.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export interface LogToolCallInput {
  tenantId: string;
  conversationId: string;
  turn: number;
  tool: string;
  params: unknown;
  durationMs: number;
  success: boolean;
  errorMessage?: string | null;
}

/**
 * Compute a stable hash of tool params. The hash is SHA-1 over the
 * JSON-stringified value with keys sorted so semantically-equal params
 * produce the same digest. Unserialisable values fall back to
 * `UNSERIALIZABLE`; no value is ever stored in plaintext.
 */
export function hashToolParams(params: unknown): string {
  const canonical = canonicaliseJson(params);
  let serialized: string;
  try {
    serialized = JSON.stringify(canonical);
  } catch {
    serialized = 'UNSERIALIZABLE';
  }
  return createHash('sha1').update(serialized).digest('hex');
}

function canonicaliseJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicaliseJson);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    sorted[key] = canonicaliseJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export async function logToolCall(
  prisma: PrismaClient,
  input: LogToolCallInput
): Promise<void> {
  try {
    await prisma.buildToolCallLog.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        turn: input.turn,
        tool: input.tool,
        paramsHash: hashToolParams(input.params),
        durationMs: Math.max(0, Math.round(input.durationMs)),
        success: input.success,
        errorMessage: input.errorMessage ?? null,
      },
    });
  } catch (err) {
    // Graceful degradation (CLAUDE.md rule 2): a BuildToolCallLog insert
    // failure must never bubble up and interrupt the turn. Log to stderr
    // so production issues surface in Railway logs.
    // eslint-disable-next-line no-console
    console.warn('[build-tool-call-log] insert failed:', err);
  }
}

// ─── Sprint 047 Session B — admin trace view helpers ───────────────────────

export interface ListToolCallsQuery {
  tenantId: string;
  conversationId?: string | null;
  tool?: string | null;
  turn?: number | null;
  /** Cursor is the last-seen row id; rows with id < cursor are returned. */
  cursorId?: string | null;
  /** Hard cap 200; default 50. */
  limit?: number | null;
}

export interface ToolCallRow {
  id: string;
  conversationId: string;
  turn: number;
  tool: string;
  paramsHash: string;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
}

export interface ToolCallPage {
  rows: ToolCallRow[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Admin-only read of BuildToolCallLog rows, tenant-scoped.
 *
 * Ordering is `createdAt DESC, id DESC` — newest first. Pagination uses
 * an id-based cursor: the caller passes the last row's id from the
 * previous page and we return rows whose id is strictly less than that.
 * This is safe even under clock skew because cuid ids are monotonically
 * increasing within a process.
 */
export async function listToolCalls(
  prisma: PrismaClient,
  q: ListToolCallsQuery
): Promise<ToolCallPage> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, q.limit ?? DEFAULT_LIMIT));
  const where: Record<string, unknown> = { tenantId: q.tenantId };
  if (q.conversationId) where.conversationId = q.conversationId;
  if (q.tool) where.tool = q.tool;
  if (typeof q.turn === 'number' && Number.isFinite(q.turn)) where.turn = q.turn;
  if (q.cursorId) where.id = { lt: q.cursorId };

  const rows = await prisma.buildToolCallLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1].id : null;
  return { rows: page, nextCursor };
}

/**
 * Bounded retention sweep. Deletes rows older than `olderThan`, at most
 * `batchSize` at a time. Returns the count deleted so the caller can
 * decide whether to re-queue.
 */
export async function deleteOldToolCalls(
  prisma: PrismaClient,
  olderThan: Date,
  batchSize: number
): Promise<number> {
  const bounded = Math.max(1, Math.min(50_000, batchSize));
  // Prisma's `deleteMany` ignores `take`, so we select a bounded id set
  // first and delete by id. This keeps lock hold times short even on a
  // large backlog.
  const victims = await prisma.buildToolCallLog.findMany({
    where: { createdAt: { lt: olderThan } },
    select: { id: true },
    take: bounded,
    orderBy: { createdAt: 'asc' },
  });
  if (victims.length === 0) return 0;
  const result = await prisma.buildToolCallLog.deleteMany({
    where: { id: { in: victims.map((v) => v.id) } },
  });
  return result.count;
}
