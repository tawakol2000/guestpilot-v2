/**
 * Regression tests for `isSlotValueFilled` — the helper behind
 * `getInterviewProgressSummary`'s per-slot fill detection.
 *
 * Pre 2026-04-22: a non-string slot value was JSON.stringify'd and then
 * scanned for the DEFAULT_MARKER sentinel. Any JSON-encoded structure
 * whose text representation happened to contain the marker (e.g. an
 * operator deliberately storing the sentinel as quoted documentation in
 * an object) was treated as defaulted and blocked interview graduation.
 *
 * Post-fix: DEFAULT_MARKER applies ONLY when the slot value is a string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSlotValueFilled } from '../tenant-state.service';

const MARKER = '<!-- DEFAULT: change me -->';

test('null → not filled', () => {
  assert.equal(isSlotValueFilled(null), false);
});

test('undefined → not filled', () => {
  assert.equal(isSlotValueFilled(undefined), false);
});

test('empty string → not filled', () => {
  assert.equal(isSlotValueFilled(''), false);
  assert.equal(isSlotValueFilled('   \n\t '), false);
});

test('plain string value → filled', () => {
  assert.equal(isSlotValueFilled('1pm on weekdays'), true);
});

test('string containing DEFAULT_MARKER → not filled', () => {
  assert.equal(isSlotValueFilled(MARKER), false);
  assert.equal(
    isSlotValueFilled(`Check-in is always at 3pm. ${MARKER}`),
    false,
    'marker anywhere in string blocks fill detection',
  );
});

// ─── Bugfix regression: non-string slot values ─────────────────────────

test('object containing DEFAULT_MARKER text is STILL filled (regression)', () => {
  // Before the fix this returned false because JSON.stringify's output
  // contained the marker. The marker is a text-prompt convention; it
  // has no meaning inside structured JSON.
  const value = { note: `Check policy: ${MARKER}` };
  assert.equal(
    isSlotValueFilled(value),
    true,
    'structured JSON should not be gated by the text-marker sentinel',
  );
});

test('array containing DEFAULT_MARKER strings is STILL filled', () => {
  const value = [`todo 1 ${MARKER}`, 'done 2'];
  assert.equal(isSlotValueFilled(value), true);
});

test('number value → filled', () => {
  assert.equal(isSlotValueFilled(42), true);
  assert.equal(isSlotValueFilled(0), true, '0 is a valid answer');
});

test('boolean value → filled (including false)', () => {
  assert.equal(isSlotValueFilled(true), true);
  assert.equal(isSlotValueFilled(false), true, 'false is a valid answer');
});

test('trivially-empty JSON forms → not filled', () => {
  assert.equal(isSlotValueFilled({}), false, 'empty object is a placeholder');
  assert.equal(isSlotValueFilled([]), false, 'empty array is a placeholder');
});

test('nested object with real data → filled', () => {
  const value = { policy: { opens: '10:00', closes: '22:00' } };
  assert.equal(isSlotValueFilled(value), true);
});

test('non-serialisable value (BigInt) → filled (best-effort)', () => {
  // The helper's try/catch defaults to "filled" because the operator
  // clearly wrote something; we just can't reason about its text.
  // BigInt throws on JSON.stringify.
  const value = BigInt(123);
  assert.equal(isSlotValueFilled(value), true);
});
