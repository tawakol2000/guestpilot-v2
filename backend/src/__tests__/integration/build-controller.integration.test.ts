/**
 * Integration: /api/build/* endpoints (sprint 045, Gate 5).
 *
 * Five cases:
 *   1. GET tenant-state on a GREENFIELD fixture → isGreenfield: true.
 *   2. GET tenant-state after seeding one SOP → isGreenfield: false.
 *   3. POST /turn without ENABLE_BUILD_MODE → 404 (hard gate).
 *   4. POST /turn with ENABLE_BUILD_MODE=true → 200 SSE stream
 *      (degrades to data-agent-disabled if ANTHROPIC_API_KEY is unset,
 *      which is fine — what we're verifying is the gate + routing, not
 *      the agent model call).
 *   5. POST /plan/:id/rollback → invokes the rollback tool, returns
 *      success.
 *
 * Each case spins up a fresh Express app on an ephemeral port so the
 * ENABLE_BUILD_MODE env gate can be flipped per case without race
 * conditions. The cost is ~50ms of listen/close per test; cheaper than
 * threading the env var through a shared server.
 */
// MUST be first — seeds env before the auth middleware's eager JWT_SECRET check.
import './_env-bootstrap';

import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../../middleware/auth';
import { buildRouter } from '../../routes/build';
import { buildFixture, type IntegrationFixture } from './_fixture';

const prisma = new PrismaClient();
let fx: IntegrationFixture;
let token: string;

interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const app = express();
  app.use(express.json());
  app.use('/api/build', buildRouter(prisma));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server.address() not bound');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

before(async () => {
  fx = await buildFixture(prisma);
  token = signToken({
    tenantId: fx.tenantId,
    email: 'TEST_integration@guestpilot.local',
    plan: 'PRO',
  });
});

after(async () => {
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

test('case 1: GET tenant-state on GREENFIELD tenant returns isGreenfield: true', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/tenant-state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.isGreenfield, true, 'fixture has no SOPs/global FAQs/custom tools');
    assert.equal(body.sopCount, 0);
    assert.equal(body.faqCounts.global, 0);
    assert.equal(body.customToolCount, 0);
    assert.equal(typeof body.propertyCount, 'number');
    assert.equal(body.lastBuildTransaction, undefined);
  } finally {
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});

test('case 2: GET tenant-state with one SOP returns isGreenfield: false', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const srv = await startServer();
  // Seed one SOP for this tenant — flips it to BROWNFIELD.
  const sop = await prisma.sopDefinition.create({
    data: {
      tenantId: fx.tenantId,
      category: 'sop-test-greenfield-flip',
      toolDescription: 'Test SOP added for the BROWNFIELD case.',
    },
  });
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/tenant-state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.isGreenfield, false);
    assert.equal(body.sopCount, 1);
  } finally {
    await prisma.sopDefinition.delete({ where: { id: sop.id } }).catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});

test('case 3: POST /turn without ENABLE_BUILD_MODE returns 404 (hard gate)', async () => {
  delete process.env.ENABLE_BUILD_MODE;
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        conversationId: 'whatever',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    });
    assert.equal(res.status, 404, 'route must 404 when feature flag is off');
    // Also the GET tenant-state path must 404 — verifies the gate covers
    // the whole router, not just /turn.
    const stateRes = await fetch(`${srv.baseUrl}/api/build/tenant-state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(stateRes.status, 404, 'tenant-state must also 404 under the gate');
  } finally {
    await srv.close();
  }
});

test('case 4: POST /turn with ENABLE_BUILD_MODE=true returns 200 SSE stream', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  // Need a TuningConversation row for the runtime to look up.
  const conv = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST integration BUILD turn',
    },
  });
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        conversationId: conv.id,
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'hi, just verifying the route' }],
          },
        ],
      }),
    });
    assert.equal(res.status, 200, 'route must 200 when feature flag is on');
    // Should return an SSE-shaped response. Body is a stream — pull it
    // to completion. Without ANTHROPIC_API_KEY set, the runtime emits a
    // data-agent-disabled part and finishes. Both cases (real model + no
    // key) produce a non-empty SSE body, so we just assert non-empty.
    const text = await res.text();
    assert.ok(text.length > 0, 'expected non-empty SSE response body');
    // Reasonable shape sniff — Vercel AI SDK SSE uses `data:` lines.
    assert.ok(/data:/.test(text), `expected SSE 'data:' lines, got: ${text.slice(0, 200)}`);
  } finally {
    await prisma.tuningMessage
      .deleteMany({ where: { conversationId: conv.id } })
      .catch(() => undefined);
    await prisma.tuningConversation
      .delete({ where: { id: conv.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});

test('case 6: POST /suggested-fix/:id/reject persists rejection memory (sprint 046 Session D)', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const conv = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST Session D rejection memory',
    },
  });
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/suggested-fix/preview:abc123/reject`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId: conv.id,
          category: 'FAQ',
          subLabel: 'wifi-password',
          target: { artifactId: 'faq-abc' },
        }),
      }
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.appliedVia, 'rejection-memory');
    assert.ok(body.fixHash);
    const row = await prisma.agentMemory.findFirst({
      where: {
        tenantId: fx.tenantId,
        key: `session/${conv.id}/rejected/${body.fixHash}`,
      },
    });
    assert.ok(row, 'rejection-memory row must be persisted');
  } finally {
    await prisma.agentMemory
      .deleteMany({
        where: {
          tenantId: fx.tenantId,
          key: { startsWith: `session/${conv.id}/rejected/` },
        },
      })
      .catch(() => undefined);
    await prisma.tuningConversation
      .delete({ where: { id: conv.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});

test('case 5: POST /plan/:id/rollback invokes rollback tool and returns success', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  // Seed a BuildTransaction + one FAQ owned by it. Rollback should
  // delete the FAQ and flip the transaction to ROLLED_BACK.
  const tx = await prisma.buildTransaction.create({
    data: {
      tenantId: fx.tenantId,
      plannedItems: [
        { type: 'faq', name: 'rollback-faq', rationale: 'rollback test' },
      ] as any,
      status: 'EXECUTING',
      rationale: 'rollback integration test',
    },
  });
  const faq = await prisma.faqEntry.create({
    data: {
      tenantId: fx.tenantId,
      propertyId: fx.propertyId,
      question: 'TEST rollback FAQ',
      answer: 'TEST rollback FAQ answer',
      category: 'WIFI',
      buildTransactionId: tx.id,
    },
  });
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/plan/${tx.id}/rollback`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(res.status, 200, `rollback must 200; got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.transactionId, tx.id);
    assert.equal(body.reverted.faqEntries, 1, 'one FAQ should be reverted');
    // Verify side effects.
    const faqAfter = await prisma.faqEntry.findUnique({ where: { id: faq.id } });
    assert.equal(faqAfter, null, 'rolled-back FAQ should be deleted');
    const txAfter = await prisma.buildTransaction.findUnique({
      where: { id: tx.id },
    });
    assert.equal(txAfter?.status, 'ROLLED_BACK');
  } finally {
    await prisma.faqEntry.deleteMany({ where: { id: faq.id } }).catch(() => undefined);
    await prisma.buildTransaction
      .delete({ where: { id: tx.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});
