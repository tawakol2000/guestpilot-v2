/**
 * transition-nonce — Sprint 060-C HMAC nonce mint+verify.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/transition-nonce.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-nonce';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mintTransitionNonce, verifyTransitionNonce } from '../lib/transition-nonce';

test('mint then verify round-trips', () => {
  const n = mintTransitionNonce();
  assert.equal(verifyTransitionNonce(n).ok, true);
});

test('rejects empty / malformed input', () => {
  assert.equal(verifyTransitionNonce('').ok, false);
  assert.equal(verifyTransitionNonce('nope').ok, false);
  assert.equal(verifyTransitionNonce('only-payload.').ok, false);
});

test('rejects tampered signature', () => {
  const n = mintTransitionNonce();
  const tampered = n.slice(0, -2) + 'XX';
  assert.equal(verifyTransitionNonce(tampered).ok, false);
});

test('rejects tampered payload (signature no longer matches)', () => {
  const n = mintTransitionNonce();
  const dot = n.lastIndexOf('.');
  const tampered = 'AAAAAAAA' + n.slice(dot);
  assert.equal(verifyTransitionNonce(tampered).ok, false);
});

test('produces unique nonces', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(mintTransitionNonce());
  assert.equal(seen.size, 1000);
});
