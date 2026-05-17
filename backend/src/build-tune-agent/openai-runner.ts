/**
 * Studio agent — OpenAI Responses API runner.
 *
 * Parallel to `sdk-runner.ts` (Claude Agent SDK). Both runners share:
 *   - the assembled system prompt (regions A/B/C)
 *   - the 18 tool definitions (handlers + Zod schemas) under `tools/`
 *   - the state-machine snapshot persisted on `TuningConversation`
 *   - the SSE wire contract (Vercel AI SDK `UIMessageChunk` + `data-*` parts)
 *
 * Differences:
 *   - tools are exposed via the Responses API `tools` array (function-tool
 *     descriptors built by `openai/tool-adapter.ts`) instead of an MCP server
 *   - hooks become inline middleware (`openai/middleware.ts`) because the
 *     Responses API has no hook surface
 *   - streaming is via Responses API stream events instead of SDK messages
 *   - the system-prompt prefix benefits from OpenAI's automatic prefix
 *     cache instead of Anthropic's explicit `cache_control` markers
 *
 * Toggle: set `STUDIO_PROVIDER=openai` to route turns here. Default is
 * `anthropic`, which dispatches to `runSdkTurn`.
 */
import type { PrismaClient } from '@prisma/client';
import type { UIMessageStreamWriter, UIMessageChunk } from 'ai';

import {
  assembleSystemPrompt,
  assembleSystemPromptRegions,
  type AgentMode,
  type SystemPromptContext,
  type TenantStateSummary,
  type InterviewProgressSummary,
} from './system-prompt';
import {
  buildOpenAiToolRegistry,
  filterRegistryByAllowedTools,
  serialiseToolOutput,
  type OpenAiFunctionTool,
} from './openai/tool-adapter';
import { buildOpenAiSystemBundle } from './openai/system-blocks';
import { loadConversationHistoryAsResponsesInput } from './openai/history-replay';
import {
  makeOpenAiBridgeState,
  bridgeOpenAiStreamEvent,
  emitFinalText,
  emitFunctionCall,
  emitToolOutput,
  finalizeOpenAiBridge,
  closeOpenTextBlockBeforeError,
} from './openai/stream-bridge';
import {
  gateToolByCompliance,
  gateToolByState,
  recordReadBudget,
  validateSuggestionOutput,
  refreshInnerState,
  traceToolCall,
  type MiddlewareState,
} from './openai/middleware';
import { getOpenAiClient, withRetry } from './openai/client';
import {
  makeExtractorState,
  wrapWriterWithExtractor,
} from './structured-output-extractor';
import { snapshotSlots } from './auto-emit';
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
  resolveStudioOpenAiModel,
  resolveStudioReasoningEffort,
  resolveStudioVerbosity,
  isStudioDebugTraceEnabled,
} from './config';
import {
  runWithAiTrace,
  logAgentGeneration,
  buildPerRoundGenerationParams,
  startAiSpan,
} from '../services/observability.service';
import {
  coerceSnapshot,
  computeTurnEndSnapshot,
  DEFAULT_SNAPSHOT,
  ALLOWED_TOOLS_BY_STATE,
  type StateMachineSnapshot,
} from './state-machine';
import type { ToolContext } from './tools/types';
import { emitTurnEndArtifacts } from './lib/turn-end';
import type { RunTurnInput, RunTurnResult } from './sdk-runner';

const MAX_TOOL_ROUNDS = 8;

export async function runOpenAiTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const mode: AgentMode = input.mode ?? 'TUNE';

  if (!isTuningAgentEnabled('openai')) {
    const reason = tuningAgentDisabledReason('openai');
    input.writer.write({ type: 'start', messageId: input.assistantMessageId });
    input.writer.write({
      type: 'data-agent-disabled',
      id: `disabled:${input.assistantMessageId}`,
      data: { reason: reason ?? 'disabled' },
      transient: true,
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
      transient: true,
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

  // ─── Conversation + state ────────────────────────────────────────────────
  const [conversation, priorMessageCount] = await Promise.all([
    input.prisma.tuningConversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId },
      select: {
        id: true,
        anchorMessageId: true,
        stateMachineSnapshot: true,
        // 2026-05-17: load the prior turn's final OpenAI response id so
        // this turn can chain via previous_response_id. The chain lets
        // OpenAI use its server-side stored state (responses live 30
        // days with store:true) instead of us re-shipping the full
        // history every turn — which was costing ~$1 in uncached input
        // per 27-message conversation. See the buildInitialPendingInput
        // call below for how the chain affects the input shape.
        sdkSessionId: true,
        anchorMessage: {
          select: { id: true, content: true, role: true },
        },
      },
    }),
    input.prisma.tuningMessage.count({
      where: { conversationId: input.conversationId },
    }),
  ]);
  const turnNumber = priorMessageCount + 1;
  const isFirstTurn = priorMessageCount === 0;

  if (!conversation) {
    input.writer.write({ type: 'start', messageId: input.assistantMessageId });
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

  // ─── Prompt assembly ────────────────────────────────────────────────────
  const lastAcceptedForAnchor = conversation.anchorMessageId
    ? await input.prisma.tuningSuggestion.findFirst({
        where: { tenantId: input.tenantId, status: 'ACCEPTED' },
        orderBy: { appliedAt: 'desc' },
        select: { diagnosticCategory: true, diagnosticSubLabel: true, rationale: true },
      })
    : null;
  const conversationAnchor = conversation.anchorMessage
    ? {
        text: conversation.anchorMessage.content ?? '',
        role: conversation.anchorMessage.role ?? 'AI',
        lastEditSummary: lastAcceptedForAnchor
          ? `${lastAcceptedForAnchor.diagnosticCategory ?? 'EDIT'}${lastAcceptedForAnchor.diagnosticSubLabel ? `:${lastAcceptedForAnchor.diagnosticSubLabel}` : ''} — ${(lastAcceptedForAnchor.rationale ?? '').slice(0, 160)}`
          : null,
      }
    : null;
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

  let turnStartSnapshot: StateMachineSnapshot = coerceSnapshot(
    conversation.stateMachineSnapshot ?? null,
    mode,
  );
  // 2026-05-15: on the FIRST assistant turn, force outer_mode to match
  // input.mode even when the persisted snapshot disagrees. The Prisma
  // schema default hardcodes outer_mode='BUILD' on every new
  // TuningConversation row, so a TUNE-mode harness/controller-created
  // conversation would otherwise render <current_state> as BUILD/scoping.
  // After the first assistant message the snapshot is canonical and we
  // trust whatever the previous turn wrote. Use priorAssistantCount (not
  // priorMessageCount) because the controller persists the user message
  // BEFORE calling runTuningAgentTurn, so priorMessageCount ≥ 1 even on
  // the agent's first response.
  const priorAssistantCount = await input.prisma.tuningMessage.count({
    where: { conversationId: input.conversationId, role: 'assistant' },
  });
  const isFirstAssistantTurn = priorAssistantCount === 0;
  if (isFirstAssistantTurn && turnStartSnapshot.outer_mode !== mode) {
    turnStartSnapshot = { ...turnStartSnapshot, outer_mode: mode };
    // Persist the corrected snapshot now so the next turn (and any
    // out-of-band reads) see the right mode, and so the SSE
    // data-state-machine-snapshot emit at turn end reflects it. Skip
    // under harness dry-run so we don't leak fixes back to the live row.
    if (process.env.STUDIO_HARNESS_DRY_RUN !== 'true') {
      try {
        await input.prisma.tuningConversation.update({
          where: { id: input.conversationId },
          data: { stateMachineSnapshot: turnStartSnapshot as unknown as object },
        });
      } catch (err) {
        console.warn('[openai-runner] first-turn outer_mode correction persist failed:', err);
      }
    }
  }

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
    conversationAnchor,
    stateMachineSnapshot: turnStartSnapshot,
  };
  // 2026-05-15 (C4 + C5): split the prompt into a cacheable static
  // prefix (Region A + B = sharedPrefix + modeAddendum) and a
  // per-turn dynamic suffix (Region C — pending snapshot, memory,
  // state, conversation anchor). The cacheable prefix goes into
  // `instructions`, where OpenAI's auto-prefix cache attaches it to
  // `prompt_cache_key`. The dynamic suffix is sent as a system role
  // input item per turn so it doesn't pollute the cached prefix.
  const regions = assembleSystemPromptRegions(promptCtx);
  const assembledSystemPrompt = regions.assembled;
  const systemBundle = buildOpenAiSystemBundle({
    cacheablePrefix: [regions.sharedPrefix, regions.modeAddendum].join('\n\n'),
    dynamicSuffix: regions.dynamicSuffix,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    mode,
  });

  // ─── Tool registry, mode/state-filtered ─────────────────────────────────
  const turnFlags: Record<string, boolean> = {};
  const compliance = {
    lastUserSanctionedApply: false,
    lastUserSanctionedRollback: false,
  };
  const persistedDataParts: Array<{ type: string; id?: string; data: unknown }> = [];
  const toolCallsInvoked: string[] = [];
  // 2026-05-15 (H2): track which tool calls actually succeeded (handler
  // returned without isError). The verifying-state auto-exit must fire
  // ONLY on a successful test_pipeline, not on every invocation — a
  // failing test should leave state in verifying so the manager can
  // retry.
  const toolCallsSucceeded: string[] = [];

  let suggestedFixEmitted = 0;
  let suggestedFixDropped = 0;

  const emitDataPart = (part: {
    type: string;
    id?: string;
    data: unknown;
    transient?: boolean;
  }) => {
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
      /* swallow */
    }
    if (!part.transient) {
      persistedDataParts.push({ type: part.type, id: part.id, data: part.data });
    }
  };

  // 2026-05-17: opt-in per-turn debug trace. See sdk-runner for rationale.
  // Pushed directly to persistedDataParts (not via emitDataPart) so the
  // 30 KiB system-prompt payload doesn't ride the SSE wire to the browser.
  if (isStudioDebugTraceEnabled()) {
    persistedDataParts.push({
      type: 'data-debug-trace',
      id: `debug-trace:${input.assistantMessageId}`,
      data: {
        capturedAt: new Date().toISOString(),
        turnNumber,
        mode,
        provider: 'openai',
        model: input.modelOverride ?? resolveStudioOpenAiModel(),
        // openai-runner doesn't load sdkSessionId today (it isn't used
        // by the Responses API path); leave null rather than expand the
        // select() just for the trace.
        previousResponseId: null,
        turnStartSnapshot,
        systemPromptBytes: assembledSystemPrompt.length,
        systemPrompt: assembledSystemPrompt,
        regionSizes: {
          sharedPrefix: regions.sharedPrefix.length,
          modeAddendum: regions.modeAddendum.length,
          dynamicSuffix: regions.dynamicSuffix.length,
        },
        userMessage: input.userMessage,
      },
    });
  }

  const toolCtx: ToolContext = {
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    userId: input.userId,
    lastUserSanctionedApply: false,
    emitDataPart,
    turnFlags,
    abortSignal: input.signal,
  };

  // Build the tool registry once; refresh allow-list each round to honour
  // mid-turn state transitions.
  const fullRegistry = buildOpenAiToolRegistry(() => {
    toolCtx.lastUserSanctionedApply = compliance.lastUserSanctionedApply;
    return toolCtx;
  });

  // Mode + state intersect — same logic as `resolveAllowedTools` in
  // sdk-runner.ts. Reusing the exported helper would create a cyclic
  // import; the simpler path is to read ALLOWED_TOOLS_BY_STATE and the
  // mode tools inline.
  const allowedToolsForState = (innerState: StateMachineSnapshot['inner_state']) =>
    [...ALLOWED_TOOLS_BY_STATE[innerState]];

  // ─── Wire writer + extractor (shared with Anthropic path) ────────────────
  const extractorState = makeExtractorState();
  const filteredWrite = wrapWriterWithExtractor(
    (chunk) => {
      try {
        input.writer.write(chunk);
      } catch {
        /* swallow */
      }
    },
    emitDataPart,
    extractorState,
  );

  const preTurnSlotSnapshot = await snapshotSlots(
    input.prisma,
    input.tenantId,
    input.conversationId,
  ).catch(() => ({} as Record<string, string>));

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

  // ─── Middleware state ────────────────────────────────────────────────────
  const middleware: MiddlewareState = {
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    turn: turnNumber,
    innerState: turnStartSnapshot.inner_state,
    lastUserMessage: input.userMessage,
    readsThisTurn: 0,
    readBudgetAdvisoryStates: new Set(),
    emitDataPart,
  };

  const bridgeState = makeOpenAiBridgeState(input.assistantMessageId);

  // ─── Build initial Responses API input ──────────────────────────────────
  type RawInputItem = Record<string, unknown>;

  // 2026-05-17: cross-turn chaining via previous_response_id. When we
  // have a stored response id from the prior turn, OpenAI's server-side
  // state (responses persist 30 days when store:true) holds the entire
  // conversation history — we only need to send the new user message +
  // new dynamic suffix. Cuts uncached input by ~95% on multi-turn
  // sessions. Falls back to full history replay if the stored id is
  // expired/invalid (caught in runResponsesLoop's catch block).
  //
  // Why this matters: the actual OpenAI billing for a 27-message session
  // showed 60% cache hit, not 90%+ as expected. Root cause: every turn
  // was starting with previousResponseId=null, forcing a full history
  // replay + a fresh dynamic suffix at position 0 of input — the latter
  // invalidated the cache prefix for everything else. Chaining sidesteps
  // both problems.
  const initialPreviousResponseId = conversation.sdkSessionId ?? null;

  let pendingInput: RawInputItem[];
  let priorInputForFallback: RawInputItem[] | null = null;
  if (initialPreviousResponseId) {
    // Chained path — minimal input. OpenAI fetches everything else from
    // the prior response's stored state.
    pendingInput = [
      { type: 'message', role: 'system', content: systemBundle.dynamicSuffix },
      { type: 'message', role: 'user', content: input.userMessage },
    ];
  } else {
    // First turn (or fallback) — full history replay.
    const priorInput = await loadConversationHistoryAsResponsesInput(
      input.prisma,
      input.conversationId,
    );
    priorInputForFallback = priorInput;
    pendingInput = [
      { type: 'message', role: 'system', content: systemBundle.dynamicSuffix },
      ...priorInput,
      { type: 'message', role: 'user', content: input.userMessage },
    ];
  }

  const model = input.modelOverride ?? resolveStudioOpenAiModel();
  let lastUsage:
    | {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
      }
    | null = null;
  // 2026-05-17: per-round usage accumulator. Studio agent token spend
  // was completely invisible — no AiApiLog rows, no Langfuse traces.
  // Now we track each round so end-of-turn can (a) persist one AiApiLog
  // row with aggregate counts + system prompt + final text, and (b)
  // emit one logAgentGeneration call per round with cache breakdown.
  const aggregateUsage = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
  };
  let roundCount = 0;
  let aggregateFinalText = '';
  // 2026-05-17: seed previousResponseId from the conversation's stored
  // sdkSessionId so cross-turn chaining works. Persisted at end-of-turn
  // (see persistTurnResponseId call below).
  let previousResponseId: string | null = initialPreviousResponseId;
  let runError: string | null = null;

  // 2026-05-17: detect OpenAI's "previous_response_id not found" error
  // so we can fall back to full history replay if the chained id is
  // stale (responses live 30 days; container restart doesn't expire
  // them but a tenant that hasn't used Studio in >30 days will).
  const isPreviousResponseIdMissing = (err: unknown): boolean => {
    const m = (err as any)?.message ?? String(err ?? '');
    return (
      /previous_response/i.test(m) &&
      /(not.found|invalid|expired|does not exist)/i.test(m)
    );
  };

  const onUsageHandler = (
    u: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
    },
    ctx?: { toolCallsInRound?: string[] },
  ) => {
    lastUsage = u;
    roundCount += 1;
    aggregateUsage.input_tokens += u.input_tokens ?? 0;
    aggregateUsage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    aggregateUsage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    aggregateUsage.output_tokens += u.output_tokens ?? 0;
    aggregateUsage.reasoning_tokens += (u as any).reasoning_tokens ?? 0;
    try {
      logAgentGeneration(
        buildPerRoundGenerationParams({
          model,
          roundIndex: roundCount,
          usage: u,
          toolNamesInRound: ctx?.toolCallsInRound ?? [],
          tenantId: input.tenantId,
          conversationId: input.conversationId,
        }),
      );
    } catch (err) {
      console.warn('[openai-runner] per-round Langfuse emit failed:', err);
    }
  };
  const onFinalTextHandler = (t: string) => {
    aggregateFinalText += t;
  };
  const onPreviousResponseIdSetHandler = (id: string) => {
    previousResponseId = id;
  };

  // Runs the responses loop with a given (pendingInput, previousResponseId).
  // Extracted so the chain-fallback retry can call it twice.
  const runLoop = (
    seedInput: RawInputItem[],
    seedPreviousResponseId: string | null,
  ) =>
    runResponsesLoop({
      input,
      middleware,
      fullRegistry,
      allowedToolsForState,
      systemBundle,
      assembledSystemPrompt,
      model,
      pendingInput: seedInput,
      previousResponseId: seedPreviousResponseId,
      bridgeState,
      filteredWrite,
      emitDataPart,
      toolCallsInvoked,
      toolCallsSucceeded,
      onUsage: onUsageHandler,
      onFinalText: onFinalTextHandler,
      onPreviousResponseIdSet: onPreviousResponseIdSetHandler,
    });

  try {
    await runWithAiTrace(
      {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        agentName: 'tuning-agent-openai',
        messageId: input.assistantMessageId,
        // 2026-05-17: thread system prompt + user message onto the trace
        // root so the Langfuse UI shows them at the top of the trace —
        // no drilling into a child generation to see what the agent saw.
        systemPrompt: assembledSystemPrompt,
        userInput: input.userMessage,
      },
      async () => {
        try {
          await runLoop(pendingInput, previousResponseId);
        } catch (err) {
          // 2026-05-17: stale previous_response_id (>30d or other) — clear
          // it from the DB, rebuild pendingInput with full history replay,
          // and retry once. After fallback succeeds, the end-of-turn
          // persist will write the fresh id back.
          if (initialPreviousResponseId && isPreviousResponseIdMissing(err)) {
            console.warn(
              `[openai-runner] previous_response_id=${initialPreviousResponseId} stale — falling back to full history replay`,
            );
            await input.prisma.tuningConversation
              .update({
                where: { id: input.conversationId },
                data: { sdkSessionId: null },
              })
              .catch(() => undefined);
            previousResponseId = null;
            const replayPrior =
              priorInputForFallback ??
              (await loadConversationHistoryAsResponsesInput(
                input.prisma,
                input.conversationId,
              ));
            const fallbackInput: RawInputItem[] = [
              { type: 'message', role: 'system', content: systemBundle.dynamicSuffix },
              ...replayPrior,
              { type: 'message', role: 'user', content: input.userMessage },
            ];
            await runLoop(fallbackInput, null);
            return;
          }
          throw err;
        }
      },
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    runError = msg;
    try {
      // 2026-05-15 (H6): if a text block is currently open when the
      // run errors out, we MUST emit its `text-end` before the
      // terminal `error` / `finish` chunks. Otherwise the Vercel AI
      // SDK consumer sees an open block and renders a malformed
      // UIMessage. Previously this only happened in the happy path
      // via finalizeOpenAiBridge → closeText; the error path skipped
      // it because we set `state.finished = true` BEFORE the fallback
      // finaliser could run.
      // Use a bare chunk-writer adapter — input.writer is a
      // UIMessageStreamWriter (Vercel AI SDK shape), our bridge takes a
      // (chunk) => void function.
      const bareWrite = (chunk: UIMessageChunk) => input.writer.write(chunk);
      closeOpenTextBlockBeforeError(bridgeState, bareWrite);
      input.writer.write({ type: 'error', errorText: msg });
      input.writer.write({ type: 'finish', finishReason: 'error' });
    } catch {
      /* stream may already be closed */
    }
    // The catch block already wrote the terminal `finish` chunk directly
    // to the writer; mark the bridge as finished so the fallback
    // finalizeOpenAiBridge() below doesn't emit a SECOND `finish` (which
    // the Vercel AI SDK consumer treats as a stream protocol error).
    bridgeState.finished = true;
  }

  if (!bridgeState.finished) {
    finalizeOpenAiBridge(bridgeState, filteredWrite, runError ? 'error' : 'stop');
  }

  // ─── State-machine turn-end ─────────────────────────────────────────────
  let endSnapshot: StateMachineSnapshot = turnStartSnapshot;
  try {
    // 2026-05-15 (H2): test_pipeline-success flag must reflect actual
    // handler success, not just "tool was invoked". A failing test
    // (throw, isError:true) should keep the state in verifying so the
    // manager can rerun rather than silently auto-exiting to drafting.
    const testPipelineSucceeded = toolCallsSucceeded.some((n) =>
      n.endsWith('studio_test_pipeline'),
    );
    // 2026-05-17 fix: see sdk-runner for full rationale. Re-fetch so
    // mid-turn pending_transition writes from studio_propose_transition
    // survive the ack-clear/auto-exit spread.
    const fresh = await input.prisma.tuningConversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId },
      select: { stateMachineSnapshot: true },
    });
    const currentSnapshot = fresh
      ? coerceSnapshot(fresh.stateMachineSnapshot ?? null, mode)
      : turnStartSnapshot;
    const next = computeTurnEndSnapshot({
      startSnapshot: turnStartSnapshot,
      currentSnapshot,
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
    console.warn('[openai-runner] state-machine turn-end persist failed:', err);
  }

  await emitTurnEndArtifacts({
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
    mode,
    toolCallsInvoked,
    toolCallsSucceeded,
    preTurnSlotSnapshot,
    endSnapshot,
    lastUsage,
    emitDataPart,
  });

  // ─── Durable token-usage persistence (2026-05-17) ───────────────────────
  // Studio agent on the OpenAI path had ZERO observability before this —
  // no AiApiLog rows, no Langfuse rollup (only per-round generations from
  // logAgentGeneration above). One AiApiLog row per turn lets the dump
  // script + cache-hit-report show "this turn cost X, cache hit rate Y%,
  // reasoning tokens Z". The per-round Langfuse generations stay too —
  // they're the timeline; this is the rollup.
  void persistTurnAiApiLog({
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    turnNumber,
    model,
    assembledSystemPrompt,
    userMessage: input.userMessage,
    finalText: aggregateFinalText,
    aggregateUsage,
    roundCount,
    error: runError,
  });

  // 2026-05-17: persist the final OpenAI response id so the next turn
  // can chain via previous_response_id. Mirrors what sdk-runner.ts does
  // for the Anthropic Agent SDK path (line ~776). Skipped when the turn
  // errored mid-stream (don't poison the chain with a half-finished
  // response). Skipped under harness dry-run for the same reason as
  // every other DB write in this file.
  if (
    previousResponseId &&
    !runError &&
    conversation.sdkSessionId !== previousResponseId &&
    process.env.STUDIO_HARNESS_DRY_RUN !== 'true'
  ) {
    void input.prisma.tuningConversation
      .update({
        where: { id: input.conversationId },
        data: { sdkSessionId: previousResponseId },
      })
      .catch((err) =>
        console.warn('[openai-runner] sdkSessionId persist failed:', err),
      );
  }

  // ─── Output-linter ──────────────────────────────────────────────────────
  try {
    const findings = lintAgentOutput({
      finalText: aggregateFinalText,
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
    console.warn('[openai-runner] output-linter pass failed:', err);
  }

  return {
    sdkSessionId: previousResponseId,
    finalAssistantText: aggregateFinalText,
    toolCallsInvoked,
    persistedDataParts,
    error: runError,
  };
}

// ─── The Responses API loop ─────────────────────────────────────────────────

interface ResponsesLoopArgs {
  input: RunTurnInput;
  middleware: MiddlewareState;
  fullRegistry: ReturnType<typeof buildOpenAiToolRegistry>;
  allowedToolsForState: (s: StateMachineSnapshot['inner_state']) => string[];
  systemBundle: ReturnType<typeof buildOpenAiSystemBundle>;
  assembledSystemPrompt: string;
  model: string;
  pendingInput: Record<string, unknown>[];
  previousResponseId: string | null;
  bridgeState: ReturnType<typeof makeOpenAiBridgeState>;
  filteredWrite: (chunk: any) => void;
  emitDataPart: (part: {
    type: string;
    id?: string;
    data: unknown;
    transient?: boolean;
  }) => void;
  toolCallsInvoked: string[];
  toolCallsSucceeded: string[];
  onUsage: (
    u: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
    },
    ctx?: { toolCallsInRound?: string[] },
  ) => void;
  onFinalText: (t: string) => void;
  onPreviousResponseIdSet: (id: string) => void;
}

async function runResponsesLoop(args: ResponsesLoopArgs): Promise<void> {
  const client = getOpenAiClient();

  let round = 0;
  let pendingInput = args.pendingInput;
  let previousResponseId = args.previousResponseId;

  while (round < MAX_TOOL_ROUNDS) {
    round += 1;
    // Refresh state + allowed tools each round in case a transition was
    // confirmed mid-turn (rare but supported).
    await refreshInnerState(args.middleware);
    const allowedPrefixed = args.allowedToolsForState(args.middleware.innerState);
    const filtered = filterRegistryByAllowedTools(args.fullRegistry, allowedPrefixed);

    const tools: OpenAiFunctionTool[] = filtered.tools;

    const requestPayload: Record<string, unknown> = {
      model: args.model,
      instructions: args.systemBundle.instructions,
      input: pendingInput,
      tools,
      tool_choice: 'auto',
      // 2026-05-17: enabled. Per OpenAI's gpt-5.4 prompting guidance,
      // independent read tools should run in parallel. Studio routinely
      // fires multi-read scoping turns (get_tenant_index +
      // get_evidence_index + studio_memory(op:'list')) where the model
      // batching them cuts round-trip latency. Safe:
      //   - read tools have no side effects, no race possible
      //   - write tools require explicit sanction (NEVER_DO #7), the
      //     state machine + sanction discipline prevent batching them
      //   - PreToolUse state gate runs per-tool with the same starting
      //     snapshot, so a batched-write attempt would be denied
      //     consistently even if it slipped through the prompt
      //   - the executor loop dispatches function_calls sequentially in
      //     JS regardless, so this only affects model batching, not our
      //     race surface
      parallel_tool_calls: true,
      // 2026-05-17: reasoning effort dropped from 'high' → 'medium'.
      // 'high' was burning 3K–8K reasoning tokens per round; 'medium'
      // ~halves that without meaningfully degrading edit quality (the
      // harder thinking happens at write time, gated by sanction
      // discipline + state-machine — not by reasoning depth on read
      // turns). Override via STUDIO_REASONING_EFFORT env.
      reasoning: { effort: resolveStudioReasoningEffort() },
      // 2026-05-17: cap GPT-5.4's internal verbosity register. We
      // already enforce a 120-word prose cap in <response_contract>;
      // setting text.verbosity='low' aligns the model's default register
      // with that cap and pushes it away from preambles ("Great
      // question!", "Let me dig into this") that NEVER_DO rule 1 also
      // bans. Expected ~10-20% output token savings, no quality cost.
      // Override via STUDIO_VERBOSITY env.
      text: { verbosity: resolveStudioVerbosity() },
      prompt_cache_key: args.systemBundle.promptCacheKey,
      // 2026-05-16: explicit 24h retention. Without this OpenAI uses
      // the default 5–10 min TTL — a Studio session with any pause
      // between turns (operator thinks, walks away, comes back) drops
      // the cache and the next turn pays full input price for the
      // ~20K-token shared prefix. The other call sites that share
      // this prefix (ai.service.ts, diagnostic.service.ts) already
      // pass '24h', so retention here aligns Studio with the rest of
      // the system.
      prompt_cache_retention: '24h',
      store: true,
    };
    if (previousResponseId) {
      requestPayload.previous_response_id = previousResponseId;
      // Avoid resending history when previous_response_id chains the state.
      // We DO still pass the new function_call_output items as the input
      // for the follow-up round; OpenAI handles the rest.
    }

    // 2026-05-15 H5: forward the controller's AbortSignal so a client
    // disconnect mid-turn cancels the in-flight OpenAI call instead of
    // burning tokens to completion. OpenAI SDK accepts this as a per-
    // request option (not inside the body).
    const createOptions: Record<string, unknown> = {};
    if (args.input.signal) createOptions.signal = args.input.signal;

    const response: any = await withRetry(
      () => (client.responses as any).create(requestPayload, createOptions),
      { signal: args.input.signal },
    );

    if (response?.id) {
      previousResponseId = response.id;
      args.onPreviousResponseIdSet(response.id);
    }
    const outputItems: any[] = Array.isArray(response?.output) ? response.output : [];
    const functionCalls = outputItems.filter((o) => o?.type === 'function_call');

    if (response?.usage) {
      // 2026-05-17: pass the tools fired this round so per-round
      // Langfuse generations get a `toolCallsInRound` metadata tag —
      // makes it trivial to see "round 7 of 12, fired test_pipeline,
      // 12K cached / 800 reasoning / 0.04s" in the trace timeline.
      args.onUsage(normaliseUsage(response.usage), {
        toolCallsInRound: functionCalls
          .map((fc: any) => (typeof fc?.name === 'string' ? fc.name : null))
          .filter((n: string | null): n is string => n !== null),
      });
    }

    if (functionCalls.length === 0) {
      // No more tool calls — emit final text + finish.
      const text = collectTextFromOutput(outputItems);
      if (text) {
        emitFinalText(text, args.bridgeState, args.filteredWrite);
        args.onFinalText(text);
      }
      finalizeOpenAiBridge(args.bridgeState, args.filteredWrite, 'stop');
      return;
    }

    // Emit any visible text BEFORE the tool calls (rare but possible).
    // 2026-05-15 (review pass D6): emit to the wire so the operator sees
    // the agent's mid-turn reasoning, but DO NOT mix it into
    // aggregateFinalText. That field feeds the output linter +
    // finalAssistantText return value — concatenating interim text
    // confuses citation / NO_FIX detection and pollutes the persisted
    // assistant message text.
    const interimText = collectTextFromOutput(outputItems);
    if (interimText) {
      emitFinalText(interimText, args.bridgeState, args.filteredWrite);
    }

    // Dispatch each function call.
    const toolOutputs: Array<Record<string, unknown>> = [];
    for (const fc of functionCalls) {
      const callId: string = fc.call_id ?? fc.id ?? `call-${Math.random().toString(36).slice(2)}`;
      const rawName: string = fc.name ?? '';
      const prefixedName = args.fullRegistry.prefixedNames.get(rawName) ?? rawName;
      const handler = args.fullRegistry.handlers.get(rawName);

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(fc.arguments ?? '{}');
      } catch {
        parsedArgs = {};
      }

      args.toolCallsInvoked.push(prefixedName);
      emitFunctionCall(
        { name: rawName, call_id: callId, arguments: fc.arguments ?? '{}' },
        args.bridgeState,
        args.filteredWrite,
      );

      // Middleware: state gate
      const stateGate = gateToolByState(prefixedName, args.middleware);
      if (!stateGate.ok) {
        emitToolOutput(callId, { isError: true, reason: stateGate.denyReason }, args.bridgeState, args.filteredWrite);
        toolOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: stateGate.denyReason ?? 'denied',
        });
        traceToolCall({
          state: args.middleware,
          toolNameRaw: rawName,
          args: parsedArgs,
          durationMs: 0,
          success: false,
          errorMessage: stateGate.denyReason ?? 'state-gate denied',
        });
        continue;
      }

      // Middleware: compliance gate
      const complianceGate = gateToolByCompliance(prefixedName, parsedArgs, args.middleware);
      if (!complianceGate.ok) {
        emitToolOutput(callId, { isError: true, reason: complianceGate.denyReason }, args.bridgeState, args.filteredWrite);
        toolOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: complianceGate.denyReason ?? 'denied',
        });
        traceToolCall({
          state: args.middleware,
          toolNameRaw: rawName,
          args: parsedArgs,
          durationMs: 0,
          success: false,
          errorMessage: complianceGate.denyReason ?? 'compliance denied',
        });
        continue;
      }

      // Read-budget advisory (non-blocking)
      recordReadBudget(prefixedName, args.middleware);

      // Invoke handler
      if (!handler) {
        const reason = `unknown tool ${rawName}`;
        emitToolOutput(callId, { isError: true, reason }, args.bridgeState, args.filteredWrite);
        toolOutputs.push({ type: 'function_call_output', call_id: callId, output: reason });
        traceToolCall({
          state: args.middleware,
          toolNameRaw: rawName,
          args: parsedArgs,
          durationMs: 0,
          success: false,
          errorMessage: reason,
        });
        continue;
      }

      const start = Date.now();
      let result: unknown;
      let success = true;
      let errorMessage: string | null = null;
      // 2026-05-17: wrap each tool invocation in a Langfuse span so
      // input + output land on the trace. Previously only BuildToolCallLog
      // captured tool names + paramsHash — no actual inputs or outputs.
      // For debugging "why did the agent do X?" the Langfuse timeline now
      // shows the literal tool args and result content.
      const toolSpan = startAiSpan(`studio.tool.${rawName}`, parsedArgs, {
        tenantId: args.input.tenantId,
        conversationId: args.input.conversationId,
        innerState: args.middleware.innerState,
      });
      try {
        result = await handler(parsedArgs);
        // Treat handler-returned {isError:true} payloads as failures even
        // when no exception was thrown. The MCP shape asError(...) sets
        // this flag for SOP/FAQ validation errors etc., and those must
        // not flip state-machine flags like test_pipeline-succeeded.
        const r = result as { isError?: boolean } | null;
        if (r && r.isError) {
          success = false;
          errorMessage = 'tool returned isError:true';
        }
      } catch (err) {
        success = false;
        errorMessage = err instanceof Error ? err.message : String(err);
        result = { isError: true, content: [{ type: 'text', text: `ERROR: ${errorMessage}` }] };
      }
      // Truncate the output before sending to Langfuse — full artifact
      // dumps can be 30 KiB+ and pollute the trace UI / billing.
      try {
        const outStr = JSON.stringify(result);
        toolSpan.end(outStr.length > 4000 ? outStr.slice(0, 4000) + '…[truncated]' : outStr, {
          success,
          errorMessage: errorMessage ?? undefined,
        });
      } catch {
        toolSpan.end('[unserialisable]', { success });
      }
      if (success) {
        args.toolCallsSucceeded.push(prefixedName);
      }
      const durationMs = Date.now() - start;
      const outputString = serialiseToolOutput(result);

      emitToolOutput(callId, result, args.bridgeState, args.filteredWrite);
      toolOutputs.push({
        type: 'function_call_output',
        call_id: callId,
        output: outputString,
      });
      traceToolCall({
        state: args.middleware,
        toolNameRaw: rawName,
        args: parsedArgs,
        durationMs,
        success,
        errorMessage,
      });

      // PostToolUse validator (mirrors Anthropic path's
      // hooks/post-tool-use.ts) — flag structurally bad
      // studio_suggestion(op='propose') output so the model can
      // self-correct on the next round. Append the validation message
      // as an additional function_call_output so it lands as model
      // context without polluting the original tool's result.
      if (success) {
        const validationError = validateSuggestionOutput(prefixedName, parsedArgs);
        if (validationError) {
          toolOutputs.push({
            type: 'function_call_output',
            call_id: callId,
            output: `[Validation error: ${validationError}. Please re-examine the current artifact text and regenerate the suggestion.]`,
          });
        }
      }
    }

    // Next round — only the function_call_output items go in.
    pendingInput = toolOutputs;
  }

  // Max rounds exceeded — emit a synthetic advisory + visible text so the
  // operator isn't left staring at a silent stream. Without this, the chat
  // surface shows only the user message and the typing indicator clears
  // with no agent reply.
  console.warn('[openai-runner] hit MAX_TOOL_ROUNDS, terminating turn');
  args.emitDataPart({
    type: DATA_PART_TYPES.advisory,
    data: {
      kind: 'tool_loop_terminated',
      reason: `Exceeded ${MAX_TOOL_ROUNDS} tool-call rounds`,
    },
    transient: true,
  });
  const fallbackText =
    `I ran out of tool-call rounds before I could finish. Tell me what you ` +
    `want me to do next and I'll pick up from here — or try rephrasing the ` +
    `request more directly.`;
  emitFinalText(fallbackText, args.bridgeState, args.filteredWrite);
  args.onFinalText(fallbackText);
  finalizeOpenAiBridge(args.bridgeState, args.filteredWrite, 'stop');
}

// 2026-05-17 — per-turn rollup persistence into AiApiLog. One row per
// assistant turn (NOT per round; round-level lives in Langfuse). Includes
// the full system prompt + user message + final text so the dump script
// and any later forensic query can reconstruct what the agent saw and
// said. Tool-use detail still lives in TuningMessage.parts +
// BuildToolCallLog — this row is the cost / cache rollup.
//
// gpt-5.4 indicative pricing (per OpenAI public pricing as of 2026-05):
//   input          $2.50  / 1M
//   cached input   $0.625 / 1M  (75% discount)
//   output         $10.00 / 1M  (reasoning tokens billed at this rate)
//
// If pricing drifts, edit the constants here OR move them to a
// centralised model-pricing service.
const GPT54_INPUT_PER_M = 2.5;
const GPT54_CACHED_INPUT_PER_M = 0.625;
const GPT54_OUTPUT_PER_M = 10.0;

function estimateOpenAiTurnCostUsd(usage: {
  input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}): number {
  // OpenAI reports input_tokens as TOTAL (cached + uncached). Cached is
  // billed at the cached rate, the remainder at the full input rate.
  const cached = Math.min(usage.cache_read_input_tokens, usage.input_tokens);
  const uncached = Math.max(0, usage.input_tokens - cached);
  // output_tokens already INCLUDES reasoning_tokens per OpenAI's docs —
  // do not double-count.
  return (
    (uncached * GPT54_INPUT_PER_M +
      cached * GPT54_CACHED_INPUT_PER_M +
      usage.output_tokens * GPT54_OUTPUT_PER_M) /
    1_000_000
  );
}

async function persistTurnAiApiLog(args: {
  prisma: RunTurnInput['prisma'];
  tenantId: string;
  conversationId: string;
  turnNumber: number;
  model: string;
  assembledSystemPrompt: string;
  userMessage: string;
  finalText: string;
  aggregateUsage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
  };
  roundCount: number;
  error: string | null;
}): Promise<void> {
  try {
    const costUsd = args.model.startsWith('gpt-5.4')
      ? estimateOpenAiTurnCostUsd(args.aggregateUsage)
      : 0;
    await args.prisma.aiApiLog.create({
      data: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        agentName: 'studio',
        model: args.model,
        systemPrompt: args.assembledSystemPrompt,
        userContent: args.userMessage,
        responseText: args.finalText,
        inputTokens: args.aggregateUsage.input_tokens,
        cachedInputTokens: args.aggregateUsage.cache_read_input_tokens,
        reasoningTokens: args.aggregateUsage.reasoning_tokens,
        outputTokens: args.aggregateUsage.output_tokens,
        costUsd,
        ragContext: {
          turnNumber: args.turnNumber,
          roundCount: args.roundCount,
          cacheCreationInputTokens: args.aggregateUsage.cache_creation_input_tokens,
        } as any,
        error: args.error,
      },
    });
  } catch (err) {
    // Never crash the turn over an observability write. The per-round
    // Langfuse generations + the data-cache-stats SSE still surface the
    // numbers even if this persist fails.
    console.warn('[openai-runner] AiApiLog persist failed (non-fatal):', err);
  }
}

function collectTextFromOutput(outputItems: any[]): string {
  let text = '';
  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') {
          text += c.text;
        }
      }
    } else if (item.type === 'output_text' && typeof item.text === 'string') {
      text += item.text;
    }
  }
  return text;
}

function normaliseUsage(usage: any): {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
} {
  // OpenAI Responses API exposes:
  //   input_tokens (TOTAL prompt tokens, cached + uncached)
  //   output_tokens (TOTAL output tokens, including reasoning)
  //   input_tokens_details: { cached_tokens }
  //   output_tokens_details: { reasoning_tokens }
  //
  // The shared cache-stats payload (buildCacheStatsPayload) computes
  // `denom = input + cached` then `cachedFraction = cached / denom`.
  // For that math to work when our `input` is uncached-only (Anthropic
  // convention), we subtract `cached` here. The OpenAI docs have been
  // ambiguous about whether `input_tokens` includes cached — the
  // current spec (2026-05) says it's the TOTAL, so this subtraction
  // is correct. If OpenAI ever changes that convention, the
  // cachedFraction will flip below 0; the buildCacheStatsPayload
  // helper clamps it but the displayed cost will drift.
  //
  // 2026-05-15 (M10): also surface reasoning_tokens. With
  // `reasoning: { effort: 'low' }` set on the request, the model
  // emits reasoning tokens billed at the output rate. Previously
  // dropped entirely from the cache-stats payload, so the UI showed
  // ~30-50% under-counted output cost.
  const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
  const cached =
    typeof usage?.input_tokens_details?.cached_tokens === 'number'
      ? usage.input_tokens_details.cached_tokens
      : undefined;
  const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
  const reasoning =
    typeof usage?.output_tokens_details?.reasoning_tokens === 'number'
      ? usage.output_tokens_details.reasoning_tokens
      : undefined;
  return {
    input_tokens: input != null && cached != null ? Math.max(0, input - cached) : input,
    cache_read_input_tokens: cached,
    // OpenAI has no notion of cache_creation tokens (auto-cache is free
    // on the write side). Anthropic charges a one-time write fee per
    // breakpoint. Returning undefined avoids inflating cost when the
    // downstream UI multiplies by an Anthropic-rate.
    cache_creation_input_tokens: undefined,
    output_tokens: output,
    reasoning_tokens: reasoning,
  };
}

// Bridge event consumer — unused right now (we use non-streaming for tool
// detection rounds and emit final text synthetically). Keep here for the
// next step when we move to streaming the final round.
void bridgeOpenAiStreamEvent;
