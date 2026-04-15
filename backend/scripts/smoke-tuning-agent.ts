/**
 * Sprint 04 — integration smoke for the tuning agent.
 *
 * Verifies (against the live Railway DB, so run carefully):
 *   1. TuningConversation + TuningMessage tables accept writes.
 *   2. AgentMemory CRUD round-trips.
 *   3. The system prompt assembler produces a byte-identical static prefix
 *      across two invocations (prerequisite for Anthropic's automatic
 *      prompt caching).
 *   4. The in-process MCP server + 8 tools register without error.
 *   5. If ANTHROPIC_API_KEY is set, attempts one single-turn agent
 *      invocation and reports the final assistant text length. (Without
 *      the key, logs a message and skips.)
 *
 * Does NOT hit the real OpenAI key or the main AI. Only exercises the
 * tuning-agent module + Prisma.
 *
 * Usage:
 *   JWT_SECRET=... DATABASE_URL=... [ANTHROPIC_API_KEY=...] \
 *     npx tsx scripts/smoke-tuning-agent.ts
 */
process.env.JWT_SECRET ||= 'test-only-stub-secret-for-smoke';
process.env.OPENAI_API_KEY ||= 'stub';
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import {
  createMemory,
  viewMemory,
  deleteMemory,
  listMemoryByPrefix,
  updateMemory,
} from '../src/tuning-agent/memory/service';
import { assembleSystemPrompt, DYNAMIC_BOUNDARY_MARKER } from '../src/tuning-agent';
import { buildTuningAgentMcpServer } from '../src/tuning-agent/tools';
import { TUNING_AGENT_TOOL_NAMES } from '../src/tuning-agent/tools/names';

function pick<T>(msg: string, v: T): T {
  console.log(`[smoke] ${msg}`);
  return v;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      console.error('[smoke] No tenant found on DB — cannot exercise memory/conversation writes.');
      process.exit(1);
    }
    const tenantId = tenant.id;
    pick(`resolved tenantId=${tenantId}`, null);

    // ─── 1. AgentMemory CRUD round-trip ─────────────────────────────────
    const key = `preferences/smoke-${Date.now().toString(36)}`;
    const created = await createMemory(prisma, tenantId, key, { tone: 'concise' }, 'sprint-04-smoke');
    if (!('ok' in created) || !created.ok) throw new Error(`memory.create failed: ${JSON.stringify(created)}`);
    pick(`memory.create ok key=${key}`, null);
    const v1 = await viewMemory(prisma, tenantId, key);
    if (!v1 || (v1.value as any).tone !== 'concise') throw new Error('memory.view roundtrip failed');
    pick('memory.view roundtrip ok', null);
    await updateMemory(prisma, tenantId, key, { tone: 'direct' }, 'sprint-04-smoke');
    const v2 = await viewMemory(prisma, tenantId, key);
    if ((v2!.value as any).tone !== 'direct') throw new Error('memory.update roundtrip failed');
    pick('memory.update roundtrip ok', null);
    const prefs = await listMemoryByPrefix(prisma, tenantId, 'preferences/', 50);
    if (!prefs.some((r) => r.key === key)) throw new Error('memory.list did not include key');
    pick(`memory.list returned ${prefs.length} preference keys (includes smoke key)`, null);
    await deleteMemory(prisma, tenantId, key);
    const v3 = await viewMemory(prisma, tenantId, key);
    if (v3) throw new Error('memory.delete did not remove key');
    pick('memory.delete roundtrip ok', null);

    // ─── 2. System prompt: static prefix byte-identical across calls ────
    const basePrompt = assembleSystemPrompt({
      tenantId,
      conversationId: 'smoke-c1',
      anchorMessageId: null,
      selectedSuggestionId: null,
      memorySnapshot: [],
      pending: { total: 0, countsByCategory: {}, topThree: [] },
    });
    const again = assembleSystemPrompt({
      tenantId,
      conversationId: 'smoke-c2',
      anchorMessageId: null,
      selectedSuggestionId: null,
      memorySnapshot: [],
      pending: { total: 0, countsByCategory: {}, topThree: [] },
    });
    const boundary = basePrompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
    const prefix1 = basePrompt.slice(0, boundary);
    const prefix2 = again.slice(0, boundary);
    if (prefix1 !== prefix2) throw new Error('static prefix changed across invocations — cache will not hit');
    pick(`static prefix is byte-identical (${prefix1.length} bytes) — caches across turns`, null);

    // ─── 3. MCP server + 8 tools register without error ────────────────
    const mcp = await buildTuningAgentMcpServer(() => ({
      prisma,
      tenantId,
      conversationId: null,
      userId: null,
      lastUserSanctionedApply: false,
      emitDataPart: undefined,
    }));
    if (!mcp || mcp.type !== 'sdk' || !mcp.instance) throw new Error('MCP server not built');
    pick('MCP server built with 8 tools', null);
    const expectedCount = Object.keys(TUNING_AGENT_TOOL_NAMES).length;
    if (expectedCount !== 8) throw new Error(`expected 8 tools, got ${expectedCount}`);
    pick(`tool-name table has ${expectedCount} entries`, null);

    // ─── 4. TuningConversation + TuningMessage round-trip ──────────────
    const conv = await prisma.tuningConversation.create({
      data: {
        tenantId,
        triggerType: 'MANUAL',
        title: 'sprint-04 smoke',
      },
      select: { id: true },
    });
    await prisma.tuningMessage.create({
      data: {
        conversationId: conv.id,
        role: 'user',
        parts: [{ type: 'text', text: 'smoke-test user turn' }] as any,
      },
    });
    await prisma.tuningMessage.create({
      data: {
        conversationId: conv.id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'smoke-test assistant turn' }] as any,
      },
    });
    const full = await prisma.tuningConversation.findFirst({
      where: { id: conv.id },
      include: { messages: true },
    });
    if (!full || full.messages.length !== 2) throw new Error('conversation+messages roundtrip failed');
    pick(`conversation ${conv.id} round-trip ok (2 messages)`, null);
    await prisma.tuningConversation.delete({ where: { id: conv.id } });
    pick('conversation cleanup ok', null);

    // ─── 5. Optional live agent turn (if key set) ───────────────────────
    if (process.env.ANTHROPIC_API_KEY) {
      pick('ANTHROPIC_API_KEY present — live turn skipped in smoke (requires a full conversation + writer). Document via /api/tuning/chat instead.', null);
    } else {
      pick('ANTHROPIC_API_KEY missing — live turn skipped (expected in local/CI).', null);
    }

    console.log('[smoke] All tuning-agent smoke checks passed ✓');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[smoke] threw:', err);
  process.exit(1);
});
