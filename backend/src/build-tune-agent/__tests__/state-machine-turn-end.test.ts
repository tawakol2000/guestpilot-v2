/**
 * Sprint 060-C — pure turn-end snapshot computation.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/state-machine-turn-end.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-turn-end';

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTurnEndSnapshot, DEFAULT_SNAPSHOT } from '../state-machine';

test('verifying + test_pipeline ran → auto-exit to drafting', () => {
  const start = { ...DEFAULT_SNAPSHOT, inner_state: 'verifying' as const };
  const next = computeTurnEndSnapshot({ startSnapshot: start, testPipelineSucceeded: true });
  assert.ok(next);
  assert.equal(next!.inner_state, 'drafting');
  assert.equal(next!.transition_ack_pending, true);
  assert.match(next!.last_transition_reason ?? '', /verifying auto-exit/);
});

test('verifying without test_pipeline → no transition', () => {
  const start = { ...DEFAULT_SNAPSHOT, inner_state: 'verifying' as const };
  const next = computeTurnEndSnapshot({ startSnapshot: start, testPipelineSucceeded: false });
  assert.equal(next, null);
});

test('non-verifying with ack pending → just clears the flag', () => {
  const start = { ...DEFAULT_SNAPSHOT, inner_state: 'drafting' as const, transition_ack_pending: true };
  const next = computeTurnEndSnapshot({ startSnapshot: start, testPipelineSucceeded: false });
  assert.ok(next);
  assert.equal(next!.transition_ack_pending, false);
  assert.equal(next!.inner_state, 'drafting');
});

test('non-verifying without ack pending → no transition', () => {
  const start = { ...DEFAULT_SNAPSHOT, inner_state: 'scoping' as const };
  const next = computeTurnEndSnapshot({ startSnapshot: start, testPipelineSucceeded: false });
  assert.equal(next, null);
});

test('verifying + test ran AND prior ack pending → auto-exit wins (single combined branch)', () => {
  const start = { ...DEFAULT_SNAPSHOT, inner_state: 'verifying' as const, transition_ack_pending: true };
  const next = computeTurnEndSnapshot({ startSnapshot: start, testPipelineSucceeded: true });
  assert.ok(next);
  assert.equal(next!.inner_state, 'drafting');
  // Fresh ack stamps the auto-exit reason; the prior ack is implicitly
  // "consumed" because the prompt already rendered <state_transition>
  // for it on this turn, and the runtime persists the auto-exit ack
  // for the NEXT turn.
  assert.equal(next!.transition_ack_pending, true);
  assert.match(next!.last_transition_reason ?? '', /verifying auto-exit/);
});
