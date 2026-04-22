/**
 * build-controller.revertToVersion / tagHistoryRow / untagHistoryRow —
 * unit tests (sprint 058-A F3 + F6).
 *
 * Run:
 *   JWT_SECRET=test npx tsx --test \
 *     src/controllers/__tests__/build-controller-revert-to.test.ts
 *
 * These tests run against mock Prisma + stub req/res. They cover the
 * validation + tenant-isolation rails of the new endpoints. The deeper
 * apply-layer happy path (which mutates through applyArtifactUpdate) is
 * covered by the existing build-controller.integration.test.ts under
 * src/__tests__/integration/.
 */
import '../../__tests__/integration/_env-bootstrap';
import { test, beforeEach, afterEach } from 'node:test';
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

interface FakeHistoryRow {
  id: string;
  tenantId: string;
  artifactType: string;
  artifactId: string;
  operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT';
  actorEmail: string | null;
  conversationId: string | null;
  createdAt: Date;
  prevBody: unknown;
  newBody: unknown;
  metadata: unknown;
  versionLabel: string | null;
}

function makePrisma(opts: {
  isAdmin?: boolean;
  rows?: FakeHistoryRow[];
} = {}) {
  const rows = opts.rows ?? [];
  return {
    tenant: {
      findUnique: async () => ({
        isAdmin: opts.isAdmin ?? false,
        email: 'op@example.com',
      }),
    },
    buildArtifactHistory: {
      findFirst: async (q: any) => {
        return (
          rows.find(
            (r) =>
              r.id === q.where.id &&
              r.tenantId === q.where.tenantId,
          ) ?? null
        );
      },
      update: async (q: any) => {
        const hit = rows.find((r) => r.id === q.where.id);
        if (!hit) throw new Error('update: row not found');
        Object.assign(hit, q.data);
        return { ...hit };
      },
      findMany: async () => rows,
    },
  } as any;
}

const mkRow = (overrides: Partial<FakeHistoryRow> = {}): FakeHistoryRow => ({
  id: 'h1',
  tenantId: 't1',
  artifactType: 'sop',
  artifactId: 'sop-1',
  operation: 'UPDATE',
  actorEmail: 'op@example.com',
  conversationId: 'c1',
  createdAt: new Date('2026-04-20T10:00:00Z'),
  prevBody: { content: 'old content text body here long enough' },
  newBody: { content: 'new content text body here long enough' },
  metadata: null,
  versionLabel: null,
  ...overrides,
});

// ─── env toggling ──────────────────────────────────────────────────────

let _origEditorFlag: string | undefined;
beforeEach(() => {
  _origEditorFlag = process.env.ENABLE_RAW_PROMPT_EDITOR;
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
});
afterEach(() => {
  if (_origEditorFlag === undefined) delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  else process.env.ENABLE_RAW_PROMPT_EDITOR = _origEditorFlag;
});

// ─── revertToVersion ───────────────────────────────────────────────────

test('F3 controller: 404 when ENABLE_RAW_PROMPT_EDITOR is off', async () => {
  delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  const ctl = makeBuildController(makePrisma({ isAdmin: true }) as any);
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: {},
    method: 'POST',
    path: '/history/h1/revert-to',
  };
  const res = makeRes();
  await ctl.revertToVersion(req, res);
  assert.equal(res.statusCode, 404);
});

test('F3 controller: non-admin caller gets 403', async () => {
  const ctl = makeBuildController(makePrisma({ isAdmin: false }) as any);
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: {},
  };
  const res = makeRes();
  await ctl.revertToVersion(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'ADMIN_ONLY');
});

test('F3 controller: 404 when history row is not visible to the caller tenant', async () => {
  const ctl = makeBuildController(
    makePrisma({
      isAdmin: true,
      rows: [mkRow({ id: 'h1', tenantId: 'tenantB' })],
    }) as any,
  );
  const req: any = {
    tenantId: 'tenantA',
    params: { id: 'h1' },
    body: {},
  };
  const res = makeRes();
  await ctl.revertToVersion(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'HISTORY_NOT_FOUND');
});

test('F3 controller: 422 when target row has no newBody (e.g. a legacy DELETE row)', async () => {
  const ctl = makeBuildController(
    makePrisma({
      isAdmin: true,
      rows: [mkRow({ newBody: null })],
    }) as any,
  );
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: {},
  };
  const res = makeRes();
  await ctl.revertToVersion(req, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'NO_NEW_BODY');
});

test('F3 controller: 422 when artifactType is not one we know how to revert', async () => {
  const ctl = makeBuildController(
    makePrisma({
      isAdmin: true,
      rows: [
        mkRow({
          artifactType: 'unknown_type',
          newBody: { content: 'whatever' },
        }),
      ],
    }) as any,
  );
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: {},
  };
  const res = makeRes();
  await ctl.revertToVersion(req, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'UNREVERTABLE_TYPE');
});

test('F3 controller: 400 on missing id param', async () => {
  const ctl = makeBuildController(makePrisma({ isAdmin: true }) as any);
  const req: any = {
    tenantId: 't1',
    params: {},
    body: {},
  };
  const res = makeRes();
  await ctl.revertToVersion(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'MISSING_HISTORY_ID');
});

// ─── tagHistoryRow ─────────────────────────────────────────────────────

test('F6 controller: tag with valid label writes versionLabel and returns updated row', async () => {
  const rows = [mkRow()];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: { label: 'stable' },
  };
  const res = makeRes();
  await ctl.tagHistoryRow(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.row.versionLabel, 'stable');
  assert.equal(rows[0].versionLabel, 'stable');
});

test('F6 controller: tag rejects empty label with 400 MISSING_LABEL', async () => {
  const ctl = makeBuildController(
    makePrisma({ isAdmin: true, rows: [mkRow()] }) as any,
  );
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: { label: '' },
  };
  const res = makeRes();
  await ctl.tagHistoryRow(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'MISSING_LABEL');
});

test('F6 controller: tag rejects label > 40 chars with LABEL_TOO_LONG', async () => {
  const ctl = makeBuildController(
    makePrisma({ isAdmin: true, rows: [mkRow()] }) as any,
  );
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: { label: 'a'.repeat(41) },
  };
  const res = makeRes();
  await ctl.tagHistoryRow(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'LABEL_TOO_LONG');
});

test('F6 controller: tag rejects non-alphanum/dash/underscore charset with INVALID_LABEL_CHARSET', async () => {
  const ctl = makeBuildController(
    makePrisma({ isAdmin: true, rows: [mkRow()] }) as any,
  );
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: { label: 'bad label!!' },
  };
  const res = makeRes();
  await ctl.tagHistoryRow(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'INVALID_LABEL_CHARSET');
});

test('F6 controller: tag accepts hyphens + underscores', async () => {
  const rows = [mkRow()];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
    body: { label: 'before-early_checkin-rework' },
  };
  const res = makeRes();
  await ctl.tagHistoryRow(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.row.versionLabel, 'before-early_checkin-rework');
});

test('F6 controller: tag tenant isolation — tag on another tenant row returns 404', async () => {
  const rows = [mkRow({ tenantId: 'tenantB' })];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = {
    tenantId: 'tenantA',
    params: { id: 'h1' },
    body: { label: 'stable' },
  };
  const res = makeRes();
  await ctl.tagHistoryRow(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'HISTORY_NOT_FOUND');
});

// ─── untagHistoryRow ──────────────────────────────────────────────────

test('F6 controller: untag clears versionLabel on a tagged row', async () => {
  const rows = [mkRow({ versionLabel: 'stable' })];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
  };
  const res = makeRes();
  await ctl.untagHistoryRow(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.row.versionLabel, null);
  assert.equal(rows[0].versionLabel, null);
});

test('F6 controller: untag on untagged row is idempotent (still ok)', async () => {
  const rows = [mkRow({ versionLabel: null })];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = {
    tenantId: 't1',
    params: { id: 'h1' },
  };
  const res = makeRes();
  await ctl.untagHistoryRow(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test('F6 controller: untag tenant isolation — untag on another tenant row returns 404', async () => {
  const rows = [mkRow({ tenantId: 'tenantB', versionLabel: 'stable' })];
  const ctl = makeBuildController(makePrisma({ isAdmin: true, rows }) as any);
  const req: any = {
    tenantId: 'tenantA',
    params: { id: 'h1' },
  };
  const res = makeRes();
  await ctl.untagHistoryRow(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'HISTORY_NOT_FOUND');
});
