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
import { assembleSystemPrompt, type SystemPromptContext } from './system-prompt';
import { buildTuningAgentMcpServer, type ToolContext } from './tools';
import { TUNING_AGENT_SERVER_NAME, TUNING_AGENT_TOOL_NAMES } from './tools/names';
import { buildTuningAgentHooks, type HookContext } from './hooks';
import { makeBridgeState, bridgeSDKMessage } from './stream-bridge';
import { listMemoryByPrefix } from './memory/service';
import { isTuningAgentEnabled, tuningAgentDisabledReason, resolveTuningAgentModel } from './config';
import { runWithAiTrace, startAiSpan } from '../services/observability.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadAgentSdk } = require('./sdk-loader.cjs') as typeof import('./sdk-loader');

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

  // ─── Resolve session id (resume or fresh) ──────────────────────────────
  const conversation = await input.prisma.tuningConversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
    select: { id: true, sdkSessionId: true, anchorMessageId: true },
  });
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
  const [memory, pending] = await Promise.all([
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
      total: pending.length,
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
  };
  const systemPrompt = assembleSystemPrompt(promptCtx);

  // ─── Wire the hook + tool contexts ─────────────────────────────────────
  const lastUserSnapshot = { text: input.userMessage };
  const compliance = { lastUserSanctionedApply: false };
  const persistedDataParts: Array<{ type: string; id?: string; data: unknown }> = [];
  const toolCallsInvoked: string[] = [];

  const emitDataPart = (part: { type: string; id?: string; data: unknown; transient?: boolean }) => {
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

  const toolCtx: ToolContext = {
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    userId: input.userId,
    lastUserSanctionedApply: false,
    emitDataPart,
  };
  const hookCtx: HookContext = {
    prisma: input.prisma,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    userId: input.userId,
    readLastUserMessage: () => lastUserSnapshot.text,
    emitDataPart,
    compliance,
  };

  const mcpServer = await buildTuningAgentMcpServer(() => {
    toolCtx.lastUserSanctionedApply = compliance.lastUserSanctionedApply;
    return toolCtx;
  });
  const hooks = buildTuningAgentHooks(() => hookCtx);
  const { query } = await loadAgentSdk();

  // ─── Query execution ───────────────────────────────────────────────────
  const state = makeBridgeState(input.assistantMessageId);
  input.writer.write({ type: 'start', messageId: input.assistantMessageId });
  input.writer.write({ type: 'start-step' });

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
          mcpServers: {
            [TUNING_AGENT_SERVER_NAME]: mcpServer,
          },
          // Always allow our in-process MCP tools without prompting.
          allowedTools: Object.values(TUNING_AGENT_TOOL_NAMES),
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

  return {
    sdkSessionId,
    finalAssistantText: finalText,
    toolCallsInvoked,
    persistedDataParts,
    error: runError,
  };
}
