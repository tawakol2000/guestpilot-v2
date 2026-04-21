/**
 * emit_session_summary — sprint 058-A F4.
 *
 * End-of-turn diff card: the agent calls this tool ONCE, as its last
 * action right before its final text reply, with a tally of what the turn
 * accomplished (writes, tests, reverts, cancellations). Emits a
 * `data-session-diff-summary` SSE part the Studio renders as a compact
 * horizontal tally row anchored to the end of the turn's assistant
 * message.
 *
 * Mode: both (BUILD + TUNE). No DB write — this is a write-only emit.
 *
 * Once-per-turn invariant: a second call in the same turn returns
 * `{ ok: false, reason: 'already_emitted_this_turn' }`. State lives in
 * `ToolContext.turnFlags` (a fresh `{}` per runTuningAgentTurn invocation,
 * so the next turn resets it automatically — see runtime.ts Gate 3
 * comment).
 *
 * Graceful degradation: all count fields are optional with 0 defaults.
 * The renderer MUST cope with any subset (e.g. a turn that only ran
 * tests passes `tested` only).
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Emit the end-of-turn session-diff summary card. Call EXACTLY ONCE per turn, as your LAST action right before the final text reply — never mid-tool-loop. Provide the tally of artifacts written, tests run, plan items cancelled, and reverts performed during THIS turn (not cumulative across the session). A second call in the same turn returns { ok: false, reason: 'already_emitted_this_turn' } and is a no-op. Write-only; no side effects.`;

const countsSchema = z
  .object({
    created: z.number().int().min(0).optional(),
    edited: z.number().int().min(0).optional(),
    reverted: z.number().int().min(0).optional(),
  })
  .optional();

const testedSchema = z
  .object({
    runs: z.number().int().min(0).optional(),
    totalVariants: z.number().int().min(0).optional(),
    passed: z.number().int().min(0).optional(),
  })
  .optional();

const plansSchema = z
  .object({
    cancelled: z.number().int().min(0).optional(),
  })
  .optional();

/** Stable SSE part type — frontend keys off this literal string. */
export const SESSION_DIFF_SUMMARY_PART_TYPE = 'data-session-diff-summary';

/** Flag key set on ToolContext.turnFlags after the first successful emit. */
export const SESSION_SUMMARY_TURN_FLAG = 'session_summary_emitted';

export interface SessionDiffSummaryData {
  written: { created: number; edited: number; reverted: number };
  tested: { runs: number; totalVariants: number; passed: number };
  plans: { cancelled: number };
  note: string | null;
}

export function buildEmitSessionSummaryTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'emit_session_summary',
    DESCRIPTION,
    {
      written: countsSchema,
      tested: testedSchema,
      plans: plansSchema,
      note: z.string().max(120).nullable().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.emit_session_summary', {});
      try {
        const flags = (c.turnFlags ??= {});
        if (flags[SESSION_SUMMARY_TURN_FLAG]) {
          const payload = {
            ok: false as const,
            reason: 'already_emitted_this_turn' as const,
          };
          span.end(payload);
          return asCallToolResult(payload);
        }

        const w = args.written ?? {};
        const t = args.tested ?? {};
        const p = args.plans ?? {};
        const data: SessionDiffSummaryData = {
          written: {
            created: w.created ?? 0,
            edited: w.edited ?? 0,
            reverted: w.reverted ?? 0,
          },
          tested: {
            runs: t.runs ?? 0,
            totalVariants: t.totalVariants ?? 0,
            passed: t.passed ?? 0,
          },
          plans: {
            cancelled: p.cancelled ?? 0,
          },
          note: args.note ?? null,
        };

        const id = `session-summary:${Date.now().toString(36)}:${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        if (c.emitDataPart) {
          c.emitDataPart({
            type: SESSION_DIFF_SUMMARY_PART_TYPE,
            id,
            data,
          });
        }

        flags[SESSION_SUMMARY_TURN_FLAG] = true;

        const payload = { ok: true as const, summaryId: id };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(
          `emit_session_summary failed: ${err?.message ?? String(err)}`,
        );
      }
    },
  );
}
