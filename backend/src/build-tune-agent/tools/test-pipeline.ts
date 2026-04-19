/**
 * test_pipeline — sprint 045 Gate 3.
 *
 * Runs ONE guest message through a simplified dry copy of the tenant's
 * reply pipeline, grades the reply with a Sonnet 4.6 judge, and returns
 * the reply + score + rationale. Emits a `data-test-pipeline-result`
 * SSE part so the frontend can render the outcome inline.
 *
 * Design notes (per spec §11, re-scoped 2026-04-19):
 *   - Single message in, single graded reply out. No batch. No golden
 *     set. No adversarial generator. No rubric. The batch subsystem is
 *     deferred to sprint 047+ (see MASTER_PLAN.md).
 *   - Cross-family judge (Sonnet 4.6 grading the GPT-5.4 pipeline) so
 *     self-enhancement bias does not apply.
 *   - `hasRunThisTurn` guard: a second call in the same turn returns
 *     a structured `TEST_ALREADY_RAN_THIS_TURN` error so the agent
 *     doesn't burn budget on a cache-warm repeat.
 *   - Tenant-config cache bypass: `runPipelineDry` threads
 *     `bypassCache: true` through to `getTenantAiConfig` so a
 *     system-prompt write <60s old is visible immediately. The
 *     production hot path does NOT use this flag and stays on its
 *     60s TTL.
 *
 * Callable in BOTH BUILD and TUNE modes (see `resolveAllowedTools`):
 * TUNE managers sometimes want to test what a correction would
 * produce before committing to apply it.
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

/**
 * Test DI seams. Default to the real implementations in production;
 * unit tests inject fakes to skip the real dependency graph.
 *
 * The default implementations are resolved lazily at first call so
 * unit tests that DI both dependencies never trigger the import of
 * `test-pipeline-runner` (which transitively loads `ai.service.ts` +
 * its eager OpenAI-client and JWT-secret-requiring middleware chain).
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

const DESCRIPTION = `test_pipeline: Run one test message through the pipeline and get an LLM-graded reply. Use after any create_* or write_system_prompt call to confirm the change behaves as intended.
WHEN TO USE: After a create_sop / create_faq / create_tool_definition / write_system_prompt call (or a plan transaction completing) to verify the new artifact is reflected in the AI's output. Also on manager request ("what would the AI say if a guest asked X?"). In TUNE mode, after an apply on a non-trivial artifact to confirm the correction landed.
WHEN NOT TO USE: Do NOT use to test the same change twice in one turn — results will be identical. Do NOT use to stress-test with dozens of messages — that's deferred to a future batch tool. Do NOT use mid-interview with no artifacts yet.
PARAMETERS:
  testMessage (string, 1-1000 chars)
  testContext (optional { reservationStatus?, channel? })
RETURNS: { reply, judgeScore (0..1), judgeRationale, judgeFailureCategory?, judgePromptVersion, replyModel, latencyMs }`;

const TURN_FLAG = 'test_pipeline:hasRunThisTurn';

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
    'test_pipeline',
    DESCRIPTION,
    {
      testMessage: z.string().min(1).max(1000),
      testContext: contextSchema,
    },
    async (args) => {
      const c = ctx();
      const flags = (c.turnFlags ??= {});
      if (flags[TURN_FLAG]) {
        return asError(
          'TEST_ALREADY_RAN_THIS_TURN: test_pipeline has already run once in this turn. Summarise the existing result or ask the manager what to change before testing again.'
        );
      }
      flags[TURN_FLAG] = true;

      const span = startAiSpan('build-tune-agent.test_pipeline', {
        tenantId: c.tenantId,
        messageChars: args.testMessage.length,
        reservationStatus: args.testContext?.reservationStatus ?? 'CONFIRMED',
        channel: args.testContext?.channel ?? 'DIRECT',
      });
      try {
        const dry = await runPipelineDry({
          tenantId: c.tenantId,
          testMessage: args.testMessage,
          context: args.testContext as TestPipelineContext | undefined,
          prisma: c.prisma,
        });

        const judge = await runTestJudge({
          tenantContext: dry.tenantContextSummary,
          guestMessage: args.testMessage,
          aiReply: dry.reply,
        });

        const payload = {
          ok: true,
          reply: dry.reply,
          judgeScore: judge.score,
          judgeRationale: judge.rationale,
          judgeFailureCategory: judge.failureCategory,
          judgePromptVersion: judge.promptVersion,
          judgeModel: judge.judgeModel,
          replyModel: dry.replyModel,
          latencyMs: dry.latencyMs,
        };

        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-test-pipeline-result',
            id: `test-pipeline:${Date.now()}`,
            data: payload,
          });
        }
        span.end({
          judgeScore: judge.score,
          latencyMs: dry.latencyMs,
          failureCategory: judge.failureCategory ?? null,
        });
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(
          `test_pipeline failed: ${err?.message ?? String(err)}`
        );
      }
    }
  );
}
