/**
 * build-controller.sessionArtifacts — unit tests (sprint 058-A F9d).
 *
 * Run:
 *   JWT_SECRET=test npx tsx --test src/controllers/__tests__/build-controller-session-artifacts.test.ts
 *
 * Unit tests against the controller handler with a mock PrismaClient.
 * Proves:
 *   - 400 on missing conversationId
 *   - 403 for non-admin tenants
 *   - Tenant isolation: tenant-A request scoped to `tenantId: 'A'` never
 *     returns tenant-B's rows even when the target conversationId belongs
 *     to tenant B (empty list, not an error — consistent with
 *     listArtifactHistory).
 *   - Happy path shape: rows[] with historyId/touchedAt ISO strings.
 *   - 500 on prisma failure does not leak error details.
 */
import '../../__tests__/integration/_env-bootstrap';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeBuildController } from '../build-controller';

function makeRes() {
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

interface HistoryRow {
  id: string;
  artifactType: string;
  artifactId: string;
  operation: string;
  actorEmail: string | null;
  conversationId: string | null;
  tenantId: string;
  createdAt: Date;
  metadata: unknown;
}

function makePrisma(opts: {
  isAdmin?: boolean;
  rows?: HistoryRow[];
  findManyThrows?: boolean;
}) {
  return {
    tenant: {
      findUnique: async () => ({ isAdmin: opts.isAdmin ?? false }),
    },
    buildArtifactHistory: {
      findMany: async (q: any) => {
        if (opts.findManyThrows) throw new Error('db down');
        const rows = opts.rows ?? [];
        return rows.filter(
          (r) =>
            r.tenantId === q.where.tenantId &&
            r.conversationId === q.where.conversationId,
        );
      },
    },
  } as any;
}

// ─── sessionArtifacts ──────────────────────────────────────────────────

test('F9d controller: rejects missing conversationId with 400', async () => {
  const ctl = makeBuildController(makePrisma({ isAdmin: true }) as any);
  const req: any = { tenantId: 't1', params: {} };
  const res = makeRes();
  await ctl.sessionArtifacts(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'MISSING_CONVERSATION_ID');
});

test('F9d controller: non-admin caller gets 403', async () => {
  const ctl = makeBuildController(makePrisma({ isAdmin: false }) as any);
  const req: any = { tenantId: 't1', params: { conversationId: 'c1' } };
  const res = makeRes();
  await ctl.sessionArtifacts(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'ADMIN_ONLY');
});

test('F9d controller: happy path returns rows ordered by asc createdAt with ISO timestamps', async () => {
  const mkRow = (id: string, when: Date): HistoryRow => ({
    id,
    artifactType: 'sop',
    artifactId: `sop-${id}`,
    operation: 'CREATE',
    actorEmail: 'op@example.com',
    conversationId: 'c1',
    tenantId: 't1',
    createdAt: when,
    metadata: { rationale: 'why' },
  });
  const rows = [
    mkRow('h1', new Date('2026-04-20T10:00:00Z')),
    mkRow('h2', new Date('2026-04-20T10:05:00Z')),
  ];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = { tenantId: 't1', params: { conversationId: 'c1' } };
  const res = makeRes();
  await ctl.sessionArtifacts(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows.length, 2);
  assert.equal(res.body.rows[0].historyId, 'h1');
  assert.equal(res.body.rows[0].artifactType, 'sop');
  assert.equal(res.body.rows[0].operation, 'CREATE');
  assert.equal(res.body.rows[0].touchedAt, '2026-04-20T10:00:00.000Z');
  assert.deepEqual(res.body.rows[0].metadata, { rationale: 'why' });
});

test('F9d controller: tenant isolation — cross-tenant conversationId returns empty list, not a 403/404', async () => {
  // Setup: history rows exist under tenant B's scope.
  const rows: HistoryRow[] = [
    {
      id: 'h-b1',
      artifactType: 'sop',
      artifactId: 'sop-1',
      operation: 'CREATE',
      actorEmail: 'b@example.com',
      conversationId: 'conv-shared-id',
      tenantId: 'tenantB',
      createdAt: new Date(),
      metadata: null,
    },
  ];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);

  // Request arrives with tenantId=tenantA but conversationId of tenant B.
  const req: any = {
    tenantId: 'tenantA',
    params: { conversationId: 'conv-shared-id' },
  };
  const res = makeRes();
  await ctl.sessionArtifacts(req, res);
  // Consistent with listArtifactHistory: empty list, 200.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows.length, 0);
});

test('F9d controller: empty session (no history yet) returns { rows: [] }', async () => {
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows: [] }) as any);
  const req: any = { tenantId: 't1', params: { conversationId: 'c1' } };
  const res = makeRes();
  await ctl.sessionArtifacts(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { rows: [] });
});

test('F9d controller: prisma error returns 500 without leaking internals', async () => {
  const ctl = makeBuildController(
    makePrisma({ isAdmin: true, findManyThrows: true }) as any,
  );
  const req: any = { tenantId: 't1', params: { conversationId: 'c1' } };
  const res = makeRes();
  await ctl.sessionArtifacts(req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'SESSION_ARTIFACTS_FAILED');
  // Error message is NOT in the response body.
  assert.equal(JSON.stringify(res.body).includes('db down'), false);
});
