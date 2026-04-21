/**
 * get_edit_history — unit tests (sprint 056-A F2).
 *
 * Run:
 *   npx tsx --test src/build-tune-agent/tools/__tests__/get-edit-history.test.ts
 *
 * Covers:
 *   - rows returned in DESC order by createdAt (newest first)
 *   - tenant isolation: tenant A calling for tenant B artifact → empty result
 *   - limit respected; default = 10 when absent
 *   - rationale-prefix passes through unchanged from metadata
 *   - zero rows → { rows: [] }, no error thrown
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGetEditHistoryTool } from '../get-edit-history';
import type { ToolContext } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_name: string, _desc: string, _schema: any, handler: any) => {
    captured = handler;
    return { name: _name };
  }) as any;
  return {
    factory: fakeToolFactory,
    invoke: (args: any) => captured(args),
  };
}

interface FakeHistoryRow {
  id: string;
  tenantId: string;
  artifactType: string;
  artifactId: string;
  operation: string;
  createdAt: Date;
  actorUserId: string | null;
  metadata: Record<string, unknown> | null;
}

function makeFakePrisma(rows: FakeHistoryRow[]) {
  const prisma: any = {
    buildArtifactHistory: {
      findMany: async ({ where, orderBy, take }: any) => {
        // Filter by tenant + artifactType + artifactId
        let filtered = rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            r.artifactType === where.artifactType &&
            r.artifactId === where.artifactId,
        );

        // Apply DESC ordering by createdAt
        if (orderBy?.createdAt === 'desc') {
          filtered = [...filtered].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }

        // Apply limit
        if (typeof take === 'number') {
          filtered = filtered.slice(0, take);
        }

        return filtered;
      },
    },
  };
  return prisma;
}

function makeCtx(prisma: any, tenantId = 't1'): ToolContext {
  return {
    prisma,
    tenantId,
    conversationId: 'c1',
    userId: 'u1',
    lastUserSanctionedApply: false,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('returns rows in DESC order by createdAt (newest first)', async () => {
  const rows: FakeHistoryRow[] = [
    {
      id: 'h1',
      tenantId: 't1',
      artifactType: 'faq',
      artifactId: 'faq-abc',
      operation: 'CREATE',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      actorUserId: 'u1',
      metadata: { rationale: 'first edit' },
    },
    {
      id: 'h2',
      tenantId: 't1',
      artifactType: 'faq',
      artifactId: 'faq-abc',
      operation: 'UPDATE',
      createdAt: new Date('2026-01-02T10:00:00Z'),
      actorUserId: 'u2',
      metadata: { rationale: 'second edit' },
    },
    {
      id: 'h3',
      tenantId: 't1',
      artifactType: 'faq',
      artifactId: 'faq-abc',
      operation: 'UPDATE',
      createdAt: new Date('2026-01-03T10:00:00Z'),
      actorUserId: 'u3',
      metadata: { rationale: 'third edit' },
    },
  ];

  const prisma = makeFakePrisma(rows);
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildGetEditHistoryTool(factory, () => ctx);

  const result = await invoke({ artifactType: 'faq', artifactId: 'faq-abc' });
  assert.ok(!result.isError, 'should not return error');

  const parsed = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(parsed.rows), 'rows must be an array');
  assert.equal(parsed.rows.length, 3, 'all three rows returned');

  // Newest first
  assert.equal(parsed.rows[0].appliedAt, '2026-01-03T10:00:00.000Z');
  assert.equal(parsed.rows[1].appliedAt, '2026-01-02T10:00:00.000Z');
  assert.equal(parsed.rows[2].appliedAt, '2026-01-01T10:00:00.000Z');
});

test('tenant isolation: artifact owned by tenant B returns empty under tenant A', async () => {
  const rows: FakeHistoryRow[] = [
    {
      id: 'h-b1',
      tenantId: 'tenant-b',
      artifactType: 'sop',
      artifactId: 'sop-xyz',
      operation: 'CREATE',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      actorUserId: null,
      metadata: null,
    },
  ];

  const prisma = makeFakePrisma(rows);
  // Calling under tenant-a for an artifact that belongs to tenant-b
  const ctx = makeCtx(prisma, 'tenant-a');
  const { factory, invoke } = captureTool();
  buildGetEditHistoryTool(factory, () => ctx);

  const result = await invoke({ artifactType: 'sop', artifactId: 'sop-xyz' });
  assert.ok(!result.isError, 'should not return error');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed.rows, [], 'no rows for wrong tenant — graceful empty, not 404');
});

test('limit is respected; default is 10 when absent', async () => {
  // Create 15 rows
  const rows: FakeHistoryRow[] = Array.from({ length: 15 }, (_, i) => ({
    id: `h${i}`,
    tenantId: 't1',
    artifactType: 'faq',
    artifactId: 'faq-many',
    operation: 'UPDATE',
    createdAt: new Date(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    actorUserId: null,
    metadata: null,
  }));

  const prisma = makeFakePrisma(rows);
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildGetEditHistoryTool(factory, () => ctx);

  // No limit supplied → default 10
  const r1 = await invoke({ artifactType: 'faq', artifactId: 'faq-many' });
  const p1 = JSON.parse(r1.content[0].text);
  assert.equal(p1.rows.length, 10, 'default limit is 10');

  // Explicit limit 3
  const r2 = await invoke({ artifactType: 'faq', artifactId: 'faq-many', limit: 3 });
  const p2 = JSON.parse(r2.content[0].text);
  assert.equal(p2.rows.length, 3, 'explicit limit respected');
});

test('rationale-prefix passes through unchanged from metadata', async () => {
  const rows: FakeHistoryRow[] = [
    {
      id: 'h1',
      tenantId: 't1',
      artifactType: 'faq',
      artifactId: 'faq-prefix',
      operation: 'UPDATE',
      createdAt: new Date('2026-03-10T12:00:00Z'),
      actorUserId: 'op1',
      metadata: {
        rationale: 'Agent-authored rationale',
        operatorRationale: 'Operator override reason',
        rationalePrefix: 'edited-by-operator',
      },
    },
  ];

  const prisma = makeFakePrisma(rows);
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildGetEditHistoryTool(factory, () => ctx);

  const result = await invoke({ artifactType: 'faq', artifactId: 'faq-prefix' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.rationale, 'Agent-authored rationale');
  assert.equal(row.operatorRationale, 'Operator override reason');
  assert.equal(row.rationalePrefix, 'edited-by-operator');
  assert.equal(row.appliedByUserId, 'op1');
  assert.equal(row.operation, 'UPDATE');
});

test('zero rows → { rows: [] } returned, no error', async () => {
  const prisma = makeFakePrisma([]);
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildGetEditHistoryTool(factory, () => ctx);

  const result = await invoke({ artifactType: 'system_prompt', artifactId: 'nonexistent-id' });
  assert.ok(!result.isError, 'should not be an error');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, { rows: [] }, 'empty rows shape returned');
});

test('null metadata fields map to null in output (no undefined leakage)', async () => {
  const rows: FakeHistoryRow[] = [
    {
      id: 'h1',
      tenantId: 't1',
      artifactType: 'sop',
      artifactId: 'sop-nometa',
      operation: 'CREATE',
      createdAt: new Date('2026-04-01T08:00:00Z'),
      actorUserId: null,
      metadata: null,
    },
  ];

  const prisma = makeFakePrisma(rows);
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildGetEditHistoryTool(factory, () => ctx);

  const result = await invoke({ artifactType: 'sop', artifactId: 'sop-nometa' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.rationale, null);
  assert.equal(row.operatorRationale, null);
  assert.equal(row.rationalePrefix, null);
  assert.equal(row.appliedByUserId, null);
});
