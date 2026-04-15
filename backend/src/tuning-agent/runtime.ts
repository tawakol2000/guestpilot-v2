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
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PrismaClient } from '@prisma/client';
import type { UIMessageStreamWriter } from 'ai';
import { assembleSystemPrompt, type SystemPromptContext } from './system-prompt';
import { buildTuningAgentMcpServer, TUNING_AGENT_SERVER_NAME, type ToolContext } from './tools';
import { buildTuningAgentHooks, type HookContext } from './hooks';
import { makeBridgeState, bridgeSDKMessage } from './stream-bridge';
import { listMemoryByPrefix } from './memory/service';
import { isTuningAgentEnabled, tuningAgentDisabledReason, resolveTuningAgentModel } from './config';
import { runWithAiTrace, startAiSpan } from '../services/observability.service';

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

  const mcpServer = buildTuningAgentMcpServer(() => {
    toolCtx.lastUserSanctionedApply = compliance.lastUserSanctionedApply;
    return toolCtx;
  });
  const hooks = buildTuningAgentHooks(() => hookCtx);

  // ─── Query execution ───────────────────────────────────────────────────
  const state = makeBridgeState(input.assistantMessageId);
  input.writer.write({ type: 'start', messageId: input.assistantMessageId });
  input.writer.write({ type: 'start-step' });

  const model = input.modelOverride ?? resolveTuningAgentModel();
  let sdkSessionId: string | null = conversation.sdkSessionId ?? null;
  let finalText = '';
  let runError: string | null = null;

  try {
    await runWithAiTrace(
      {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        agentName: 'tuning-agent',
        messageId: input.assistantMessageId,
      },
      async () => {
        const span = startAiSpan('tuning-agent.query', { model });
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
              allowedTools: Object.values(
                (await import('./tools')).TUNING_AGENT_TOOL_NAMES
              ),
              // Disable built-in CLI tools — agent should only use our 8.
              tools: [],
              hooks,
              // Streaming + session persistence.
              includePartialMessages: true,
              persistSession: true,
              ...(sdkSessionId ? { resume: sdkSessionId } : {}),
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
