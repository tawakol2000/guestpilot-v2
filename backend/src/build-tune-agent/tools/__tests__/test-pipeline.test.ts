/**
 * test_pipeline — unit tests (sprint 045 Gate 3 baseline + 054-A F3).
 *
 * Run: npx tsx --test src/build-tune-agent/tools/__tests__/test-pipeline.test.ts
 *
 * Covers:
 *   - Happy path (single + multi-variant)
 *   - Emission of data-test-pipeline-result with new shape
 *   - Ritual cap: 4th variant in the same window is rejected
 *   - Input shapes: empty → error; testMessages > 3 in one call → rejected
 *   - Runner failure → structured asError return
 *   - Judge failure → verdict still persists as "failed" with error reason
 */
process.env.JWT_SECRET ??= 'test-secret-test-pipeline';
process.env.OPENAI_API_KEY ??= 'sk-test-placeholder';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestPipelineTool, type TestPipelineDeps } from '../test-pipeline';
import type { ToolContext } from '../types';
import type { RunPipelineDryInput, RunPipelineDryResult } from '../../preview/test-pipeline-runner';
import type { TestJudgeInput, TestJudgeResult } from '../../preview/test-judge';
import {
  VERIFICATION_RITUAL_VERSION,
  openRitualWindow,
} from '../../lib/ritual-state';

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
    prisma: {
      buildArtifactHistory: {
        findUnique: async () => null,
        update: async () => ({}),
      },
    } as any,
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

function makeDeps(overrides?: {
  dryResults?: RunPipelineDryResult[];
  judgeResults?: TestJudgeResult[];
  dryThrows?: Error;
  judgeThrows?: Error;
}): TestPipelineDeps {
  let dryCallIdx = 0;
  let judgeCallIdx = 0;
  return {
    runPipelineDry: async (_input) => {
      if (overrides?.dryThrows) throw overrides.dryThrows;
      const idx = dryCallIdx++;
      const result = overrides?.dryResults?.[idx];
      return (
        result ?? {
          reply: `Yes — 2pm late checkout is fine. (#${idx})`,
          replyModel: 'gpt-5.4-mini-2026-03-17',
          tenantContextSummary:
            '## System prompt\nBe friendly.\n\n## Active SOPs\nLate-checkout.',
          latencyMs: 200 + idx,
        }
      );
    },
    runTestJudge: async (_input) => {
      if (overrides?.judgeThrows) throw overrides.judgeThrows;
      const idx = judgeCallIdx++;
      const result = overrides?.judgeResults?.[idx];
      return (
        result ?? {
          score: 0.86,
          rationale: `Reply correctly cites the SOP. (#${idx})`,
          promptVersion: 'test-judge/v1',
          judgeModel: 'claude-sonnet-4-6',
        }
      );
    },
  };
}

test('test_pipeline: happy path (single-variant, testMessage form)', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  const r = await invoke({ testMessage: 'hey can I check out at 2pm?' });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.variants.length, 1);
  assert.equal(parsed.variants[0].verdict, 'passed');
  assert.equal(parsed.aggregateVerdict, 'all_passed');
  assert.equal(parsed.ritualVersion, VERIFICATION_RITUAL_VERSION);
});

test('test_pipeline: multi-variant (3 triggers, testMessages form) runs in parallel', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  const r = await invoke({
    testMessages: [
      'Can I check out at 2pm?',
      'Our flight is at 4pm tomorrow.',
      'Partner birthday celebration, we do not want to rush out.',
    ],
  });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.variants.length, 3);
  assert.equal(parsed.aggregateVerdict, 'all_passed');
});

test('test_pipeline: aggregate verdict partial when a subset fails', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(
    factory,
    () => ctx,
    makeDeps({
      judgeResults: [
        { score: 0.86, rationale: 'pass 1', promptVersion: 'v1', judgeModel: 'claude-sonnet-4-6' },
        { score: 0.45, rationale: 'missed sop', promptVersion: 'v1', judgeModel: 'claude-sonnet-4-6', failureCategory: 'missing-sop-reference' },
        { score: 0.8, rationale: 'pass 3', promptVersion: 'v1', judgeModel: 'claude-sonnet-4-6' },
      ],
    })
  );
  const r = await invoke({
    testMessages: ['t1', 't2', 't3'],
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.aggregateVerdict, 'partial');
  assert.equal(parsed.variants.filter((v: any) => v.verdict === 'passed').length, 2);
  assert.equal(parsed.variants.filter((v: any) => v.verdict === 'failed').length, 1);
});

test('test_pipeline: aggregate verdict all_failed when all variants fail', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(
    factory,
    () => ctx,
    makeDeps({
      judgeResults: [
        { score: 0.2, rationale: 'off', promptVersion: 'v1', judgeModel: 'claude-sonnet-4-6', failureCategory: 'off-topic' },
        { score: 0.4, rationale: 'off', promptVersion: 'v1', judgeModel: 'claude-sonnet-4-6', failureCategory: 'hallucination' },
      ],
    })
  );
  const r = await invoke({ testMessages: ['a', 'b'] });
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.aggregateVerdict, 'all_failed');
  assert.equal(parsed.variants.length, 2);
});

test('test_pipeline: emits data-test-pipeline-result SSE part with new shape', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  await invoke({ testMessage: 'noise complaint at 2am' });
  assert.equal(ctx._emitted.length, 1);
  assert.equal(ctx._emitted[0].type, 'data-test-pipeline-result');
  const data = ctx._emitted[0].data as any;
  assert.ok(Array.isArray(data.variants));
  assert.equal(data.variants.length, 1);
  assert.equal(data.ritualVersion, VERIFICATION_RITUAL_VERSION);
});

test('test_pipeline: ritual cap — 4th variant across calls is rejected', async () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'hist-1');
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  // Fire 3 variants total across two calls (2 + 1 = 3) — both succeed.
  const r1 = await invoke({ testMessages: ['t1', 't2'] });
  assert.ok(!r1.isError);
  const r2 = await invoke({ testMessage: 't3' });
  assert.ok(!r2.isError);
  // A 4th attempt should be rejected.
  const r3 = await invoke({ testMessage: 't4' });
  assert.ok(r3.isError);
  assert.match(r3.content[0].text, /TEST_RITUAL_EXHAUSTED/);
});

test('test_pipeline: >3 triggers in a single call is rejected before running', async () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'hist-1');
  let runnerCalls = 0;
  const deps = makeDeps();
  const wrappedRunner = deps.runPipelineDry!;
  deps.runPipelineDry = async (input) => {
    runnerCalls++;
    return wrappedRunner(input);
  };
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, deps);
  const r = await invoke({ testMessages: ['a', 'b', 'c', 'd'] });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /caps verification at 3/);
  assert.equal(runnerCalls, 0, 'runner must not execute for rejected inputs');
});

test('test_pipeline: judge failure still produces a variant with verdict=failed', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(
    factory,
    () => ctx,
    makeDeps({ judgeThrows: new Error('Anthropic 429 slow down') })
  );
  const r = await invoke({ testMessage: 'hi' });
  assert.ok(!r.isError, 'judge failure should NOT propagate — result is still emitted');
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.variants.length, 1);
  assert.equal(parsed.variants[0].verdict, 'failed');
  assert.match(parsed.variants[0].judgeReasoning, /Judge call failed/);
  assert.equal(parsed.aggregateVerdict, 'all_failed');
});

test('test_pipeline: runner failure returns structured error (not throw)', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(
    factory,
    () => ctx,
    makeDeps({ dryThrows: new Error('OpenAI rate limit 429') })
  );
  const r = await invoke({ testMessage: 'test' });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /test_pipeline failed/);
  assert.match(r.content[0].text, /rate limit/);
});

test('test_pipeline: user-initiated (no active ritual) does NOT mutate any history row', async () => {
  const ctx = makeCtx();
  // No openRitualWindow call → historyId is null.
  let updateCalls = 0;
  (ctx.prisma as any).buildArtifactHistory.update = async () => {
    updateCalls++;
    return {};
  };
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  const r = await invoke({ testMessage: 'what time is checkout?' });
  assert.ok(!r.isError);
  assert.equal(updateCalls, 0, 'no history row mutation outside a ritual');
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.sourceWriteHistoryId, null);
});

test('test_pipeline: ritual-linked call writes variants onto the triggering history row', async () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'hist-77');
  let captured: any = null;
  (ctx.prisma as any).buildArtifactHistory.findUnique = async () => ({
    metadata: { rationale: 'Added a late-checkout SOP.' },
  });
  (ctx.prisma as any).buildArtifactHistory.update = async ({ where, data }: any) => {
    captured = { where, data };
    return {};
  };
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  await invoke({ testMessages: ['Can I check out at 2pm?'] });
  assert.ok(captured, 'update must be called when in a ritual');
  assert.equal(captured.where.id, 'hist-77');
  const meta = captured.data.metadata as any;
  assert.ok(meta.testResult, 'metadata.testResult must be populated');
  assert.equal(meta.testResult.variants.length, 1);
  assert.equal(meta.testResult.aggregateVerdict, 'all_passed');
  assert.equal(meta.testResult.ritualVersion, VERIFICATION_RITUAL_VERSION);
  // Pre-existing metadata.rationale must survive the merge.
  assert.equal(meta.rationale, 'Added a late-checkout SOP.');
});

test('test_pipeline: no triggers at all → error before any runner call', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  const r = await invoke({});
  assert.ok(r.isError);
  assert.match(r.content[0].text, /1–3 distinct triggers|at least one trigger/i);
});

test('test_pipeline: second ritual (new write) resets the counter', async () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'hist-A');
  const { factory, invoke } = captureTool();
  buildTestPipelineTool(factory, () => ctx, makeDeps());
  // Use up ritual A's full budget (3 calls).
  await invoke({ testMessages: ['a', 'b', 'c'] });
  // A new write opens a fresh window — counter resets.
  openRitualWindow(ctx, 'hist-B');
  const r2 = await invoke({ testMessages: ['d', 'e'] });
  assert.ok(!r2.isError, 'fresh ritual must allow a new batch');
});
