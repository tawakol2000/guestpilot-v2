/**
 * Sprint 059-A F1.5 — Direct-transport runner.
 *
 * Wires the MCP router (F1.1) + hook dispatcher (F1.2) + history replay
 * (F1.3) + raw-stream bridge (F1.4) around a direct
 * `@anthropic-ai/sdk` `messages.stream()` call. On any unhandled
 * exception the runner logs a `[DirectRunner]` WARN tagged with a
 * `<reason>`, and returns `{ status: 'fallback', fallbackReason: <tag> }`.
 * The runtime.ts dispatcher treats that as a signal to run the SDK path
 * for the same turn.
 *
 * Fallback tags (spec §3 F1.5):
 *   - 'history_error'   loadConversationHistory threw
 *   - 'api_error'       anthropic.messages.stream threw before or during
 *   - 'bridge_error'    bridgeAnthropicStream threw
 *   - 'hook_error'      pre/post/stop hook threw
 *   - 'unknown_tool'    McpUnknownToolError from dispatch
 *
 * No metric module exists yet — the WARN line is the only observability
 * today. A follow-up sprint wires `build_direct_fallback_total{reason}`
 * into the metrics sink. See PROGRESS.md.
 */
import type { UIMessageChunk } from 'ai';
import {
  bridgeAnthropicStream,
  toolResultSDKMessage,
  type BridgedSDKMessage,
  type ToolResultShape,
} from './anthropic-stream-bridge';
import {
  loadConversationHistory,
  persistAssistantTurn,
  type AnthropicMessageHistory,
} from './history-replay';
import {
  McpUnknownToolError,
  type McpRouter,
  type McpDispatchContext,
  type McpToolResult,
} from './mcp-router';
import type { HookDispatcher } from './hook-dispatcher';
import type { PrismaClient } from '@prisma/client';

/**
 * Subset of the Anthropic SDK client surface the runner needs. Kept as an
 * interface so tests can stub `messages.stream` without pulling the real SDK
 * client (which requires ANTHROPIC_API_KEY at import time on some versions).
 */
export interface AnthropicMessagesClient {
  messages: {
    stream(params: Record<string, unknown>): AsyncIterable<any>;
  };
}

export interface DirectRunInput {
  prisma: PrismaClient;
  conversationId: string;
  tenantId: string;
  mode: 'BUILD' | 'TUNE';
  /** The incoming user turn — appended to replayed history. */
  userTurn: { role: 'user'; content: string | Array<Record<string, unknown>> };
  model: string;
  maxTokens: number;
  /** Full assembled system prompt. `buildDirectMessagesCreateParams` splits it. */
  assembledSystemPrompt: string;
  /** Anthropic-shaped tool definitions (name / description / input_schema). */
  tools: Array<{ name: string; description?: string; input_schema: Record<string, unknown>; [key: string]: unknown }>;
  /** Optional extended-thinking config. */
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** Hook dispatcher wrapping buildTuningAgentHooks + HookContext. */
  hooks: HookDispatcher;
  /** MCP router wrapping the tool handlers. */
  mcpRouter: McpRouter;
  /** Anthropic SDK client — injectable for tests. */
  anthropic: AnthropicMessagesClient;
  /** Pre-computed assistant message id (deterministic stream ids). */
  assistantMessageId: string;
}

export type DirectFallbackReason =
  | 'unknown_tool'
  | 'hook_error'
  | 'bridge_error'
  | 'history_error'
  | 'api_error';

export interface DirectRunResult {
  status: 'success' | 'fallback' | 'error';
  fallbackReason?: DirectFallbackReason;
  /**
   * On success, the aggregated assistant message that was persisted via
   * `persistAssistantTurn()`. On fallback/error, undefined.
   */
  assistantMessage?: { content: string | Array<Record<string, unknown>> };
}

/** Max number of tool-use rounds per turn. Matches runtime.ts convention. */
const MAX_TOOL_ROUNDS = 5;

export async function runDirectTurn(
  input: DirectRunInput,
  write: (chunk: UIMessageChunk) => void,
): Promise<DirectRunResult> {
  // ─── 1. Load history ───────────────────────────────────────────────────
  let history: AnthropicMessageHistory[];
  try {
    history = await loadConversationHistory(input.prisma, input.conversationId);
  } catch (err) {
    console.warn(
      `[DirectRunner] fallback: reason=history_error`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'fallback', fallbackReason: 'history_error' };
  }

  // ─── 2. Build base Anthropic messages array ────────────────────────────
  // We append tool_use/tool_result pairs here across rounds.
  const messages: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = [
    ...history,
    input.userTurn,
  ];

  const mcpCtx: McpDispatchContext = {
    conversationId: input.conversationId,
    tenantId: input.tenantId,
    mode: input.mode,
  };

  // Aggregated assistant content across all rounds — this is what we
  // ultimately persist via persistAssistantTurn(). Each round's assistant
  // turn may carry text + tool_use blocks; we collect them in-order.
  const aggregatedAssistant: Array<Record<string, unknown>> = [];

  // Feed bridged SDKMessages through the UI stream (stream-bridge.ts).
  // Imported lazily to match runtime.ts's pattern — keeps this module
  // testable without having to stub stream-bridge in every test.
  const { makeBridgeState, bridgeSDKMessage } = await loadStreamBridge();
  const bridgeState = makeBridgeState(input.assistantMessageId);

  const forwardToUi = (msg: BridgedSDKMessage) => {
    try {
      bridgeSDKMessage(msg as any, bridgeState, write);
    } catch {
      /* stream closed — swallow */
    }
  };

  // ─── 3. Tool-use round loop ────────────────────────────────────────────
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    // Build params fresh each round — system + tools array are identical
    // across rounds (cache prefix stays hot); only `messages` grows.
    let params: Record<string, unknown>;
    try {
      const { buildDirectMessagesCreateParams } = await import('../runtime-direct');
      params = buildDirectMessagesCreateParams({
        model: input.model,
        maxTokens: input.maxTokens,
        assembledSystemPrompt: input.assembledSystemPrompt,
        tools: input.tools,
        messages,
        thinking: input.thinking,
      }) as unknown as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[DirectRunner] fallback: reason=api_error (param build)`,
        err instanceof Error ? err.message : err,
      );
      return { status: 'fallback', fallbackReason: 'api_error' };
    }

    // Raw Anthropic stream.
    let rawStream: AsyncIterable<any>;
    try {
      rawStream = input.anthropic.messages.stream(params);
    } catch (err) {
      console.warn(
        `[DirectRunner] fallback: reason=api_error (stream init)`,
        err instanceof Error ? err.message : err,
      );
      return { status: 'fallback', fallbackReason: 'api_error' };
    }

    // Collect tool_use blocks we see via the bridge's synthetic assistant
    // SDKMessages. Each one we dispatch + inject a tool_result for, then
    // continue to the next round with the extended `messages` array.
    const pendingToolUses: Array<{ id: string; name: string; input: unknown }> = [];
    // Collect text blocks accumulated so far (for aggregation + persist).
    const roundAssistantBlocks: Array<Record<string, unknown>> = [];
    // Used to assemble text from per-delta bridge stream_events when the
    // server sends a final message without a content_block_start aggregate.
    let roundText = '';
    let sawStopReason: string | null = null;

    try {
      for await (const bridged of bridgeAnthropicStream(rawStream)) {
        // Forward every bridged message to the UI first — the bridge
        // handles text-start/delta/end, tool-input-available, etc.
        forwardToUi(bridged);

        if (bridged.type === 'assistant') {
          // Synthetic assistant SDKMessage from content_block_stop on a
          // tool_use block. Extract it for dispatch.
          const msg: any = bridged;
          const content = msg.message?.content ?? [];
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              pendingToolUses.push({
                id: block.id,
                name: block.name ?? 'unknown',
                input: block.input ?? {},
              });
              roundAssistantBlocks.push({
                type: 'tool_use',
                id: block.id,
                name: block.name ?? 'unknown',
                input: block.input ?? {},
              });
            }
          }
        } else if (bridged.type === 'stream_event') {
          // Accumulate text/thinking deltas for the aggregated assistant
          // turn. Text deltas alone cover the final text on this round.
          const ev: any = (bridged as any).event;
          if (ev?.type === 'content_block_delta') {
            const d = ev.delta;
            if (d?.type === 'text_delta' && typeof d.text === 'string') {
              roundText += d.text;
            }
          } else if (ev?.type === 'message_delta') {
            const reason = ev.delta?.stop_reason;
            if (typeof reason === 'string') sawStopReason = reason;
          }
        } else if (bridged.type === 'result') {
          // Bridge finished consuming raw events for this round.
          break;
        }
      }
    } catch (err) {
      if (err instanceof McpUnknownToolError) {
        console.warn(
          `[DirectRunner] fallback: reason=unknown_tool tool=${err.toolName}`,
          err.message,
        );
        return { status: 'fallback', fallbackReason: 'unknown_tool' };
      }
      console.warn(
        `[DirectRunner] fallback: reason=bridge_error`,
        err instanceof Error ? err.message : err,
      );
      return { status: 'fallback', fallbackReason: 'bridge_error' };
    }

    // Prepend any pure-text content for this round BEFORE tool_use blocks
    // (matches the Anthropic ordering on the replay).
    if (roundText.length > 0) {
      roundAssistantBlocks.unshift({ type: 'text', text: roundText });
    }

    // Append this round's assistant blocks to the aggregated transcript +
    // the live `messages` array (so the next round has the full context).
    if (roundAssistantBlocks.length > 0) {
      aggregatedAssistant.push(...roundAssistantBlocks);
      messages.push({ role: 'assistant', content: roundAssistantBlocks });
    }

    // No tool calls this round → turn is done.
    if (pendingToolUses.length === 0) {
      break;
    }

    // Dispatch each tool call via hook pipeline + MCP router.
    const toolResultBlocks: Array<Record<string, unknown>> = [];
    for (const call of pendingToolUses) {
      // PreToolUse hook.
      let preOutcome;
      try {
        preOutcome = await input.hooks.preToolUse(call.name, call.input, call.id);
      } catch (err) {
        console.warn(
          `[DirectRunner] fallback: reason=hook_error (preToolUse ${call.name})`,
          err instanceof Error ? err.message : err,
        );
        return { status: 'fallback', fallbackReason: 'hook_error' };
      }

      let result: McpToolResult;
      if (preOutcome.cancel) {
        // Hook denied. Synthesize a tool_result with the reason.
        result = {
          type: 'tool_result',
          tool_use_id: call.id,
          content: preOutcome.reason ?? 'hook denied',
          is_error: true,
        };
      } else {
        // Dispatch via router.
        try {
          result = await input.mcpRouter.dispatch(call.name, call.input, mcpCtx, call.id);
        } catch (err) {
          if (err instanceof McpUnknownToolError) {
            console.warn(
              `[DirectRunner] fallback: reason=unknown_tool tool=${err.toolName}`,
              err.message,
            );
            return { status: 'fallback', fallbackReason: 'unknown_tool' };
          }
          // Other router throws are wrapped as bridge_error — the router
          // normally surfaces handler failures as `is_error: true` tool
          // results, so an exception here is a router-layer failure.
          console.warn(
            `[DirectRunner] fallback: reason=bridge_error (router dispatch)`,
            err instanceof Error ? err.message : err,
          );
          return { status: 'fallback', fallbackReason: 'bridge_error' };
        }
      }

      // PostToolUse hook (always awaited — writes ToolTrace rows).
      try {
        await input.hooks.postToolUse(call.name, call.input, result, call.id);
      } catch (err) {
        console.warn(
          `[DirectRunner] fallback: reason=hook_error (postToolUse ${call.name})`,
          err instanceof Error ? err.message : err,
        );
        return { status: 'fallback', fallbackReason: 'hook_error' };
      }

      // Feed the tool_result through the UI bridge (tool-output-available).
      const toolResultSDK = toolResultSDKMessage(call.id, result as unknown as ToolResultShape);
      forwardToUi(toolResultSDK);

      // Collect for the next `messages.stream` round.
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.content,
        ...(result.is_error ? { is_error: true } : {}),
      });
    }

    // Append tool results as a single user turn.
    if (toolResultBlocks.length > 0) {
      messages.push({ role: 'user', content: toolResultBlocks });
    }

    // If the model signalled end_turn, we would have broken out above
    // (no pendingToolUses). If stop_reason was tool_use we continue.
    if (sawStopReason && sawStopReason !== 'tool_use') {
      break;
    }
  }

  // ─── 4. Stop hook ──────────────────────────────────────────────────────
  try {
    await input.hooks.stop();
  } catch (err) {
    console.warn(
      `[DirectRunner] fallback: reason=hook_error (stop)`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'fallback', fallbackReason: 'hook_error' };
  }

  // ─── 5. Persist the aggregated assistant message ───────────────────────
  const assistantMessage: { content: string | Array<Record<string, unknown>> } =
    aggregatedAssistant.every((b) => b.type === 'text')
      ? { content: aggregatedAssistant.map((b) => String(b.text ?? '')).join('') }
      : { content: aggregatedAssistant };
  try {
    await persistAssistantTurn(input.prisma, input.conversationId, assistantMessage);
  } catch (err) {
    // Non-fatal for the user's turn — we already streamed the reply.
    // Log but don't fallback (fallback would re-run the turn, producing
    // duplicate messages).
    console.warn(
      `[DirectRunner] persistAssistantTurn failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }

  // ─── 6. Final finish chunk ─────────────────────────────────────────────
  try {
    write({ type: 'finish' } as unknown as UIMessageChunk);
  } catch {
    /* swallow */
  }

  return { status: 'success', assistantMessage };
}

/**
 * Load stream-bridge lazily. Matches runtime.ts's CJS-require dance for the
 * Agent SDK — avoids top-level ESM/CJS interop hazards in the backend build.
 */
async function loadStreamBridge(): Promise<typeof import('../stream-bridge')> {
  // Static import works here because stream-bridge.ts is a pure TS module
  // with no SDK-gated side effects; the lazy wrapper keeps the option open
  // if we need to swap it later.
  return import('../stream-bridge');
}
