/**
 * Unit tests for the sprint-02 preprocessing helpers.
 *
 * Uses node's built-in `node:test` runner so this repo does not gain a new
 * dev dep. Invoke with:
 *
 *   npx tsx --test src/services/tuning/__tests__/diff.service.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMyersDiff,
  semanticSimilarity,
  classifyEditMagnitude,
} from '../diff.service';

test('semanticSimilarity: identical strings → 1.0', () => {
  assert.equal(semanticSimilarity('hello world', 'hello world'), 1);
});

test('semanticSimilarity: disjoint strings → <= 0.3', () => {
  const s = semanticSimilarity(
    'the cat sat on the mat quietly',
    'pineapple upside down cake recipe with lemon zest'
  );
  assert.ok(s <= 0.3, `expected ≤ 0.3 but got ${s}`);
});

test('semanticSimilarity: punctuation / case insensitive', () => {
  const s = semanticSimilarity('Hello WORLD.', 'hello world');
  assert.ok(s >= 0.5, `expected ≥ 0.5 but got ${s}`);
});

test('semanticSimilarity: empty vs non-empty → 0', () => {
  assert.equal(semanticSimilarity('', 'something'), 0);
  assert.equal(semanticSimilarity('', ''), 1);
});

test('classifyEditMagnitude: identical → MINOR', () => {
  const original = 'Hello, check-in is at 3pm. Please let me know if you need anything.';
  assert.equal(classifyEditMagnitude(original, original), 'MINOR');
});

test('classifyEditMagnitude: tiny typo edit → MINOR', () => {
  const original = 'Hello, check-in is at 3pm.';
  const final = 'Hello, check in is at 3pm.';
  assert.equal(classifyEditMagnitude(original, final), 'MINOR');
});

test('classifyEditMagnitude: wholesale rewrite → WHOLESALE', () => {
  const original = 'Hello, check-in is at 3pm.';
  const final = 'Hi there — welcome! Our apartments open at 15:00 local time. Please ring the bell.';
  assert.equal(classifyEditMagnitude(original, final), 'WHOLESALE');
});

test('classifyEditMagnitude: totally unrelated text → WHOLESALE', () => {
  const original = 'the cat sat on the mat quietly';
  const final = 'pineapple upside down cake recipe with lemon zest';
  assert.equal(classifyEditMagnitude(original, final), 'WHOLESALE');
});

test('computeMyersDiff: inserts + deletes + unified populated', () => {
  const original = 'Hello, check-in is at 3pm.';
  const final = 'Hello, check-in is at 4pm today.';
  const diff = computeMyersDiff(original, final);
  assert.ok(diff.unified.includes('---'), 'unified diff should contain patch header');
  assert.ok(diff.insertions.join('').toLowerCase().includes('4pm'));
  assert.ok(diff.deletions.join('').toLowerCase().includes('3pm'));
});
