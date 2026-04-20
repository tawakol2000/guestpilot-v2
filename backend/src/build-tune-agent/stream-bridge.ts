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
 * Data parts (`data-*`) do NOT flow through this bridge — tools emit them
 * directly via the runtime's `emitDataPart` sink, which writes to the
 * Vercel AI SDK stream writer as already-shaped chunks. Adding a new
 * `data-*` type requires (a) a contract entry in `./data-parts.ts` and
 * (b) a frontend `StandalonePart` consumer; no change here. See sprint
 * 046 Session B plan §5.4.
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
  /** Sprint 09 fix 11 — monotonically increasing index for unique text block ids. */
  textBlockCounter: number;
}

export function makeBridgeState(assistantMessageId: string): BridgeState {
  return {
    assistantMessageId,
    textBlockId: null,
    reasoningBlockId: null,
    seenToolIds: new Set(),
    finished: false,
    textBlockCounter: 0,
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
          // If partial `stream_event` deltas already forwarded THIS text
          // block live, the SDK's aggregated `assistant` message carries
          // the same content verbatim — emitting another text-delta would
          // duplicate the text in the UI. Skip the aggregate in that case;
          // closeText() on a subsequent tool_use / result ends the block.
          if (state.textBlockId) continue;
          // Sprint 09 fix 11: after a tool_use, the next text block was
          // silently dropped because closeText() cleared textBlockId but
          // any subsequent text_delta / aggregate text kept re-using the
          // SAME stream id — the UI had already closed that id and
          // ignored it. Bump a counter so each text block gets a unique
          // id and its own text-start.
          state.textBlockCounter += 1;
          const id = `text:${state.assistantMessageId}:${state.textBlockCounter}`;
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
          // Sprint 09 fix 11: same counter-based unique id as the
          // aggregated-assistant path. A stream_event arriving AFTER a
          // tool_use started the next text block needs a fresh id, not
          // the same `text:…:1` the UI already closed.
          let id = state.textBlockId;
          if (!id) {
            state.textBlockCounter += 1;
            id = `text:${state.assistantMessageId}:${state.textBlockCounter}`;
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
