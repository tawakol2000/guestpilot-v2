/**
 * Feature 041 sprint 03 — preference-pair writer unit tests.
 *
 * Run via:
 *   npx tsx --test src/services/tuning/__tests__/preference-pair.service.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordPreferencePair } from '../preference-pair.service';

function fakePrismaCapture() {
  const calls: any[] = [];
  const prisma: any = {
    preferencePair: {
      create: async (args: any) => {
        calls.push(args);
        return { id: 'pp_1', ...args.data };
      },
    },
  };
  return { prisma, calls };
}

test('recordPreferencePair writes a row with the right payload shape', async () => {
  const { prisma, calls } = fakePrismaCapture();
  await recordPreferencePair(prisma, {
    tenantId: 't1',
    suggestionId: 's1',
    category: 'SOP_CONTENT',
    before: 'AI draft',
    rejectedProposal: 'Diagnostic proposal',
    preferredFinal: 'Manager edit',
  });
  assert.equal(calls.length, 1);
  const data = calls[0].data;
  assert.equal(data.tenantId, 't1');
  assert.equal(data.category, 'SOP_CONTENT');
  assert.deepEqual(data.context, { suggestionId: 's1', before: 'AI draft' });
  assert.deepEqual(data.rejectedSuggestion, { text: 'Diagnostic proposal' });
  assert.deepEqual(data.preferredFinal, { text: 'Manager edit' });
});

test('recordPreferencePair tolerates a null category (legacy row)', async () => {
  const { prisma, calls } = fakePrismaCapture();
  await recordPreferencePair(prisma, {
    tenantId: 't1',
    suggestionId: 's2',
    category: null,
    before: null,
    rejectedProposal: 'x',
    preferredFinal: 'y',
  });
  assert.equal(calls[0].data.category, null);
});
