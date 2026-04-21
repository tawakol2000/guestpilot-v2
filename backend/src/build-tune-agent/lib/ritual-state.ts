/**
 * Sprint 054-A F3 — post-write verification ritual state.
 *
 * A "ritual window" is the span between a successful write-tool call
 * and the next write-tool call (or end-of-turn). During that window the
 * agent can fire up to 3 test_pipeline calls to verify the edit; a 4th
 * is rejected at the executor layer.
 *
 * State lives in `ToolContext.turnFlags` (a plain Record) — turn-local,
 * no DB persistence. A turn that dies mid-ritual (user closes the
 * session between write and test) loses the ritual; re-engagement is
 * user-initiated. Acceptable per spec §5.
 *
 * Three keys are used:
 *   - `verification_ritual:historyId` — id of the history row for the
 *     last successful write. When present, a test_pipeline call is "in
 *     a ritual" and its result is written back to that row's
 *     metadata.testResult.
 *   - `verification_ritual:count` — number of test_pipeline calls fired
 *     since the ritual was opened. Starts at 0, bumps to 3, rejects 4+.
 *   - `verification_ritual:writeCount` — total write-tool calls in this
 *     turn; used for test-observability / non-ritual test handling.
 */
import type { ToolContext } from '../tools/types';

export const VERIFICATION_RITUAL_VERSION = '054-a.1';

/** Maximum test_pipeline invocations per ritual window. */
export const VERIFICATION_MAX_CALLS = 3;

const K_HISTORY_ID = 'verification_ritual:historyId';
const K_COUNT = 'verification_ritual:count';
const K_WRITE_COUNT = 'verification_ritual:writeCount';
const K_ARTIFACT_CTX = 'verification_ritual:artifactCtx';

function flags(ctx: ToolContext): Record<string, unknown> {
  return (ctx.turnFlags ??= {}) as Record<string, unknown>;
}

export interface RitualArtifactContext {
  artifactType:
    | 'sop'
    | 'faq'
    | 'system_prompt'
    | 'tool_definition'
    | 'property_override';
  artifactId: string;
  operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT';
}

/**
 * Record a successful write. Opens a fresh ritual window, resetting
 * the test-pipeline counter. The history id is the triggering row's
 * primary key so the verification result can be linked back.
 * `artifactContext` (optional) carries the artifact type + id +
 * operation so the F4 chat card can render a "Testing: UPDATE sop —
 * late_checkout" chip without a round-trip to the DB.
 */
export function openRitualWindow(
  ctx: ToolContext,
  historyId: string | null,
  artifactContext?: RitualArtifactContext,
): void {
  const f = flags(ctx);
  f[K_HISTORY_ID] = historyId ?? null;
  f[K_COUNT] = 0;
  f[K_ARTIFACT_CTX] = artifactContext ?? null;
  f[K_WRITE_COUNT] = (typeof f[K_WRITE_COUNT] === 'number' ? (f[K_WRITE_COUNT] as number) : 0) + 1;
}

export function getActiveRitualArtifactContext(
  ctx: ToolContext,
): RitualArtifactContext | null {
  const f = flags(ctx);
  const v = f[K_ARTIFACT_CTX];
  if (!v || typeof v !== 'object') return null;
  return v as RitualArtifactContext;
}

/**
 * The history row id of the currently active ritual window, or null
 * if we're not in a ritual (e.g. user-initiated test_pipeline outside
 * any write).
 */
export function getActiveRitualHistoryId(ctx: ToolContext): string | null {
  const f = flags(ctx);
  const v = f[K_HISTORY_ID];
  return typeof v === 'string' ? v : null;
}

/**
 * Returns how many test_pipeline calls the current ritual has already
 * fired. Outside a ritual, returns the same per-turn count so a user-
 * initiated test still respects the global ceiling (defence-in-depth).
 */
export function getVerificationCallCount(ctx: ToolContext): number {
  const f = flags(ctx);
  const v = f[K_COUNT];
  return typeof v === 'number' ? v : 0;
}

/**
 * Advance the counter by `by` (typically the number of parallel
 * variants being attempted in this call). Returns the new total.
 */
export function bumpVerificationCallCount(ctx: ToolContext, by: number): number {
  const f = flags(ctx);
  const next = getVerificationCallCount(ctx) + Math.max(1, by);
  f[K_COUNT] = next;
  return next;
}

/**
 * True iff a test_pipeline call with `n` variants would still fit under
 * VERIFICATION_MAX_CALLS. `n` counts the number of triggers being fired
 * in this single tool invocation (1 for legacy testMessage, up to 3 for
 * the 054-A testMessages array form).
 */
export function canFireVerification(
  ctx: ToolContext,
  n: number,
): { ok: true } | { ok: false; error: string; current: number; max: number } {
  const current = getVerificationCallCount(ctx);
  const max = VERIFICATION_MAX_CALLS;
  if (n < 1) {
    return {
      ok: false,
      error: 'test_pipeline: at least one trigger message is required.',
      current,
      max,
    };
  }
  if (n > max) {
    return {
      ok: false,
      error: `test_pipeline: ${n} triggers requested in one call but the ritual window caps verification at ${max} variants total. Propose the ${max} most distinct triggers.`,
      current,
      max,
    };
  }
  if (current + n > max) {
    return {
      ok: false,
      error: `TEST_RITUAL_EXHAUSTED: the current verification ritual has already fired ${current}/${max} test_pipeline variants; a ${n}-variant call would exceed the cap. Summarise existing results or propose a new edit (which opens a fresh ritual).`,
      current,
      max,
    };
  }
  return { ok: true };
}
