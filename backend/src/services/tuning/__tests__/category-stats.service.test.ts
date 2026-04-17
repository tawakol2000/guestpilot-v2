/**
 * Sprint 02 §8 — at least one test for the category-stats EMA update.
 *
 * Validates the math (α=0.3) across accept + reject updates using an
 * in-memory mock Prisma client.
 *
 * Invoke: npx tsx --test src/services/tuning/__tests__/category-stats.service.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateCategoryStatsOnAccept,
  updateCategoryStatsOnReject,
} from '../category-stats.service';

function makeMockPrisma() {
  const rows = new Map<string, { acceptRateEma: number; acceptCount: number; rejectCount: number }>();
  const key = (tenantId: string, category: string) => `${tenantId}:${category}`;
  const tuningCategoryStats = {
    findUnique: async ({ where }: any) => {
      const k = key(where.tenantId_category.tenantId, where.tenantId_category.category);
      return rows.get(k) ?? null;
    },
    upsert: async ({ where, create, update }: any) => {
      const k = key(where.tenantId_category.tenantId, where.tenantId_category.category);
      const existing = rows.get(k);
      if (!existing) {
        rows.set(k, {
          acceptRateEma: create.acceptRateEma,
          acceptCount: create.acceptCount,
          rejectCount: create.rejectCount,
        });
        return;
      }
      const newAccept = existing.acceptCount + (update.acceptCount?.increment ?? 0);
      const newReject = existing.rejectCount + (update.rejectCount?.increment ?? 0);
      rows.set(k, {
        acceptRateEma: update.acceptRateEma,
        acceptCount: newAccept,
        rejectCount: newReject,
      });
    },
  };
  const prisma: any = {
    tuningCategoryStats,
    // Sprint 09 phase 6 added a $transaction wrapper around the EMA read-
    // compute-write. The test mock now implements $transaction as a pass-
    // through that invokes the callback with `this` — equivalent to
    // running the work inline without isolation.
    $transaction: async (cb: (tx: any) => Promise<any>) => cb(prisma),
  };
  return { rows, prisma };
}

test('EMA on first accept = α (0.3)', async () => {
  const { prisma, rows } = makeMockPrisma();
  await updateCategoryStatsOnAccept(prisma as any, 't1', 'SOP_CONTENT' as any);
  const row = rows.get('t1:SOP_CONTENT');
  assert.ok(row);
  assert.equal(row!.acceptCount, 1);
  assert.equal(row!.rejectCount, 0);
  assert.ok(Math.abs(row!.acceptRateEma - 0.3) < 1e-9);
});

test('EMA on first reject = 0', async () => {
  const { prisma, rows } = makeMockPrisma();
  await updateCategoryStatsOnReject(prisma as any, 't1', 'FAQ' as any);
  const row = rows.get('t1:FAQ');
  assert.ok(row);
  assert.equal(row!.acceptCount, 0);
  assert.equal(row!.rejectCount, 1);
  assert.ok(Math.abs(row!.acceptRateEma - 0) < 1e-9);
});

test('EMA after accept then reject: 0.3 → 0.3 * 0.7 = 0.21', async () => {
  const { prisma, rows } = makeMockPrisma();
  await updateCategoryStatsOnAccept(prisma as any, 't1', 'SYSTEM_PROMPT' as any);
  await updateCategoryStatsOnReject(prisma as any, 't1', 'SYSTEM_PROMPT' as any);
  const row = rows.get('t1:SYSTEM_PROMPT');
  assert.ok(row);
  assert.equal(row!.acceptCount, 1);
  assert.equal(row!.rejectCount, 1);
  // 0.3 * 0 + 0.7 * 0.3 = 0.21
  assert.ok(Math.abs(row!.acceptRateEma - 0.21) < 1e-9, `got ${row!.acceptRateEma}`);
});

test('Null category is a no-op', async () => {
  const { prisma, rows } = makeMockPrisma();
  await updateCategoryStatsOnAccept(prisma as any, 't1', null as any);
  await updateCategoryStatsOnReject(prisma as any, 't1', null as any);
  assert.equal(rows.size, 0);
});
