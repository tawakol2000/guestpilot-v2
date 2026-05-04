/**
 * Sprint 059-A F1.5 — SDK path extracted from `runtime.ts`.
 *
 * This is a PURE RENAME of `runTuningAgentTurn`'s body. Zero behavioural
 * change when `BUILD_AGENT_DIRECT_TRANSPORT` is unset — the dispatcher in
 * `runtime.ts` unconditionally calls `runSdkTurn(input)` in that case.
 *
 * The direct path (`./direct/runner.ts`) is the other branch; both are
 * composed by `runtime.ts`.
 */
import type { PrismaClient } from '@prisma/client';
import type { UIMessageStreamWriter } from 'ai';
import {
  assembleSystemPrompt,
  type AgentMode,
  type SystemPromptContext,
  type TenantStateSummary,
  type InterviewProgressSummary,
} from './system-prompt';
import { buildTuningAgentMcpServer, type ToolContext } from './tools';
import { TUNING_AGENT_SERVER_NAME, TUNING_AGENT_TOOL_NAMES } from './tools/names';
import { buildTuningAgentHooks, type HookContext } from './hooks';
import { resetReadBudgetForTurn } from './hooks/read-budget-warn';
import { makeBridgeState, bridgeSDKMessage } from './stream-bridge';
import {
  makeExtractorState,
  wrapWriterWithExtractor,
} from './structured-output-extractor';
import {
  maybeEmitSessionDiffSummary,
  maybeEmitInterviewProgress,
  snapshotSlots,
} from './auto-emit';
import { listMemoryForSnapshot } from './memory/service';
import { runForcedFirstTurnCall } from './forced-first-turn';
import {
  lintAgentOutput,
  buildLinterAdvisories,
  LINTER_SYNTHETIC_TOOL_NAME,
} from './output-linter';
import { DATA_PART_TYPES, type AdvisoryData } from './data-parts';
import { logToolCall } from '../services/build-tool-call-log.service';
import {
  isTuningAgentEnabled,
  tuningAgentDisabledReason,
  isBuildModeEnabled,
  buildModeDisabledReason,
  resolveTuningAgentModel,
} from './config';
import {
  runWithAiTrace,
  startAiSpan,
  logAgentGeneration,
  buildPerRoundGenerationParams,
} from '../services/observability.service';
import {
  logCacheBlockStructure,
  buildCacheStatsPayload,
  type CacheStatsPayload,
} from './prompt-cache-blocks';
import {
  coerceSnapshot,
  computeTurnEndSnapshot,
  DEFAULT_SNAPSHOT,
  ALLOWED_TOOLS_BY_STATE,
  type StateMachineSnapshot,
  type InnerState,
} from './state-machine';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadAgentSdk } = require('./sdk-loader.cjs') as typeof import('./sdk-loader');

/**
 * Resolve the path to the Claude Agent SDK's bundled `cli.js`. See the
 * original docstring in `runtime.ts` — this helper is moved here verbatim.
 */
function resolveAgentSdkCliPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const r = require as unknown as { resolve: (id: string) => string };
    return r.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
  } catch {
    return undefined;
  }
}
const RESOLVED_SDK_CLI_PATH = resolveAgentSdkCliPath();

export interface RunTurnInput {
  prisma: PrismaClient;
  tenantId: string;
  userId: string | null;
  conversationId: string;
  /** The latest user message text. */
  userMessage: string;
  /** Optional `?suggestionId=` context the UI had selected. */
  selectedSuggestionId: string | null;
  /** Pre-computed assistant-message DB id (used for deterministic stream ids). */
  assistantMessageId: string;
  /** Vercel AI SDK stream writer; bridge emits chunks into this. */
  writer: UIMessageStreamWriter;
  /** Optional model override (falls back to TUNING_AGENT_MODEL / sonnet default). */
  modelOverride?: string;
  /**
   * Sprint 045: agent mode. Defaults to 'TUNE' for back-compat. BUILD
   * mode requires `ENABLE_BUILD_MODE` env flag; otherwise the runtime
   * short-circuits with a data-agent-disabled part.
   */
  mode?: AgentMode;
  /** BUILD only: tenant-state summary for dynamic suffix (spec §9). */
  tenantState?: TenantStateSummary | null;
  /** BUILD only: in-session interview progress. */
  interviewProgress?: InterviewProgressSummary | null;
}

/**
 * Sprint 045 per-mode allow-lists, refined in feature 047 PR 6 per-state
 * compaction.
 *
 * Returned ordering is deterministic and stable-prefix-first to preserve
 * the cached read-tools prefix across state transitions. Anthropic's
 * prompt cache invalidates from the first byte that differs onward; with
 * stable-tools-first, scoping↔drafting state changes only invalidate the
 * trailing 1-2K of the tools block, not the leading 3K of read-tool
 * descriptions. The cache_control marker on the last tool entry remains
 * unchanged.
 *
 * @param mode - Outer mode (BUILD/TUNE) — the privilege gate.
 * @param innerState - Inner cognitive state (scoping/drafting/verifying)
 *   — the tactical filter. When provided, the returned list is the
 *   intersection of {tools allowed in mode} and {tools allowed in state}.
 *   When undefined, returns the mode's full set (legacy behavior).
 */
function resolveAllowedTools(mode: AgentMode, innerState?: InnerState): string[] {
  const modeTools = resolveModeTools(mode);
  if (!innerState) return modeTools;

  // Per-state filter: keep only tools the inner state allows. The
  // intersection narrows the outer mode's privilege set by the inner
  // state's tactical posture.
  const stateAllowedShortNames = new Set(ALLOWED_TOOLS_BY_STATE[innerState]);
  const filtered = modeTools.filter((name) => {
    // ALLOWED_TOOLS_BY_STATE references TUNING_AGENT_TOOL_NAMES values
    // (mcp__tuning-agent__studio_*) so direct membership works for those.
    // STUDIO_PROPOSE_TRANSITION_TOOL_NAME is also in the set already.
    return stateAllowedShortNames.has(name);
  });

  // Stable-prefix ordering: read tools alphabetical, then state-specific.
  // The cache_control marker stays on the last entry (handled elsewhere
  // by withLastToolCacheControl); putting state-variable tools at the
  // tail isolates cache invalidation to the suffix.
  const readToolsSet = new Set<string>([
    TUNING_AGENT_TOOL_NAMES.studio_get_context,
    TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_section,
    TUNING_AGENT_TOOL_NAMES.studio_search_corrections,
    TUNING_AGENT_TOOL_NAMES.studio_get_correction,
    TUNING_AGENT_TOOL_NAMES.studio_get_canonical_template,
    TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
    TUNING_AGENT_TOOL_NAMES.studio_memory,
  ]);
  const readPart = filtered.filter((n) => readToolsSet.has(n)).sort();
  const variablePart = filtered.filter((n) => !readToolsSet.has(n)).sort();
  return [...readPart, ...variablePart];
}

function resolveModeTools(mode: AgentMode): string[] {
  if (mode === 'BUILD') {
    return [
      TUNING_AGENT_TOOL_NAMES.studio_get_context,
      TUNING_AGENT_TOOL_NAMES.studio_memory,
      TUNING_AGENT_TOOL_NAMES.studio_search_corrections,
      TUNING_AGENT_TOOL_NAMES.studio_get_correction,
      TUNING_AGENT_TOOL_NAMES.studio_rollback,
      TUNING_AGENT_TOOL_NAMES.studio_create_faq,
      TUNING_AGENT_TOOL_NAMES.studio_create_sop,
      TUNING_AGENT_TOOL_NAMES.studio_create_tool_definition,
      TUNING_AGENT_TOOL_NAMES.studio_create_system_prompt,
      TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes,
      TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
      TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
      TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
      TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
      TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index,
      TUNING_AGENT_TOOL_NAMES.studio_get_evidence_section,
      TUNING_AGENT_TOOL_NAMES.studio_suggestion,
      TUNING_AGENT_TOOL_NAMES.studio_get_canonical_template,
      TUNING_AGENT_TOOL_NAMES.studio_propose_transition,
    ];
  }
  return [
    TUNING_AGENT_TOOL_NAMES.studio_get_context,
    TUNING_AGENT_TOOL_NAMES.studio_search_corrections,
    TUNING_AGENT_TOOL_NAMES.studio_get_correction,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_section,
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    TUNING_AGENT_TOOL_NAMES.studio_memory,
    TUNING_AGENT_TOOL_NAMES.studio_rollback,
    TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes,
    TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
    TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
    TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
    TUNING_AGENT_TOOL_NAMES.studio_propose_transition,
  ];
}

// Exported for unit tests (per-state allow-list filtering).
export const __resolveAllowedToolsForTest = resolveAllowedTools;

export interface RunTurnResult {
  sdkSessionId: string | null;
  finalAssistantText: string;
  toolCallsInvoked: string[];
  /** All non-transient data parts emitted during the turn. */
  persistedDataParts: Array<{ type: string; id?: string; data: unknown }>;
  /** Non-empty when the agent finished without a proper result (errors, aborts). */
  error: string | null;
}

/**
 * The SDK-path run-turn. Previously `runTuningAgentTurn()` in runtime.ts.
 * Pure-rename extraction — no behavioural change.
 */
export async function runSdkTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const mode: AgentMode = input.mode ?? 'TUNE';

  if (!isTuningAgentEnabled()) {
    const reason = tuningAgentDisabledReason();
    input.writer.write({
      type: 'start',
      messageId: input.assistantMessageId,
    });
    input.writer.write({
      type: 'data-agent-disabled',
      id: `disabled:${input.assistantMessageId}`,
      data: { reason: reason ?? 'disabled' },
    } as any);
    input.writer.write({ type: 'finish', finishReason: 'error' });
    return {
      sdkSessionId: null,
      finalAssistantText: '',
      toolCallsInvoked: [],
      persistedDataParts: [],
      error: reason ?? 'disabled',
    };
  }

  if (mode === 'BUILD' && !isBuildModeEnabled()) {
    const reason = buildModeDisabledReason() ?? 'build mode disabled';
    input.writer.write({ type: 'start', messageId: input.assistantMessageId });
    input.writer.write({
      type: 'data-agent-disabled',
      id: `disabled:${input.assistantMessageId}`,
      data: { reason, mode: 'BUILD' },
    } as any);
    input.writer.write({ type: 'finish', finishReason: 'error' });
    return {
      sdkSessionId: null,
      finalAssistantText: '',
      toolCallsInvoked: [],
      persistedDataParts: [],
      error: reason,
    };
  }

  // ─── Resolve session id (resume or fresh) ──────────────────────────────
  const [conversation, priorMessageCount] = await Promise.all([
    input.prisma.tuningConversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId },
      select: { id: true, sdkSessionId: true, anchorMessageId: true, stateMachineSnapshot: true },
    }),
    input.prisma.tuningMessage.count({
      where: { conversationId: input.conversationId },
    }),
  ]);
  const turnNumber = priorMessageCount + 1;
  const isFirstTurn = priorMessageCount === 0;
  if (!conversation) {
    input.writer.write({
      type: 'start',
      messageId: input.assistantMessageId,
    });
    input.writer.write({
      type: 'error',
      errorText: `TuningConversation ${input.conversationId} not found for tenant.`,
    });
    input.writer.write({ type: 'finish', finishReason: 'error' });
    return {
      sdkSessionId: null,
      finalAssistantText: '',
      toolCallsInvoked: [],
      persistedDataParts: [],
      error: 'CONVERSATION_NOT_FOUND',
    };
  }

  // ─── Assemble prompt context ───────────────────────────────────────────
  const [memory, pending, pendingTotal] = await Promise.all([
    listMemoryForSnapshot(input.prisma, input.tenantId, 50),
    input.prisma.tuningSuggestion.findMany({
      where: { tenantId: input.tenantId, status: 'PENDING' },
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
    input.prisma.tuningSuggestion.count({
      where: { tenantId: input.tenantId, status: 'PENDING' },
    }),
  ]);
  const countsByCategory = pending.reduce<Record<string, number>>((acc, s) => {
    const k = s.diagnosticCategory ?? 'LEGACY';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const promptCtx: SystemPromptContext = {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    anchorMessageId: conversation.anchorMessageId,
    selectedSuggestionId: input.selectedSuggestionId,
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
        createdAt: s.createdAt.toISOString(),
      })),
    },
    mode,
    tenantState: input.tenantState ?? null,
    interviewProgress: input.interviewProgress ?? null,
    // Sprint 060-C — DB snapshot drives <current_state> + optional
    // <state_transition> in Region C. Falls back to default scoping
    // for any legacy row that somehow missed the migration default.
    stateMachineSnapshot: coerceSnapshot(conversation.stateMachineSnapshot ?? DEFAULT_SNAPSHOT),
  };
  const turnStartSnapshot: StateMachineSnapshot = promptCtx.stateMachineSnapshot!;
  const systemPrompt = assembleSystemPrompt(promptCtx);
  logCacheBlockStructure(input.tenantId, systemPrompt);
  // Feature 047 PR 6 — per-state allow-list compaction. The agent only
  // sees tools allowed in BOTH the current outer mode AND the current
  // inner state. PreToolUse hook (pretooluse-state-gate) remains as a
  // runtime backstop for the rare case where state changes mid-turn.
  const allowedTools = resolveAllowedTools(mode, turnStartSnapshot.inner_state);

  // ─── Wire the hook + tool contexts ─────────────────────────────────────
  const lastUserSnapshot = { text: input.userMessage };
  const compliance = { lastUserSanctionedApply: false, lastUserSanctionedRollback: false };
  const persistedDataParts: Array<{ type: string; id?: string; data: unknown }> = [];
  const toolCallsInvoked: string[] = [];

  let suggestedFixEmitted = 0;
  let suggestedFixDropped = 0;

  const emitDataPart = (part: { type: string; id?: string; data: unknown; transient?: boolean }) => {
    if (part.type === DATA_PART_TYPES.suggested_fix) {
      if (suggestedFixEmitted >= 1) {
        suggestedFixDropped += 1;
        return;
      }
      suggestedFixEmitted += 1;
    }
    try {
      (input.writer as any).write({
        type: part.type,
        id: part.id,
        data: part.data,
        transient: part.transient ?? false,
      });
    } catch {
      /* swallow — stream already closed */
    }
    if (!part.transient) {
      persistedDataParts.push({ type: part.type, id: part.id, data: part.data });
    }
  };

  const turnFlags: Record<string, boolean> = {};
  const toolCtx: ToolContext = {
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    userId: input.userId,
    lastUserSanctionedApply: false,
    emitDataPart,
    turnFlags,
  };
  const hookCtx: HookContext = {
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    userId: input.userId,
    readLastUserMessage: () => lastUserSnapshot.text,
    emitDataPart,
    compliance,
    turn: turnNumber,
    toolCallStartTimes: new Map<string, number>(),
  };

  const mcpServer = await buildTuningAgentMcpServer(() => {
    toolCtx.lastUserSanctionedApply = compliance.lastUserSanctionedApply;
    return toolCtx;
  });
  const hooks = buildTuningAgentHooks(() => hookCtx);
  const { query } = await loadAgentSdk();

  // ─── Pre-turn slot snapshot (for interview-progress auto-emit) ──────────
  const preTurnSlotSnapshot = await snapshotSlots(
    input.prisma,
    input.tenantId,
    input.conversationId,
  ).catch(() => ({} as Record<string, string>));

  // ─── Query execution ───────────────────────────────────────────────────
  const state = makeBridgeState(input.assistantMessageId);
  const extractorState = makeExtractorState();
  const filteredWrite = wrapWriterWithExtractor(
    (chunk) => {
      try {
        input.writer.write(chunk);
      } catch {
        /* swallow — stream may be closed */
      }
    },
    emitDataPart,
    extractorState,
  );
  let lastUsage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
  // 2026-05-04 (feature 047 PR 1) — per-round Langfuse capture.
  // Each SDK assistant message corresponds to ONE internal messages.create
  // round; a tuning-agent.query typically fires 3-8 such rounds. We emit
  // ONE logAgentGeneration call per round LIVE inside the for-await loop
  // (not batched at end-of-query) so:
  //   1. Mid-turn process crashes preserve the partial trace for debugging
  //   2. Long-running turns surface progress in Langfuse in real-time
  //   3. Each round's usage is attributable to the round's actual tool-use
  //      decisions, not averaged across the turn
  // Counter is held outside the loop so roundIndex is monotonic across
  // a SINGLE runQuery() invocation. Resets per-runQuery (which equals
  // per-tuning-agent.query span).
  let roundsSeen = 0;
  // Span end metadata still gets aggregate counts for at-a-glance trace
  // inspection — it doesn't replace the per-round generations.
  const aggregateUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
  };
  input.writer.write({ type: 'start', messageId: input.assistantMessageId });
  input.writer.write({ type: 'start-step' });

  if (isFirstTurn) {
    await runForcedFirstTurnCall({
      prisma: input.prisma,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      turn: turnNumber,
      emitDataPart,
      toolCallsInvoked,
    });
  }

  const model = input.modelOverride ?? resolveTuningAgentModel();
  let sdkSessionId: string | null = conversation.sdkSessionId ?? null;
  let finalText = '';
  let runError: string | null = null;

  const isSessionNotFoundError = (e: any): boolean => {
    const msg: string = e?.message ?? String(e ?? '')
    return /No conversation found with session ID/i.test(msg)
        || /session.*(not found|does not exist|invalid)/i.test(msg)
  }

  const runQuery = async (resumeSessionId: string | null): Promise<void> => {
    // Feature 047 PR 4 — reset the read-budget counter at the start of
    // each runQuery call (one query == one user turn). Hook reads the
    // counter on every PreToolUse and emits an advisory when the
    // per-state budget is exceeded.
    resetReadBudgetForTurn(input.conversationId, turnNumber);
    const span = startAiSpan('tuning-agent.query', { model, resumed: resumeSessionId !== null });
    try {
      const q = query({
        prompt: input.userMessage,
        options: {
          model,
          systemPrompt,
          ...(RESOLVED_SDK_CLI_PATH ? { pathToClaudeCodeExecutable: RESOLVED_SDK_CLI_PATH } : {}),
          mcpServers: {
            [TUNING_AGENT_SERVER_NAME]: mcpServer,
          },
          allowedTools,
          tools: [],
          hooks,
          includePartialMessages: true,
          persistSession: true,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          permissionMode: 'dontAsk',
          settingSources: [],
          effort: 'medium',
        },
      });
      for await (const message of q) {
        if (!sdkSessionId && 'session_id' in message && typeof message.session_id === 'string') {
          sdkSessionId = message.session_id;
        }
        if (message.type === 'assistant') {
          const toolNamesInThisRound: string[] = [];
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text') finalText += block.text;
            if (block.type === 'tool_use') {
              toolCallsInvoked.push(block.name);
              toolNamesInThisRound.push(block.name);
            }
          }
          const u: any = (message as any).message?.usage;
          if (u && (u.cache_read_input_tokens !== undefined || u.input_tokens !== undefined)) {
            const inp = u.input_tokens ?? 0;
            const cached = u.cache_read_input_tokens ?? 0;
            const created = u.cache_creation_input_tokens ?? 0;
            const out = u.output_tokens ?? 0;
            roundsSeen += 1;
            aggregateUsage.input += inp;
            aggregateUsage.cacheRead += cached;
            aggregateUsage.cacheCreate += created;
            aggregateUsage.output += out;
            const denom = inp + cached;
            const frac = denom === 0 ? 0 : cached / denom;
            console.log(
              `[TuningAgent] round=${roundsSeen} tenant=${input.tenantId} input=${inp} cache_read=${cached} cache_created=${created} output=${out} cached_fraction=${frac.toFixed(3)}`
            );
            // Per-round LIVE emit — fires inside the for-await loop the
            // moment this round's assistant message lands. Replaces the
            // pre-feature-047 cumulative-then-emit-once-at-end pattern.
            logAgentGeneration(
              buildPerRoundGenerationParams({
                model,
                roundIndex: roundsSeen,
                usage: u,
                toolNamesInRound: toolNamesInThisRound,
                tenantId: input.tenantId,
                conversationId: input.conversationId,
              }),
            );
            lastUsage = u;
          }
        }
        bridgeSDKMessage(message, state, filteredWrite);
      }
      // Span-end metadata carries the AGGREGATE for at-a-glance trace
      // inspection. The per-round generations above are the source of
      // truth for cost; this is a convenience.
      span.end({
        toolCalls: toolCallsInvoked.length,
        length: finalText.length,
        rounds: roundsSeen,
        inputTokens: aggregateUsage.input,
        cacheReadTokens: aggregateUsage.cacheRead,
        cacheCreationTokens: aggregateUsage.cacheCreate,
        outputTokens: aggregateUsage.output,
      });
    } catch (err: any) {
      runError = err?.message ?? String(err);
      span.end({ error: runError });
      throw err;
    }
  };

  try {
    await runWithAiTrace(
      {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        agentName: 'tuning-agent',
        messageId: input.assistantMessageId,
      },
      async () => {
        try {
          await runQuery(sdkSessionId);
        } catch (err: any) {
          if (sdkSessionId && isSessionNotFoundError(err)) {
            console.warn(
              `[TuningAgent] sdkSessionId=${sdkSessionId} not found on the SDK side (likely container restart). Retrying without resume.`
            );
            await input.prisma.tuningConversation
              .update({
                where: { id: input.conversationId },
                data: { sdkSessionId: null },
              })
              .catch((e) =>
                console.warn('[TuningAgent] could not clear stale sdkSessionId:', e)
              );
            sdkSessionId = null;
            finalText = '';
            toolCallsInvoked.length = 0;
            persistedDataParts.length = 0;
            await runQuery(null);
          } else {
            throw err;
          }
        }
      }
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    runError = msg;
    try {
      input.writer.write({ type: 'error', errorText: msg });
      input.writer.write({ type: 'finish', finishReason: 'error' });
    } catch {
      /* stream may already be closed */
    }
  }

  // ─── Persist session id ────────────────────────────────────────────────
  if (sdkSessionId && conversation.sdkSessionId !== sdkSessionId) {
    await input.prisma.tuningConversation
      .update({
        where: { id: input.conversationId },
        data: { sdkSessionId },
      })
      .catch((err) => console.warn('[tuning-agent] sdkSessionId persist failed:', err));
  }

  if (lastUsage) {
    try {
      const cacheStats: CacheStatsPayload = buildCacheStatsPayload(lastUsage);
      emitDataPart({
        type: 'data-cache-stats',
        id: `cache-stats:${input.assistantMessageId}`,
        data: cacheStats,
        transient: true,
      });
    } catch {
      /* swallow — telemetry must never break the main flow */
    }
  }

  // ─── Sprint 060-C — turn-end state-machine lifecycle ─────────────────────
  //
  // Two effects, computed by a single pure function:
  //   1. Verifying auto-exit when test_pipeline ran successfully.
  //   2. Clear transition_ack_pending after the prompt rendered the
  //      one-turn <state_transition> announcement.
  //
  // Always emit a transient data-state-machine-snapshot SSE part so
  // the frontend chip stays in sync with the DB without polling.
  let endSnapshot: StateMachineSnapshot = turnStartSnapshot;
  try {
    const testPipelineSucceeded = toolCallsInvoked.includes(
      TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
    );
    const next = computeTurnEndSnapshot({
      startSnapshot: turnStartSnapshot,
      testPipelineSucceeded,
    });
    if (next) {
      await input.prisma.tuningConversation.update({
        where: { id: input.conversationId },
        data: { stateMachineSnapshot: next as unknown as object },
      });
      endSnapshot = next;
    }
  } catch (err) {
    console.warn('[tuning-agent] state-machine turn-end persist failed:', err);
  }
  try {
    emitDataPart({
      type: 'data-state-machine-snapshot',
      id: `state-machine:${input.assistantMessageId}`,
      data: endSnapshot,
      transient: true,
    });
  } catch {
    /* swallow — telemetry must never break the main flow */
  }

  // ─── Runtime auto-emit (sprint 060-D phase 6) ──────────────────────────
  try {
    maybeEmitSessionDiffSummary({
      toolCallsInvoked,
      emitDataPart,
      assistantMessageId: input.assistantMessageId,
    });
  } catch (err) {
    console.warn('[tuning-agent] session-summary auto-emit failed:', err);
  }
  try {
    await maybeEmitInterviewProgress({
      prisma: input.prisma,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      mode,
      beforeSnapshot: preTurnSlotSnapshot,
      emitDataPart,
      assistantMessageId: input.assistantMessageId,
    });
  } catch (err) {
    console.warn('[tuning-agent] interview-progress auto-emit failed:', err);
  }

  // ─── Output-linter pass ────────────────────────────────────────────────
  try {
    const findings = lintAgentOutput({
      finalText: finalText,
      dataPartTypes: persistedDataParts.map((p) => p.type),
    });

    const enforcedFindings = [...findings];
    if (suggestedFixDropped > 0) {
      enforcedFindings.push({
        rule: 'R2',
        severity: 'warn',
        message: 'R2 enforced at emit time',
        detail: { suggestedFixCount: suggestedFixEmitted + suggestedFixDropped },
      });
    }

    const advisories = buildLinterAdvisories(enforcedFindings, {
      droppedSuggestedFixCount: suggestedFixDropped,
    });
    for (const adv of advisories) {
      const payload: AdvisoryData = {
        kind: adv.kind,
        message: adv.message,
        context: adv.context,
      };
      emitDataPart({
        type: DATA_PART_TYPES.advisory,
        id: `advisory:${adv.kind}:${(adv.context as any)?.rule ?? 'lint'}`,
        data: payload,
        transient: true,
      });
    }

    if (enforcedFindings.length > 0) {
      void logToolCall(input.prisma, {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        turn: turnNumber,
        tool: LINTER_SYNTHETIC_TOOL_NAME,
        params: {
          rules: enforcedFindings.map((f) => f.rule),
          findings: enforcedFindings,
          enforced: {
            suggestedFixDropped,
            suggestedFixKept: suggestedFixEmitted,
          },
        },
        durationMs: 0,
        success: true,
      });
    }
  } catch (err) {
    console.warn('[tuning-agent] output-linter pass failed:', err);
  }

  return {
    sdkSessionId,
    finalAssistantText: finalText,
    toolCallsInvoked,
    persistedDataParts,
    error: runError,
  };
}
