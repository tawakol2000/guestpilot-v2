/**
 * dump-studio-conversation.ts — comprehensive Studio session dump for debugging.
 *
 * Pulls a single TuningConversation and writes a self-contained markdown
 * file with everything needed to debug what the agent did and why:
 *
 *   - Conversation metadata + final state-machine snapshot
 *   - Every TuningMessage (user + assistant) with full parts:
 *       - assistant text + reasoning (if persisted)
 *       - tool calls with full input + full output (NOT truncated)
 *       - data-parts (state snapshots, question_choices, suggested-fix,
 *         test-pipeline-result, session-diff-summary, etc.)
 *   - BuildToolCallLog timings per tool call (cross-referenced by name)
 *   - The reconstructed system prompt as it would render TODAY for the
 *     conversation's current snapshot (best-effort — see caveats below)
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/dump-studio-conversation.ts <conversationId>
 *
 *   # Custom output path:
 *   npx tsx scripts/dump-studio-conversation.ts <conversationId> --out /tmp/foo.md
 *
 *   # Find recent conversations for a tenant:
 *   npx tsx scripts/dump-studio-conversation.ts --list <tenantId>
 *
 * Default output path: /tmp/studio-dump-<conversationId>-<isodate>.md
 *
 * CAVEATS:
 *
 * 1. The system prompt is reconstructed using the CURRENT templates
 *    (system-prompt.ts) plus the conversation's CURRENT snapshot and the
 *    CURRENT tenant state. If the templates have been edited or the
 *    tenant state has drifted since the conversation ran, the reproduction
 *    will NOT be byte-identical to what the agent actually saw at any
 *    historical turn. To get an exact past-turn prompt, you'd need to
 *    persist it per-turn (see the BuildTurnDebugTrace TODO in
 *    sdk-runner.ts) — not done yet to avoid schema churn.
 *
 * 2. Reasoning blocks (Sonnet <thinking>, GPT-5.4 reasoning tokens) are
 *    NOT persisted to TuningMessage.parts today. They stream live during
 *    the turn and are dropped. The dump will show "[reasoning not
 *    captured]" in those slots until the runners are extended.
 *
 * 3. Token usage per turn is emitted via the transient data-cache-stats
 *    SSE part, which is NOT persisted. The dump cross-references
 *    BuildToolCallLog durations as a proxy for compute work but cannot
 *    show input/output token counts without the transient data.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  assembleSystemPrompt,
  type SystemPromptContext,
  type AgentMode,
} from '../src/build-tune-agent/system-prompt';
import { coerceSnapshot } from '../src/build-tune-agent/state-machine';
import { listMemoryForSnapshot } from '../src/build-tune-agent/memory/service';
import {
  getTenantStateSummary,
  getInterviewProgressSummary,
} from '../src/services/tenant-state.service';

const HORIZONTAL_RULE = '\n\n---\n\n';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function fmtJson(v: unknown, indent = 2): string {
  try {
    return JSON.stringify(v, null, indent);
  } catch {
    return String(v);
  }
}

interface ToolCallLogIndex {
  byTurn: Map<number, Array<{ tool: string; durationMs: number; success: boolean; errorMessage: string | null; createdAt: Date }>>;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/dump-studio-conversation.ts <conversationId> [--out <path>]');
    console.error('       npx tsx scripts/dump-studio-conversation.ts --list <tenantId>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    if (args[0] === '--list') {
      const tenantId = args[1];
      if (!tenantId) {
        console.error('--list requires a tenantId.');
        process.exit(1);
      }
      const convs = await prisma.tuningConversation.findMany({
        where: { tenantId },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          triggerType: true,
          stateMachineSnapshot: true,
          _count: { select: { messages: true } },
        },
      });
      console.log(`Recent conversations for tenant ${tenantId}:\n`);
      for (const c of convs) {
        const s = coerceSnapshot(c.stateMachineSnapshot ?? null);
        console.log(`  ${c.id}  msgs=${c._count.messages.toString().padStart(3)}  ${s.outer_mode}/${s.inner_state.padEnd(9)}  ${c.updatedAt.toISOString().slice(0, 19)}  "${(c.title ?? '(untitled)').slice(0, 60)}"`);
      }
      return;
    }

    const conversationId = args[0];
    const outFlag = args.indexOf('--out');
    const outPath =
      outFlag >= 0 && args[outFlag + 1]
        ? args[outFlag + 1]
        : `/tmp/studio-dump-${conversationId}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`;

    const conv = await prisma.tuningConversation.findUnique({
      where: { id: conversationId },
      include: {
        anchorMessage: {
          select: { id: true, content: true, role: true, sentAt: true, channel: true },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, createdAt: true, parts: true },
        },
      },
    });
    if (!conv) {
      console.error(`Conversation ${conversationId} not found.`);
      process.exit(2);
    }

    // Cross-reference BuildToolCallLog by turn.
    const toolLogs = await prisma.buildToolCallLog.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { tool: true, turn: true, durationMs: true, success: true, errorMessage: true, createdAt: true },
    });
    const toolIndex: ToolCallLogIndex = { byTurn: new Map() };
    for (const t of toolLogs) {
      const arr = toolIndex.byTurn.get(t.turn) ?? [];
      arr.push(t);
      toolIndex.byTurn.set(t.turn, arr);
    }

    // Reconstruct the system prompt using CURRENT templates + tenant state.
    let reconstructedPrompt = '';
    let reconstructionNote = '';
    try {
      const snapshot = coerceSnapshot(conv.stateMachineSnapshot ?? null);
      const mode: AgentMode = snapshot.outer_mode;
      const [memory, pending, pendingTotal, tenantState, interviewProgress] =
        await Promise.all([
          listMemoryForSnapshot(prisma, conv.tenantId, 50),
          prisma.tuningSuggestion.findMany({
            where: { tenantId: conv.tenantId, status: 'PENDING' },
            orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
            take: 10,
            select: {
              id: true,
              diagnosticCategory: true,
              diagnosticSubLabel: true,
              confidence: true,
              rationale: true,
              createdAt: true,
            },
          }),
          prisma.tuningSuggestion.count({
            where: { tenantId: conv.tenantId, status: 'PENDING' },
          }),
          getTenantStateSummary(prisma, conv.tenantId).catch(() => null),
          getInterviewProgressSummary(prisma, conv.tenantId, conversationId).catch(() => null),
        ]);
      const countsByCategory = pending.reduce<Record<string, number>>((acc, s) => {
        const k = s.diagnosticCategory ?? 'LEGACY';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      const runtimeTenantState = tenantState
        ? {
            posture: (tenantState.isGreenfield ? 'GREENFIELD' : 'BROWNFIELD') as
              | 'GREENFIELD'
              | 'BROWNFIELD',
            systemPromptStatus: tenantState.systemPromptStatus,
            systemPromptEditCount: tenantState.systemPromptEditCount,
            sopsDefined: tenantState.sopCount,
            sopsDefaulted: tenantState.sopsDefaulted,
            faqsGlobal: tenantState.faqCounts.global,
            faqsPropertyScoped: tenantState.faqCounts.perProperty,
            customToolsDefined: tenantState.customToolCount,
            propertiesImported: tenantState.propertyCount,
            lastBuildSessionAt: tenantState.lastBuildTransaction?.createdAt ?? null,
          }
        : null;
      const runtimeInterviewProgress = interviewProgress
        ? {
            loadBearingFilled: interviewProgress.loadBearingFilled,
            loadBearingTotal: 6,
            nonLoadBearingFilled:
              interviewProgress.filledSlots.length - interviewProgress.loadBearingFilled,
            nonLoadBearingTotal: 14,
            defaultedSlots: [] as string[],
          }
        : null;
      const ctx: SystemPromptContext = {
        tenantId: conv.tenantId,
        conversationId: conv.id,
        anchorMessageId: conv.anchorMessageId,
        selectedSuggestionId: null,
        memorySnapshot: memory,
        pending: {
          total: pendingTotal,
          countsByCategory,
          topThree: pending.slice(0, 3).map((s) => ({
            id: s.id,
            diagnosticCategory: s.diagnosticCategory,
            diagnosticSubLabel: s.diagnosticSubLabel,
            confidence: s.confidence,
            rationale: s.rationale,
            createdAt: s.createdAt,
          })),
        },
        mode,
        tenantState: runtimeTenantState,
        interviewProgress: runtimeInterviewProgress,
        conversationAnchor: conv.anchorMessage
          ? {
              text: conv.anchorMessage.content,
              role: conv.anchorMessage.role,
              lastEditSummary: null,
            }
          : null,
        stateMachineSnapshot: snapshot,
      };
      reconstructedPrompt = assembleSystemPrompt(ctx);
    } catch (err: any) {
      reconstructionNote = `(system-prompt reconstruction failed: ${err?.message ?? err})`;
    }

    // Build markdown.
    const lines: string[] = [];
    lines.push(`# Studio Conversation Dump — ${conv.id}`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Metadata');
    lines.push('');
    lines.push('```json');
    lines.push(
      fmtJson({
        id: conv.id,
        tenantId: conv.tenantId,
        title: conv.title,
        triggerType: conv.triggerType,
        anchorMessageId: conv.anchorMessageId,
        sdkSessionId: conv.sdkSessionId,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
        toolCallLogCount: toolLogs.length,
      }),
    );
    lines.push('```');
    lines.push('');
    lines.push('## Final state-machine snapshot');
    lines.push('');
    lines.push('```json');
    lines.push(fmtJson(conv.stateMachineSnapshot));
    lines.push('```');
    if (conv.anchorMessage) {
      lines.push('');
      lines.push('## Anchor message (main-AI reply this session is anchored to)');
      lines.push('');
      lines.push('```json');
      lines.push(fmtJson(conv.anchorMessage));
      lines.push('```');
    }
    // Count how many turns have a persisted per-turn debug trace (which
    // gives us the EXACT system prompt that turn saw). Surface up-front
    // so a reader knows whether to trust per-turn details or fall back
    // to the reconstructed prompt at the bottom.
    const perTurnTraces = conv.messages.flatMap((m) =>
      (Array.isArray(m.parts) ? (m.parts as any[]) : []).filter(
        (p) => p && p.type === 'data-debug-trace',
      ),
    );

    lines.push(HORIZONTAL_RULE);
    lines.push('## Per-turn debug traces');
    lines.push('');
    if (perTurnTraces.length > 0) {
      lines.push(
        `> ${perTurnTraces.length} of ${conv.messages.filter((m) => m.role === 'assistant').length} assistant turns have a persisted \`data-debug-trace\` (STUDIO_DEBUG_TRACE was enabled). Each trace contains the byte-exact system prompt the agent saw on that turn — see the per-message Part listings below for the full prompts.`,
      );
    } else {
      lines.push(
        '> No per-turn traces persisted (STUDIO_DEBUG_TRACE was off when this conversation ran). The reconstructed prompt below is best-effort using CURRENT templates and state — past turns may have seen a different prompt if templates or tenant state have changed.',
      );
      lines.push('>');
      lines.push(
        '> To capture per-turn traces on future conversations: `STUDIO_DEBUG_TRACE=true npm run dev` (backend).',
      );
    }
    lines.push('');
    lines.push('## Reconstructed system prompt (CURRENT templates + state)');
    lines.push('');
    if (reconstructionNote) {
      lines.push(`> ${reconstructionNote}`);
    } else {
      lines.push(`> Size: ${fmtBytes(reconstructedPrompt.length)} (${reconstructedPrompt.length.toLocaleString()} chars)`);
      lines.push('>');
      lines.push('> Best-effort reconstruction. See the Per-turn debug traces section above.');
      lines.push('');
      lines.push('````text');
      lines.push(reconstructedPrompt);
      lines.push('````');
    }
    lines.push(HORIZONTAL_RULE);
    lines.push('## Messages');
    lines.push('');

    let turnNumber = 0;
    for (const msg of conv.messages) {
      turnNumber += 1;
      const ts = msg.createdAt.toISOString();
      lines.push(`### Message ${turnNumber}/${conv.messages.length} — ${msg.role.toUpperCase()} (${ts})`);
      lines.push('');
      lines.push(`Message id: \`${msg.id}\``);
      lines.push('');
      const parts = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : [];
      let partIdx = 0;
      for (const part of parts) {
        partIdx += 1;
        const p = part as any;
        const t = p?.type ?? '(unknown)';
        lines.push(`#### Part ${partIdx} — \`${t}\``);
        lines.push('');
        if (t === 'text') {
          lines.push('```');
          lines.push(String(p.text ?? ''));
          lines.push('```');
        } else if (typeof t === 'string' && (t.startsWith('tool-') || t === 'dynamic-tool')) {
          const name = p.toolName ?? p.name ?? t.replace(/^tool-/, '');
          const state = p.state ?? 'unknown';
          lines.push(`Tool: \`${name}\` (state: \`${state}\`)`);
          lines.push('');
          if (p.input !== undefined || p.args !== undefined) {
            lines.push('Input:');
            lines.push('```json');
            lines.push(fmtJson(p.input ?? p.args));
            lines.push('```');
          }
          if (p.output !== undefined || p.result !== undefined) {
            lines.push('Output:');
            lines.push('```json');
            lines.push(fmtJson(p.output ?? p.result));
            lines.push('```');
          }
        } else if (typeof t === 'string' && t.startsWith('data-')) {
          lines.push('Data:');
          lines.push('```json');
          lines.push(fmtJson(p.data ?? p));
          lines.push('```');
        } else {
          lines.push('```json');
          lines.push(fmtJson(p));
          lines.push('```');
        }
        lines.push('');
      }
      lines.push('');
    }

    if (toolLogs.length > 0) {
      lines.push(HORIZONTAL_RULE);
      lines.push('## BuildToolCallLog (per-tool timing & success)');
      lines.push('');
      lines.push('| Turn | Tool | Duration (ms) | Success | Error |');
      lines.push('| ---: | --- | ---: | :---: | --- |');
      for (const t of toolLogs) {
        lines.push(
          `| ${t.turn} | \`${t.tool}\` | ${t.durationMs} | ${t.success ? '✓' : '✗'} | ${
            t.errorMessage ? t.errorMessage.replace(/\|/g, '\\|').slice(0, 120) : ''
          } |`,
        );
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`Wrote dump to ${outPath} (${fmtBytes(fs.statSync(outPath).size)})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
