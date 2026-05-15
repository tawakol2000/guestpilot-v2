/**
 * OpenAI Responses API streaming events → Vercel AI SDK UIMessageChunk bridge.
 *
 * Output is byte-compatible with `../stream-bridge.ts` (Anthropic path):
 *   - `text-start` / `text-delta` / `text-end` for visible assistant text
 *   - `tool-input-start` / `tool-input-available` for function calls
 *   - `tool-output-available` for function-call results
 *   - `finish-step` / `finish` at the end of the turn
 *
 * The Responses API emits events shaped roughly like:
 *   { type: 'response.output_text.delta', delta: '...' }
 *   { type: 'response.output_item.added', item: { type, name, call_id } }
 *   { type: 'response.output_item.done', item: { ... } }
 *   { type: 'response.function_call_arguments.delta', delta: '...' }
 *   { type: 'response.completed', response: { ... } }
 *
 * Many of these are not surfaced (e.g. arguments deltas mid-call). We only
 * map the events the frontend cares about — the non-streaming "detect tool
 * calls first" round in the runner already handles tool dispatch; this
 * bridge only runs during the final streaming text emit.
 */
import type { UIMessageChunk } from 'ai';

type Writer = (chunk: UIMessageChunk) => void;

export interface OpenAiBridgeState {
  assistantMessageId: string;
  textBlockId: string | null;
  textBlockCounter: number;
  finished: boolean;
}

export function makeOpenAiBridgeState(assistantMessageId: string): OpenAiBridgeState {
  return {
    assistantMessageId,
    textBlockId: null,
    textBlockCounter: 0,
    finished: false,
  };
}

function closeText(state: OpenAiBridgeState, write: Writer) {
  if (state.textBlockId) {
    write({ type: 'text-end', id: state.textBlockId });
    state.textBlockId = null;
  }
}

/**
 * 2026-05-15 (H6): exposed helper for the runner's error path. When the
 * run throws mid-stream, the bridge may have an open text block. The
 * runner must close it BEFORE writing `error` + `finish` chunks, then
 * mark `state.finished = true` so the trailing finaliser short-circuits.
 * Calling this on a clean bridge (no open block) is a no-op.
 */
export function closeOpenTextBlockBeforeError(state: OpenAiBridgeState, write: Writer): void {
  closeText(state, write);
}

function ensureTextBlock(state: OpenAiBridgeState, write: Writer): string {
  if (state.textBlockId) return state.textBlockId;
  state.textBlockCounter += 1;
  const id = `text:${state.assistantMessageId}:${state.textBlockCounter}`;
  state.textBlockId = id;
  write({ type: 'text-start', id });
  return id;
}

/**
 * Apply one Responses API stream event. Unknown event types are silently
 * dropped — never throw, since OpenAI ships new event types every few
 * months and a missing case must not stall the turn.
 */
export function bridgeOpenAiStreamEvent(
  event: { type?: string; delta?: unknown; text?: unknown; [k: string]: unknown },
  state: OpenAiBridgeState,
  write: Writer,
): void {
  if (state.finished) return;
  if (!event || typeof event.type !== 'string') return;

  switch (event.type) {
    case 'response.output_text.delta': {
      if (typeof event.delta !== 'string' || event.delta.length === 0) return;
      const id = ensureTextBlock(state, write);
      write({ type: 'text-delta', id, delta: event.delta });
      return;
    }
    case 'response.output_text.done': {
      // Don't close the text block here — multiple text segments may
      // share the same logical block (e.g. between tool calls in the
      // non-streaming detection loop). The runner closes the block at
      // turn end via `finalizeOpenAiBridge`.
      return;
    }
    case 'response.completed':
    case 'response.failed':
    case 'response.incomplete': {
      finalizeOpenAiBridge(state, write, event.type === 'response.completed' ? 'stop' : 'error');
      return;
    }
    default:
      return;
  }
}

/**
 * Emit a single text block from a non-streaming response. Called when the
 * runner finishes its tool-detection loop and the final text came back as
 * a complete response (no streaming).
 */
export function emitFinalText(
  text: string,
  state: OpenAiBridgeState,
  write: Writer,
): void {
  if (state.finished || !text) return;
  const id = ensureTextBlock(state, write);
  write({ type: 'text-delta', id, delta: text });
}

/**
 * Emit a function call as `tool-input-start` + `tool-input-available`.
 * Mirrors the Anthropic bridge's tool-use shape so the frontend renders
 * the same `ToolCallChip`.
 */
export function emitFunctionCall(
  call: { name: string; call_id: string; arguments: string },
  state: OpenAiBridgeState,
  write: Writer,
): void {
  if (state.finished) return;
  closeText(state, write);
  let parsedArgs: unknown = {};
  try {
    parsedArgs = JSON.parse(call.arguments || '{}');
  } catch {
    parsedArgs = { _raw: call.arguments };
  }
  write({
    type: 'tool-input-start',
    toolCallId: call.call_id,
    toolName: call.name,
  });
  write({
    type: 'tool-input-available',
    toolCallId: call.call_id,
    toolName: call.name,
    input: parsedArgs,
  });
}

/**
 * Emit a tool-result payload. The Anthropic bridge does this from `user`
 * messages carrying `tool_result` blocks; we just emit directly after the
 * handler returns.
 */
export function emitToolOutput(
  callId: string,
  output: unknown,
  state: OpenAiBridgeState,
  write: Writer,
): void {
  if (state.finished) return;
  write({
    type: 'tool-output-available',
    toolCallId: callId,
    output,
  });
}

/** Close any open text block and emit terminal chunks. */
export function finalizeOpenAiBridge(
  state: OpenAiBridgeState,
  write: Writer,
  finishReason: 'stop' | 'error' = 'stop',
): void {
  if (state.finished) return;
  closeText(state, write);
  state.finished = true;
  write({ type: 'finish-step' });
  write({ type: 'finish', finishReason });
}
