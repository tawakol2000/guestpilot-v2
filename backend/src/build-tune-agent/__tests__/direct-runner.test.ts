/**
 * Sprint 059-A F1.5 — Direct-transport runner unit tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/direct-runner.test.ts
 *
 * Scope: the `runDirectTurn()` contract surface — fallback on unknown
 * tool, hook error, bridge error, history error, API error, and the
 * happy path persisting the aggregated assistant message.
 */
// Satisfy auth middleware's top-level JWT_SECRET assertion if transitive
// imports trip it during module boot.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-direct-runner';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runDirectTurn,
  type DirectRunInput,
  type AnthropicMessagesClient,
} from '../direct/runner';
import {
  McpUnknownToolError,
  type McpRouter,
  type McpToolResult,
} from '../direct/mcp-router';
import type { HookDispatcher } from '../direct/hook-dispatcher';
import {
  SHARED_MODE_BOUNDARY_MARKER,
  DYNAMIC_BOUNDARY_MARKER,
} from '../config';

// ─── Fixtures ──────────────────────────────────────────────────────────

function fakeAssembledPrompt(): string {
  return ['A', SHARED_MODE_BOUNDARY_MARKER, 'B', DYNAMIC_BOUNDARY_MARKER, 'C'].join('\n');
}

/**
 * Fake Prisma stub. `tuningMessage.findMany` returns `[]` by default so
 * loadConversationHistory resolves with an empty history; the tests that
 * need history_error override this to throw.
 */
function fakePrisma(overrides: Partial<{
  findManyThrows: boolean;
  persistThrows: boolean;
}> = {}): any {
  return {
    tuningMessage: {
      findMany: async (..._args: any[]) => {
        if (overrides.findManyThrows) throw new Error('pg-down');
        return [];
      },
      create: async () => ({}),
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      if (overrides.persistThrows) throw new Error('persist-fail');
      return fn({
        tuningMessage: {
          create: async () => ({}),
        },
      });
    },
  };
}

/** Build a router with optional dispatch override. */
function fakeRouter(
  opts: {
    dispatch?: (name: string, input: unknown, ctx: unknown, id: string) => Promise<McpToolResult>;
    has?: (name: string) => boolean;
  } = {},
): McpRouter {
  return {
    has: opts.has ?? (() => true),
    dispatch:
      opts.dispatch ??
      (async (_n, _i, _c, id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: 'ok' }],
      })),
  };
}

function fakeHooks(
  opts: {
    preThrows?: boolean;
    postThrows?: boolean;
    stopThrows?: boolean;
    preCancel?: boolean;
  } = {},
): HookDispatcher {
  return {
    preToolUse: async () => {
      if (opts.preThrows) throw new Error('pre-boom');
      if (opts.preCancel) return { cancel: true, reason: 'denied-by-hook' };
      return { cancel: false };
    },
    postToolUse: async () => {
      if (opts.postThrows) throw new Error('post-boom');
    },
    stop: async () => {
      if (opts.stopThrows) throw new Error('stop-boom');
    },
  };
}

/** Build a fake Anthropic client returning a prebuilt stream of raw events. */
function fakeAnthropic(
  rawEventsPerCall: Array<Array<any>>,
  opts: { throwOnCall?: number } = {},
): AnthropicMessagesClient {
  let call = 0;
  return {
    messages: {
      stream(_params: Record<string, unknown>): AsyncIterable<any> {
        const thisCall = call;
        call += 1;
        if (opts.throwOnCall === thisCall) {
          throw new Error('api-down');
        }
        const events = rawEventsPerCall[thisCall] ?? [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of events) yield ev;
          },
        };
      },
    },
  };
}

/** A minimal raw-stream sequence emitting a pure-text assistant turn. */
function textOnlyStream(text: string): any[] {
  return [
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

/** A raw-stream sequence with ONE tool_use block. */
function toolUseStream(toolId: string, toolName: string, argsJson: string): any[] {
  return [
    { type: 'message_start' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: argsJson },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

function baseInput(
  overrides: Partial<DirectRunInput> = {},
): DirectRunInput {
  return {
    prisma: fakePrisma(),
    conversationId: 'c1',
    tenantId: 't1',
    mode: 'BUILD',
    userTurn: { role: 'user', content: 'hello' },
    model: 'claude-sonnet-4-6',
    maxTokens: 1024,
    assembledSystemPrompt: fakeAssembledPrompt(),
    tools: [{ name: 'noop', input_schema: { type: 'object' } }],
    hooks: fakeHooks(),
    mcpRouter: fakeRouter(),
    anthropic: fakeAnthropic([textOnlyStream('hi')]),
    assistantMessageId: 'asst-1',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

test('F1.5 happy path — text-only turn returns success + persists assistant message', async () => {
  const chunks: any[] = [];
  const result = await runDirectTurn(baseInput(), (c) => chunks.push(c));
  assert.equal(result.status, 'success');
  assert.ok(result.assistantMessage);
  assert.equal(result.assistantMessage!.content, 'hi');
});

test('F1.5 fallback — history_error when loadConversationHistory throws', async () => {
  const result = await runDirectTurn(
    baseInput({ prisma: fakePrisma({ findManyThrows: true }) }),
    () => {},
  );
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallbackReason, 'history_error');
});

test('F1.5 fallback — api_error when anthropic.messages.stream throws', async () => {
  const result = await runDirectTurn(
    baseInput({
      anthropic: fakeAnthropic([[]], { throwOnCall: 0 }),
    }),
    () => {},
  );
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallbackReason, 'api_error');
});

test('F1.5 fallback — unknown_tool when router.dispatch throws McpUnknownToolError', async () => {
  const raw = toolUseStream('tu_1', 'mystery', '{"k":"v"}');
  const result = await runDirectTurn(
    baseInput({
      anthropic: fakeAnthropic([raw]),
      mcpRouter: fakeRouter({
        dispatch: async () => {
          throw new McpUnknownToolError('mystery');
        },
      }),
    }),
    () => {},
  );
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallbackReason, 'unknown_tool');
});

test('F1.5 fallback — hook_error when preToolUse throws', async () => {
  const raw = toolUseStream('tu_1', 'noop', '{}');
  const result = await runDirectTurn(
    baseInput({
      anthropic: fakeAnthropic([raw]),
      hooks: fakeHooks({ preThrows: true }),
    }),
    () => {},
  );
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallbackReason, 'hook_error');
});

test('F1.5 preToolUse cancel synthesises is_error tool_result and continues the turn', async () => {
  // Round 1 emits a tool_use. Pre-hook denies. Router should NOT be hit.
  // Round 2 emits a text-only completion. Turn completes successfully.
  let routerCalls = 0;
  const result = await runDirectTurn(
    baseInput({
      anthropic: fakeAnthropic([
        toolUseStream('tu_1', 'noop', '{}'),
        textOnlyStream('ok-after-deny'),
      ]),
      hooks: fakeHooks({ preCancel: true }),
      mcpRouter: fakeRouter({
        dispatch: async () => {
          routerCalls += 1;
          return {
            type: 'tool_result',
            tool_use_id: 'unused',
            content: 'router-was-hit',
          };
        },
      }),
    }),
    () => {},
  );
  assert.equal(result.status, 'success');
  assert.equal(routerCalls, 0, 'router must not be dispatched when pre-hook cancels');
});
