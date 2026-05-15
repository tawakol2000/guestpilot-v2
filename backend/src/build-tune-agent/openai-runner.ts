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
} from './config';
import { runWithAiTrace } from '../services/observability.service';
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

  // ─── Conversation + state ────────────────────────────────────────────────
  const [conversation, priorMessageCount] = await Promise.all([
    input.prisma.tuningConversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId },
      select: {
        id: true,
        anchorMessageId: true,
        stateMachineSnapshot: true,
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

  const turnStartSnapshot: StateMachineSnapshot = coerceSnapshot(
    conversation.stateMachineSnapshot ?? DEFAULT_SNAPSHOT,
  );

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
    emitDataPart,
  };

  const bridgeState = makeOpenAiBridgeState(input.assistantMessageId);

  // ─── Build initial Responses API input ──────────────────────────────────
  const priorInput = await loadConversationHistoryAsResponsesInput(
    input.prisma,
    input.conversationId,
  );
  type RawInputItem = Record<string, unknown>;
  // 2026-05-15 (C5): emit the per-turn dynamic suffix (Region C) as a
  // system role input item BEFORE the replayed history + user message.
  // This keeps the cacheable Region A+B prefix in `instructions` static
  // across turns, while still letting the model see the up-to-date
  // pending/memory/state context.
  let pendingInput: RawInputItem[] = [
    { type: 'message', role: 'system', content: systemBundle.dynamicSuffix },
    ...priorInput,
    { type: 'message', role: 'user', content: input.userMessage },
  ];

  const model = input.modelOverride ?? resolveStudioOpenAiModel();
  let lastUsage:
    | {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
      }
    | null = null;
  let aggregateFinalText = '';
  let previousResponseId: string | null = null;
  let runError: string | null = null;

  try {
    await runWithAiTrace(
      {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        agentName: 'tuning-agent-openai',
        messageId: input.assistantMessageId,
      },
      async () => {
        await runResponsesLoop({
          input,
          middleware,
          fullRegistry,
          allowedToolsForState,
          systemBundle,
          assembledSystemPrompt,
          model,
          pendingInput,
          previousResponseId,
          bridgeState,
          filteredWrite,
          emitDataPart,
          toolCallsInvoked,
          toolCallsSucceeded,
          onUsage: (u) => {
            lastUsage = u;
          },
          onFinalText: (t) => {
            aggregateFinalText += t;
          },
          onPreviousResponseIdSet: (id) => {
            previousResponseId = id;
          },
        });
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
  onUsage: (u: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  }) => void;
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
      parallel_tool_calls: false,
      reasoning: { effort: 'low' },
      prompt_cache_key: args.systemBundle.promptCacheKey,
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
    if (response?.usage) {
      args.onUsage(normaliseUsage(response.usage));
    }

    const outputItems: any[] = Array.isArray(response?.output) ? response.output : [];
    const functionCalls = outputItems.filter((o) => o?.type === 'function_call');

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

  // Max rounds exceeded — emit a synthetic advisory + finish.
  console.warn('[openai-runner] hit MAX_TOOL_ROUNDS, terminating turn');
  args.emitDataPart({
    type: DATA_PART_TYPES.advisory,
    data: {
      kind: 'tool_loop_terminated',
      reason: `Exceeded ${MAX_TOOL_ROUNDS} tool-call rounds`,
    },
    transient: true,
  });
  finalizeOpenAiBridge(args.bridgeState, args.filteredWrite, 'stop');
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
