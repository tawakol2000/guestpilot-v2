/**
 * Feature 047 PR 4 — read-budget warning hook unit tests.
 *
 * Run:  JWT_SECRET=test npx tsx --test src/build-tune-agent/hooks/__tests__/read-budget-warn.test.ts
 *
 * Tests the counter logic + advisory emission. The PreToolUse → snapshot
 * lookup integration is exercised by sdk-runner integration tests; these
 * tests target the pure counter behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetReadBudgetForTurn,
  getReadBudgetCount,
  READ_BUDGET_BY_STATE,
} from '../read-budget-warn';

test('read-budget: per-state caps match the spec (scoping=4, drafting=2, verifying=1)', () => {
  assert.equal(READ_BUDGET_BY_STATE.scoping, 4);
  assert.equal(READ_BUDGET_BY_STATE.drafting, 2);
  assert.equal(READ_BUDGET_BY_STATE.verifying, 1);
});

test('read-budget: counter resets per turn', () => {
  resetReadBudgetForTurn('conv-1', 1);
  assert.equal(getReadBudgetCount('conv-1'), 0);
  resetReadBudgetForTurn('conv-1', 2);
  assert.equal(getReadBudgetCount('conv-1'), 0);
});

test('read-budget: separate conversations have independent counters', () => {
  resetReadBudgetForTurn('conv-a', 1);
  resetReadBudgetForTurn('conv-b', 1);
  assert.equal(getReadBudgetCount('conv-a'), 0);
  assert.equal(getReadBudgetCount('conv-b'), 0);
});
