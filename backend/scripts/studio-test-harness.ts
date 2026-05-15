/**
 * Studio test harness — drive the tuning agent end-to-end from CLI.
 *
 * Use cases:
 *   - Smoke-test a real OpenAI / Anthropic round-trip without the frontend.
 *   - Verify a polish change behaves as intended in a real session.
 *   - Score the agent's response on a scenario, qualitatively or by counting
 *     specific data-parts in the resulting stream.
 *
 * Usage:
 *   npx tsx scripts/studio-test-harness.ts <tenantId> '<user message>' [conversationId] [provider]
 *
 *   - tenantId: required.
 *   - user message: required, the turn the harness drives.
 *   - conversationId: optional. If omitted, a fresh TuningConversation is
 *     created and printed at the end so subsequent invocations can resume.
 *   - provider: optional, 'openai' (default) | 'anthropic'.
 *
 * The harness collects every UIMessageChunk emitted by the runner, groups
 * them by type, and prints a digest + the assistant's final visible text.
 * It does NOT delete the test conversation — the operator can keep
 * driving it, or delete it manually when done.
 */
import * as dotenv from 'dotenv';
// Force override so a stale empty ANTHROPIC_API_KEY=/OPENAI_API_KEY= in
// the parent shell doesn't shadow the real values in .env.
dotenv.config({ override: true });
// 2026-05-15: harness dry-run mode. Block any write tool from mutating
// live artifacts (system prompts, SOPs, FAQs, tool definitions). The
// agent still sees a successful apply payload so its downstream flow
// exercises end-to-end, but the underlying state stays untouched.
// Set STUDIO_HARNESS_DRY_RUN=false to opt out (e.g. to capture a real
// before/after for a regression test).
if (process.env.STUDIO_HARNESS_DRY_RUN !== 'false') {
  process.env.STUDIO_HARNESS_DRY_RUN = 'true';
}
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { runTuningAgentTurn } from '../src/build-tune-agent/runtime';

const prisma = new PrismaClient();

async function main() {
  const tenantId = process.argv[2];
  const message = process.argv[3];
  let conversationId: string | undefined = process.argv[4];
  const provider = (process.argv[5] ?? 'openai') as 'openai' | 'anthropic';
  const mode = ((process.argv[6] ?? 'TUNE').toUpperCase() === 'BUILD' ? 'BUILD' : 'TUNE') as 'BUILD' | 'TUNE';

  if (!tenantId || !message) {
    console.error(
      'Usage: tsx scripts/studio-test-harness.ts <tenantId> "<message>" [conversationId] [openai|anthropic]',
    );
    process.exit(1);
  }

  // Verify tenant exists.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true },
  });
  if (!tenant) {
    console.error(`Tenant ${tenantId} not found`);
    process.exit(1);
  }
  console.log(`[harness] tenant=${tenant.id} (${tenant.name})`);

  if (!conversationId) {
    const conv = await prisma.tuningConversation.create({
      data: {
        tenantId,
        triggerType: 'MANUAL',
        title: '[harness test]',
      },
    });
    conversationId = conv.id;
    console.log(`[harness] created conversation ${conversationId}`);
  } else {
    const conv = await prisma.tuningConversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true },
    });
    if (!conv) {
      console.error(`Conversation ${conversationId} not found for tenant ${tenantId}`);
      process.exit(1);
    }
    console.log(`[harness] resuming conversation ${conversationId}`);
  }

  // Persist user message so the runner's history-replay sees it.
  await prisma.tuningMessage.create({
    data: {
      conversationId,
      role: 'user',
      parts: [{ type: 'text', text: message }] as any,
    },
  });

  // Capture every chunk the runner writes.
  const chunks: any[] = [];
  const writer: any = {
    write: (chunk: any) => {
      chunks.push(chunk);
    },
    merge: () => {},
    onError: (err: any) => {
      console.error(`[harness] writer.onError:`, err?.message ?? err);
    },
  };

  const assistantMessageId = `asst:${randomBytes(8).toString('hex')}`;
  const turnStart = Date.now();

  let result: any;
  try {
    result = await runTuningAgentTurn({
      prisma,
      tenantId,
      userId: null,
      conversationId,
      userMessage: message,
      selectedSuggestionId: null,
      assistantMessageId,
      writer,
      providerOverride: provider,
      mode,
    } as any);
  } catch (err: any) {
    console.error(`\n[harness] runTuningAgentTurn threw:`, err?.message ?? err);
    console.error(err?.stack ?? '');
    await prisma.$disconnect();
    process.exit(2);
  }

  const turnMs = Date.now() - turnStart;

  // Persist assistant message so future harness invocations see it.
  const assistantParts = chunks
    .filter((c) => !c?.transient && (c.type === 'text-delta' || c.type?.startsWith('data-') || c.type === 'tool-input-available' || c.type === 'tool-output-available'))
    .reduce((acc: any[], c: any) => {
      if (c.type === 'text-delta' && c.delta) {
        const last = acc[acc.length - 1];
        if (last?.type === 'text') {
          last.text += c.delta;
        } else {
          acc.push({ type: 'text', text: c.delta });
        }
      } else if (c.type?.startsWith('data-')) {
        acc.push(c);
      } else if (c.type === 'tool-input-available') {
        acc.push({ type: 'tool-input-available', toolName: c.toolName, input: c.input });
      } else if (c.type === 'tool-output-available') {
        acc.push({ type: 'tool-output-available', output: c.output });
      }
      return acc;
    }, []);

  await prisma.tuningMessage.create({
    data: {
      conversationId,
      role: 'assistant',
      parts: assistantParts as any,
    },
  });

  // ─── Print digest ─────────────────────────────────────────────────────
  const byType = new Map<string, number>();
  for (const c of chunks) {
    const t = c?.type ?? 'unknown';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }

  console.log(`\n=== TURN DIGEST (${turnMs}ms, ${chunks.length} chunks) ===`);
  for (const [t, n] of [...byType.entries()].sort()) {
    console.log(`  ${t}: ${n}`);
  }

  // Visible text
  const visibleText = chunks
    .filter((c) => c.type === 'text-delta' && typeof c.delta === 'string')
    .map((c) => c.delta)
    .join('');
  console.log(`\n--- ASSISTANT VISIBLE TEXT ---\n${visibleText.trim()}\n`);

  // Tool calls
  const toolCalls = chunks.filter((c) => c.type === 'tool-input-available');
  if (toolCalls.length) {
    console.log(`--- TOOL CALLS (${toolCalls.length}) ---`);
    for (const tc of toolCalls) {
      const input = JSON.stringify(tc.input).slice(0, 240);
      console.log(`  ${tc.toolName ?? '?'}: ${input}`);
    }
  }

  // Data parts (non-transient, sketch of what frontend would render)
  const dataParts = chunks.filter((c) => typeof c.type === 'string' && c.type.startsWith('data-'));
  if (dataParts.length) {
    console.log(`\n--- DATA PARTS (${dataParts.length}) ---`);
    for (const dp of dataParts) {
      const data = JSON.stringify(dp.data).slice(0, 240);
      console.log(`  ${dp.type}: ${data}`);
    }
  }

  // Errors
  const errors = chunks.filter((c) => c.type === 'error');
  if (errors.length) {
    console.log(`\n--- ERRORS ---`);
    for (const e of errors) console.log(`  ${e.errorText ?? JSON.stringify(e)}`);
  }

  console.log(`\n=== conversationId for next turn: ${conversationId} ===\n`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[harness] fatal:', err);
  await prisma.$disconnect();
  process.exit(1);
});
