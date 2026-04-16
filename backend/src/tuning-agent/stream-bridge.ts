/**
 * SDKMessage → UIMessageChunk bridge.
 *
 * The Claude Agent SDK yields `SDKMessage` events (assistant message,
 * partial streaming event, tool use, tool result, result, etc.). The Vercel
 * AI SDK `useChat()` consumer expects `UIMessageChunk` events over SSE
 * (text-start/text-delta/text-end, tool-input-*, tool-output-*, data-*, etc.).
 *
 * This module adapts one to the other. It is intentionally pure (no
 * framework code): the chat controller wires it to `createUIMessageStream`
 * and `pipeUIMessageStreamToResponse`.
 *
 * Minimal, correct-enough coverage:
 *   - `assistant` messages with text content blocks → text-start/end
 *     around a single text-delta with the whole text.
 *   - `assistant` messages with thinking content → reasoning-start/delta/end.
 *   - `assistant` tool_use content → tool-input-start, tool-input-available
 *     (once we have the full input — sufficient for non-streaming case).
 *   - `user` tool_result content → tool-output-available.
 *   - Partial streaming events (`stream_event`) are best-effort: the SDK
 *     emits Anthropic BetaRawMessageStreamEvent objects. We only forward
 *     text_delta content block deltas as text-delta; reasoning deltas as
 *     reasoning-delta. Other partial shapes are ignored (final assistant
 *     message covers them on completion).
 *   - `result` messages close any open text/reasoning blocks and emit
 *     a top-level finish chunk.
 *   - `system` / retry / hook-progress / notification messages are dropped.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UIMessageChunk } from 'ai';

type Writer = (chunk: UIMessageChunk) => void;

export interface BridgeState {
  assistantMessageId: string;
  textBlockId: string | null;
  reasoningBlockId: string | null;
  seenToolIds: Set<string>;
  finished: boolean;
}

export function makeBridgeState(assistantMessageId: string): BridgeState {
  return {
    assistantMessageId,
    textBlockId: null,
    reasoningBlockId: null,
    seenToolIds: new Set(),
    finished: false,
  };
}

function closeText(state: BridgeState, write: Writer) {
  if (state.textBlockId) {
    write({ type: 'text-end', id: state.textBlockId });
    state.textBlockId = null;
  }
}

function closeReasoning(state: BridgeState, write: Writer) {
  if (state.reasoningBlockId) {
    write({ type: 'reasoning-end', id: state.reasoningBlockId });
    state.reasoningBlockId = null;
  }
}

/**
 * Apply an incoming SDKMessage to the bridge. `write` emits UIMessageChunks
 * directly into the Vercel AI SDK stream writer.
 */
export function bridgeSDKMessage(message: SDKMessage, state: BridgeState, write: Writer): void {
  if (state.finished) return;
  switch (message.type) {
    case 'assistant': {
      const assistant = message;
      const content = assistant.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text') {
          closeReasoning(state, write);
          // If partial `stream_event` deltas already forwarded this text
          // block live, the SDK's aggregated `assistant` message carries
          // the same content verbatim — emitting another text-delta here
          // would make the UI (and `onFinish`-persisted parts) show every
          // word twice. Skip the aggregate; closeText() on a subsequent
          // tool_use / result will end the block.
          if (state.textBlockId) continue;
          const id = `text:${state.assistantMessageId}:1`;
          state.textBlockId = id;
          write({ type: 'text-start', id });
          write({ type: 'text-delta', id, delta: block.text });
        } else if (block.type === 'thinking') {
          closeText(state, write);
          // Same rule for reasoning: don't re-emit the aggregate if
          // stream_event thinking_deltas already streamed the block.
          if (state.reasoningBlockId) continue;
          const id = `reasoning:${state.assistantMessageId}`;
          state.reasoningBlockId = id;
          write({ type: 'reasoning-start', id });
          write({ type: 'reasoning-delta', id, delta: block.thinking });
        } else if (block.type === 'tool_use') {
          closeText(state, write);
          closeReasoning(state, write);
          if (state.seenToolIds.has(block.id)) continue;
          state.seenToolIds.add(block.id);
          write({
            type: 'tool-input-start',
            toolCallId: block.id,
            toolName: block.name,
          });
          write({
            type: 'tool-input-available',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          });
        }
      }
      return;
    }
    case 'user': {
      // User messages inside the stream carry tool results (from tool_use).
      const user = message;
      const content = user.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && block.type === 'tool_result') {
            write({
              type: 'tool-output-available',
              toolCallId: block.tool_use_id,
              output: block.content,
            });
          }
        }
      }
      return;
    }
    case 'result': {
      closeText(state, write);
      closeReasoning(state, write);
      state.finished = true;
      write({ type: 'finish-step' });
      write({
        type: 'finish',
        finishReason: message.subtype === 'success' ? 'stop' : 'error',
      });
      return;
    }
    case 'stream_event': {
      const se = message as any;
      const ev = se.event;
      if (!ev) return;
      // Only the most useful partial events — Anthropic native delta shapes.
      if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
          const id = state.textBlockId ?? `text:${state.assistantMessageId}:1`;
          if (!state.textBlockId) {
            state.textBlockId = id;
            write({ type: 'text-start', id });
          }
          write({ type: 'text-delta', id, delta: ev.delta.text });
        } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
          const id = state.reasoningBlockId ?? `reasoning:${state.assistantMessageId}`;
          if (!state.reasoningBlockId) {
            state.reasoningBlockId = id;
            write({ type: 'reasoning-start', id });
          }
          write({ type: 'reasoning-delta', id, delta: ev.delta.thinking });
        }
      }
      return;
    }
    default:
      return;
  }
}
