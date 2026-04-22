/**
 * F1.3 — history-replay unit tests (sprint 059-A Stream B).
 *
 * Run: npx tsx --test src/build-tune-agent/__tests__/history-replay.test.ts
 *
 * Verifies:
 *   1. Empty conversation → empty array.
 *   2. 3 user + 3 assistant turns → 6-entry array, order preserved.
 *   3. Assistant turn with tool_use preserved verbatim (content is array).
 *   4. User turn with tool_result preserved verbatim.
 *   5. persistAssistantTurn writes exactly one row.
 *   6. Concurrent persistAssistantTurn does not interleave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConversationHistory,
  persistAssistantTurn,
} from '../direct/history-replay';

type FakeRow = {
  conversationId: string;
  role: 'user' | 'assistant';
  parts: unknown;
  createdAt: Date;
};

function makePrismaStub(rows: FakeRow[] = []) {
  const creates: Array<{ conversationId: string; role: string; parts: unknown }> = [];
  // Track transaction serialisation: each $transaction call takes the lock
  // before resolving. We simulate row-lock serialisation by only executing
  // one tx body at a time, so concurrent calls interleave row-by-row
  // rather than field-by-field.
  let txInFlight = Promise.resolve();
  const prisma: any = {
    tuningMessage: {
      findMany: async ({ where, orderBy }: any) => {
        assert.equal(orderBy.createdAt, 'asc');
        return rows
          .filter((r) => r.conversationId === where.conversationId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((r) => ({ role: r.role, parts: r.parts }));
      },
      create: async ({ data }: any) => {
        creates.push({
          conversationId: data.conversationId,
          role: data.role,
          parts: data.parts,
        });
        return { id: 'tm_' + creates.length };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<void>) => {
      const prev = txInFlight;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      txInFlight = gate;
      try {
        await prev;
        await fn(prisma);
      } finally {
        release();
      }
    },
  };
  return { prisma, creates };
}

test('loadConversationHistory: empty conversation → empty array', async () => {
  const { prisma } = makePrismaStub();
  const out = await loadConversationHistory(prisma, 'conv_none');
  assert.deepEqual(out, []);
});

test('loadConversationHistory: 3 user + 3 assistant turns preserved in createdAt order', async () => {
  const rows: FakeRow[] = [
    { conversationId: 'c1', role: 'user', parts: [{ type: 'text', text: 'u1' }], createdAt: new Date(1) },
    { conversationId: 'c1', role: 'assistant', parts: [{ type: 'text', text: 'a1' }], createdAt: new Date(2) },
    { conversationId: 'c1', role: 'user', parts: [{ type: 'text', text: 'u2' }], createdAt: new Date(3) },
    { conversationId: 'c1', role: 'assistant', parts: [{ type: 'text', text: 'a2' }], createdAt: new Date(4) },
    { conversationId: 'c1', role: 'user', parts: [{ type: 'text', text: 'u3' }], createdAt: new Date(5) },
    { conversationId: 'c1', role: 'assistant', parts: [{ type: 'text', text: 'a3' }], createdAt: new Date(6) },
  ];
  const { prisma } = makePrismaStub(rows);
  const out = await loadConversationHistory(prisma, 'c1');
  assert.equal(out.length, 6);
  assert.deepEqual(out[0], { role: 'user', content: 'u1' });
  assert.deepEqual(out[1], { role: 'assistant', content: 'a1' });
  assert.deepEqual(out[5], { role: 'assistant', content: 'a3' });
});

test('loadConversationHistory: assistant tool_use block preserved verbatim', async () => {
  const rows: FakeRow[] = [
    {
      conversationId: 'c2',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'I will look that up.' },
        {
          type: 'tool-call',
          toolCallId: 'toolu_abc',
          toolName: 'mcp__tuning-agent__get_context',
          input: { scope: 'summary' },
        },
      ],
      createdAt: new Date(10),
    },
  ];
  const { prisma } = makePrismaStub(rows);
  const out = await loadConversationHistory(prisma, 'c2');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  const content = out[0].content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content), 'content is array when tool_use present');
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: 'text', text: 'I will look that up.' });
  assert.deepEqual(content[1], {
    type: 'tool_use',
    id: 'toolu_abc',
    name: 'mcp__tuning-agent__get_context',
    input: { scope: 'summary' },
  });
});

test('loadConversationHistory: user tool_result block preserved verbatim', async () => {
  const rows: FakeRow[] = [
    {
      conversationId: 'c3',
      role: 'user',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'toolu_abc',
          output: { ok: true, count: 3 },
        },
      ],
      createdAt: new Date(20),
    },
  ];
  const { prisma } = makePrismaStub(rows);
  const out = await loadConversationHistory(prisma, 'c3');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  const content = out[0].content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content), 'content is array when tool_result present');
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'tool_result');
  assert.equal(content[0].tool_use_id, 'toolu_abc');
  // Output is JSON-stringified into `content` (Anthropic tool_result shape
  // accepts either string or block-array; string is simplest for replay).
  assert.equal(content[0].content, JSON.stringify({ ok: true, count: 3 }));
});

test('loadConversationHistory: user tool_result via Vercel tool-<name> state=output-available', async () => {
  const rows: FakeRow[] = [
    {
      conversationId: 'c3b',
      role: 'user',
      parts: [
        {
          type: 'tool-mcp__tuning-agent__get_context',
          toolCallId: 'toolu_xyz',
          state: 'output-available',
          output: 'plain result',
        },
      ],
      createdAt: new Date(30),
    },
  ];
  const { prisma } = makePrismaStub(rows);
  const out = await loadConversationHistory(prisma, 'c3b');
  const content = out[0].content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, 'tool_result');
  assert.equal(content[0].tool_use_id, 'toolu_xyz');
  assert.equal(content[0].content, 'plain result');
});

test('persistAssistantTurn: writes exactly one row', async () => {
  const { prisma, creates } = makePrismaStub();
  await persistAssistantTurn(prisma, 'c4', { content: 'hello world' });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].conversationId, 'c4');
  assert.equal(creates[0].role, 'assistant');
  assert.deepEqual(creates[0].parts, [{ type: 'text', text: 'hello world' }]);
});

test('persistAssistantTurn: concurrent calls do not interleave, write distinct rows', async () => {
  const { prisma, creates } = makePrismaStub();
  await Promise.all([
    persistAssistantTurn(prisma, 'c5', { content: 'first' }),
    persistAssistantTurn(prisma, 'c5', { content: 'second' }),
  ]);
  assert.equal(creates.length, 2, 'two distinct rows written');
  // Each row's parts array is intact (not corrupted by interleaving).
  for (const c of creates) {
    assert.ok(Array.isArray(c.parts), 'parts is an array, not a merged scalar');
    assert.equal((c.parts as any[]).length, 1);
  }
  const texts = creates.map((c) => (c.parts as any[])[0].text).sort();
  assert.deepEqual(texts, ['first', 'second']);
});

test('persistAssistantTurn: content with tool_use block → tool-call Vercel part', async () => {
  const { prisma, creates } = makePrismaStub();
  await persistAssistantTurn(prisma, 'c6', {
    content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'toolu_z', name: 'create_faq', input: { q: 'q' } },
    ],
  });
  assert.equal(creates.length, 1);
  const parts = creates[0].parts as any[];
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: 'text', text: 'ok' });
  assert.equal(parts[1].type, 'tool-call');
  assert.equal(parts[1].toolCallId, 'toolu_z');
  assert.equal(parts[1].toolName, 'create_faq');
  assert.deepEqual(parts[1].input, { q: 'q' });
});

test('loadConversationHistory: truncates to last 50 turns with WARN', async () => {
  const rows: FakeRow[] = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push({
      conversationId: 'c_big',
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `m${i}` }],
      createdAt: new Date(i + 100),
    });
  }
  const { prisma } = makePrismaStub(rows);
  const originalWarn = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };
  try {
    const out = await loadConversationHistory(prisma, 'c_big');
    assert.equal(out.length, 50);
    // First surviving entry is m10 (60 - 50 = 10).
    assert.equal((out[0].content as string), 'm10');
    assert.ok(warnCount >= 1, 'truncation emits WARN');
  } finally {
    console.warn = originalWarn;
  }
});
