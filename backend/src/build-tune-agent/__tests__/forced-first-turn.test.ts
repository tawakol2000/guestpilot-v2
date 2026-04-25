/**
 * Forced first-turn grounding — unit tests (sprint 046 Session A).
 *
 * Run: npx tsx --test src/build-tune-agent/__tests__/forced-first-turn.test.ts
 *
 * Verifies:
 *   - happy path emits data-state-snapshot + pushes get_current_state
 *     into toolCallsInvoked + writes a BuildToolCallLog row
 *   - payload carries the expected summary fields (sopCount, faqCounts, etc.)
 *   - failure path does NOT throw, does NOT push to toolCallsInvoked, and
 *     still writes a log row with success=false
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runForcedFirstTurnCall } from '../forced-first-turn';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';

function makePrismaStub(opts: {
  summary?: {
    sopCount: number;
    faqGlobal: number;
    faqPerProperty: number;
    customToolCount: number;
    propertyCount: number;
  };
  throwOnSummary?: boolean;
}) {
  const buildToolCallLogRows: Array<{
    tenantId: string;
    tool: string;
    success: boolean;
    errorMessage: string | null;
  }> = [];
  const prisma: any = {
    sopDefinition: {
      count: async () =>
        opts.throwOnSummary ? Promise.reject(new Error('boom')) : opts.summary?.sopCount ?? 0,
    },
    faqEntry: {
      count: async ({ where }: any) =>
        where.scope === 'GLOBAL'
          ? opts.summary?.faqGlobal ?? 0
          : opts.summary?.faqPerProperty ?? 0,
    },
    toolDefinition: {
      count: async () => opts.summary?.customToolCount ?? 0,
    },
    property: {
      count: async () => opts.summary?.propertyCount ?? 0,
    },
    buildTransaction: {
      findFirst: async () => null,
    },
    buildToolCallLog: {
      create: async ({ data }: any) => {
        buildToolCallLogRows.push({
          tenantId: data.tenantId,
          tool: data.tool,
          success: data.success,
          errorMessage: data.errorMessage ?? null,
        });
        return { id: 'log_' + buildToolCallLogRows.length };
      },
    },
  };
  return { prisma, buildToolCallLogRows };
}

function makeEmitCapture() {
  const calls: Array<{ type: string; id?: string; data: unknown }> = [];
  return {
    emit: (part: { type: string; id?: string; data: unknown }) => {
      calls.push({ type: part.type, id: part.id, data: part.data });
    },
    calls,
  };
}

// Wait for any queued fire-and-forget `void logToolCall(...)` to run.
// The service catches its own errors, so awaiting a single microtask
// tick is enough for the insert promise to resolve/reject.
function flushMicrotasks(count = 5): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    function tick() {
      if (n >= count) return resolve();
      n += 1;
      setImmediate(tick);
    }
    tick();
  });
}

test('forced first-turn happy path: emits snapshot, pushes tool name, logs row', async () => {
  const { prisma, buildToolCallLogRows } = makePrismaStub({
    summary: {
      sopCount: 23,
      faqGlobal: 74,
      faqPerProperty: 0,
      customToolCount: 2,
      propertyCount: 20,
    },
  });
  const emit = makeEmitCapture();
  const toolCallsInvoked: string[] = [];

  await runForcedFirstTurnCall({
    prisma,
    tenantId: 't1',
    conversationId: 'c1',
    assistantMessageId: 'a1',
    turn: 1,
    emitDataPart: emit.emit,
    toolCallsInvoked,
  });

  await flushMicrotasks();

  assert.equal(emit.calls.length, 1);
  assert.equal(emit.calls[0].type, 'data-state-snapshot');
  assert.equal(emit.calls[0].id, 'state-snapshot:a1');
  const snapshot = emit.calls[0].data as any;
  assert.equal(snapshot.scope, 'summary');
  assert.equal(snapshot.summary.sopCount, 23);
  assert.equal(snapshot.summary.faqCounts.global, 74);

  assert.equal(toolCallsInvoked.length, 1);
  assert.equal(toolCallsInvoked[0], TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index);

  assert.equal(buildToolCallLogRows.length, 1);
  assert.equal(buildToolCallLogRows[0].tenantId, 't1');
  assert.equal(buildToolCallLogRows[0].tool, TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index);
  assert.equal(buildToolCallLogRows[0].success, true);
});

test('forced first-turn failure path: swallows error, logs success=false, no toolCallsInvoked push', async () => {
  const { prisma, buildToolCallLogRows } = makePrismaStub({ throwOnSummary: true });
  const emit = makeEmitCapture();
  const toolCallsInvoked: string[] = [];

  // Must not throw.
  await runForcedFirstTurnCall({
    prisma,
    tenantId: 't1',
    conversationId: 'c1',
    assistantMessageId: 'a1',
    turn: 1,
    emitDataPart: emit.emit,
    toolCallsInvoked,
  });

  await flushMicrotasks();

  assert.equal(emit.calls.length, 0, 'no snapshot emitted on failure');
  assert.equal(toolCallsInvoked.length, 0, 'no tool-invocation recorded on failure');
  assert.equal(buildToolCallLogRows.length, 1);
  assert.equal(buildToolCallLogRows[0].success, false);
  assert.ok(buildToolCallLogRows[0].errorMessage?.includes('boom'));
});
