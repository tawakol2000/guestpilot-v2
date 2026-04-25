/**
 * Sprint 060-C — system-prompt renderers for the state machine.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/state-machine-prompt.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-prompt';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSystemPrompt,
  buildDynamicSuffix,
  buildSharedPrefix,
  type SystemPromptContext,
} from '../system-prompt';
import { DEFAULT_SNAPSHOT } from '../state-machine';

function ctxFor(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    tenantId: 't',
    conversationId: 'c',
    anchorMessageId: null,
    selectedSuggestionId: null,
    memorySnapshot: [],
    pending: { total: 0, topThree: [], countsByCategory: {} },
    mode: 'BUILD',
    tenantState: null,
    interviewProgress: null,
    stateMachineSnapshot: { ...DEFAULT_SNAPSHOT },
    ...overrides,
  };
}

test('Region A includes <state_machine> block (lives in shared prefix)', () => {
  const prefix = buildSharedPrefix();
  assert.ok(prefix.includes('<state_machine>'));
  assert.ok(prefix.includes('</state_machine>'));
  assert.ok(prefix.includes('scoping'));
  assert.ok(prefix.includes('drafting'));
  assert.ok(prefix.includes('verifying'));
  assert.ok(prefix.includes('studio_propose_transition'));
  // The <state_machine> sits between TOOLS_DOC and CONTEXT_HANDLING.
  const toolsIdx = prefix.indexOf('<tools>');
  const stateIdx = prefix.indexOf('<state_machine>');
  const ctxIdx = prefix.indexOf('<context_handling>');
  assert.ok(toolsIdx >= 0 && stateIdx > toolsIdx && ctxIdx > stateIdx);
});

test('<verification_ritual> block is fully removed from BUILD addendum', () => {
  const ctx = ctxFor();
  const assembled = assembleSystemPrompt(ctx);
  assert.equal(assembled.includes('<verification_ritual>'), false);
  assert.equal(assembled.includes('</verification_ritual>'), false);
});

test('Region C renders <current_state> first', () => {
  const ctx = ctxFor({ stateMachineSnapshot: { ...DEFAULT_SNAPSHOT, inner_state: 'drafting' } });
  const dynamic = buildDynamicSuffix(ctx);
  assert.match(dynamic, /^<current_state>drafting<\/current_state>/);
});

test('Region C falls back to scoping when snapshot omitted (legacy callers)', () => {
  const ctx = ctxFor({ stateMachineSnapshot: undefined });
  const dynamic = buildDynamicSuffix(ctx);
  assert.match(dynamic, /^<current_state>scoping<\/current_state>/);
});

test('<state_transition> renders only when transition_ack_pending=true', () => {
  const withAck = ctxFor({
    stateMachineSnapshot: {
      ...DEFAULT_SNAPSHOT,
      inner_state: 'drafting',
      transition_ack_pending: true,
      last_transition_at: '2026-04-25T12:00:00.000Z',
      last_transition_reason: 'gathered enough info',
    },
  });
  const withoutAck = ctxFor({
    stateMachineSnapshot: {
      ...DEFAULT_SNAPSHOT,
      inner_state: 'drafting',
      transition_ack_pending: false,
    },
  });
  assert.match(buildDynamicSuffix(withAck), /<state_transition>/);
  assert.match(buildDynamicSuffix(withAck), /State transitioned to drafting/);
  assert.match(buildDynamicSuffix(withAck), /gathered enough info/);
  assert.equal(buildDynamicSuffix(withoutAck).includes('<state_transition>'), false);
});

test('<current_state> reflects each of the three valid inner states', () => {
  for (const state of ['scoping', 'drafting', 'verifying'] as const) {
    const ctx = ctxFor({ stateMachineSnapshot: { ...DEFAULT_SNAPSHOT, inner_state: state } });
    assert.match(buildDynamicSuffix(ctx), new RegExp(`<current_state>${state}</current_state>`));
  }
});

test('Region C ordering: current_state → optional state_transition → tenant_state', () => {
  const ctx = ctxFor({
    stateMachineSnapshot: {
      ...DEFAULT_SNAPSHOT,
      inner_state: 'drafting',
      transition_ack_pending: true,
      last_transition_at: '2026-04-25T12:00:00.000Z',
      last_transition_reason: 'gathered enough info',
    },
    tenantState: {
      posture: 'GREENFIELD',
      systemPromptStatus: 'EMPTY',
      systemPromptEditCount: 0,
      sopsDefined: 0,
      sopsDefaulted: 0,
      faqsGlobal: 0,
      faqsPropertyScoped: 0,
      customToolsDefined: 0,
      propertiesImported: 0,
      lastBuildSessionAt: null,
    },
  });
  const dynamic = buildDynamicSuffix(ctx);
  const cur = dynamic.indexOf('<current_state>');
  const trans = dynamic.indexOf('<state_transition>');
  const tenant = dynamic.indexOf('<tenant_state>');
  assert.ok(cur === 0);
  assert.ok(trans > cur && trans < tenant);
});
