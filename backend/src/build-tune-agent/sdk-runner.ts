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
import { listMemoryByPrefix } from './memory/service';
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
import { runWithAiTrace, startAiSpan } from '../services/observability.service';
import {
  logCacheBlockStructure,
  buildCacheStatsPayload,
  type CacheStatsPayload,
} from './prompt-cache-blocks';
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
 * Sprint 045 per-mode allow-lists.
 */
function resolveAllowedTools(mode: AgentMode): string[] {
  if (mode === 'BUILD') {
    return [
      TUNING_AGENT_TOOL_NAMES.studio_get_context,
      TUNING_AGENT_TOOL_NAMES.studio_memory,
      TUNING_AGENT_TOOL_NAMES.search_corrections,
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
      // Sprint 046 — BUILD mode was rejecting propose_suggestion +
      // fetch_evidence_bundle, which broke the "discuss-in-tuning"
      // flow from the inbox (agent tried to fetch evidence, got
      // denied, degraded to prose instead of emitting a
      // data-suggested-fix card for the operator to Accept/Reject).
      // These two tools are safe to allow in BUILD — suggestion
      // flow is staged via `data-suggested-fix` and still requires
      // operator approval to apply.
      TUNING_AGENT_TOOL_NAMES.fetch_evidence_bundle,
      TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    ];
  }
  return [
    TUNING_AGENT_TOOL_NAMES.studio_get_context,
    TUNING_AGENT_TOOL_NAMES.search_corrections,
    TUNING_AGENT_TOOL_NAMES.fetch_evidence_bundle,
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    TUNING_AGENT_TOOL_NAMES.studio_memory,
    TUNING_AGENT_TOOL_NAMES.studio_rollback,
    TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes,
    TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
    TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
    TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
  ];
}

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
      select: { id: true, sdkSessionId: true, anchorMessageId: true },
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
    listMemoryByPrefix(input.prisma, input.tenantId, 'preferences/', 30),
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
  };
  const systemPrompt = assembleSystemPrompt(promptCtx);
  logCacheBlockStructure(input.tenantId, systemPrompt);
  const allowedTools = resolveAllowedTools(mode);

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
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text') finalText += block.text;
            if (block.type === 'tool_use') toolCallsInvoked.push(block.name);
          }
          const u: any = (message as any).message?.usage;
          if (u && (u.cache_read_input_tokens !== undefined || u.input_tokens !== undefined)) {
            const inp = u.input_tokens ?? 0;
            const cached = u.cache_read_input_tokens ?? 0;
            const created = u.cache_creation_input_tokens ?? 0;
            const out = u.output_tokens ?? 0;
            const denom = inp + cached;
            const frac = denom === 0 ? 0 : cached / denom;
            console.log(
              `[TuningAgent] usage tenant=${input.tenantId} input=${inp} cache_read=${cached} cache_created=${created} output=${out} cached_fraction=${frac.toFixed(3)}`
            );
            lastUsage = u;
          }
        }
        bridgeSDKMessage(message, state, filteredWrite);
      }
      span.end({ toolCalls: toolCallsInvoked.length, length: finalText.length });
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
