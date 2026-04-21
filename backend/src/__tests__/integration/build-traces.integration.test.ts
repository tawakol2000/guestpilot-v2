/**
 * Integration: /api/build/traces + /api/build/capabilities (sprint 047 Session B).
 *
 * Covers:
 *   1. GET /traces with ENABLE_BUILD_TRACE_VIEW unset → 404.
 *   2. GET /traces with flag on but tenant.isAdmin=false → 403.
 *   3. GET /traces with flag on + admin tenant → 200 + rows scoped to tenant,
 *      newest first.
 *   4. GET /traces cursor round-trip: page 1 + page 2 have no id overlap and
 *      together cover every seeded row.
 *   5. GET /traces with tool= and turn= filters narrows correctly.
 *   6. GET /capabilities reflects the flag + isAdmin state.
 *   7. Retention sweep: deleteOldToolCalls respects batch size + createdAt.
 */
import './_env-bootstrap';

import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../../middleware/auth';
import { buildRouter } from '../../routes/build';
import { buildFixture, type IntegrationFixture } from './_fixture';
import { deleteOldToolCalls } from '../../services/build-tool-call-log.service';

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

async function seedToolCalls(
  tenantId: string,
  conversationId: string,
  n: number,
  opts: { tool?: string; turnBase?: number; ageDaysAgo?: number } = {}
) {
  // Seed n rows sequentially so cuid ids increase monotonically → cursor
  // pagination order is predictable.
  const tool = opts.tool ?? 'get_current_state';
  const turnBase = opts.turnBase ?? 1;
  const now = Date.now();
  const createdBase = opts.ageDaysAgo
    ? new Date(now - opts.ageDaysAgo * 24 * 60 * 60 * 1000)
    : null;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = await prisma.buildToolCallLog.create({
      data: {
        tenantId,
        conversationId,
        turn: turnBase + i,
        tool,
        paramsHash: `hash_${i}`,
        durationMs: 10 + i,
        success: true,
        errorMessage: null,
        ...(createdBase
          ? { createdAt: new Date(createdBase.getTime() + i * 1000) }
          : {}),
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return ids;
}

before(async () => {
  fx = await buildFixture(prisma);
  token = signToken({
    tenantId: fx.tenantId,
    email: 'TEST_traces_integration@guestpilot.local',
    plan: 'PRO',
  });
});

after(async () => {
  // Env flags are per-process; clean them so sibling tests aren't affected.
  delete process.env.ENABLE_BUILD_TRACE_VIEW;
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

test('case 1: GET /traces without ENABLE_BUILD_TRACE_VIEW returns 404', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  delete process.env.ENABLE_BUILD_TRACE_VIEW;
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/traces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test('case 2: GET /traces with flag on but non-admin tenant returns 403', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_BUILD_TRACE_VIEW = 'true';
  // Fixture tenant starts with isAdmin=false (schema default).
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: false },
  });
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/traces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('case 3: GET /traces with admin tenant returns tenant-scoped rows, newest first', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_BUILD_TRACE_VIEW = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });

  // Clean any stray rows left from previous cases.
  await prisma.buildToolCallLog.deleteMany({ where: { tenantId: fx.tenantId } });
  const seededIds = await seedToolCalls(fx.tenantId, fx.conversationId, 3);

  const srv = await startServer();
  try {
    const res = await fetch(`${srv.baseUrl}/api/build/traces?limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: any[]; nextCursor: string | null };
    assert.equal(body.rows.length, 3);
    // Newest-first order → seededIds[2] should land at position 0.
    assert.equal(body.rows[0].id, seededIds[2]);
    assert.equal(body.rows[2].id, seededIds[0]);
    for (const r of body.rows) assert.equal(r.conversationId, fx.conversationId);
    assert.equal(body.nextCursor, null);
  } finally {
    await srv.close();
  }
});

test('case 4: cursor pagination — page 1 + page 2 have no overlap and cover every row', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_BUILD_TRACE_VIEW = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });

  await prisma.buildToolCallLog.deleteMany({ where: { tenantId: fx.tenantId } });
  const allIds = await seedToolCalls(fx.tenantId, fx.conversationId, 5);

  const srv = await startServer();
  try {
    const page1Res = await fetch(`${srv.baseUrl}/api/build/traces?limit=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const page1 = (await page1Res.json()) as { rows: any[]; nextCursor: string | null };
    assert.equal(page1.rows.length, 2);
    assert.ok(page1.nextCursor, 'page 1 must return a cursor');

    const page2Res = await fetch(
      `${srv.baseUrl}/api/build/traces?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const page2 = (await page2Res.json()) as { rows: any[]; nextCursor: string | null };
    assert.equal(page2.rows.length, 2);
    assert.ok(page2.nextCursor, 'page 2 must still have a cursor (1 row remains)');

    const page1Ids = new Set(page1.rows.map((r) => r.id));
    const page2Ids = new Set(page2.rows.map((r) => r.id));
    for (const id of page1Ids) assert.ok(!page2Ids.has(id), `id ${id} duplicated across pages`);

    const page3Res = await fetch(
      `${srv.baseUrl}/api/build/traces?limit=2&cursor=${encodeURIComponent(page2.nextCursor!)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const page3 = (await page3Res.json()) as { rows: any[]; nextCursor: string | null };
    assert.equal(page3.rows.length, 1);
    assert.equal(page3.nextCursor, null);

    const covered = new Set<string>([
      ...page1.rows.map((r) => r.id),
      ...page2.rows.map((r) => r.id),
      ...page3.rows.map((r) => r.id),
    ]);
    for (const id of allIds) assert.ok(covered.has(id), `row ${id} missing from paged result`);
  } finally {
    await srv.close();
  }
});

test('case 5: tool + turn filters narrow the result set', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_BUILD_TRACE_VIEW = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });

  await prisma.buildToolCallLog.deleteMany({ where: { tenantId: fx.tenantId } });
  await seedToolCalls(fx.tenantId, fx.conversationId, 2, { tool: 'get_current_state', turnBase: 1 });
  await seedToolCalls(fx.tenantId, fx.conversationId, 3, { tool: 'propose_suggestion', turnBase: 10 });

  const srv = await startServer();
  try {
    const toolRes = await fetch(
      `${srv.baseUrl}/api/build/traces?tool=propose_suggestion`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const toolBody = (await toolRes.json()) as { rows: any[] };
    assert.equal(toolBody.rows.length, 3);
    for (const r of toolBody.rows) assert.equal(r.tool, 'propose_suggestion');

    const turnRes = await fetch(`${srv.baseUrl}/api/build/traces?turn=11`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const turnBody = (await turnRes.json()) as { rows: any[] };
    assert.equal(turnBody.rows.length, 1);
    assert.equal(turnBody.rows[0].turn, 11);
  } finally {
    await srv.close();
  }
});

test('case 6: GET /capabilities reflects flag + isAdmin state', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_BUILD_TRACE_VIEW = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });

  const srv = await startServer();
  try {
    const on = await fetch(`${srv.baseUrl}/api/build/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(on.status, 200);
    const onBody = (await on.json()) as {
      traceViewEnabled: boolean;
      rawPromptEditorEnabled: boolean;
      isAdmin: boolean;
    };
    assert.equal(onBody.traceViewEnabled, true);
    assert.equal(onBody.rawPromptEditorEnabled, true);
    assert.equal(onBody.isAdmin, true);

    delete process.env.ENABLE_BUILD_TRACE_VIEW;
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
    await prisma.tenant.update({
      where: { id: fx.tenantId },
      data: { isAdmin: false },
    });
    const off = await fetch(`${srv.baseUrl}/api/build/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(off.status, 200);
    const offBody = (await off.json()) as {
      traceViewEnabled: boolean;
      rawPromptEditorEnabled: boolean;
      isAdmin: boolean;
    };
    assert.equal(offBody.traceViewEnabled, false);
    assert.equal(offBody.rawPromptEditorEnabled, false);
    assert.equal(offBody.isAdmin, false);
  } finally {
    await srv.close();
  }
});

// ─── Sprint 047 Session C — raw-prompt editor drawer integration ─────────

test('case 8a: GET /system-prompt without ENABLE_RAW_PROMPT_EDITOR returns 404', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/system-prompt?conversationId=${encodeURIComponent(fx.conversationId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test('case 8b: GET /system-prompt with flag on but non-admin tenant returns 403', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: false },
  });
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/system-prompt?conversationId=${encodeURIComponent(fx.conversationId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

test('case 8c: GET /system-prompt with admin tenant returns three regions + assembled body', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  // The fixture's conversationId is a Message conversation, not a
  // TuningConversation; stand one up for this admin call.
  const conv = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST Session C raw-prompt read',
    },
  });
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/system-prompt?conversationId=${encodeURIComponent(conv.id)}&mode=BUILD`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as {
      mode: string;
      conversationId: string;
      regions: { shared: string; modeAddendum: string; dynamic: string };
      assembled: string;
      bytes: {
        shared: number;
        modeAddendum: number;
        dynamic: number;
        total: number;
      };
    };
    assert.equal(body.mode, 'BUILD');
    assert.equal(body.conversationId, conv.id);
    // Each region must be non-empty and the assembled body must
    // contain each region substring so downstream consumers can
    // round-trip without re-assembly.
    assert.ok(body.regions.shared.length > 0, 'shared region non-empty');
    assert.ok(body.regions.modeAddendum.length > 0, 'mode addendum non-empty');
    assert.ok(body.regions.dynamic.length > 0, 'dynamic suffix non-empty');
    assert.ok(body.assembled.includes(body.regions.shared));
    assert.ok(body.assembled.includes(body.regions.modeAddendum));
    assert.ok(body.assembled.includes(body.regions.dynamic));
    assert.ok(body.bytes.total >= body.bytes.shared);
    // BUILD mode emits <build_mode> (not <tune_mode>) in the addendum.
    assert.ok(
      body.regions.modeAddendum.includes('build_mode'),
      'BUILD mode addendum must reference build_mode',
    );
  } finally {
    await prisma.tuningConversation
      .delete({ where: { id: conv.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

test('case 8d: GET /system-prompt with mode=TUNE returns TUNE addendum', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  const conv = await prisma.tuningConversation.create({
    data: {
      tenantId: fx.tenantId,
      triggerType: 'MANUAL',
      title: 'TEST Session C raw-prompt TUNE mode',
    },
  });
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/system-prompt?conversationId=${encodeURIComponent(conv.id)}&mode=TUNE`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      mode: string;
      regions: { modeAddendum: string };
    };
    assert.equal(body.mode, 'TUNE');
    assert.ok(
      body.regions.modeAddendum.includes('tune_mode'),
      'TUNE mode addendum must reference tune_mode',
    );
  } finally {
    await prisma.tuningConversation
      .delete({ where: { id: conv.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

test('case 8e: GET /system-prompt on a non-owned conversation returns 404', async () => {
  process.env.ENABLE_BUILD_MODE = 'true';
  process.env.ENABLE_RAW_PROMPT_EDITOR = 'true';
  await prisma.tenant.update({
    where: { id: fx.tenantId },
    data: { isAdmin: true },
  });
  // Mint a second tenant + conversation owned by it; admin tenant must
  // not be able to read across tenants even with isAdmin=true.
  const otherTenant = await prisma.tenant.create({
    data: {
      email: `TEST_other_${Date.now()}@guestpilot.local`,
      name: 'TEST other tenant',
      passwordHash: 'TEST',
      hostawayApiKey: 'TEST',
      hostawayAccountId: `TEST_other_${Date.now()}`,
    },
  });
  const otherConv = await prisma.tuningConversation.create({
    data: {
      tenantId: otherTenant.id,
      triggerType: 'MANUAL',
      title: 'TEST Session C — other tenant conv',
    },
  });
  const srv = await startServer();
  try {
    const res = await fetch(
      `${srv.baseUrl}/api/build/system-prompt?conversationId=${encodeURIComponent(otherConv.id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
  } finally {
    await prisma.tuningConversation
      .delete({ where: { id: otherConv.id } })
      .catch(() => undefined);
    await prisma.tenant
      .delete({ where: { id: otherTenant.id } })
      .catch(() => undefined);
    await srv.close();
    delete process.env.ENABLE_RAW_PROMPT_EDITOR;
  }
});

test('case 7: deleteOldToolCalls deletes only rows older than threshold, honours batch', async () => {
  await prisma.buildToolCallLog.deleteMany({ where: { tenantId: fx.tenantId } });
  // Seed 4 old + 2 fresh rows.
  await seedToolCalls(fx.tenantId, fx.conversationId, 4, { ageDaysAgo: 60, turnBase: 1 });
  await seedToolCalls(fx.tenantId, fx.conversationId, 2, { turnBase: 100 });

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // First pass: batch of 2 → deletes 2 of the 4 old rows.
  const first = await deleteOldToolCalls(prisma, cutoff, 2);
  assert.equal(first, 2);

  // Second pass: batch of 10 → deletes the remaining 2 old rows only.
  const second = await deleteOldToolCalls(prisma, cutoff, 10);
  assert.equal(second, 2);

  // Third pass: nothing to delete.
  const third = await deleteOldToolCalls(prisma, cutoff, 10);
  assert.equal(third, 0);

  const remaining = await prisma.buildToolCallLog.count({ where: { tenantId: fx.tenantId } });
  assert.equal(remaining, 2); // the two fresh rows
});
