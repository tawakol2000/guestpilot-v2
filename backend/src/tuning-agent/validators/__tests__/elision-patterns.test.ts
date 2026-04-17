/**
 * Tests for the shared elision-marker detector used by PostToolUse
 * validator and the suggestion_action draft pre-persist check. Targets the
 * real false-positives the old patterns produced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectElisionMarker } from '../elision-patterns';

// ─── positive: should detect elision markers ───────────────────────────
test('detects // ... comment', () => {
  assert.ok(detectElisionMarker('line 1\n// ...\nline 2'));
});

test('detects [unchanged]', () => {
  assert.ok(detectElisionMarker('header\n[unchanged]\nfooter'));
});

test('detects "[rest of the content]" (placeholder intent)', () => {
  assert.ok(detectElisionMarker('start\n[rest of the content unchanged]\nend'));
});

test('detects "[rest of the prompt]"', () => {
  assert.ok(detectElisionMarker('intro\n[rest of the prompt]\noutro'));
});

test('detects TODO: fill in <field>', () => {
  assert.ok(detectElisionMarker('TODO: fill in the check-in time here'));
});

test('detects bare ellipsis line', () => {
  assert.equal(detectElisionMarker('before\n...\nafter'), 'bare-ellipsis-line');
});

test('detects "// rest of unchanged"', () => {
  assert.ok(detectElisionMarker('foo\n// rest of unchanged\nbar'));
});

test('detects "<!-- ... -->" and "<!-- remaining -->"', () => {
  assert.ok(detectElisionMarker('<!-- ... -->'));
  assert.ok(detectElisionMarker('<!-- remaining -->'));
});

// ─── negative: legitimate FAQ / SOP content should NOT match ─────────────
test('does NOT flag "call us for the rest of your stay"', () => {
  assert.equal(detectElisionMarker('Please call us for the rest of your stay.'), null);
});

test('does NOT flag "for the rest of the weekend"', () => {
  assert.equal(detectElisionMarker('Quiet hours apply for the rest of the weekend.'), null);
});

test('does NOT flag "TODO: fill out form on arrival"', () => {
  assert.equal(detectElisionMarker('TODO: fill out the registration form on arrival.'), null);
});

test('does NOT flag ordinary prose with an inline ellipsis', () => {
  // Inline ellipsis as punctuation should not trigger the bare-ellipsis-line rule.
  assert.equal(detectElisionMarker('She said the instructions were... confusing.'), null);
});

test('does NOT flag sentence containing "..."  followed by words', () => {
  assert.equal(
    detectElisionMarker('Wait... actually, the door code is 1234.'),
    null
  );
});

test('clean short text returns null', () => {
  assert.equal(detectElisionMarker('All good'), null);
  assert.equal(detectElisionMarker(''), null);
});
