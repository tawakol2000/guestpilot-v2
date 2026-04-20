/**
 * Sprint 04 — memory service unit tests.
 *
 * Run:  npx tsx --test src/tuning-agent/__tests__/memory.service.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  viewMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  listMemoryByPrefix,
  writeRejectionMemory,
  listRejectionHashes,
  computeRejectionFixHash,
} from '../memory/service';

function makeFakePrisma() {
  const rows = new Map<string, any>();
  const prisma: any = {
    agentMemory: {
      findUnique: async ({ where }: any) => {
        const key = `${where.tenantId_key.tenantId}:${where.tenantId_key.key}`;
        return rows.get(key) ?? null;
      },
      create: async ({ data }: any) => {
        const key = `${data.tenantId}:${data.key}`;
        if (rows.has(key)) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { ...data, id: `m_${rows.size + 1}`, createdAt: new Date(), updatedAt: new Date() };
        rows.set(key, row);
        return row;
      },
      upsert: async ({ where, update, create }: any) => {
        const key = `${where.tenantId_key.tenantId}:${where.tenantId_key.key}`;
        const existing = rows.get(key);
        if (existing) {
          const row = { ...existing, ...update, updatedAt: new Date() };
          rows.set(key, row);
          return row;
        }
        const row = { ...create, id: `m_${rows.size + 1}`, createdAt: new Date(), updatedAt: new Date() };
        rows.set(key, row);
        return row;
      },
      delete: async ({ where }: any) => {
        const key = `${where.tenantId_key.tenantId}:${where.tenantId_key.key}`;
        if (!rows.has(key)) {
          const err: any = new Error('not found');
          err.code = 'P2025';
          throw err;
        }
        rows.delete(key);
        return { id: 'deleted' };
      },
      findMany: async ({ where, take }: any) => {
        const out: any[] = [];
        for (const row of rows.values()) {
          if (row.tenantId !== where.tenantId) continue;
          if (where.key?.startsWith && !row.key.startsWith(where.key.startsWith)) continue;
          out.push(row);
        }
        out.sort((a, b) => b.updatedAt - a.updatedAt);
        return out.slice(0, take ?? out.length);
      },
    },
  };
  return { prisma, rows };
}

test('createMemory persists a new row', async () => {
  const { prisma } = makeFakePrisma();
  const r = await createMemory(prisma, 't1', 'preferences/tone', 'concise');
  assert.deepEqual(r, { ok: true });
  const v = await viewMemory(prisma, 't1', 'preferences/tone');
  assert.ok(v);
  assert.equal(v?.value, 'concise');
});

test('createMemory returns ALREADY_EXISTS on collision', async () => {
  const { prisma } = makeFakePrisma();
  await createMemory(prisma, 't1', 'preferences/tone', 'v1');
  const r = await createMemory(prisma, 't1', 'preferences/tone', 'v2');
  assert.deepEqual(r, { ok: false, error: 'ALREADY_EXISTS' });
});

test('updateMemory upserts', async () => {
  const { prisma } = makeFakePrisma();
  const r1 = await updateMemory(prisma, 't1', 'facts/luxury', true);
  assert.equal(r1.value, true);
  const r2 = await updateMemory(prisma, 't1', 'facts/luxury', false);
  assert.equal(r2.value, false);
});

test('deleteMemory is idempotent', async () => {
  const { prisma } = makeFakePrisma();
  await updateMemory(prisma, 't1', 'x', 1);
  const a = await deleteMemory(prisma, 't1', 'x');
  assert.deepEqual(a, { ok: true, deleted: true });
  const b = await deleteMemory(prisma, 't1', 'x');
  assert.deepEqual(b, { ok: true, deleted: false });
});

test('listMemoryByPrefix filters by key prefix', async () => {
  const { prisma } = makeFakePrisma();
  await updateMemory(prisma, 't1', 'preferences/tone', 'concise');
  await updateMemory(prisma, 't1', 'preferences/style', 'editorial');
  await updateMemory(prisma, 't1', 'facts/luxury', true);
  const prefs = await listMemoryByPrefix(prisma, 't1', 'preferences/');
  assert.equal(prefs.length, 2);
  assert.ok(prefs.every((r) => r.key.startsWith('preferences/')));
});

// ─── Sprint 046 Session D — session-scoped rejection memory ───────────

test('writeRejectionMemory + listRejectionHashes round-trip in a single conversation', async () => {
  const { prisma } = makeFakePrisma();
  const intent = {
    artifactId: 'faq-abc',
    sectionOrSlotKey: '',
    semanticIntent: 'FAQ:wifi-password',
  };
  const hash = computeRejectionFixHash(intent);

  await writeRejectionMemory(prisma, 't1', 'conv1', hash, intent);
  const hashes = await listRejectionHashes(prisma, 't1', 'conv1');
  assert.ok(hashes.has(hash));
  assert.equal(hashes.size, 1);
});

test('listRejectionHashes is scoped to a single conversation', async () => {
  const { prisma } = makeFakePrisma();
  const intentA = {
    artifactId: 'faq-abc',
    sectionOrSlotKey: '',
    semanticIntent: 'FAQ:wifi-password',
  };
  const intentB = {
    artifactId: 'faq-xyz',
    sectionOrSlotKey: '',
    semanticIntent: 'FAQ:parking-note',
  };
  const hashA = computeRejectionFixHash(intentA);
  const hashB = computeRejectionFixHash(intentB);

  await writeRejectionMemory(prisma, 't1', 'conv1', hashA, intentA);
  await writeRejectionMemory(prisma, 't1', 'conv2', hashB, intentB);

  const conv1 = await listRejectionHashes(prisma, 't1', 'conv1');
  const conv2 = await listRejectionHashes(prisma, 't1', 'conv2');
  assert.ok(conv1.has(hashA) && !conv1.has(hashB));
  assert.ok(conv2.has(hashB) && !conv2.has(hashA));
});

test('writeRejectionMemory is idempotent (upsert)', async () => {
  const { prisma, rows } = makeFakePrisma();
  const intent = {
    artifactId: 'sop-checkin',
    sectionOrSlotKey: 'checkout_time',
    semanticIntent: 'SOP_CONTENT:checkout-time-wording',
  };
  const hash = computeRejectionFixHash(intent);
  await writeRejectionMemory(prisma, 't1', 'conv1', hash, intent);
  await writeRejectionMemory(prisma, 't1', 'conv1', hash, intent);
  // Upsert must not duplicate the row.
  assert.equal(rows.size, 1);
});
