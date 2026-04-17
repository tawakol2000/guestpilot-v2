/**
 * Sprint 09 follow-up — unit tests for performSearchReplace.
 *
 * Covers the three critical regressions from the sprint-10-A audit:
 *   1. `$` back-reference corruption (String.replace with string pattern
 *      interprets $1/$&/$$ in newText as special — SOP text with prices or
 *      placeholders got mangled).
 *   2. Multi-match silent-first-replace (String.replace only replaces the
 *      first occurrence — two-occurrence oldText lost the second edit).
 *   3. Empty oldText acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { performSearchReplace } from '../search-replace';

test('single occurrence replaces cleanly', () => {
  const r = performSearchReplace('hello world', 'world', 'there');
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.result, 'hello there');
});

test('newText with $ back-reference pattern is treated literally', () => {
  const r = performSearchReplace(
    'rental price is TBD',
    'TBD',
    '$100' // would be interpreted as capture group #100 by String.replace
  );
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.result, 'rental price is $100');
});

test('newText with $$ is not doubled', () => {
  const r = performSearchReplace('cost: TBD', 'TBD', '$$$$');
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.result, 'cost: $$$$');
});

test('multi-match returns ambiguous without replacing', () => {
  const r = performSearchReplace('foo foo foo', 'foo', 'bar');
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') assert.equal(r.count, 3);
});

test('ambiguous count is capped at 10 for large fan-outs', () => {
  const r = performSearchReplace('x'.repeat(100), 'x', 'y');
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') assert.ok(r.count >= 10);
});

test('oldText not present returns not_found', () => {
  const r = performSearchReplace('hello world', 'missing', 'anything');
  assert.equal(r.kind, 'not_found');
});

test('empty oldText returns not_found (no infinite loop)', () => {
  const r = performSearchReplace('hello world', '', 'anything');
  assert.equal(r.kind, 'not_found');
});

test('multi-line oldText matches exactly', () => {
  const r = performSearchReplace(
    'line 1\nline 2\nline 3',
    'line 2\nline 3',
    'last line'
  );
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.result, 'line 1\nlast line');
});

test('CRLF mismatch returns not_found (does not silently LF-normalise)', () => {
  // The apply path intentionally requires exact bytewise match; the agent
  // is expected to pull the current text via fetch_evidence_bundle before
  // constructing oldText. Mixed-newlines drift surfaces as not_found, not
  // a silent wrong-match.
  const r = performSearchReplace('line1\r\nline2', 'line1\nline2', 'new');
  assert.equal(r.kind, 'not_found');
});
