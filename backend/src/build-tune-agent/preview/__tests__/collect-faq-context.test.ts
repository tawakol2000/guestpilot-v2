/**
 * Regression test for the test_pipeline runner's PROPERTY-scoped FAQ drop.
 *
 * Before 2026-04-22: `collectFaqContext` filtered on `scope: 'GLOBAL'`
 * only, so any FAQ a manager just created against a specific property
 * was silently missing from the test-pipeline context. The Sonnet judge
 * correctly marked the reply a failure because the dry pipeline wasn't
 * loading the FAQ under test — operator sees "test failed" when in fact
 * the change is fine.
 *
 * After: both scopes are included, tagged with `[GLOBAL ...]` or
 * `[PROPERTY:<id> ...]` so the judge can reason about applicability,
 * ordered GLOBAL first so truncation at 2,000 chars preferentially
 * preserves fleet-wide entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectFaqContext } from '../test-pipeline-runner';

type Row = {
  category: string;
  question: string;
  answer: string;
  scope: 'GLOBAL' | 'PROPERTY';
  propertyId: string | null;
  status?: string;
};

function makeFakePrisma(rows: Row[], tenantId = 't1') {
  return {
    faqEntry: {
      findMany: async ({ where, select, orderBy, take }: any) => {
        assert.equal(where.tenantId, tenantId);
        assert.equal(where.status, 'ACTIVE');
        // Bugfix assertion: the query MUST NOT hard-filter scope
        // (regression guard for the 2026-04-22 fix).
        assert.equal(where.scope, undefined, 'scope filter should be absent');
        const picked = rows
          .filter(
            (r) =>
              (r.status ?? 'ACTIVE') === 'ACTIVE',
          )
          .map((r) => {
            const out: any = {};
            if (select.category) out.category = r.category;
            if (select.question) out.question = r.question;
            if (select.answer) out.answer = r.answer;
            if (select.scope) out.scope = r.scope;
            if (select.propertyId) out.propertyId = r.propertyId;
            return out;
          });
        // Honour ordering when specified (GLOBAL first).
        const ordered = Array.isArray(orderBy) ? orderBy : [orderBy];
        picked.sort((a, b) => {
          for (const o of ordered) {
            const key = Object.keys(o)[0];
            const dir = (o as any)[key];
            const av = a[key];
            const bv = b[key];
            if (av == null || bv == null) continue;
            if (av < bv) return dir === 'asc' ? -1 : 1;
            if (av > bv) return dir === 'asc' ? 1 : -1;
          }
          return 0;
        });
        return picked.slice(0, take ?? picked.length);
      },
    },
  } as any;
}

test('collectFaqContext: empty tenant → empty string', async () => {
  const out = await collectFaqContext('t1', makeFakePrisma([]));
  assert.equal(out, '');
});

test('collectFaqContext: GLOBAL entries rendered with [GLOBAL ...] prefix', async () => {
  const prisma = makeFakePrisma([
    {
      category: 'parking',
      question: 'Is parking free?',
      answer: 'Yes, free street parking overnight.',
      scope: 'GLOBAL',
      propertyId: null,
    },
  ]);
  const out = await collectFaqContext('t1', prisma);
  assert.match(out, /\[GLOBAL parking\] Q: Is parking free\?/);
  assert.match(out, /A: Yes, free street parking overnight\./);
});

test('collectFaqContext: PROPERTY-scoped entries included and tagged with propertyId', async () => {
  // Regression: this is the exact case the bug hid — a per-property FAQ
  // the manager just wrote was invisible to the test pipeline.
  const prisma = makeFakePrisma([
    {
      category: 'wifi',
      question: 'What is the wifi password at Greenwich?',
      answer: 'Flat_GW_4G',
      scope: 'PROPERTY',
      propertyId: 'prop_gw_01',
    },
  ]);
  const out = await collectFaqContext('t1', prisma);
  assert.match(out, /\[PROPERTY:prop_gw_01 wifi\]/);
  assert.match(out, /Flat_GW_4G/);
});

test('collectFaqContext: mixed scopes → GLOBAL listed first (survives truncation)', async () => {
  const prisma = makeFakePrisma([
    {
      category: 'checkin',
      question: 'Where is check-in at flat 3?',
      answer: 'Key lockbox at door.',
      scope: 'PROPERTY',
      propertyId: 'prop_3',
    },
    {
      category: 'checkin',
      question: 'What time can we check in?',
      answer: 'Standard is 3pm.',
      scope: 'GLOBAL',
      propertyId: null,
    },
  ]);
  const out = await collectFaqContext('t1', prisma);
  const globalIdx = out.indexOf('[GLOBAL');
  const propIdx = out.indexOf('[PROPERTY:');
  assert.ok(globalIdx >= 0 && propIdx >= 0, 'both variants present');
  assert.ok(globalIdx < propIdx, 'GLOBAL appears before PROPERTY in rendered text');
});

test('collectFaqContext: PROPERTY entry with null propertyId renders PROPERTY:unknown', async () => {
  // Shouldn't happen in production (a PROPERTY-scoped FAQ should have a
  // propertyId), but Prisma column is nullable so defensive render is
  // required. Silent empty string would hide misconfigured rows.
  const prisma = makeFakePrisma([
    {
      category: 'amenity',
      question: 'Do you have a gym?',
      answer: 'Yes in building.',
      scope: 'PROPERTY',
      propertyId: null,
    },
  ]);
  const out = await collectFaqContext('t1', prisma);
  assert.match(out, /\[PROPERTY:unknown amenity\]/);
});
