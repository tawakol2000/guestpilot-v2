/**
 * Tests for openai/middleware.ts state + compliance gates.
 *
 * Run: npx tsx --test src/build-tune-agent/openai/__tests__/middleware.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-middleware';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateToolByCompliance,
  gateToolByState,
  recordReadBudget,
  type MiddlewareState,
} from '../middleware';
import { TUNING_AGENT_TOOL_NAMES } from '../../tools/names';

function makeState(overrides: Partial<MiddlewareState> = {}): MiddlewareState {
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'c1',
    turn: 1,
    innerState: 'scoping',
    lastUserMessage: '',
    readsThisTurn: 0,
    emitDataPart: () => {},
    ...overrides,
  } as MiddlewareState;
}

test('state-gate: scoping allows read tools', () => {
  const state = makeState({ innerState: 'scoping' });
  const result = gateToolByState(TUNING_AGENT_TOOL_NAMES.studio_get_artifact, state);
  assert.equal(result.ok, true);
});

test('state-gate: scoping DENIES studio_create_sop', () => {
  const state = makeState({ innerState: 'scoping' });
  const result = gateToolByState(TUNING_AGENT_TOOL_NAMES.studio_create_sop, state);
  assert.equal(result.ok, false);
  assert.ok(result.denyReason);
  assert.ok(/scoping/i.test(result.denyReason!));
});

test('state-gate: drafting allows studio_create_sop', () => {
  const state = makeState({ innerState: 'drafting' });
  const result = gateToolByState(TUNING_AGENT_TOOL_NAMES.studio_create_sop, state);
  assert.equal(result.ok, true);
});

test('state-gate: verifying allows only test_pipeline + reads', () => {
  const state = makeState({ innerState: 'verifying' });
  const reads = gateToolByState(TUNING_AGENT_TOOL_NAMES.studio_get_artifact, state);
  const test = gateToolByState(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline, state);
  const create = gateToolByState(TUNING_AGENT_TOOL_NAMES.studio_create_sop, state);
  assert.equal(reads.ok, true);
  assert.equal(test.ok, true);
  assert.equal(create.ok, false);
});

test('compliance-gate: studio_rollback requires explicit sanction phrase', () => {
  const noSanction = makeState({ lastUserMessage: 'looks good' });
  const withSanction = makeState({ lastUserMessage: 'go ahead and roll it back' });
  assert.equal(
    gateToolByCompliance(TUNING_AGENT_TOOL_NAMES.studio_rollback, {}, noSanction).ok,
    false,
  );
  assert.equal(
    gateToolByCompliance(TUNING_AGENT_TOOL_NAMES.studio_rollback, {}, withSanction).ok,
    true,
  );
});

test('compliance-gate: studio_suggestion(propose) passes through without sanction', () => {
  const state = makeState({ lastUserMessage: 'hmm' });
  const result = gateToolByCompliance(
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    { op: 'propose' },
    state,
  );
  assert.equal(result.ok, true);
});

test('compliance-gate: studio_suggestion(apply) requires sanction', () => {
  const state = makeState({ lastUserMessage: 'hmm' });
  const denied = gateToolByCompliance(
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    { op: 'apply' },
    state,
  );
  assert.equal(denied.ok, false);

  const sanctioned = makeState({ lastUserMessage: 'apply it now' });
  const allowed = gateToolByCompliance(
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    { op: 'apply' },
    sanctioned,
  );
  assert.equal(allowed.ok, true);
});

test('read-budget: scoping budget = 4, exceeding emits advisory', () => {
  const emitted: any[] = [];
  const state = makeState({
    innerState: 'scoping',
    emitDataPart: (part) => emitted.push(part),
  });
  for (let i = 0; i < 5; i++) {
    recordReadBudget(TUNING_AGENT_TOOL_NAMES.studio_get_artifact, state);
  }
  // Budget=4; 5th call should have emitted an advisory.
  assert.ok(emitted.length >= 1);
  assert.equal(emitted[0].type, 'data-advisory');
  assert.equal((emitted[0].data as any).kind, 'read_budget_exceeded');
});

test('read-budget: non-read tools do NOT increment', () => {
  const emitted: any[] = [];
  const state = makeState({
    innerState: 'verifying',
    emitDataPart: (part) => emitted.push(part),
  });
  // Verifying budget=1. Read once = under, then call non-read 10x = still ok.
  recordReadBudget(TUNING_AGENT_TOOL_NAMES.studio_get_artifact, state);
  for (let i = 0; i < 10; i++) {
    recordReadBudget(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline, state);
  }
  assert.equal(emitted.length, 0);
});
