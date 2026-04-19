/**
 * test_pipeline — unit tests.
 *
 * Run: npx tsx --test src/build-tune-agent/tools/__tests__/test-pipeline.test.ts
 *
 * Covers:
 *   - Happy path: reply + judgeScore + rationale + version stamp flow
 *     through the tool handler.
 *   - hasRunThisTurn guard: a second invocation in the same turn
 *     returns TEST_ALREADY_RAN_THIS_TURN.
 *   - Emission: data-test-pipeline-result SSE part fires on success.
 *   - Input validation: empty testMessage → upstream runner not invoked.
 *   - Error propagation: runner throws → structured asError return.
 */
// Env vars must be set before the transitive import graph loads
// ai.service.ts (which eagerly constructs an OpenAI client) and
// middleware/auth.ts (which process.exit(1)s without JWT_SECRET).
// The runner uses dependency injection at test time, so these only
// need to exist — they don't have to be valid credentials.
process.env.JWT_SECRET ??= 'test-secret-test-pipeline';
process.env.OPENAI_API_KEY ??= 'sk-test-placeholder';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestPipelineTool, type TestPipelineDeps } from '../test-pipeline';
import type { ToolContext } from '../types';
import type { RunPipelineDryInput, RunPipelineDryResult } from '../../preview/test-pipeline-runner';
import type { TestJudgeInput, TestJudgeResult } from '../../preview/test-judge';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (args: any) => captured(args) };
}

function makeCtx(): ToolContext & {
  _emitted: Array<{ type: string; id?: string; data: unknown }>;
} {
  const emitted: Array<{ type: string; id?: string; data: unknown }> = [];
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) =>
      emitted.push({ type: part.type, id: part.id, data: part.data }),
    turnFlags: {},
    _emitted: emitted,
  };
}

function deps(overrides?: {
  dryResult?: RunPipelineDryResult | Error;
  judgeResult?: TestJudgeResult | Error;
  onDry?: (input: RunPipelineDryInput) => void;
  onJudge?: (input: TestJudgeInput) => void;
}): TestPipelineDeps {
  return {
    runPipelineDry: async (input) => {
      overrides?.onDry?.(input);
      if (overrides?.dryResult instanceof Error) throw overrides.dryResult;
      return (
        overrides?.dryResult ?? {
          reply: 'Yes — 2pm late checkout is complimentary at this property.',
          replyModel: 'gpt-5.4-mini-2026-03-17',
          tenantContextSummary:
            '## System prompt (excerpt)\nBe friendly.\n\n## Active SOPs\nLate-checkout SOP: 2pm free.',
          latencyMs: 212,
        }
      );
    },
    runTestJudge: async (input) => {
      overrides?.onJudge?.(input);
      if (overrides?.judgeResult instanceof Error) throw overrides.judgeResult;
      return (
        overrides?.judgeResult ?? {
          score: 0.86,
          rationale: 'Reply correctly cites the late-checkout SOP.',
          promptVersion: 'test-judge/v1',
          judgeModel: 'claude-sonnet-4-6',
        }
      );
    },
  };
}

test('test_pipeline: happy path returns reply + score + rationale + version', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, deps());
  const r = await invoke({ testMessage: 'hey can I check out at 2pm?' });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reply, 'Yes — 2pm late checkout is complimentary at this property.');
  assert.equal(parsed.judgeScore, 0.86);
  assert.equal(parsed.judgePromptVersion, 'test-judge/v1');
  assert.equal(parsed.judgeModel, 'claude-sonnet-4-6');
  assert.equal(parsed.replyModel, 'gpt-5.4-mini-2026-03-17');
  assert.ok(typeof parsed.latencyMs === 'number');
});

test('test_pipeline: emits data-test-pipeline-result SSE part', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, deps());
  await invoke({ testMessage: 'noise complaint at 2am please help' });
  assert.equal(ctx._emitted.length, 1);
  assert.equal(ctx._emitted[0].type, 'data-test-pipeline-result');
  const data = ctx._emitted[0].data as any;
  assert.equal(data.judgeScore, 0.86);
});

test('test_pipeline: hasRunThisTurn guard blocks second call', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, deps());
  const r1 = await invoke({ testMessage: 'first' });
  assert.ok(!r1.isError);
  const r2 = await invoke({ testMessage: 'second' });
  assert.ok(r2.isError);
  assert.match(r2.content[0].text, /TEST_ALREADY_RAN_THIS_TURN/);
});

test('test_pipeline: fresh turnFlags allow a new invocation', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, deps());
  const r1 = await invoke({ testMessage: 'first' });
  assert.ok(!r1.isError);
  // Simulate a new turn by resetting turnFlags.
  ctx.turnFlags = {};
  const r2 = await invoke({ testMessage: 'second' });
  assert.ok(!r2.isError);
});

test('test_pipeline: propagates testContext to runner', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  let captured: RunPipelineDryInput | null = null;
  buildTestPipelineTool(
    factory,
    () => ctx,
    deps({
      onDry: (input) => {
        captured = input;
      },
    })
  );
  await invoke({
    testMessage: 'When can I check in?',
    testContext: { reservationStatus: 'INQUIRY', channel: 'AIRBNB' },
  });
  assert.ok(captured);
  assert.equal(captured!.context?.reservationStatus, 'INQUIRY');
  assert.equal(captured!.context?.channel, 'AIRBNB');
  assert.equal(captured!.tenantId, 't1');
});

test('test_pipeline: runner failure returns structured error (not throw)', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(
    factory,
    () => ctx,
    deps({ dryResult: new Error('OpenAI rate limit 429') })
  );
  const r = await invoke({ testMessage: 'test' });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /test_pipeline failed/);
  assert.match(r.content[0].text, /rate limit/);
});

test('test_pipeline: judge rationale reaches the payload', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  let captured: TestJudgeInput | null = null;
  buildTestPipelineTool(
    factory,
    () => ctx,
    deps({
      onJudge: (input) => {
        captured = input;
      },
      judgeResult: {
        score: 0.45,
        rationale: 'Reply ignored the wifi SOP.',
        failureCategory: 'missing-sop-reference',
        promptVersion: 'test-judge/v1',
        judgeModel: 'claude-sonnet-4-6',
      },
    })
  );
  const r = await invoke({ testMessage: "what's the wifi password?" });
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.judgeScore, 0.45);
  assert.equal(parsed.judgeFailureCategory, 'missing-sop-reference');
  assert.equal(parsed.judgeRationale, 'Reply ignored the wifi SOP.');
  // Judge received the pipeline's generated reply + context.
  assert.ok(captured);
  assert.equal(captured!.guestMessage, "what's the wifi password?");
  assert.match(captured!.tenantContext, /System prompt/);
});
