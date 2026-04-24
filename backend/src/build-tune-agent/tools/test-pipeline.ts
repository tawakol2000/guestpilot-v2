/**
 * test_pipeline — sprint 045 Gate 3, extended in sprint 054-A F3.
 *
 * Runs 1–3 guest messages through the tenant's dry pipeline in parallel
 * (Promise.all over test + judge pairs), then grades each reply with a
 * Sonnet 4.6 judge. Emits a `data-test-pipeline-result` SSE part whose
 * payload is either legacy single-variant or 054-A multi-variant.
 *
 * Ritual discipline (054-A F3):
 *   - After a successful write tool, a "ritual window" opens. A
 *     test_pipeline call fired inside the window counts against the
 *     VERIFICATION_MAX_CALLS=3 cap. On completion, each variant's
 *     verdict + judge reasoning is appended to the triggering history
 *     row's metadata.testResult so the ledger can render a pass/fail
 *     chip and the drawer can render the Verification section.
 *   - Outside a ritual window (user-initiated test, no preceding write
 *     this turn), the call still runs but NO history row is mutated.
 *   - Executor-level: the ritual-state helper rejects a 4th call. Belt
 *     + suspenders with the prompt-level "once per ritual" instruction.
 *
 * Cross-family judge (Sonnet 4.6 grading GPT-5.4 pipeline) sidesteps
 * self-enhancement bias. Callable in both BUILD and TUNE modes.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';
import type {
  RunPipelineDryInput,
  RunPipelineDryResult,
  TestPipelineContext,
} from '../preview/test-pipeline-runner';
import type {
  TestJudgeInput,
  TestJudgeResult,
} from '../preview/test-judge';
import {
  appendVerificationResult,
  computeAggregateVerdict,
  type VerificationVariantInput,
} from '../lib/artifact-history';
import {
  bumpVerificationCallCount,
  canFireVerification,
  getActiveRitualArtifactContext,
  getActiveRitualHistoryId,
  getVerificationCallCount,
  VERIFICATION_MAX_CALLS,
  VERIFICATION_RITUAL_VERSION,
} from '../lib/ritual-state';

/**
 * Test DI seams. Default to the real implementations in production;
 * unit tests inject fakes to skip the real dependency graph.
 */
export interface TestPipelineDeps {
  runPipelineDry?: (input: RunPipelineDryInput) => Promise<RunPipelineDryResult>;
  runTestJudge?: (input: TestJudgeInput) => Promise<TestJudgeResult>;
}

let _defaultRunPipelineDry:
  | ((input: RunPipelineDryInput) => Promise<RunPipelineDryResult>)
  | undefined;
let _defaultRunTestJudge:
  | ((input: TestJudgeInput) => Promise<TestJudgeResult>)
  | undefined;

function loadDefaultRunPipelineDry() {
  if (!_defaultRunPipelineDry) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _defaultRunPipelineDry = require('../preview/test-pipeline-runner')
      .runPipelineDry as typeof _defaultRunPipelineDry;
  }
  return _defaultRunPipelineDry!;
}

function loadDefaultRunTestJudge() {
  if (!_defaultRunTestJudge) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _defaultRunTestJudge = require('../preview/test-judge')
      .runTestJudge as typeof _defaultRunTestJudge;
  }
  return _defaultRunTestJudge!;
}

const DESCRIPTION = `test_pipeline: Verify a tenant-config edit by running one-to-three representative guest messages through the tenant's reply pipeline and grading each reply with a cross-family judge.
WHEN TO USE: After a successful create_sop / create_faq / create_tool_definition / write_system_prompt call, propose up to 3 distinct triggers varying along a direct-ask / implicit-ask / framed-ask axis that exercise the same edit from different angles, then call test_pipeline ONCE with testMessages: [t1, t2, t3]. Also callable on manager request for ad-hoc testing.
WHEN NOT TO USE: Do NOT use to test the same change twice in one turn — results will be identical. Do NOT pad 3 near-paraphrases if only 1–2 meaningfully distinct phrasings exist; 1/1 and 2/2 are honest, 1/3 is padded. Do NOT chain tests on the same edit (propose a new edit and a fresh ritual starts).
PARAMETERS:
  testMessage (string, 1-1000 chars, deprecated) — legacy single-trigger form.
  testMessages (string[], 1-3 entries, preferred) — the 054-A multi-variant form; run in parallel via Promise.all.
  testContext (optional { reservationStatus?, channel? })
RETURNS: Multi-variant: { ok, variants:[{triggerMessage,pipelineOutput,verdict,judgeReasoning,judgeScore,judgePromptVersion,ranAt}], aggregateVerdict: "all_passed"|"partial"|"all_failed", ritualVersion }`;

const contextSchema = z
  .object({
    reservationStatus: z
      .enum(['INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'])
      .optional(),
    channel: z
      .enum(['AIRBNB', 'BOOKING', 'DIRECT', 'WHATSAPP', 'OTHER'])
      .optional(),
  })
  .optional();

export function buildTestPipelineTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
  deps?: TestPipelineDeps
) {
  const runPipelineDry =
    deps?.runPipelineDry ??
    ((input: RunPipelineDryInput) => loadDefaultRunPipelineDry()(input));
  const runTestJudge =
    deps?.runTestJudge ??
    ((input: TestJudgeInput) => loadDefaultRunTestJudge()(input));
  return tool(
    'studio_test_pipeline',
    DESCRIPTION,
    {
      testMessage: z.string().min(1).max(1000).optional(),
      testMessages: z.array(z.string().min(1).max(1000)).min(1).max(10).optional(),
      testContext: contextSchema,
    },
    async (args) => {
      const c = ctx();

      // Reconcile the two input shapes into a single `triggers` array.
      // testMessages wins when both are present; legacy testMessage
      // fills in otherwise. Empty / missing both → error.
      let triggers: string[] = [];
      if (Array.isArray(args.testMessages) && args.testMessages.length > 0) {
        triggers = args.testMessages;
      } else if (typeof args.testMessage === 'string' && args.testMessage.length > 0) {
        triggers = [args.testMessage];
      }
      if (triggers.length === 0) {
        return asError(
          'test_pipeline: provide testMessages: string[] (1–3 distinct triggers) or testMessage: string.'
        );
      }

      // 054-A F3 — per-ritual cap. Up to VERIFICATION_MAX_CALLS total
      // variants per ritual window. A fresh write opens a new window.
      const guard = canFireVerification(c, triggers.length);
      if (!guard.ok) {
        return asError(guard.error);
      }

      const span = startAiSpan('build-tune-agent.test_pipeline', {
        tenantId: c.tenantId,
        triggers: triggers.length,
        reservationStatus: args.testContext?.reservationStatus ?? 'CONFIRMED',
        channel: args.testContext?.channel ?? 'DIRECT',
      });

      const historyId = getActiveRitualHistoryId(c);
      const artifactCtx = getActiveRitualArtifactContext(c);

      try {
        // Promise.all over (test, judge) pairs — sequential inside each
        // pair (judge must wait on the reply it's grading), parallel
        // across pairs.  This is the 054-A execution pivot: sequential
        // triples wall-time. If Promise.all isn't feasible for infra
        // reasons in a future refactor, STOP AND SURFACE — do not fall
        // back to sequential (per spec amendment).
        const results = await Promise.all(
          triggers.map(async (trigger) => {
            const dry = await runPipelineDry({
              tenantId: c.tenantId,
              testMessage: trigger,
              context: args.testContext as TestPipelineContext | undefined,
              prisma: c.prisma,
            });
            let judge: TestJudgeResult;
            try {
              judge = await runTestJudge({
                tenantContext: dry.tenantContextSummary,
                guestMessage: trigger,
                aiReply: dry.reply,
                // 2026-04-24: pass the structured pipeline action so
                // the judge credits escalation/scheduledTime signals
                // the SOP intended — fixes the passport-verification
                // false-negative where "Thanks for sending the
                // passport." + escalation was graded 'missing-sop-
                // reference'. `action` is null only when the dry
                // runner couldn't honour the schema; the judge
                // falls back to legacy reply-only grading in that
                // case (see JudgePipelineAction header).
                pipelineAction: dry.action ?? undefined,
              });
            } catch (jerr: any) {
              // Empty/malformed judge output → test result still
              // persists with verdict:failed and judgeReasoning carrying
              // the error placeholder (spec §5). Never drop the result.
              judge = {
                score: 0,
                rationale: `Judge call failed: ${jerr?.message ?? String(jerr)}`,
                failureCategory: 'judge-error',
                promptVersion: '(judge-error)',
                judgeModel: '(judge-error)',
              };
            }
            const verdict: 'passed' | 'failed' =
              judge.score >= 0.7 ? 'passed' : 'failed';
            return {
              triggerMessage: trigger,
              pipelineOutput: dry.reply,
              // 2026-04-24: include the structured action so the
              // verdict card can render "Escalated as {title} (urgency)"
              // alongside the prose reply — otherwise operators see a
              // short ack and can't tell the escalation fired.
              pipelineAction: dry.action ?? null,
              verdict,
              judgeReasoning: judge.rationale,
              judgeScore: judge.score,
              judgeFailureCategory: judge.failureCategory,
              judgePromptVersion: judge.promptVersion,
              judgeModel: judge.judgeModel,
              replyModel: dry.replyModel,
              latencyMs: dry.latencyMs,
              ranAt: new Date().toISOString(),
            };
          })
        );

        const aggregateVerdict = computeAggregateVerdict(
          results.map(
            (r): VerificationVariantInput => ({
              triggerMessage: r.triggerMessage,
              pipelineOutput: r.pipelineOutput,
              verdict: r.verdict,
              judgeReasoning: r.judgeReasoning,
              judgePromptVersion: r.judgePromptVersion,
              ranAt: r.ranAt,
            })
          )
        );

        // Bump the ritual counter AFTER success so a failure doesn't
        // permanently burn budget if the model decides to retry
        // (rare — usually a retry appears as a fresh tool call).
        bumpVerificationCallCount(c, triggers.length);

        // Linkage: if we're in a ritual window, append the new
        // variants onto the triggering history row's metadata.testResult.
        // Outside a ritual, we deliberately DO NOT mutate any row —
        // a user-initiated test_pipeline renders in chat only.
        if (historyId) {
          await appendVerificationResult(
            c.prisma,
            historyId,
            results.map((r) => ({
              triggerMessage: r.triggerMessage,
              pipelineOutput: r.pipelineOutput,
              verdict: r.verdict,
              judgeReasoning: r.judgeReasoning,
              judgePromptVersion: r.judgePromptVersion,
              ranAt: r.ranAt,
            })),
            VERIFICATION_RITUAL_VERSION
          );
        }

        const payload = {
          ok: true,
          variants: results,
          aggregateVerdict,
          ritualVersion: VERIFICATION_RITUAL_VERSION,
          sourceWriteHistoryId: historyId,
          sourceWriteLabel: artifactCtx,
          ritualCallsRemaining: Math.max(
            0,
            VERIFICATION_MAX_CALLS - getVerificationCallCount(c)
          ),
        };

        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-test-pipeline-result',
            id: `test-pipeline:${Date.now()}`,
            data: payload,
          });
        }
        span.end({
          aggregateVerdict,
          variants: results.length,
          inRitual: Boolean(historyId),
        });
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(
          `test_pipeline failed: ${err?.message ?? String(err)}`
        );
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
