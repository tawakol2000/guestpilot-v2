/**
 * Integration: BuildToolCallLog retention sweep (sprint 047 Session B).
 *
 * Exercises `runRetentionSweep` end-to-end: seeds rows at varied ages,
 * runs the sweep with a small `batchSize`, asserts the loop keeps going
 * until the backlog drains and leaves fresh rows untouched.
 *
 * One extra case proves the bounded MAX_BATCHES_PER_RUN safety cap
 * short-circuits cleanly (we lower batchSize to make the cap reachable
 * without seeding half a million rows).
 */
import './_env-bootstrap';

import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { buildFixture, type IntegrationFixture } from './_fixture';
import { runRetentionSweep } from '../../jobs/buildToolCallLogRetention.job';

const prisma = new PrismaClient();
let fx: IntegrationFixture;

async function seedAged(
  tenantId: string,
  conversationId: string,
  n: number,
  ageDaysAgo: number,
  toolPrefix: string
) {
  const base = Date.now() - ageDaysAgo * 24 * 60 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    await prisma.buildToolCallLog.create({
      data: {
        tenantId,
        conversationId,
        turn: i,
        tool: `${toolPrefix}_${i}`,
        paramsHash: `hash_${i}`,
        durationMs: 1,
        success: true,
        errorMessage: null,
        createdAt: new Date(base + i),
      },
    });
  }
}

before(async () => {
  fx = await buildFixture(prisma);
});

after(async () => {
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

test('runRetentionSweep loops batches until the old backlog drains and leaves fresh rows', async () => {
  await prisma.buildToolCallLog.deleteMany({ where: { tenantId: fx.tenantId } });
  await seedAged(fx.tenantId, fx.conversationId, 15, 45, 'old');
  await seedAged(fx.tenantId, fx.conversationId, 3, 5, 'fresh');

  // batchSize=4 forces 4 batches: 4+4+4+3 over four loop iterations.
  const result = await runRetentionSweep(prisma, { batchSize: 4, retentionDays: 30 });
  assert.equal(result.deleted, 15);
  assert.equal(result.batches, 4);
  assert.equal(result.truncated, false);

  const remaining = await prisma.buildToolCallLog.count({
    where: { tenantId: fx.tenantId },
  });
  assert.equal(remaining, 3);
  const remainingTools = await prisma.buildToolCallLog.findMany({
    where: { tenantId: fx.tenantId },
    select: { tool: true },
  });
  for (const r of remainingTools) {
    assert.ok(r.tool.startsWith('fresh_'), `leftover tool ${r.tool} should be fresh`);
  }
});

test('runRetentionSweep is a no-op when nothing is older than retention', async () => {
  await prisma.buildToolCallLog.deleteMany({ where: { tenantId: fx.tenantId } });
  await seedAged(fx.tenantId, fx.conversationId, 5, 2, 'fresh');

  const result = await runRetentionSweep(prisma, { retentionDays: 30 });
  assert.equal(result.deleted, 0);
  assert.equal(result.batches, 0);
  assert.equal(result.truncated, false);

  const remaining = await prisma.buildToolCallLog.count({
    where: { tenantId: fx.tenantId },
  });
  assert.equal(remaining, 5);
});
