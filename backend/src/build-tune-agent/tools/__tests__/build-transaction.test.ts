/**
 * BuildTransaction state-machine tests (sprint 045 refinement B1/C3).
 *
 * Run: npx tsx --test src/build-tune-agent/tools/__tests__/build-transaction.test.ts
 *
 * Locks down the PLANNED → EXECUTING → {COMPLETED | PARTIAL} → ROLLED_BACK
 * transitions that were missing before this sprint's refinement pass:
 *   - validateBuildTransaction flips PLANNED → EXECUTING on first use.
 *   - finalizeBuildTransactionIfComplete flips EXECUTING → COMPLETED
 *     once the child-row count reaches plannedItems length.
 *   - markBuildTransactionPartial flips EXECUTING → PARTIAL on a failed
 *     write post-validation.
 *   - terminal states (COMPLETED, PARTIAL, ROLLED_BACK) reject new writes
 *     AND are never re-flipped by a late-arriving finalize/mark call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  finalizeBuildTransactionIfComplete,
  markBuildTransactionPartial,
  validateBuildTransaction,
} from '../build-transaction';

interface TxRow {
  id: string;
  tenantId: string;
  status: string;
  plannedItems: unknown[];
  rationale?: string | null;
  completedAt?: Date | null;
  children: {
    sopVariants: number;
    sopPropertyOverrides: number;
    faqEntries: number;
    toolDefinitions: number;
    aiConfigVersions: number;
  };
}

function makeFakePrisma(rows: TxRow[]): any {
  return {
    buildTransaction: {
      findFirst: async ({ where, select }: any) => {
        const r = rows.find(
          (x) => x.id === where.id && x.tenantId === where.tenantId
        );
        if (!r) return null;
        const out: any = { id: r.id, status: r.status };
        if (select?.plannedItems) out.plannedItems = r.plannedItems;
        if (select?.rationale) out.rationale = r.rationale ?? null;
        if (select?._count) {
          out._count = {
            sopVariants: r.children.sopVariants,
            sopPropertyOverrides: r.children.sopPropertyOverrides,
            faqEntries: r.children.faqEntries,
            toolDefinitions: r.children.toolDefinitions,
            aiConfigVersions: r.children.aiConfigVersions,
          };
        }
        return out;
      },
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('row not found');
        if (data.status) r.status = data.status;
        if ('completedAt' in data) r.completedAt = data.completedAt;
        if ('rationale' in data) r.rationale = data.rationale;
        return r;
      },
    },
  };
}

function newRow(id: string, plannedCount: number, status = 'PLANNED'): TxRow {
  return {
    id,
    tenantId: 't1',
    status,
    plannedItems: new Array(plannedCount).fill({
      type: 'sop',
      name: 'x',
      rationale: 'x',
    }),
    rationale: null,
    completedAt: null,
    children: {
      sopVariants: 0,
      sopPropertyOverrides: 0,
      faqEntries: 0,
      toolDefinitions: 0,
      aiConfigVersions: 0,
    },
  };
}

test('validateBuildTransaction: PLANNED → EXECUTING on first call', async () => {
  const row = newRow('tx1', 3, 'PLANNED');
  const prisma = makeFakePrisma([row]);
  const res = await validateBuildTransaction(prisma, 't1', 'tx1');
  assert.ok(res.ok);
  assert.equal(row.status, 'EXECUTING');
});

test('validateBuildTransaction rejects COMPLETED / PARTIAL / ROLLED_BACK', async () => {
  for (const terminal of ['COMPLETED', 'PARTIAL', 'ROLLED_BACK']) {
    const row = newRow('tx', 3, terminal);
    const prisma = makeFakePrisma([row]);
    const res = await validateBuildTransaction(prisma, 't1', 'tx');
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.error.includes(terminal));
    assert.equal(row.status, terminal, 'terminal state must not be re-flipped');
  }
});

test('finalizeBuildTransactionIfComplete: flips EXECUTING → COMPLETED once write count hits plannedItems', async () => {
  const row = newRow('tx1', 3, 'EXECUTING');
  row.children.sopVariants = 2;
  row.children.faqEntries = 0;
  const prisma = makeFakePrisma([row]);

  // Not yet complete: 2 < 3.
  let res = await finalizeBuildTransactionIfComplete(prisma, 't1', 'tx1');
  assert.equal(res.completed, false);
  assert.equal(res.writeCount, 2);
  assert.equal(res.plannedCount, 3);
  assert.equal(row.status, 'EXECUTING', 'must not flip before write count reaches planned count');

  // Third child written — should flip to COMPLETED.
  row.children.faqEntries = 1;
  res = await finalizeBuildTransactionIfComplete(prisma, 't1', 'tx1');
  assert.equal(res.completed, true);
  assert.equal(row.status, 'COMPLETED');
  assert.ok(row.completedAt instanceof Date);
});

test('finalizeBuildTransactionIfComplete is a no-op on terminal transactions', async () => {
  for (const terminal of ['COMPLETED', 'PARTIAL', 'ROLLED_BACK']) {
    const row = newRow('tx', 3, terminal);
    row.children.sopVariants = 3;
    const prisma = makeFakePrisma([row]);
    const res = await finalizeBuildTransactionIfComplete(prisma, 't1', 'tx');
    assert.equal(row.status, terminal, 'terminal state must be left alone');
    assert.equal(res.completed, terminal === 'COMPLETED');
  }
});

test('markBuildTransactionPartial: flips EXECUTING → PARTIAL with diagnostic stamp', async () => {
  const row = newRow('tx1', 3, 'EXECUTING');
  row.rationale = 'original rationale';
  const prisma = makeFakePrisma([row]);
  await markBuildTransactionPartial(prisma, 't1', 'tx1', {
    failedTool: 'create_faq',
    message: 'P2002 unique constraint on question',
  });
  assert.equal(row.status, 'PARTIAL');
  assert.ok(row.rationale?.startsWith('original rationale'));
  assert.ok(row.rationale?.includes('create_faq'));
  assert.ok(row.rationale?.includes('P2002'));
  assert.ok(row.completedAt instanceof Date);
});

test('markBuildTransactionPartial is a no-op on terminal transactions', async () => {
  for (const terminal of ['COMPLETED', 'PARTIAL', 'ROLLED_BACK']) {
    const row = newRow('tx', 3, terminal);
    const prisma = makeFakePrisma([row]);
    await markBuildTransactionPartial(prisma, 't1', 'tx', {
      failedTool: 'create_sop',
      message: 'anything',
    });
    assert.equal(row.status, terminal, 'terminal state must be left alone');
  }
});

test('partial-plan scenario: 2 succeed, 1 fails → PARTIAL; terminal status rejects further writes', async () => {
  // Plan with 3 items: sop + sop + faq. First two succeed (sopVariants=2),
  // third tool fails — markPartial fires. State should be PARTIAL and
  // subsequent writes should be rejected by validateBuildTransaction.
  const row = newRow('tx1', 3, 'PLANNED');
  const prisma = makeFakePrisma([row]);

  // First sop write: validate flips PLANNED → EXECUTING, then success
  // increments child count.
  let v = await validateBuildTransaction(prisma, 't1', 'tx1');
  assert.ok(v.ok);
  row.children.sopVariants = 1;
  await finalizeBuildTransactionIfComplete(prisma, 't1', 'tx1');
  assert.equal(row.status, 'EXECUTING');

  // Second sop write: validate re-checks EXECUTING is accepted.
  v = await validateBuildTransaction(prisma, 't1', 'tx1');
  assert.ok(v.ok);
  row.children.sopVariants = 2;
  await finalizeBuildTransactionIfComplete(prisma, 't1', 'tx1');
  assert.equal(row.status, 'EXECUTING');

  // Third write (FAQ) fails post-validation.
  v = await validateBuildTransaction(prisma, 't1', 'tx1');
  assert.ok(v.ok);
  await markBuildTransactionPartial(prisma, 't1', 'tx1', {
    failedTool: 'create_faq',
    message: 'P2002 unique constraint on question',
  });
  assert.equal(row.status, 'PARTIAL');

  // Further writes must be rejected.
  const blocked = await validateBuildTransaction(prisma, 't1', 'tx1');
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.error.includes('PARTIAL'));
});

test('helpers are no-ops when transactionId is null/undefined', async () => {
  const prisma = makeFakePrisma([]);
  const a = await finalizeBuildTransactionIfComplete(prisma, 't1', null);
  assert.equal(a.completed, false);
  assert.equal(a.plannedCount, 0);
  await markBuildTransactionPartial(prisma, 't1', undefined, {
    failedTool: 'create_sop',
    message: 'x',
  });
  // no throw, no row
});
