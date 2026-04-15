/**
 * Sprint 03 — DiffViewer logic test (no DOM).
 *
 * The diff algorithm is internal to diff-viewer.tsx (not exported) so we
 * test it via a small re-export shim. This file exists primarily to keep
 * the diff algorithm honest: the same input must produce a stable token
 * sequence going forward.
 *
 * Run via:
 *   npx tsx --test components/tuning/__tests__/diff-viewer.logic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffTokensForTesting } from './_diff-helpers';

test('identical strings produce only equal tokens', () => {
  const out = diffTokensForTesting('hello world', 'hello world');
  assert.ok(out.every((t) => t.type === 'equal'));
});

test('insertion of a single word produces an add token', () => {
  const out = diffTokensForTesting('check in is at noon', 'check in is at 3pm noon');
  assert.ok(out.some((t) => t.type === 'add' && t.text === '3pm'));
});

test('deletion of a word produces a del token', () => {
  const out = diffTokensForTesting('check in is at 3pm noon', 'check in is at noon');
  assert.ok(out.some((t) => t.type === 'del' && t.text === '3pm'));
});

test('full rewrite emits both adds and dels', () => {
  const out = diffTokensForTesting('hello there', 'goodbye now');
  const adds = out.filter((t) => t.type === 'add').length;
  const dels = out.filter((t) => t.type === 'del').length;
  assert.ok(adds > 0);
  assert.ok(dels > 0);
});

test('empty before is treated as full insertion', () => {
  const out = diffTokensForTesting('', 'hello world');
  assert.ok(out.every((t) => t.type === 'add' || /^\s*$/.test(t.text)));
});
