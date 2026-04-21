/**
 * enhance-prompt service — unit tests (sprint 058-A F8).
 *
 * Run: JWT_SECRET=test npx tsx --test src/services/__tests__/enhance-prompt.service.test.ts
 *
 * Covers the pure pieces (validation, rate limiter) and uses dependency
 * injection to test the happy / error paths without hitting OpenAI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  enhancePromptDraft,
  checkEnhanceRateLimit,
  ENHANCE_RATE_LIMIT_MAX,
  ENHANCE_RATE_LIMIT_WINDOW_MS,
  MIN_ENHANCE_CHARS,
  type RateLimitBucket,
} from '../enhance-prompt.service';

// ─── enhancePromptDraft ────────────────────────────────────────────────

test('F8 enhancePromptDraft: rejects empty draft', async () => {
  const r = await enhancePromptDraft('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_draft');
});

test('F8 enhancePromptDraft: rejects whitespace-only draft', async () => {
  const r = await enhancePromptDraft('   \n\t  ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_draft');
});

test('F8 enhancePromptDraft: rejects too-short draft', async () => {
  const r = await enhancePromptDraft('hey');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_short');
});

test('F8 enhancePromptDraft: MIN_ENHANCE_CHARS threshold is honoured', async () => {
  // Exactly 10 chars passes, 9 fails.
  const nine = 'x'.repeat(MIN_ENHANCE_CHARS - 1);
  const ten = 'x'.repeat(MIN_ENHANCE_CHARS);
  const r9 = await enhancePromptDraft(nine);
  assert.equal(r9.ok, false);
  assert.equal(r9.reason, 'too_short');
  const r10 = await enhancePromptDraft(ten, {
    backend: async () => 'polished',
  });
  assert.equal(r10.ok, true);
  assert.equal(r10.rewrite, 'polished');
});

test('F8 enhancePromptDraft: happy path returns the trimmed rewrite', async () => {
  const r = await enhancePromptDraft(
    'please look at the check in sop its not great make it better',
    { backend: async () => '  Please review the check-in SOP for tone.  ' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.rewrite, 'Please review the check-in SOP for tone.');
});

test('F8 enhancePromptDraft: backend error surfaces as nano_error', async () => {
  const r = await enhancePromptDraft('the draft is long enough now', {
    backend: async () => {
      throw new Error('500 Bad Gateway');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nano_error');
});

test('F8 enhancePromptDraft: missing API key error surfaces as no_api_key', async () => {
  const r = await enhancePromptDraft('the draft is long enough now', {
    backend: async () => {
      throw new Error('OPENAI_API_KEY missing');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_api_key');
});

test('F8 enhancePromptDraft: empty Nano response surfaces as empty_response', async () => {
  const r = await enhancePromptDraft('the draft is long enough now', {
    backend: async () => '   \n  ',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_response');
});

test('F8 enhancePromptDraft: input over 4000 chars is clipped before the Nano call', async () => {
  const huge = 'a'.repeat(5000);
  let seen = '';
  const r = await enhancePromptDraft(huge, {
    backend: async (draft) => {
      seen = draft;
      return 'ok';
    },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 4000);
});

// ─── checkEnhanceRateLimit ─────────────────────────────────────────────

test('F8 checkEnhanceRateLimit: first request in a fresh bucket is allowed', () => {
  const buckets = new Map<string, RateLimitBucket>();
  const r = checkEnhanceRateLimit(buckets, 'k1', 1000);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.remaining, ENHANCE_RATE_LIMIT_MAX - 1);
});

test('F8 checkEnhanceRateLimit: caps at exactly ENHANCE_RATE_LIMIT_MAX per window', () => {
  const buckets = new Map<string, RateLimitBucket>();
  const now = 1000;
  for (let i = 0; i < ENHANCE_RATE_LIMIT_MAX; i++) {
    const r = checkEnhanceRateLimit(buckets, 'k1', now);
    assert.equal(r.ok, true, `iter ${i}`);
  }
  const r = checkEnhanceRateLimit(buckets, 'k1', now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.retryAfterMs > 0);
});

test('F8 checkEnhanceRateLimit: window rolls over after ENHANCE_RATE_LIMIT_WINDOW_MS', () => {
  const buckets = new Map<string, RateLimitBucket>();
  const t0 = 1000;
  for (let i = 0; i < ENHANCE_RATE_LIMIT_MAX; i++) {
    checkEnhanceRateLimit(buckets, 'k1', t0);
  }
  // Exactly at window-end — should reset.
  const r = checkEnhanceRateLimit(buckets, 'k1', t0 + ENHANCE_RATE_LIMIT_WINDOW_MS);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.remaining, ENHANCE_RATE_LIMIT_MAX - 1);
});

test('F8 checkEnhanceRateLimit: per-key isolation', () => {
  const buckets = new Map<string, RateLimitBucket>();
  const now = 1000;
  for (let i = 0; i < ENHANCE_RATE_LIMIT_MAX; i++) {
    checkEnhanceRateLimit(buckets, 'tenant-a', now);
  }
  // tenant-a is exhausted, tenant-b is still fresh.
  const exhausted = checkEnhanceRateLimit(buckets, 'tenant-a', now);
  const fresh = checkEnhanceRateLimit(buckets, 'tenant-b', now);
  assert.equal(exhausted.ok, false);
  assert.equal(fresh.ok, true);
});
