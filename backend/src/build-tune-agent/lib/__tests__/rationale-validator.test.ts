/**
 * Sprint 054-A F1 — rationale validator unit tests.
 *
 * Run: JWT_SECRET=test OPENAI_API_KEY=test-fake \
 *        npx tsx --test src/build-tune-agent/lib/__tests__/rationale-validator.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RATIONALE_MAX_CHARS,
  RATIONALE_MIN_CHARS,
  RATIONALE_PROMPT_VERSION,
  validateRationale,
} from '../rationale-validator';

test('validateRationale: version stamp is "054-a.1"', () => {
  assert.equal(RATIONALE_PROMPT_VERSION, '054-a.1');
});

test('validateRationale: rejects non-strings with a clear error', () => {
  for (const bad of [undefined, null, 42, true, {}, []]) {
    const r = validateRationale(bad as any);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    if (!r.ok) {
      assert.match(r.error, /rationale is required/);
    }
  }
});

test('validateRationale: rejects whitespace-only strings', () => {
  for (const bad of ['', '   ', '\n\n\t']) {
    const r = validateRationale(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /empty|whitespace/i);
  }
});

test('validateRationale: rejects strings shorter than the minimum', () => {
  const shortStr = 'too short';
  assert.ok(shortStr.length < RATIONALE_MIN_CHARS);
  const r = validateRationale(shortStr);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, new RegExp(`min ${RATIONALE_MIN_CHARS}`));
  }
});

test('validateRationale: rejects strings longer than the maximum', () => {
  const tooLong = 'x'.repeat(RATIONALE_MAX_CHARS + 1);
  const r = validateRationale(tooLong);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, new RegExp(`max ${RATIONALE_MAX_CHARS}`));
  }
});

test('validateRationale: rejects bare lazy placeholders (case-insensitive)', () => {
  for (const bad of [
    'updating',
    'UPDATING',
    'update',
    'edit',
    'change',
    'changes',
    'fix',
    'tweak',
    'n/a',
    'none',
    'test',
    '.',
    '-',
  ]) {
    // Short placeholders may fail length check first — pad with spaces to
    // isolate the blocklist branch, which uses .trim() before comparison.
    const padded = bad.length >= RATIONALE_MIN_CHARS ? bad : `${bad}${' '.repeat(RATIONALE_MIN_CHARS - bad.length + 1)}`;
    const r = validateRationale(padded);
    assert.equal(r.ok, false, `bare placeholder "${bad}" must be rejected`);
    if (!r.ok) {
      // Error message mentions "lazy placeholder" OR "too short" depending on
      // whether the blocklist branch or the length branch caught it.
      assert.match(r.error, /lazy placeholder|too short/i);
    }
  }
});

test('validateRationale: blocklist entries within a longer sentence pass (prompt-engineering dial)', () => {
  // Per spec §5 watch-out: the blocklist catches *bare* words only. A real
  // sentence that starts with one of them still passes. This is intentional.
  const r = validateRationale(
    'updating the late-checkout SOP because the manager mentioned a 2pm guest-cap policy.'
  );
  assert.equal(r.ok, true);
});

test('validateRationale: accepts and trims a valid rationale', () => {
  const raw =
    '  Manager mentioned guests keep asking about parking on arrival; adding a global FAQ.  ';
  const r = validateRationale(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.rationale, raw.trim());
  }
});
