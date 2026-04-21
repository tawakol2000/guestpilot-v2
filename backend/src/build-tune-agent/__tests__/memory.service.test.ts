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
  writeCrossSessionRejection,
  lookupCrossSessionRejection,
} from '../memory/service';

function makeFakePrisma() {
  const rows = new Map<string, any>();
  // Sprint 047 Session C — durable rejection rows. Separate map so
  // session-scoped AgentMemory tests stay isolated from cross-session
  // assertions.
  const rejections = new Map<string, any>();
  const rejectionKey = (tenantId: string, artifact: string, fixHash: string) =>
    `${tenantId}|${artifact}|${fixHash}`;
  const prisma: any = {
    rejectionMemory: {
      findUnique: async ({ where }: any) => {
        const { tenantId, artifact, fixHash } =
          where.tenantId_artifact_fixHash;
        return rejections.get(rejectionKey(tenantId, artifact, fixHash)) ?? null;
      },
      upsert: async ({ where, update, create }: any) => {
        const { tenantId, artifact, fixHash } =
          where.tenantId_artifact_fixHash;
        const key = rejectionKey(tenantId, artifact, fixHash);
        const existing = rejections.get(key);
        if (existing) {
          const row = { ...existing, ...update };
          rejections.set(key, row);
          return row;
        }
        const row = { ...create, id: `r_${rejections.size + 1}` };
        rejections.set(key, row);
        return row;
      },
    },
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
  return { prisma, rows, rejections };
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

// ─── Sprint 047 Session C — cross-session rejection memory ────────────

test('writeCrossSessionRejection + lookupCrossSessionRejection round-trip', async () => {
  const { prisma, rejections } = makeFakePrisma();
  const intent = {
    artifactId: 'faq-abc',
    sectionOrSlotKey: '',
    semanticIntent: 'FAQ:wifi-password',
  };
  const fixHash = computeRejectionFixHash(intent);

  await writeCrossSessionRejection(prisma, 't1', {
    artifact: 'faq',
    fixHash,
    intent,
    category: 'FAQ',
    subLabel: 'wifi-password',
    rationale: 'Too vague — say WiFi by the router.',
    sourceConversationId: 'conv-original',
  });

  assert.equal(rejections.size, 1);
  const hit = await lookupCrossSessionRejection(prisma, 't1', 'faq', fixHash);
  assert.ok(hit, 'rejection must be found');
  assert.equal(hit?.rationale, 'Too vague — say WiFi by the router.');
  assert.equal(hit?.sourceConversationId, 'conv-original');
  assert.equal(hit?.category, 'FAQ');
});

test('lookupCrossSessionRejection returns null when nothing is stored', async () => {
  const { prisma } = makeFakePrisma();
  const hit = await lookupCrossSessionRejection(prisma, 't1', 'faq', 'nohash');
  assert.equal(hit, null);
});

test('lookupCrossSessionRejection treats expired rows as null', async () => {
  const { prisma } = makeFakePrisma();
  const intent = {
    artifactId: 'sop-checkin',
    sectionOrSlotKey: 'checkout_time',
    semanticIntent: 'SOP_CONTENT:checkout-rephrase',
  };
  const fixHash = computeRejectionFixHash(intent);
  // Write with a "rejectedAt" 100 days in the past → expiresAt ~10 days past.
  const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  await writeCrossSessionRejection(prisma, 't1', {
    artifact: 'sop',
    fixHash,
    intent,
    now: past,
  });
  const hit = await lookupCrossSessionRejection(prisma, 't1', 'sop', fixHash);
  assert.equal(hit, null, 'expired row must not be returned');
});

test('writeCrossSessionRejection is idempotent — re-reject refreshes TTL', async () => {
  const { prisma, rejections } = makeFakePrisma();
  const intent = {
    artifactId: 'sop-checkin',
    sectionOrSlotKey: '',
    semanticIntent: 'SOP_CONTENT:checkout-time',
  };
  const fixHash = computeRejectionFixHash(intent);
  const first = new Date('2026-01-01T00:00:00Z');
  const second = new Date('2026-02-01T00:00:00Z');

  await writeCrossSessionRejection(prisma, 't1', {
    artifact: 'sop',
    fixHash,
    intent,
    rationale: 'first rejection',
    now: first,
  });
  await writeCrossSessionRejection(prisma, 't1', {
    artifact: 'sop',
    fixHash,
    intent,
    rationale: 'second rejection',
    now: second,
  });

  // One row, refreshed to the second timestamp.
  assert.equal(rejections.size, 1);
  const hit = await lookupCrossSessionRejection(
    prisma,
    't1',
    'sop',
    fixHash,
    new Date('2026-02-15T00:00:00Z')
  );
  assert.ok(hit);
  assert.equal(hit?.rationale, 'second rejection');
  // expiresAt should equal second + 90d
  const expectedExpires = new Date(second.getTime() + 90 * 24 * 60 * 60 * 1000);
  assert.equal(hit?.expiresAt, expectedExpires.toISOString());
});

test('cross-session lookup is keyed by artifact type — different artifacts do not collide', async () => {
  const { prisma } = makeFakePrisma();
  const intent = {
    artifactId: 'shared-id',
    sectionOrSlotKey: '',
    semanticIntent: 'WORDING:concise',
  };
  const fixHash = computeRejectionFixHash(intent);

  await writeCrossSessionRejection(prisma, 't1', {
    artifact: 'faq',
    fixHash,
    intent,
  });

  const faqHit = await lookupCrossSessionRejection(prisma, 't1', 'faq', fixHash);
  const sopHit = await lookupCrossSessionRejection(prisma, 't1', 'sop', fixHash);
  assert.ok(faqHit, 'FAQ artifact lookup must hit');
  assert.equal(sopHit, null, 'SOP artifact lookup must miss — different (artifact, fixHash) key');
});
