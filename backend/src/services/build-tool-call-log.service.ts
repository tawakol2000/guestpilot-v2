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
