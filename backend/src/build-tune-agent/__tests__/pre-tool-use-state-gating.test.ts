/**
 * Sprint 060-C — PreToolUse hook state-gating.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/pre-tool-use-state-gating.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-state-gating';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreToolUseHook } from '../hooks/pre-tool-use';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';
import { DEFAULT_SNAPSHOT, type InnerState } from '../state-machine';

function makeCtx(snapshot: any, opts: Partial<{ conversationId: string }> = {}) {
  const prisma = {
    tuningConversation: {
      findFirst: async () => ({ stateMachineSnapshot: snapshot }),
    },
    tuningSuggestion: {
      findFirst: async () => null,
    },
  } as any;
  return () => ({
    prisma,
    tenantId: 't1',
    conversationId: opts.conversationId ?? 'conv1',
    userId: null,
    readLastUserMessage: () => '',
    emitDataPart: () => undefined,
    compliance: { lastUserSanctionedApply: false, lastUserSanctionedRollback: false },
    turn: 1,
    toolCallStartTimes: new Map(),
  } as any);
}

function snapshotInState(state: InnerState) {
  return { ...DEFAULT_SNAPSHOT, inner_state: state };
}

async function callHook(ctxFn: any, toolName: string) {
  const hook = buildPreToolUseHook(ctxFn);
  return hook({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
  } as any);
}

test('scoping state: blocks studio_create_sop with descriptive deny + propose-transition hint', async () => {
  const ctx = makeCtx(snapshotInState('scoping'));
  const out: any = await callHook(ctx, TUNING_AGENT_TOOL_NAMES.studio_create_sop);
  assert.equal(out.continue, false);
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /studio_create_sop is blocked in scoping state/);
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /studio_propose_transition\(\{to: 'drafting'/);
});

test('scoping state: allows read tools', async () => {
  const ctx = makeCtx(snapshotInState('scoping'));
  const out: any = await callHook(ctx, TUNING_AGENT_TOOL_NAMES.studio_get_artifact);
  assert.equal(out.continue, true);
});

test('scoping state: allows studio_propose_transition + studio_test_pipeline + studio_memory', async () => {
  for (const t of [
    TUNING_AGENT_TOOL_NAMES.studio_propose_transition,
    TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
    TUNING_AGENT_TOOL_NAMES.studio_memory,
  ]) {
    const ctx = makeCtx(snapshotInState('scoping'));
    const out: any = await callHook(ctx, t);
    assert.equal(out.continue, true, `expected continue:true for ${t}`);
  }
});

test('drafting state: allows studio_create_sop + studio_create_faq + studio_plan_build_changes', async () => {
  for (const t of [
    TUNING_AGENT_TOOL_NAMES.studio_create_sop,
    TUNING_AGENT_TOOL_NAMES.studio_create_faq,
    TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes,
  ]) {
    const ctx = makeCtx(snapshotInState('drafting'));
    const out: any = await callHook(ctx, t);
    assert.equal(out.continue, true, `expected continue:true for ${t}`);
  }
});

test('drafting state: blocks studio_test_pipeline (verifying-only)', async () => {
  const ctx = makeCtx(snapshotInState('drafting'));
  const out: any = await callHook(ctx, TUNING_AGENT_TOOL_NAMES.studio_test_pipeline);
  assert.equal(out.continue, false);
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /blocked in drafting/);
  // test_pipeline lives in scoping AND verifying — the hint suggests scoping (first match).
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /to: 'scoping'/);
});

test('verifying state: blocks studio_create_sop (mutation tools off)', async () => {
  const ctx = makeCtx(snapshotInState('verifying'));
  const out: any = await callHook(ctx, TUNING_AGENT_TOOL_NAMES.studio_create_sop);
  assert.equal(out.continue, false);
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /blocked in verifying/);
});

test('verifying state: allows studio_test_pipeline', async () => {
  const ctx = makeCtx(snapshotInState('verifying'));
  const out: any = await callHook(ctx, TUNING_AGENT_TOOL_NAMES.studio_test_pipeline);
  assert.equal(out.continue, true);
});

test('non-MCP tool name passes through state gate (defensive)', async () => {
  const ctx = makeCtx(snapshotInState('scoping'));
  const out: any = await callHook(ctx, 'Read');
  // Not gated by state machine; the rest of the hook applies (it's not
  // a Studio mutation tool either, so it's a clean continue).
  assert.equal(out.continue, true);
});

test('no conversationId in ctx → state-gating skipped (test harness path)', async () => {
  const ctx = makeCtx(snapshotInState('scoping'), { conversationId: undefined });
  // Even though scoping would normally block create_sop, with no
  // conversation context we can't read the snapshot — fall through to
  // legacy behaviour. (BUILD-creator advisory may emit; that's fine.)
  const ctxFn = () => ({ ...(ctx() as any), conversationId: null });
  const out: any = await callHook(ctxFn, TUNING_AGENT_TOOL_NAMES.studio_create_sop);
  assert.equal(out.continue, true);
});
