/**
 * build-controller.enhancePrompt — unit tests (sprint 058-A F8).
 *
 * Run:
 *   JWT_SECRET=test npx tsx --test src/controllers/__tests__/build-controller-enhance-prompt.test.ts
 *
 * Tests the controller handler in isolation with a mock PrismaClient and
 * stub req/res objects. No database, no network. Proves:
 *   - tenant isolation on conversationId
 *   - rate-limit 429 with Retry-After header
 *   - graceful 200 `{ ok: false }` on Nano error (no 5xx bleed)
 *   - missing draft → empty_draft reason
 *
 * Note: the real Nano call is NOT exercised here; the service-layer test
 * (enhance-prompt.service.test.ts) covers that path via dependency
 * injection. This file focuses on the request/response seam.
 */
// Bootstrap env BEFORE any transitive import reaches auth middleware
// (which process.exit(1)s when JWT_SECRET is unset). tsx hoists static
// imports; this file sets the env from inside a dedicated module that
// runs before the rest of the graph. See src/__tests__/integration/_env-bootstrap.ts.
import '../../__tests__/integration/_env-bootstrap';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeBuildController } from '../build-controller';

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
}

function makeRes(): MockResponse & {
  status: (n: number) => any;
  json: (b: any) => any;
  setHeader: (k: string, v: string) => any;
} {
  const r: any = { statusCode: 200, body: null, headers: {} };
  r.status = (n: number) => {
    r.statusCode = n;
    return r;
  };
  r.json = (b: any) => {
    r.body = b;
    return r;
  };
  r.setHeader = (k: string, v: string) => {
    r.headers[k.toLowerCase()] = v;
    return r;
  };
  return r;
}

function makePrisma(opts: {
  tuningConversationOwner?: string;
  isAdmin?: boolean;
} = {}) {
  return {
    tuningConversation: {
      findFirst: async (q: any) => {
        if (!opts.tuningConversationOwner) return null;
        if (q.where.tenantId === opts.tuningConversationOwner) {
          return { id: q.where.id };
        }
        return null;
      },
    },
    tenant: {
      findUnique: async () => ({ isAdmin: opts.isAdmin ?? false }),
    },
    buildArtifactHistory: {
      findMany: async () => [],
    },
  } as any;
}

// ─── enhancePrompt ─────────────────────────────────────────────────────

let _origOpenAiKey: string | undefined;
beforeEach(() => {
  _origOpenAiKey = process.env.OPENAI_API_KEY;
  // Clear so the service returns `no_api_key` — the controller should
  // still respond with 200 `{ ok: false }`.
  delete process.env.OPENAI_API_KEY;
});

test('F8 controller: rejects empty draft with 200 and reason=empty_draft', async () => {
  const ctl = makeBuildController(makePrisma() as any);
  const req: any = { tenantId: 't1', body: { draft: '' } };
  const res = makeRes();
  await ctl.enhancePrompt(req, res as any);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'empty_draft');
});

test('F8 controller: rejects too-short draft with 200 and reason=too_short', async () => {
  const ctl = makeBuildController(makePrisma() as any);
  const req: any = { tenantId: 't1', body: { draft: 'hi' } };
  const res = makeRes();
  await ctl.enhancePrompt(req, res as any);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'too_short');
});

test('F8 controller: 404 when conversationId does not belong to the caller tenant', async () => {
  // Prisma reports the conversation is owned by tenant-B, request is from tenant-A.
  const ctl = makeBuildController(makePrisma({ tuningConversationOwner: 'tenantB' }) as any);
  const req: any = {
    tenantId: 'tenantA',
    body: { draft: 'long enough draft here', conversationId: 'conv1' },
  };
  const res = makeRes();
  await ctl.enhancePrompt(req, res as any);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.reason, 'CONVERSATION_NOT_FOUND');
});

test('F8 controller: lets the request through when conversationId belongs to caller tenant (degrades to no_api_key)', async () => {
  const ctl = makeBuildController(makePrisma({ tuningConversationOwner: 'tenantA' }) as any);
  const req: any = {
    tenantId: 'tenantA',
    body: { draft: 'long enough draft here', conversationId: 'conv1' },
  };
  const res = makeRes();
  await ctl.enhancePrompt(req, res as any);
  assert.equal(res.statusCode, 200);
  // OPENAI_API_KEY was deleted → service returns { ok:false, reason: 'no_api_key' }.
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'no_api_key');
});

test('F8 controller: rate limit returns 429 with Retry-After header after 20 requests in the same window', async () => {
  const ctl = makeBuildController(makePrisma() as any);
  const buildReq = (tenantId: string) => ({
    tenantId,
    body: { draft: 'long enough draft here' },
  });

  // Blast 20 → all should return 200 (each one hits `no_api_key` but not 429).
  // Use a distinct tenantId so this test doesn't inherit rate-limit state
  // from earlier tests in this file.
  const tenantId = 't-ratelimit-' + Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < 20; i++) {
    const res = makeRes();
    await ctl.enhancePrompt(buildReq(tenantId) as any, res as any);
    assert.equal(res.statusCode, 200, `iter ${i}`);
  }
  // 21st is rate-limited.
  const res = makeRes();
  await ctl.enhancePrompt(buildReq(tenantId) as any, res as any);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.reason, 'rate_limited');
  assert.ok(res.headers['retry-after']);
  assert.ok(Number(res.headers['retry-after']) > 0);
});

test('F8 controller: tenant isolation on the rate-limit bucket — exhausted tenant does not block a different tenant', async () => {
  const ctl = makeBuildController(makePrisma() as any);
  const tenantA = 't-iso-a-' + Math.random().toString(36).slice(2, 8);
  const tenantB = 't-iso-b-' + Math.random().toString(36).slice(2, 8);

  // Exhaust tenant A.
  for (let i = 0; i < 20; i++) {
    const res = makeRes();
    await ctl.enhancePrompt(
      { tenantId: tenantA, body: { draft: 'long enough draft' } } as any,
      res as any,
    );
  }
  // 21st for tenant A is 429.
  const resA = makeRes();
  await ctl.enhancePrompt(
    { tenantId: tenantA, body: { draft: 'long enough draft' } } as any,
    resA as any,
  );
  assert.equal(resA.statusCode, 429);

  // Tenant B, same moment, is still fresh.
  const resB = makeRes();
  await ctl.enhancePrompt(
    { tenantId: tenantB, body: { draft: 'long enough draft' } } as any,
    resB as any,
  );
  assert.equal(resB.statusCode, 200);
});
