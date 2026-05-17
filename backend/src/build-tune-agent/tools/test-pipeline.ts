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
  // 2026-05-16: judge now accepts an AbortSignal so an aborted turn
  // doesn't keep burning tokens on in-flight Anthropic calls.
  runTestJudge?: (input: TestJudgeInput, options?: { signal?: AbortSignal }) => Promise<TestJudgeResult>;
}

let _defaultRunPipelineDry:
  | ((input: RunPipelineDryInput) => Promise<RunPipelineDryResult>)
  | undefined;
let _defaultRunTestJudge:
  | ((input: TestJudgeInput, options?: { signal?: AbortSignal }) => Promise<TestJudgeResult>)
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
  verificationIntent (optional string, ≤280 chars) — STRONGLY RECOMMENDED after a write. One-line description of THE SPECIFIC change you just made — e.g. "screening prompt: party-composition question now uses 'and who will be joining you?' instead of relationship labels". The judge returns a separate intentLanded verdict (passed/partial/failed) about whether THIS change is visible in the reply, independent of the overall quality score. Without it, a reply that adopts your edit correctly but also has unrelated bugs scores low overall and the operator can't tell if their fix actually worked.
RETURNS: Multi-variant: { ok, variants:[{triggerMessage,pipelineOutput,verdict,judgeReasoning,judgeScore,judgePromptVersion,intentLanded?,intentRationale?,ranAt}], aggregateVerdict: "all_passed"|"partial"|"all_failed", intentAggregate?: "passed"|"partial"|"failed", ritualVersion }`;

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
    ((input: TestJudgeInput, options?: { signal?: AbortSignal }) =>
      loadDefaultRunTestJudge()(input, options));
  return tool(
    'studio_test_pipeline',
    DESCRIPTION,
    {
      testMessage: z.string().min(1).max(1000).optional(),
      testMessages: z.array(z.string().min(1).max(1000)).min(1).max(3).optional(),
      testContext: contextSchema,
      verbosity: z.enum(['concise', 'detailed']).optional(),
      verificationIntent: z.string().min(1).max(280).optional(),
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
            if (c.abortSignal?.aborted) {
              throw new Error('Aborted before dry-run');
            }
            const dry = await runPipelineDry({
              tenantId: c.tenantId,
              testMessage: trigger,
              context: args.testContext as TestPipelineContext | undefined,
              prisma: c.prisma,
              signal: c.abortSignal,
            });
            let judge: TestJudgeResult;
            try {
              // 2026-05-16: propagate abort signal so a client
              // disconnect cancels the in-flight judge call instead
              // of burning the full 30s + token budget.
              if (c.abortSignal?.aborted) {
                throw new Error('Aborted before judge call');
              }
              judge = await runTestJudge(
                {
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
                  // 2026-05-17: per-axis grading — when the agent passes
                  // verificationIntent (recommended after a write), the
                  // judge separately reports whether THE specific change
                  // landed, not just whether the whole reply is good.
                  verificationIntent: args.verificationIntent,
                },
                { signal: c.abortSignal },
              );
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
              // 2026-05-17: per-axis verdict — present only when
              // verificationIntent was passed. UI renders it as a
              // separate chip next to the overall pass/fail so the
              // operator can see "the change you made worked" even
              // when the reply has unrelated quality issues.
              intentLanded: judge.intentLanded,
              intentRationale: judge.intentRationale,
              judgePromptVersion: judge.promptVersion,
              judgeModel: judge.judgeModel,
              replyModel: dry.replyModel,
              latencyMs: dry.latencyMs,
              ranAt: new Date().toISOString(),
            };
          })
        );

        // 2026-05-17: compute an intent-axis aggregate alongside the
        // overall-quality aggregate. Same rollup rule: all passed → passed,
        // none passed → failed, mixed → partial. Absent when no variants
        // returned an intent verdict (i.e. the agent didn't pass
        // verificationIntent).
        const intentVerdicts = results
          .map((r) => r.intentLanded)
          .filter((v): v is 'passed' | 'partial' | 'failed' => !!v);
        const intentAggregate: 'passed' | 'partial' | 'failed' | undefined =
          intentVerdicts.length === 0
            ? undefined
            : intentVerdicts.every((v) => v === 'passed')
              ? 'passed'
              : intentVerdicts.every((v) => v === 'failed')
                ? 'failed'
                : 'partial';

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
        // 2026-05-15: skip metadata persistence under STUDIO_HARNESS_DRY_RUN
        // so harness runs don't mutate BuildArtifactHistory rows on the
        // live tenant. The variant data still flows through the SSE part
        // so the agent + frontend see the same payload.
        if (historyId && process.env.STUDIO_HARNESS_DRY_RUN !== 'true') {
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
          // 2026-05-17: present only when verificationIntent was passed.
          // Frontend should display this AS THE PRIMARY VERDICT when set
          // and demote `aggregateVerdict` to a secondary "overall quality"
          // chip. Without it, operators see "all failed" for tests where
          // their actual edit landed but unrelated bugs dragged the
          // score down.
          intentAggregate,
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
        // 2026-05-15 polish: append a close-of-turn hint so the model
        // wraps the session with a concrete pass/fail summary instead of
        // a generic "I ran the test" close. all_passed → ok to close;
        // partial / all_failed → suggest rollback or another iteration.
        //
        // 2026-05-17 refinement: when intentAggregate is present, lead
        // with it. The operator cares first about "did my edit land?"
        // and only second about "is the rest of the reply good?".
        // Conflating the two has been the #1 source of "all tests
        // failed but they look good tbh" frustration.
        const closeHint = intentAggregate
          ? intentAggregate === 'passed' && aggregateVerdict === 'all_passed'
            ? 'Intent landed AND overall quality passed across all variants. Close with a one-line summary.'
            : intentAggregate === 'passed'
              ? `Your intended change LANDED in every variant (intentAggregate=passed). Overall quality verdict is ${aggregateVerdict} due to OTHER issues unrelated to this edit — surface them as separate follow-ups, not as "the fix failed". State plainly: "the edit you asked for is working" and then list the unrelated issues the judge found.`
              : intentAggregate === 'partial'
                ? `Your intended change landed in SOME variants but not others (intentAggregate=partial). Per-variant breakdown: ${results.map((r) => `"${r.triggerMessage.slice(0, 40)}…" → ${r.intentLanded ?? 'n/a'}`).join('; ')}. Tell the operator which triggers worked vs. which still don't, and ask whether to iterate on the prompt or accept partial coverage.`
                : `Your intended change did NOT land in any variant (intentAggregate=failed). This means the edit you wrote isn't taking effect in the live pipeline — re-read the artifact, confirm the right section was edited, and consider a rollback before re-attempting.`
          : aggregateVerdict === 'all_passed'
            ? 'All variants passed the cross-family judge. Safe to close the turn with a one-line summary.'
            : aggregateVerdict === 'partial'
              ? 'Some variants regressed under the judge. Surface which variant failed and ask the manager whether to roll back, accept partial improvement, or iterate. (Tip: pass `verificationIntent` next time to get a per-axis verdict isolating whether YOUR edit landed.)'
              : 'All variants failed the judge. Recommend studio_rollback unless the manager explicitly wants to keep the change. (Tip: pass `verificationIntent` next time — without it, unrelated quality issues drag down the overall score and you can\'t tell whether the edit you made actually worked.)';
        return asCallToolResult({ ...payload, close_of_turn_hint: closeHint });
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(
          `test_pipeline failed: ${err?.message ?? String(err)}`
        );
      }
    },
    // 2026-05-15: readOnlyHint was incorrectly true — the tool writes
    // verification metadata to BuildArtifactHistory under a live ritual.
    // Mark non-destructive (re-running re-stamps metadata, no data loss)
    // but not read-only.
    { annotations: { destructiveHint: false } },
  );
}
