/**
 * Sprint 054-A F3 — ritual-state helper unit tests.
 *
 * Run: JWT_SECRET=test OPENAI_API_KEY=test-fake \
 *        npx tsx --test src/build-tune-agent/lib/__tests__/ritual-state.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFICATION_MAX_CALLS,
  VERIFICATION_RITUAL_VERSION,
  bumpVerificationCallCount,
  canFireVerification,
  getActiveRitualHistoryId,
  getVerificationCallCount,
  openRitualWindow,
} from '../ritual-state';
import type { ToolContext } from '../../tools/types';

function makeCtx(): ToolContext {
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'c1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    turnFlags: {},
  };
}

test('VERIFICATION_RITUAL_VERSION is "054-a.1" and MAX is 3', () => {
  assert.equal(VERIFICATION_RITUAL_VERSION, '054-a.1');
  assert.equal(VERIFICATION_MAX_CALLS, 3);
});

test('openRitualWindow sets the active history id and resets the counter', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'hist-1');
  assert.equal(getActiveRitualHistoryId(ctx), 'hist-1');
  assert.equal(getVerificationCallCount(ctx), 0);
});

test('a fresh openRitualWindow resets the counter even after previous use', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'hist-A');
  bumpVerificationCallCount(ctx, 2);
  assert.equal(getVerificationCallCount(ctx), 2);
  openRitualWindow(ctx, 'hist-B');
  assert.equal(getVerificationCallCount(ctx), 0);
  assert.equal(getActiveRitualHistoryId(ctx), 'hist-B');
});

test('canFireVerification: ok for 1/2/3 variants when counter is 0', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'h');
  assert.equal(canFireVerification(ctx, 1).ok, true);
  assert.equal(canFireVerification(ctx, 2).ok, true);
  assert.equal(canFireVerification(ctx, 3).ok, true);
});

test('canFireVerification: rejects > MAX in a single call', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'h');
  const r = canFireVerification(ctx, 4);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /caps verification at 3/);
});

test('canFireVerification: rejects when cumulative count would exceed MAX', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'h');
  bumpVerificationCallCount(ctx, 2); // used 2 / 3
  const r = canFireVerification(ctx, 2); // would push to 4
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /TEST_RITUAL_EXHAUSTED/);
});

test('canFireVerification: rejects zero or negative n', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, 'h');
  assert.equal(canFireVerification(ctx, 0).ok, false);
});

test('getActiveRitualHistoryId returns null when no ritual is open', () => {
  const ctx = makeCtx();
  assert.equal(getActiveRitualHistoryId(ctx), null);
});

test('getActiveRitualHistoryId returns null when openRitualWindow was called with null id', () => {
  const ctx = makeCtx();
  openRitualWindow(ctx, null);
  assert.equal(getActiveRitualHistoryId(ctx), null);
  // Counter still resets even if history id is null (defensive).
  assert.equal(getVerificationCallCount(ctx), 0);
});
