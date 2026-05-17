/**
 * Sprint 060-C — pure turn-end snapshot computation.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/state-machine-turn-end.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-turn-end';

import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceSnapshot, computeTurnEndSnapshot, DEFAULT_SNAPSHOT } from '../state-machine';

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

// 2026-05-17 regression: studio_propose_transition writes pending_transition
// mid-turn. If the turn started with transition_ack_pending=true (post a
// prior confirmation), the ack-clear branch used to spread from
// startSnapshot and silently overwrite the new pending → the freshly
// emitted card's Confirm button hit NO_PENDING_TRANSITION 409.
test('ack-pending turn + mid-turn propose_transition → preserves new pending', () => {
  const start = {
    ...DEFAULT_SNAPSHOT,
    inner_state: 'drafting' as const,
    transition_ack_pending: true,
    pending_transition: null,
  };
  const current = {
    ...start,
    pending_transition: {
      to: 'verifying' as const,
      because: 'rerun a tighter phrasing-only test against the live screening prompt',
      proposed_at: '2026-05-17T10:00:00.000Z',
      expires_at: '2026-05-18T10:00:00.000Z',
      token: 'abc.def.ghi',
    },
  };
  const next = computeTurnEndSnapshot({
    startSnapshot: start,
    currentSnapshot: current,
    testPipelineSucceeded: false,
  });
  assert.ok(next);
  assert.equal(next!.transition_ack_pending, false);
  assert.ok(next!.pending_transition, 'mid-turn pending_transition must survive');
  assert.equal(next!.pending_transition!.to, 'verifying');
  assert.equal(next!.pending_transition!.token, 'abc.def.ghi');
});

test('verifying auto-exit always clears pending (even if one snuck in mid-turn)', () => {
  // Defensive: verifying state forbids propose_transition at the tool
  // layer, but if some race ever puts a pending in there, auto-exit
  // semantics require clearing it — the agent's next turn starts fresh
  // in drafting with no stale proposal hanging around.
  const start = { ...DEFAULT_SNAPSHOT, inner_state: 'verifying' as const };
  const current = {
    ...start,
    pending_transition: {
      to: 'scoping' as const,
      because: 'spurious mid-turn pending that should be cleared by auto-exit',
      proposed_at: '2026-05-17T10:00:00.000Z',
      expires_at: '2026-05-18T10:00:00.000Z',
      token: 'spurious',
    },
  };
  const next = computeTurnEndSnapshot({
    startSnapshot: start,
    currentSnapshot: current,
    testPipelineSucceeded: true,
  });
  assert.ok(next);
  assert.equal(next!.inner_state, 'drafting');
  assert.equal(next!.pending_transition, null);
});
