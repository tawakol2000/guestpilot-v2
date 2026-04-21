/**
 * Sprint 056-A F1 — compose-span endpoint tests.
 *
 * Tests run via: npx tsx --test src/build-tune-agent/tools/__tests__/compose-span.test.ts
 *
 * 1. Returns replacement bounded by selection-size heuristic.
 * 2. Tenant-scoped: request for another tenant's artifactId → 404.
 * 3. Rate-limited: > 10/min per conversationId → 429.
 * 4. Missing required fields → 400.
 * 5. Empty instruction → 400.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../../types';
import { composeSpanHandler, type ComposeSpanRateLimiter } from '../../compose-span';

// ─── Shared mocks ──────────────────────────────────────────────────────────

/**
 * Minimal fake Prisma that resolves BuildArtifactHistory lookups.
 * `ownedArtifactIds` — IDs that return a history row for the tenant.
 */
function makeFakePrisma(ownedArtifactIds: string[] = []): any {
  return {
    buildArtifactHistory: {
      findFirst: async ({ where }: any) => {
        if (ownedArtifactIds.includes(where.artifactId) && where.tenantId === 'tenant-A') {
          return { id: 'hist-1' };
        }
        return null;
      },
    },
    // Fallback tables — return null to force 404 on unknown types.
    sopDefinition: { findFirst: async () => null },
    faqEntry: { findFirst: async () => null },
    tenantAiConfig: { findFirst: async () => null },
  };
}

/**
 * Minimal fake Express Response that captures the status + JSON.
 */
function makeFakeRes(): { res: Response; captured: { status: number; body: any } } {
  const captured = { status: 200, body: undefined as any };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

function makeReq(overrides: Partial<AuthenticatedRequest['body']> = {}, tenantId = 'tenant-A'): AuthenticatedRequest {
  return {
    tenantId,
    body: {
      artifactId: 'artifact-001',
      artifactType: 'sop',
      selection: { start: 10, end: 29, text: 'Check-in is at 4pm' },
      surroundingBody: 'Welcome! Check-in is at 4pm. We hope you enjoy your stay.',
      instruction: 'make it warmer',
      conversationId: 'conv-001',
      ...overrides,
    },
  } as unknown as AuthenticatedRequest;
}

// ─── Test 1: Missing required fields → 400 ────────────────────────────────

test('missing artifactId → 400', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  await composeSpanHandler(makeReq({ artifactId: '' }), res, prisma, limiter);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'MISSING_ARTIFACT_ID');
});

test('missing artifactType → 400', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  await composeSpanHandler(makeReq({ artifactType: '' }), res, prisma, limiter);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'MISSING_ARTIFACT_TYPE');
});

test('missing instruction → 400', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  await composeSpanHandler(makeReq({ instruction: '' }), res, prisma, limiter);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'MISSING_INSTRUCTION');
});

test('missing selection text → 400', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  await composeSpanHandler(
    makeReq({ selection: { start: 0, end: 0, text: '' } }),
    res,
    prisma,
    limiter,
  );
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'INVALID_SELECTION');
});

test('invalid selection (missing offsets) → 400', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  await composeSpanHandler(
    makeReq({ selection: { text: 'Hello' } as any }),
    res,
    prisma,
    limiter,
  );
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'INVALID_SELECTION');
});

// ─── Test 2: Tenant-scoped — cross-tenant → 404 ───────────────────────────

test('cross-tenant artifactId returns 404', async () => {
  // artifact-001 belongs to tenant-A; request from tenant-B should 404.
  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  // tenantId = 'tenant-B' — no history row exists for this tenant.
  const req = makeReq({}, 'tenant-B');
  await composeSpanHandler(req, res, prisma, limiter);

  assert.equal(captured.status, 404);
  assert.equal(captured.body.error, 'ARTIFACT_NOT_FOUND');
});

// ─── Test 3: Rate limiting — > 10/min → 429 ──────────────────────────────

test('rate limit: 11th request within 60s returns 429', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const limiter: ComposeSpanRateLimiter = new Map();

  // The first 10 requests should pass the rate-limit check and fail at
  // the agent-disabled check (no ANTHROPIC_API_KEY in test env), not 429.
  // The 11th should return 429.
  for (let i = 0; i < 10; i++) {
    const { res, captured } = makeFakeRes();
    await composeSpanHandler(makeReq(), res, prisma, limiter);
    // Should NOT be 429 for the first 10.
    assert.notEqual(captured.status, 429, `Request ${i + 1} should not be rate-limited`);
  }

  // 11th request — must be 429.
  const { res: res11, captured: captured11 } = makeFakeRes();
  await composeSpanHandler(makeReq(), res11, prisma, limiter);
  assert.equal(captured11.status, 429);
  assert.equal(captured11.body.error, 'RATE_LIMIT_EXCEEDED');
});

test('rate limit resets after window expires', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const limiter: ComposeSpanRateLimiter = new Map();

  // Manually set the limiter to a just-expired window.
  const pastTime = Date.now() - 70_000; // 70s ago — well past 60s window
  limiter.set('conv-001', { count: 10, resetAt: pastTime });

  // First request after window should NOT be rate-limited.
  const { res, captured } = makeFakeRes();
  await composeSpanHandler(makeReq(), res, prisma, limiter);
  assert.notEqual(captured.status, 429);
});

// ─── Test 4: Rate limiter keyed by conversationId ─────────────────────────

test('rate limiter uses conversationId as key', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const limiter: ComposeSpanRateLimiter = new Map();

  // Fill up the limit for conv-001.
  limiter.set('conv-001', { count: 10, resetAt: Date.now() + 60_000 });

  // Request with conv-002 should NOT be blocked.
  const { res, captured } = makeFakeRes();
  await composeSpanHandler(makeReq({ conversationId: 'conv-002' }), res, prisma, limiter);
  assert.notEqual(captured.status, 429);
});

test('rate limiter falls back to tenantId when no conversationId', async () => {
  const prisma = makeFakePrisma(['artifact-001']);
  const limiter: ComposeSpanRateLimiter = new Map();

  // Fill up the limit for tenant-A.
  limiter.set('tenant-A', { count: 10, resetAt: Date.now() + 60_000 });

  // Request with no conversationId — uses tenantId as key.
  const { res, captured } = makeFakeRes();
  await composeSpanHandler(makeReq({ conversationId: undefined }), res, prisma, limiter);
  assert.equal(captured.status, 429);
});

// ─── Test 5: Agent disabled guard ─────────────────────────────────────────

test('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
  // The test environment has no ANTHROPIC_API_KEY, so this should 503.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const prisma = makeFakePrisma(['artifact-001']);
  const { res, captured } = makeFakeRes();
  const limiter: ComposeSpanRateLimiter = new Map();

  await composeSpanHandler(makeReq(), res, prisma, limiter);
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'AGENT_DISABLED');

  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
});
