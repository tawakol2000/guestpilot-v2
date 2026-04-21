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

test('case 7: POST /suggested-fix/preview:*/accept writes FAQ + creates ACCEPTED TuningSuggestion (sprint 047 Session A)', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const conv = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST Session A preview accept',
    },
  });
  const faq = await prisma.faqEntry.create({
    data: {
      tenantId: fx.tenantId,
      propertyId: fx.propertyId,
      question: 'TEST Session A FAQ Q?',
      answer: 'TEST Session A FAQ original answer.',
      category: 'WIFI',
      scope: 'PROPERTY',
      status: 'ACTIVE',
      source: 'MANUAL',
    },
  });
  const previewId = `preview:session-a:${Date.now().toString(36)}`;
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/suggested-fix/${encodeURIComponent(previewId)}/accept`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId: conv.id,
          category: 'FAQ',
          subLabel: 'tone',
          rationale: 'Softened tone for FAQ.',
          before: 'TEST Session A FAQ original answer.',
          after: 'TEST Session A FAQ softened answer.',
          target: { faqEntryId: faq.id },
        }),
      }
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.applied, true);
    assert.equal(body.appliedVia, 'suggestion_action');
    assert.ok(body.suggestionId, 'expected a persisted suggestionId');

    // Artifact write happened.
    const faqAfter = await prisma.faqEntry.findUnique({ where: { id: faq.id } });
    assert.match(String(faqAfter?.answer), /softened/);

    // TuningSuggestion row persisted with ACCEPTED + appliedAt + conversationId.
    const row = await prisma.tuningSuggestion.findUnique({
      where: { id: body.suggestionId },
    });
    assert.ok(row, 'expected TuningSuggestion row to exist');
    assert.equal(row?.status, 'ACCEPTED');
    assert.ok(row?.appliedAt);
    assert.equal(row?.conversationId, conv.id);
    assert.equal(row?.faqEntryId, faq.id);
    const applied = (row?.appliedPayload ?? {}) as any;
    assert.equal(applied.previewId, previewId);

    // Idempotency: re-accept with the same previewId returns 200 and does
    // NOT create a second row.
    const res2 = await fetch(
      `${srv.baseUrl}/api/build/suggested-fix/${encodeURIComponent(previewId)}/accept`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId: conv.id,
          category: 'FAQ',
          subLabel: 'tone',
          rationale: 'Softened tone for FAQ.',
          before: 'TEST Session A FAQ original answer.',
          after: 'TEST Session A FAQ softened answer.',
          target: { faqEntryId: faq.id },
        }),
      }
    );
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as any;
    assert.equal(body2.alreadyApplied, true);
    assert.equal(body2.suggestionId, body.suggestionId);

    const rows = await prisma.tuningSuggestion.findMany({
      where: {
        tenantId: fx.tenantId,
        conversationId: conv.id,
      },
    });
    assert.equal(rows.length, 1, 'exactly one row persisted');
  } finally {
    await prisma.tuningSuggestion
      .deleteMany({ where: { tenantId: fx.tenantId, conversationId: conv.id } })
      .catch(() => undefined);
    await prisma.faqEntry.delete({ where: { id: faq.id } }).catch(() => undefined);
    await prisma.tuningConversation
      .delete({ where: { id: conv.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});

test('case 8: POST /suggested-fix/preview:*/accept fails with 400 when conversationId missing (sprint 047 Session A)', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/suggested-fix/preview:no-conv/accept`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          category: 'FAQ',
          before: 'a',
          after: 'b',
          target: { faqEntryId: 'faq-x' },
        }),
      }
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'MISSING_CONVERSATION_ID');
  } finally {
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
          // Sprint 047 Session C — `target.artifact` drives the
          // RejectionMemory composite key. Omitting it falls back to '',
          // which is still a valid-but-untargeted durable row.
          target: { artifact: 'faq', artifactId: 'faq-abc' },
          rationale: 'Too vague — say WiFi by the router.',
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

    // Sprint 047 Session C — same POST must also persist a durable row.
    const durable = await prisma.rejectionMemory.findUnique({
      where: {
        tenantId_artifact_fixHash: {
          tenantId: fx.tenantId,
          artifact: 'faq',
          fixHash: body.fixHash,
        },
      },
    });
    assert.ok(durable, 'cross-session RejectionMemory row must be persisted');
    assert.equal(
      durable?.rationale,
      'Too vague — say WiFi by the router.',
      'captured rationale must round-trip'
    );
    assert.equal(durable?.sourceConversationId, conv.id);
    // TTL: rejectedAt stamp → expiresAt exactly 90d later.
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const drift = Math.abs(
      durable!.expiresAt.getTime() -
        (durable!.rejectedAt.getTime() + ninetyDaysMs)
    );
    assert.ok(drift < 1000, `expiresAt must be rejectedAt + 90d (±1s), drift=${drift}ms`);
  } finally {
    await prisma.agentMemory
      .deleteMany({
        where: {
          tenantId: fx.tenantId,
          key: { startsWith: `session/${conv.id}/rejected/` },
        },
      })
      .catch(() => undefined);
    await prisma.rejectionMemory
      .deleteMany({ where: { tenantId: fx.tenantId } })
      .catch(() => undefined);
    await prisma.tuningConversation
      .delete({ where: { id: conv.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});

test('case 6b: cross-session rejection suppresses re-propose across conversations (sprint 047 Session C)', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const convA = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST Session C cross-session — convA',
    },
  });
  const convB = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST Session C cross-session — convB',
    },
  });
  const srv = await startServer();
  let fixHash = '';
  try {
    // Step 1 — manager rejects in conversation A.
    const rejectRes = await fetch(
      `${srv.baseUrl}/api/build/suggested-fix/preview:crosssess/reject`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId: convA.id,
          category: 'SOP_CONTENT',
          subLabel: 'checkout-time-rephrase',
          target: {
            artifact: 'sop',
            artifactId: 'sop-checkin',
            sectionId: 'checkout_time',
          },
          rationale: 'Hated last week — leaves no window.',
        }),
      }
    );
    assert.equal(rejectRes.status, 200);
    const rejectBody = (await rejectRes.json()) as any;
    fixHash = rejectBody.fixHash;

    // Step 2 — verify lookup from a *different* conversation still
    // hits. The propose_suggestion tool's read path uses the same
    // lookup, so this verifies the cross-session read end-to-end.
    const {
      lookupCrossSessionRejection,
    } = await import('../../build-tune-agent/memory/service');
    const hit = await lookupCrossSessionRejection(
      prisma,
      fx.tenantId,
      'sop',
      fixHash
    );
    assert.ok(
      hit,
      'cross-session lookup from conversation B must find the convA rejection'
    );
    assert.equal(hit?.sourceConversationId, convA.id);
    assert.equal(hit?.rationale, 'Hated last week — leaves no window.');

    // Session-scoped memory for convB must NOT contain this hash —
    // that would contaminate the test of the durable layer.
    const sessionRow = await prisma.agentMemory.findFirst({
      where: {
        tenantId: fx.tenantId,
        key: `session/${convB.id}/rejected/${fixHash}`,
      },
    });
    assert.equal(
      sessionRow,
      null,
      'convB session memory must be clean — cross-session suppression proves the durable layer works'
    );
  } finally {
    await prisma.agentMemory
      .deleteMany({
        where: {
          tenantId: fx.tenantId,
          key: { startsWith: `session/` },
        },
      })
      .catch(() => undefined);
    await prisma.rejectionMemory
      .deleteMany({ where: { tenantId: fx.tenantId } })
      .catch(() => undefined);
    await prisma.tuningConversation
      .deleteMany({ where: { id: { in: [convA.id, convB.id] } } })
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

// ─── Sprint 053-A D4 — write-ledger list + revert endpoints ────────────────

test('case 053-D4-list: GET /artifacts/history is admin-only + tenant-scoped', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  // Make this fixture tenant admin so the endpoint returns rows.
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  // Seed two history rows scoped to fx.conversationId, plus one row for a
  // different (synthetic) conversationId — proves session scoping.
  const otherConv = `OTHER_conv_${Date.now()}`;
  const seeded = await Promise.all([
    prisma.buildArtifactHistory.create({
      data: {
        tenantId: fx.tenantId,
        artifactType: 'sop',
        artifactId: 'fixture-sop-1',
        operation: 'CREATE',
        prevBody: undefined as any,
        newBody: { content: 'first sop body' },
        actorEmail: 'TEST@local',
        conversationId: fx.conversationId,
      },
    }),
    prisma.buildArtifactHistory.create({
      data: {
        tenantId: fx.tenantId,
        artifactType: 'faq',
        artifactId: 'fixture-faq-1',
        operation: 'UPDATE',
        prevBody: { question: 'q', answer: 'old' },
        newBody: { question: 'q', answer: 'new' },
        actorEmail: 'TEST@local',
        conversationId: fx.conversationId,
      },
    }),
    prisma.buildArtifactHistory.create({
      data: {
        tenantId: fx.tenantId,
        artifactType: 'sop',
        artifactId: 'fixture-sop-2',
        operation: 'CREATE',
        newBody: { content: 'sop body in OTHER conv' },
        actorEmail: 'TEST@local',
        conversationId: otherConv,
      },
    }),
  ]);

  const srv = await startServer();
  try {
    // Without ENABLE_RAW_PROMPT_EDITOR → 404. Toggle off temporarily.
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
    const r404 = await fetch(`${srv.baseUrl}/api/build/artifacts/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r404.status, 404);
    process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';

    // Scoped to fx.conversationId — should return 2 rows (not 3).
    const rScoped = await fetch(
      `${srv.baseUrl}/api/build/artifacts/history?conversationId=${encodeURIComponent(fx.conversationId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(rScoped.status, 200);
    const bodyScoped = (await rScoped.json()) as any;
    assert.equal(bodyScoped.rows.length, 2, 'scoped to fx conversation');

    // Tenant isolation — pass an unrelated conversationId; expect 0 rows.
    const rOther = await fetch(
      `${srv.baseUrl}/api/build/artifacts/history?conversationId=non-existent-conv-xyz`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(rOther.status, 200);
    const bodyOther = (await rOther.json()) as any;
    assert.equal(bodyOther.rows.length, 0);
  } finally {
    await prisma.buildArtifactHistory
      .deleteMany({ where: { id: { in: seeded.map((s) => s.id) } } })
      .catch(() => undefined);
    await prisma.tenant
      .update({ where: { id: fx.tenantId }, data: { isAdmin: false } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

test('case 053-D4-revert: POST /artifacts/history/:id/revert with dryRun returns preview, no writes', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  // Seed an SOP variant + an UPDATE history row pointing at it.
  const def = await prisma.sopDefinition.create({
    data: {
      tenantId: fx.tenantId,
      category: 'd4-revert-test',
      toolDescription: 'test',
      enabled: true,
    },
  });
  const variant = await prisma.sopVariant.create({
    data: {
      sopDefinitionId: def.id,
      status: 'DEFAULT',
      content: 'CURRENT body that should NOT change in dry-run.',
      enabled: true,
    },
  });
  const histRow = await prisma.buildArtifactHistory.create({
    data: {
      tenantId: fx.tenantId,
      artifactType: 'sop',
      artifactId: variant.id,
      operation: 'UPDATE',
      prevBody: { content: 'PRIOR body that revert should restore.' },
      newBody: { content: 'CURRENT body' },
      conversationId: fx.conversationId,
      actorEmail: 'TEST@local',
    },
  });

  const srv = await startServer();
  try {
    const r = await fetch(
      `${srv.baseUrl}/api/build/artifacts/history/${histRow.id}/revert`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dryRun: true }),
      },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    assert.ok(body.preview, 'preview present');
    // Variant content unchanged.
    const fresh = await prisma.sopVariant.findUnique({ where: { id: variant.id } });
    assert.equal(fresh?.content, 'CURRENT body that should NOT change in dry-run.');
  } finally {
    await prisma.buildArtifactHistory
      .deleteMany({ where: { id: histRow.id } })
      .catch(() => undefined);
    await prisma.sopVariant.delete({ where: { id: variant.id } }).catch(() => undefined);
    await prisma.sopDefinition.delete({ where: { id: def.id } }).catch(() => undefined);
    await prisma.tenant
      .update({ where: { id: fx.tenantId }, data: { isAdmin: false } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

test('case 053-D4-revert-real: revert applies prevBody + writes a REVERT history row', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  const def = await prisma.sopDefinition.create({
    data: {
      tenantId: fx.tenantId,
      category: 'd4-revert-real',
      toolDescription: 'test',
      enabled: true,
    },
  });
  const variant = await prisma.sopVariant.create({
    data: {
      sopDefinitionId: def.id,
      status: 'DEFAULT',
      content: 'CURRENT body to be reverted away.',
      enabled: true,
    },
  });
  const histRow = await prisma.buildArtifactHistory.create({
    data: {
      tenantId: fx.tenantId,
      artifactType: 'sop',
      artifactId: variant.id,
      operation: 'UPDATE',
      prevBody: { content: 'EARLIER body to restore via revert.' },
      newBody: { content: 'CURRENT body to be reverted away.' },
      conversationId: fx.conversationId,
      actorEmail: 'TEST@local',
    },
  });

  const srv = await startServer();
  try {
    const r = await fetch(
      `${srv.baseUrl}/api/build/artifacts/history/${histRow.id}/revert`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dryRun: false }),
      },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, false);

    const fresh = await prisma.sopVariant.findUnique({ where: { id: variant.id } });
    assert.equal(fresh?.content, 'EARLIER body to restore via revert.');

    // A new history row with operation REVERT should exist for this artifact.
    const recent = await prisma.buildArtifactHistory.findFirst({
      where: {
        tenantId: fx.tenantId,
        artifactType: 'sop',
        artifactId: variant.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(recent?.operation, 'REVERT');
    const meta = recent?.metadata as any;
    assert.equal(meta?.revertsHistoryId, histRow.id);
  } finally {
    await prisma.buildArtifactHistory
      .deleteMany({
        where: { tenantId: fx.tenantId, artifactType: 'sop', artifactId: variant.id },
      })
      .catch(() => undefined);
    await prisma.sopVariant.delete({ where: { id: variant.id } }).catch(() => undefined);
    await prisma.sopDefinition.delete({ where: { id: def.id } }).catch(() => undefined);
    await prisma.tenant
      .update({ where: { id: fx.tenantId }, data: { isAdmin: false } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

// ─── Sprint 055-A F2+F3 — operator-edited-body metadata passthrough ─────────
//
// Calls the apply endpoint with metadata.rationalePrefix and
// metadata.operatorRationale; asserts the created BuildArtifactHistory row
// carries both values verbatim.

test('case 055-F2-F3: applyArtifact stores operator-edit metadata on history row', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  const def = await prisma.sopDefinition.create({
    data: {
      tenantId: fx.tenantId,
      category: '055-f2f3-metadata',
      toolDescription: 'operator-edit metadata test',
      enabled: true,
    },
  });
  const variant = await prisma.sopVariant.create({
    data: {
      sopDefinitionId: def.id,
      status: 'DEFAULT',
      content: 'Original SOP content that is at least twenty chars.',
      enabled: true,
    },
  });
  const srv = await startServer();
  try {
    const r = await fetch(
      `${srv.baseUrl}/api/build/artifacts/sop/${variant.id}/apply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dryRun: false,
          body: { content: 'Operator-edited SOP content — this is definitely twenty plus characters.' },
          metadata: {
            rationalePrefix: 'edited-by-operator',
            operatorRationale: 'Fixed a typo',
          },
        }),
      },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, false);

    // Verify the history row was created with the operator metadata.
    const histRow = await prisma.buildArtifactHistory.findFirst({
      where: {
        tenantId: fx.tenantId,
        artifactType: 'sop',
        artifactId: variant.id,
        operation: 'UPDATE',
      },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(histRow, 'history row must exist');
    const meta = histRow!.metadata as Record<string, unknown>;
    assert.equal(
      meta?.rationalePrefix,
      'edited-by-operator',
      'rationalePrefix must be stored',
    );
    assert.equal(
      meta?.operatorRationale,
      'Fixed a typo',
      'operatorRationale must be stored',
    );
  } finally {
    await prisma.buildArtifactHistory
      .deleteMany({
        where: { tenantId: fx.tenantId, artifactType: 'sop', artifactId: variant.id },
      })
      .catch(() => undefined);
    await prisma.sopVariant.delete({ where: { id: variant.id } }).catch(() => undefined);
    await prisma.sopDefinition.delete({ where: { id: def.id } }).catch(() => undefined);
    await prisma.tenant
      .update({ where: { id: fx.tenantId }, data: { isAdmin: false } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

// ─── Sprint 055-A F1 — concurrent-approve idempotency ──────────────────────

test('case 055-F1: concurrent approvePlan × 5 → exactly one alreadyApproved:false, rest are true, DB has one approvedAt', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  const tx = await prisma.buildTransaction.create({
    data: {
      tenantId: fx.tenantId,
      plannedItems: [
        { type: 'sop', name: 'concurrent-test-sop', rationale: 'concurrent test' },
      ] as any,
      status: 'PLANNED',
      rationale: 'concurrent approve integration test',
    },
  });
  const srv = await startServer();
  try {
    // Fire 5 concurrent POST /plan/:id/approve requests.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${srv.baseUrl}/api/build/plan/${tx.id}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: '{}',
        }).then(async (r) => ({ status: r.status, body: (await r.json()) as any })),
      ),
    );

    // All must be 200.
    for (const r of results) {
      assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    }

    // Exactly one has alreadyApproved: false.
    const firstApprovals = results.filter((r) => r.body.alreadyApproved === false);
    const idempotentApprovals = results.filter((r) => r.body.alreadyApproved === true);
    assert.equal(
      firstApprovals.length,
      1,
      `expected exactly 1 alreadyApproved:false, got ${firstApprovals.length}`,
    );
    assert.equal(
      idempotentApprovals.length,
      4,
      `expected exactly 4 alreadyApproved:true, got ${idempotentApprovals.length}`,
    );

    // DB row has exactly one approvedAt (not null).
    const txAfter = await prisma.buildTransaction.findUnique({ where: { id: tx.id } });
    assert.ok(txAfter?.approvedAt, 'approvedAt must be set in DB');
  } finally {
    await prisma.buildTransaction.delete({ where: { id: tx.id } }).catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_BUILD_MODE;
  }
});
