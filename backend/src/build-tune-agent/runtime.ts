/**
 * Tuning-agent runtime entry point.
 *
 * Responsibilities:
 *   - Build the ToolContext + HookContext closures.
 *   - Assemble the system prompt (with cache boundary).
 *   - Call Claude Agent SDK `query()` with the in-process MCP server + hooks.
 *   - Stream SDKMessage events through the bridge into a Vercel AI SDK
 *     UIMessageStreamWriter. Emit data parts inline.
 *   - Persist the final assistant message to TuningMessage.
 *   - Update TuningConversation.sdkSessionId on first turn, resume it on
 *     subsequent turns.
 *
 * Degrades silently when ANTHROPIC_API_KEY is missing (returns a data-error
 * part and finishes the stream; UI renders a calm "chat disabled" card).
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
 * Resolve the path to the Claude Agent SDK's bundled `cli.js` so we can pass
 * it explicitly as `options.pathToClaudeCodeExecutable`. The SDK tries to
 * auto-resolve this via `require.resolve` against its own `import.meta.url`,
 * which on some hosts (e.g. Railway / nixpacks) fails even though the file is
 * present on disk. Resolving it ourselves from the backend's own require()
 * root is robust to whatever the SDK's internal detection gets wrong.
 * Returns undefined if resolution fails — the SDK will then attempt its own
 * discovery (which may still work on well-behaved environments).
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
 * Sprint 045 per-mode allow-lists. The tools array sent to the SDK is
 * always the full MCP server (cache-preserving); `allowedTools` gates
 * which tool_use blocks the SDK permits the agent to emit.
 *
 * Gate 2 (create_sop etc.) will append the BUILD-path tool names as
 * they're registered. Until then BUILD mode can only call read-only
 * tools + plan/preview when those land.
 */
function resolveAllowedTools(mode: AgentMode): string[] {
  if (mode === 'BUILD') {
    return [
      TUNING_AGENT_TOOL_NAMES.get_context,
      TUNING_AGENT_TOOL_NAMES.memory,
      TUNING_AGENT_TOOL_NAMES.search_corrections,
      TUNING_AGENT_TOOL_NAMES.get_version_history,
      TUNING_AGENT_TOOL_NAMES.rollback,
      // Gate 2 BUILD-path creators:
      TUNING_AGENT_TOOL_NAMES.create_faq,
      TUNING_AGENT_TOOL_NAMES.create_sop,
      TUNING_AGENT_TOOL_NAMES.create_tool_definition,
      TUNING_AGENT_TOOL_NAMES.write_system_prompt,
      TUNING_AGENT_TOOL_NAMES.plan_build_changes,
      // Gate 3 single-message verification tool (also in TUNE below):
      TUNING_AGENT_TOOL_NAMES.test_pipeline,
      // Sprint 046 Session A — full-artifact grounding tool (also in TUNE).
      TUNING_AGENT_TOOL_NAMES.get_current_state,
      // Sprint 046 Session B — card-shaped I/O wrappers (also in TUNE).
      TUNING_AGENT_TOOL_NAMES.ask_manager,
      TUNING_AGENT_TOOL_NAMES.emit_audit,
      // Sprint 056-A F2 — "Ask-the-past" edit-history query (also in TUNE).
      TUNING_AGENT_TOOL_NAMES.get_edit_history,
    ];
  }
  // TUNE mode per spec §2 — existing TUNE tools PLUS plan_build_changes
  // and test_pipeline (both callable in both modes). Deliberately does
  // NOT include the BUILD create_* tools; if the agent attempts one in
  // TUNE mode, the SDK denies it and the system-prompt instructs the
  // agent to advise switching modes rather than fabricate a workaround.
  return [
    TUNING_AGENT_TOOL_NAMES.get_context,
    TUNING_AGENT_TOOL_NAMES.search_corrections,
    TUNING_AGENT_TOOL_NAMES.fetch_evidence_bundle,
    TUNING_AGENT_TOOL_NAMES.propose_suggestion,
    TUNING_AGENT_TOOL_NAMES.suggestion_action,
    TUNING_AGENT_TOOL_NAMES.memory,
    TUNING_AGENT_TOOL_NAMES.get_version_history,
    TUNING_AGENT_TOOL_NAMES.rollback,
    TUNING_AGENT_TOOL_NAMES.plan_build_changes,
    TUNING_AGENT_TOOL_NAMES.test_pipeline,
    // Sprint 046 Session A — full-artifact grounding tool (shared with BUILD).
    TUNING_AGENT_TOOL_NAMES.get_current_state,
    // Sprint 046 Session B — card-shaped I/O wrappers (shared with BUILD).
    TUNING_AGENT_TOOL_NAMES.ask_manager,
    TUNING_AGENT_TOOL_NAMES.emit_audit,
    // Sprint 056-A F2 — "Ask-the-past" edit-history query (shared with BUILD).
    TUNING_AGENT_TOOL_NAMES.get_edit_history,
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

export async function runTuningAgentTurn(input: RunTurnInput): Promise<RunTurnResult> {
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

  // Sprint 045: BUILD requests require ENABLE_BUILD_MODE. TUNE requests
  // are unaffected.
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
    // Sprint 046 Session A — turn counter for BuildToolCallLog + the
    // forced first-turn get_current_state grounding call. Counting
    // TuningMessage rows before dispatching means turn 1 is `count === 0`.
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

  // ─── Assemble prompt context (memory + pending + session state) ────────
  //
  // Sprint 09 fix 1: `pending.length` after `take: 10` hid the real queue
  // size from the agent — 23 pending suggestions would be reported as "10".
  // Separate `count()` call keeps the detail array capped at 10 while
  // reporting the true total.
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
  // F3 — log the three-block split for observability. In a future sprint
  // where the Agent SDK exposes structured system-prompt content, replace
  // the flat `systemPrompt` string with `blocks` from this call and attach
  // `cache_control: { type: 'ephemeral' }` to region-a and region-b only.
  logCacheBlockStructure(input.tenantId, systemPrompt);
  const allowedTools = resolveAllowedTools(mode);

  // ─── Wire the hook + tool contexts ─────────────────────────────────────
  const lastUserSnapshot = { text: input.userMessage };
  const compliance = { lastUserSanctionedApply: false, lastUserSanctionedRollback: false };
  const persistedDataParts: Array<{ type: string; id?: string; data: unknown }> = [];
  const toolCallsInvoked: string[] = [];

  // Sprint 046 Session D — R2 enforcement. Only the first
  // `data-suggested-fix` per turn reaches the client + DB; subsequent
  // attempts are intercepted here so the manager never sees a duplicate
  // card, and a single `data-advisory` (kind: 'linter-drop') is emitted
  // at turn-end documenting the drop count.
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

  // Sprint 045 Gate 3: per-turn flags (test_pipeline hasRunThisTurn).
  // A fresh `{}` per `runTuningAgentTurn` invocation means the guard is
  // scoped to one user turn — a new turn resets it automatically.
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

  // ─── Query execution ───────────────────────────────────────────────────
  const state = makeBridgeState(input.assistantMessageId);
  // F3 — accumulate last usage object for cache-stats SSE part at turn end.
  let lastUsage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
  input.writer.write({ type: 'start', messageId: input.assistantMessageId });
  input.writer.write({ type: 'start-step' });

  // ─── Sprint 046 Session A — forced first-turn grounding ────────────────
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

  // Hotfix — the Claude Agent SDK persists session state on the local FS.
  // On Railway the container disk is ephemeral, so on every container
  // restart all stored sessions vanish. The next turn passes our saved
  // sdkSessionId as `resume`, the SDK can't find it, and the whole turn
  // errors with "No conversation found with session ID …". Architectural
  // fix is to stop using SDK session cache entirely and replay the
  // TuningMessage transcript ourselves; this hotfix detects the specific
  // "session not found" error and retries the SAME turn without resume so
  // the user gets a working response. The prior turns' context is lost
  // (SDK has no memory of them) — a follow-up will reconstruct context
  // from TuningMessage rows.
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
          // See resolveAgentSdkCliPath above — bypasses the SDK's own CLI
          // discovery when the hosting environment's require.resolve is
          // confused (seen on Railway with "Native CLI binary ... not found").
          ...(RESOLVED_SDK_CLI_PATH ? { pathToClaudeCodeExecutable: RESOLVED_SDK_CLI_PATH } : {}),
          mcpServers: {
            [TUNING_AGENT_SERVER_NAME]: mcpServer,
          },
          // Sprint 045: per-mode allow-list (TUNE: all 9 today; BUILD: subset
          // until Gate 2 tools land). The underlying MCP tools array is
          // unchanged between modes so the prompt cache stays warm.
          allowedTools,
          // Disable built-in CLI tools — agent should only use our 8.
          tools: [],
          hooks,
          // Streaming + session persistence.
          includePartialMessages: true,
          persistSession: true,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          // Low-cost permission mode: we pre-authorize our tools and
          // nothing else is exposed. `dontAsk` keeps accidental tool
          // calls from hanging on a user-input prompt that can't exist
          // in an API context.
          permissionMode: 'dontAsk',
          settingSources: [],
          // Agent-proper reasoning; Stop hook will emit a follow-up.
          effort: 'medium',
        },
      });
      for await (const message of q) {
        // Capture the SDK session id on first message.
        if (!sdkSessionId && 'session_id' in message && typeof message.session_id === 'string') {
          sdkSessionId = message.session_id;
        }
        if (message.type === 'assistant') {
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text') finalText += block.text;
            if (block.type === 'tool_use') toolCallsInvoked.push(block.name);
          }
          // Sprint 05 §8: surface prompt-cache usage on every assistant
          // message so the deploy verification can confirm the cached-
          // fraction target ≥ 0.70 on turn 2 without round-tripping to
          // Langfuse. The SDK passes the underlying Anthropic usage
          // object through verbatim on `message.message.usage`.
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
            // F3: keep the last usage object for the data-cache-stats part.
            lastUsage = u;
          }
        }
        bridgeSDKMessage(message, state, (chunk) => {
          try {
            input.writer.write(chunk);
          } catch {
            /* swallow — stream may be closed */
          }
        });
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
          // Session-not-found recovery — clear the stale id, drop our
          // local copy, and retry the same turn fresh. Prior-turn context
          // is lost (the SDK had no memory of it on disk), but the user's
          // CURRENT request still gets answered.
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
            // Reset state we accumulated on the failed pass so the retry
            // doesn't double-emit.
            finalText = '';
            toolCallsInvoked.length = 0;
            // Sprint 09 fix 16: also clear persistedDataParts. Previously any
            // data parts emitted during the failed first attempt would be
            // persisted twice — once here, once after the successful retry.
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

  // ─── Sprint 056-A F3 — data-cache-stats SSE part (LangFuse tagging) ───
  // Emit cache telemetry as a transient SSE part. The UI does NOT render
  // this; it is consumed by LangFuse via the onFinish event for tagging.
  // explicitCacheControlWired is always false until the Agent SDK exposes
  // structured system-prompt content blocks (sdk.d.ts:1475 limitation).
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

  // ─── Sprint 046 Sessions A + D — output-linter pass ────────────────────
  //
  // Post-turn inspection: does the completed turn violate the Response
  // Contract from the shared system prefix?
  //
  // Session A shipped log-only persistence as synthetic `__lint__` rows
  // in BuildToolCallLog. Session D flips R1 + R2 to drop-not-log:
  //   - R2 interception happens at emit time (first-wins in emitDataPart
  //     above). Post-turn we emit a single `data-advisory` documenting
  //     the drop count.
  //   - R1 emits a `data-advisory` when prose > 120 words with zero
  //     structured parts.
  //   - R3 stays log-only.
  // The advisory is emitted BEFORE persistence, so the Vercel AI SDK
  // onFinish event reads the linted final state.
  try {
    // Lint on the *post-intercept* part list — if R2 interception kicked
    // in, persistedDataParts already reflects one `data-suggested-fix`,
    // so lintAgentOutput won't re-flag R2. We pass the intercept count
    // separately to build an accurate advisory.
    const findings = lintAgentOutput({
      finalText: finalText,
      dataPartTypes: persistedDataParts.map((p) => p.type),
    });

    // R2 enforcement fires when suggestedFixDropped > 0 even if lint
    // didn't see multiple in the persisted array (because we dropped
    // them pre-persistence). Synthesise an R2 finding if interception
    // happened.
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
        success: true, // linter ran successfully; findings != error
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
