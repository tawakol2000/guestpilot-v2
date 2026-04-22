/**
 * Sprint 059-A F1.2 — Hook dispatcher unit tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/hook-dispatcher.test.ts
 *
 * Scope: contract of `buildHookDispatcher()` — pre/post/stop timing, cancel
 * semantics, idempotency, error propagation. Uses lightweight fake
 * HookCallbacks that mimic the SDK shape; DB and network are out of scope.
 */
// Satisfy the auth middleware's top-level JWT_SECRET assertion when
// transitive imports boot.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-hook-dispatcher';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHookDispatcher } from '../direct/hook-dispatcher';
import type { HookContext } from '../hooks/shared';
import type { McpToolResult } from '../direct/mcp-router';

// ─── Fixtures ──────────────────────────────────────────────────────────

/** Minimal HookContext stub — the dispatcher itself doesn't dereference it. */
function fakeHookContext(): HookContext {
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'c1',
    userId: null,
    readLastUserMessage: () => '',
    compliance: {
      lastUserSanctionedApply: false,
      lastUserSanctionedRollback: false,
    },
    turn: 1,
    toolCallStartTimes: new Map<string, number>(),
  };
}

/**
 * Build a fake hooks object mirroring `buildTuningAgentHooks()`'s shape:
 *   { PreToolUse: [{ hooks: [...cbs] }], PostToolUse: [...], Stop: [...] }
 * Passing `undefined` for an event omits it (so dispatcher treats it as empty).
 */
function fakeHooks(config: {
  pre?: Array<(input: any) => any>;
  post?: Array<(input: any) => any>;
  stop?: Array<(input: any) => any>;
}): any {
  const wrap = (cb: (input: any) => any) =>
    async (input: any, _id: any, _opts: any) => cb(input);
  const out: any = {};
  if (config.pre)
    out.PreToolUse = [{ hooks: config.pre.map(wrap) }];
  if (config.post)
    out.PostToolUse = [{ hooks: config.post.map(wrap) }];
  if (config.stop)
    out.Stop = [{ hooks: config.stop.map(wrap) }];
  return out;
}

const SAMPLE_RESULT: McpToolResult = {
  type: 'tool_result',
  tool_use_id: 'tu_x',
  content: [{ type: 'text', text: 'ok' }],
};

// ─── Test 1 — preToolUse cancel returns {cancel:true, reason} ──────────

test('F1.2 preToolUse cancel returns {cancel: true, reason: <str>}', async () => {
  const hooks = fakeHooks({
    pre: [
      () => ({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'compliance: not sanctioned',
        },
      }),
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  const outcome = await d.preToolUse('foo', { x: 1 }, 'tu_1');
  assert.equal(outcome.cancel, true);
  assert.equal(outcome.reason, 'compliance: not sanctioned');
});

test('F1.2 preToolUse continue passes through (cancel:false)', async () => {
  const hooks = fakeHooks({ pre: [() => ({ continue: true })] });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  const outcome = await d.preToolUse('foo', {}, 'tu_1');
  assert.equal(outcome.cancel, false);
});

test('F1.2 preToolUse with no hooks returns cancel:false', async () => {
  const d = buildHookDispatcher(fakeHooks({}), fakeHookContext());
  const outcome = await d.preToolUse('foo', {}, 'tu_1');
  assert.equal(outcome.cancel, false);
});

// ─── Test 2 — postToolUse is awaited ───────────────────────────────────

test('F1.2 postToolUse awaits the underlying hook (resolves no sooner than the slow hook)', async () => {
  const SLOW_MS = 50;
  const hooks = fakeHooks({
    post: [
      async () => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        return { continue: true };
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  const t0 = Date.now();
  await d.postToolUse('foo', {}, SAMPLE_RESULT, 'tu_x');
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed >= SLOW_MS - 2, // small timer jitter tolerance
    `expected elapsed >= ${SLOW_MS}, got ${elapsed}`,
  );
});

// ─── Test 3 — stop is idempotent ───────────────────────────────────────

test('F1.2 stop is idempotent — underlying hook fires exactly once across two stop() calls', async () => {
  let counter = 0;
  const hooks = fakeHooks({
    stop: [
      () => {
        counter += 1;
        return { continue: true };
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  await d.stop();
  await d.stop();
  assert.equal(counter, 1, 'stop must fire the underlying hook exactly once');
});

// ─── Test 4 — hook throw propagates ────────────────────────────────────

test('F1.2 preToolUse throw propagates (assert.rejects)', async () => {
  const hooks = fakeHooks({
    pre: [
      () => {
        throw new Error('hook-boom');
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  await assert.rejects(
    () => d.preToolUse('foo', {}, 'tu_1'),
    /hook-boom/,
    'dispatcher must propagate hook throws — the runner decides to fall back',
  );
});

test('F1.2 postToolUse throw propagates', async () => {
  const hooks = fakeHooks({
    post: [
      () => {
        throw new Error('post-boom');
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  await assert.rejects(
    () => d.postToolUse('foo', {}, SAMPLE_RESULT, 'tu_x'),
    /post-boom/,
  );
});

test('F1.2 stop throw propagates (and still flips the idempotency flag)', async () => {
  let calls = 0;
  const hooks = fakeHooks({
    stop: [
      () => {
        calls += 1;
        throw new Error('stop-boom');
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  await assert.rejects(() => d.stop(), /stop-boom/);
  // Second stop() must NOT re-fire the hook — idempotency wins even when
  // the first attempt threw. Prevents double-firing on retry paths.
  await d.stop();
  assert.equal(calls, 1);
});

// ─── Bonus tests — ordering and short-circuit semantics ────────────────

test('F1.2 preToolUse fires multiple hooks in registration order, short-circuits on first cancel', async () => {
  const seen: string[] = [];
  const hooks = fakeHooks({
    pre: [
      () => {
        seen.push('a');
        return { continue: true };
      },
      () => {
        seen.push('b');
        return {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'b denied',
          },
        };
      },
      () => {
        seen.push('c');
        return { continue: true };
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  const outcome = await d.preToolUse('foo', {}, 'tu_1');
  assert.deepEqual(seen, ['a', 'b'], 'c must NOT run after b denies');
  assert.equal(outcome.cancel, true);
  assert.equal(outcome.reason, 'b denied');
});

test('F1.2 postToolUse fires all hooks in order (no short-circuit)', async () => {
  const seen: string[] = [];
  const hooks = fakeHooks({
    post: [
      () => {
        seen.push('a');
        return { continue: true };
      },
      () => {
        seen.push('b');
        return { continue: true };
      },
    ],
  });
  const d = buildHookDispatcher(hooks, fakeHookContext());
  await d.postToolUse('foo', {}, SAMPLE_RESULT, 'tu_x');
  assert.deepEqual(seen, ['a', 'b']);
});
