/**
 * Sprint 045 Gate 3 — cache-bypass unit test.
 *
 * Run: npx tsx --test src/build-tune-agent/preview/__tests__/tenant-config-bypass.test.ts
 *
 * Target: `getTenantAiConfig(tenantId, prisma, { bypassCache: true })`
 * must re-read from the DB even when a cached entry is <60s old.
 * Without this, a BUILD `write_system_prompt` write would not be
 * visible to the subsequent `test_pipeline` call for up to 60s.
 */
// tenant-config.service transitively imports ai.service.ts (for
// SEED_COORDINATOR_PROMPT / SEED_SCREENING_PROMPT), which constructs
// an OpenAI client at module load. Placeholder env vars are enough.
process.env.JWT_SECRET ??= 'test-secret-bypass';
process.env.OPENAI_API_KEY ??= 'sk-test-placeholder';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getTenantAiConfig,
  invalidateTenantConfigCache,
} from '../../../services/tenant-config.service';

function makeFakePrisma(rows: Record<string, any>) {
  const calls: Array<{ op: 'upsert' | 'update'; tenantId: string }> = [];
  const prisma: any = {
    tenantAiConfig: {
      upsert: async ({ where }: any) => {
        calls.push({ op: 'upsert', tenantId: where.tenantId });
        if (!rows[where.tenantId]) {
          // Include enough template-variable mentions that the lazy
          // migration block in `getTenantAiConfig` doesn't append to
          // these prompts (we want to assert against the exact string
          // we write). See `hasMinimumVariables` in template-variable.service.
          const varStub =
            ' {CONVERSATION_HISTORY} {PROPERTY_DESCRIPTION} {CURRENT_MESSAGES}';
          rows[where.tenantId] = {
            id: 'cfg_' + where.tenantId,
            tenantId: where.tenantId,
            systemPromptCoordinator:
              'SEED coordinator prompt — ' +
              Math.random().toString(36).slice(2, 10) +
              varStub,
            systemPromptScreening:
              'SEED screening prompt — ' +
              Math.random().toString(36).slice(2, 10) +
              varStub,
            systemPromptVersion: 1,
            model: 'gpt-5.4-mini-2026-03-17',
            systemPromptHistory: [],
          };
        }
        return { ...rows[where.tenantId] }; // shallow copy: cache must not alias the row
      },
      update: async ({ where, data }: any) => {
        calls.push({ op: 'update', tenantId: where.tenantId });
        const row = rows[where.tenantId];
        Object.assign(row, data);
        return { ...row };
      },
      findUnique: async ({ where }: any) =>
        rows[where.tenantId] ? { ...rows[where.tenantId] } : null,
    },
  };
  return { prisma, calls };
}

test('getTenantAiConfig: default call hits the 60s cache on the second read', async () => {
  const tenantId = 'bypass-test-cache-hit-' + Date.now();
  invalidateTenantConfigCache(tenantId);
  const { prisma, calls } = makeFakePrisma({});

  const first = await getTenantAiConfig(tenantId, prisma);
  assert.ok(first.systemPromptCoordinator);
  const upsertsAfterFirst = calls.filter((c) => c.op === 'upsert').length;

  // Second call within TTL — must be cached (no new upsert).
  const second = await getTenantAiConfig(tenantId, prisma);
  assert.equal(second.systemPromptCoordinator, first.systemPromptCoordinator);
  const upsertsAfterSecond = calls.filter((c) => c.op === 'upsert').length;
  assert.equal(upsertsAfterSecond, upsertsAfterFirst, 'cached read should not re-upsert');
});

test('getTenantAiConfig: bypassCache: true forces a fresh DB read', async () => {
  const tenantId = 'bypass-test-bypass-' + Date.now();
  invalidateTenantConfigCache(tenantId);
  const rows: Record<string, any> = {};
  const { prisma, calls } = makeFakePrisma(rows);

  // First call — seeds + caches.
  await getTenantAiConfig(tenantId, prisma);
  const upsertsAfterFirst = calls.filter((c) => c.op === 'upsert').length;

  // Simulate a BUILD `write_system_prompt` landing in the DB while the
  // old value is still cached in memory — mutate the stored row.
  const writtenPrompt =
    'UPDATED coordinator — post-write {CONVERSATION_HISTORY} {PROPERTY_DESCRIPTION} {CURRENT_MESSAGES}';
  rows[tenantId].systemPromptCoordinator = writtenPrompt;

  // Without bypass, cache still returns the stale value (sanity check).
  const stale = await getTenantAiConfig(tenantId, prisma);
  assert.notEqual(stale.systemPromptCoordinator, writtenPrompt);

  // With bypassCache, the in-memory cache is skipped and we see the write.
  const bypassed = await getTenantAiConfig(tenantId, prisma, { bypassCache: true });
  assert.equal(bypassed.systemPromptCoordinator, writtenPrompt);

  // bypassCache also repopulates the cache, so the next default call
  // returns the fresh value.
  const after = await getTenantAiConfig(tenantId, prisma);
  assert.equal(after.systemPromptCoordinator, writtenPrompt);

  const upsertsTotal = calls.filter((c) => c.op === 'upsert').length;
  assert.ok(upsertsTotal > upsertsAfterFirst, 'bypass should have re-called upsert');
});

test('getTenantAiConfig: bypassCache=false / undefined preserves byte-identity with default path', async () => {
  const tenantId = 'bypass-test-byte-identity-' + Date.now();
  invalidateTenantConfigCache(tenantId);
  const { prisma } = makeFakePrisma({});

  const implicit = await getTenantAiConfig(tenantId, prisma);
  const explicit = await getTenantAiConfig(tenantId, prisma, { bypassCache: false });
  const undef = await getTenantAiConfig(tenantId, prisma, {});
  assert.equal(implicit.systemPromptCoordinator, explicit.systemPromptCoordinator);
  assert.equal(implicit.systemPromptCoordinator, undef.systemPromptCoordinator);
});
