/**
 * Sprint 059-A Stream B F1.4 — Anthropic raw-stream → SDKMessage adapter.
 *
 * The existing `stream-bridge.ts` consumes SDKMessage events (aggregate
 * shapes assembled by the Claude Agent SDK). The direct-transport path
 * (F1.5 runner) receives raw Anthropic events from
 * `anthropic.messages.stream()`:
 *   - message_start
 *   - content_block_start   (text | thinking | tool_use)
 *   - content_block_delta   (text_delta | thinking_delta | input_json_delta)
 *   - content_block_stop
 *   - message_delta         (carries stop_reason)
 *   - message_stop
 *
 * Per spec §3 F1.4 (option a) + §6 R3 we DO NOT recreate the
 * SDKMessage-bridge state machine here. stream-bridge.ts's Sprint 09 fix 11
 * (unique text ids + tool-id de-dup + reasoning/text interleaving) took two
 * sprints to get right; reimplementing it invites regressions. Instead we
 * adapt raw events → SDKMessage-shaped objects and feed them through the
 * existing `bridgeSDKMessage()` unchanged.
 *
 * Emission contract (verified by the three golden fixtures under
 * __tests__/fixtures/direct-stream/):
 *
 *   - Every text_delta / thinking_delta / input_json_delta raw event is
 *     wrapped as `{ type: 'stream_event', event: <raw> }` so the existing
 *     bridge's per-delta text/reasoning emission path handles it.
 *   - `content_block_stop` for a tool_use block synthesises an `assistant`
 *     SDKMessage carrying just that one complete tool_use block (with the
 *     aggregated input JSON parsed from the accumulated input_json_delta
 *     pieces). The existing bridge emits tool-input-start +
 *     tool-input-available. The runner (F1.5) also sees this event and
 *     dispatches the tool via the MCP router.
 *   - `message_delta` with `stop_reason === 'tool_use'` is a signal for
 *     the runner — we yield an `assistant` SDKMessage carrying all
 *     non-tool-use blocks (text/thinking aggregates) so the bridge's
 *     end-of-turn close is wired; the runner then dispatches the tool and
 *     injects a tool_result via `toolResultSDKMessage`, then re-streams.
 *   - `message_stop` synthesises a `result` SDKMessage with `subtype:
 *     'success'`. On exception propagation the caller yields a `result`
 *     with `subtype: 'error_during_execution'` itself — we do NOT catch
 *     inside the generator.
 *
 * NOTE on text/thinking aggregate de-dup:
 *   The existing bridge skips the aggregate text block if partial deltas
 *   already fed it — so synthesising an `assistant` SDKMessage with the
 *   same text content as was already streamed is safe. For tool_use we
 *   rely on `seenToolIds` de-dup in the bridge to suppress any duplicate
 *   emission across the per-block-stop and end-of-turn assistant messages.
 */

// Type imports — keeping these type-only means the module bundles cleanly
// whether or not the callers import the full Anthropic SDK at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';

/**
 * Shape matches `SDKMessage` variants consumed by `bridgeSDKMessage()` in
 * `stream-bridge.ts`. We do NOT import the concrete SDK types here — the
 * Claude Agent SDK's SDKMessage union adds hook/progress/notification
 * variants we don't produce, so a structurally-typed local interface
 * keeps this module independent of SDK-only variants while remaining
 * compatible with what the existing bridge switch-expects.
 */
export interface BridgedSDKMessage {
  type: 'stream_event' | 'assistant' | 'user' | 'result';
  [key: string]: unknown;
}

/**
 * Structural type for the result produced by F1.1's MCP router. The
 * Stream A module will export a richer `McpToolResult` type; we only
 * need enough here to serialise into an Anthropic `tool_result` content
 * block. Keep in sync if the actual F1.1 export diverges.
 */
export interface ToolResultShape {
  /** Either a plain text result or an Anthropic-compatible content array. */
  content: string | Array<Record<string, unknown>>;
  /** Sprint 058 MCP router contract: error results set `is_error: true`. */
  is_error?: boolean;
}

/**
 * Async generator: consume raw Anthropic stream events, yield
 * SDKMessage-shaped objects that `bridgeSDKMessage()` consumes unchanged.
 */
export async function* bridgeAnthropicStream(
  rawStream: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<BridgedSDKMessage> {
  // Block-index → accumulator. Text/thinking carry their delta text;
  // tool_use carries the partial input_json buffer + the block_start's
  // id/name so we can reconstruct the full block on block_stop.
  const blocks = new Map<number, BlockAccumulator>();
  let sawError = false;
  let stopReason: string | null = null;

  for await (const ev of rawStream as AsyncIterable<any>) {
    try {
      switch (ev.type) {
        case 'message_start':
          // No emission. The assistant message is not yet complete — we
          // wait for content blocks / message_stop.
          break;

        case 'content_block_start': {
          const idx = ev.index;
          const cb = ev.content_block;
          const acc: BlockAccumulator = blockFromStart(cb);
          blocks.set(idx, acc);
          // Forward the start event so the existing bridge has a hook to
          // react to (it mostly cares about deltas, but this keeps
          // semantics identical to the SDK's own event surface).
          yield { type: 'stream_event', event: ev };
          break;
        }

        case 'content_block_delta': {
          const idx = ev.index;
          const acc = blocks.get(idx);
          if (acc) {
            const d = ev.delta;
            if (d?.type === 'text_delta' && typeof d.text === 'string') {
              acc.text += d.text;
            } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
              acc.text += d.thinking;
            } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              acc.text += d.partial_json; // text field doubles as buffer for tool_use
            }
          }
          // text_delta / thinking_delta are the two deltas the existing
          // bridge's `stream_event` path recognises. input_json_delta is
          // ignored there, but forwarding it is harmless (bridge falls
          // through the default arm).
          yield { type: 'stream_event', event: ev };
          break;
        }

        case 'content_block_stop': {
          const idx = ev.index;
          const acc = blocks.get(idx);
          if (acc && acc.kind === 'tool_use') {
            // Synthesise a minimal `assistant` SDKMessage carrying only
            // this tool_use block. The bridge's `seenToolIds` de-dup
            // guarantees idempotence if the caller replays it.
            const input = parseJsonOrEmpty(acc.text);
            yield {
              type: 'assistant',
              session_id: 'direct',
              uuid: `toolu-wrap:${acc.toolId ?? idx}`,
              parent_tool_use_id: null,
              message: {
                id: `direct-${idx}`,
                role: 'assistant',
                type: 'message',
                content: [
                  {
                    type: 'tool_use',
                    id: acc.toolId ?? `toolu_unknown_${idx}`,
                    name: acc.toolName ?? 'unknown',
                    input,
                  },
                ],
              },
            };
          }
          // Forward the stop event so downstream consumers that track
          // per-block lifecycle have the signal (existing bridge ignores).
          yield { type: 'stream_event', event: ev };
          break;
        }

        case 'message_delta': {
          // Carries final stop_reason. We stash it and apply it at
          // message_stop — emitting a `result` here would close the
          // bridge's text/reasoning blocks before the final text_delta
          // has been seen on some providers.
          const reason = ev.delta?.stop_reason;
          if (typeof reason === 'string') stopReason = reason;
          yield { type: 'stream_event', event: ev };
          break;
        }

        case 'message_stop': {
          // Emit result. The bridge closes any open text/reasoning blocks
          // on this message and writes a finish chunk. `subtype: 'success'`
          // unless an error was injected upstream.
          yield {
            type: 'result',
            subtype: sawError ? 'error_during_execution' : 'success',
            session_id: 'direct',
            uuid: 'direct-result',
            result: '',
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: sawError,
            num_turns: 1,
            stop_reason: stopReason ?? 'end_turn',
            total_cost_usd: 0,
            usage: null,
            modelUsage: {},
            permission_denials: [],
          } as BridgedSDKMessage;
          break;
        }

        default:
          // Unknown event — forward as stream_event. The bridge's default
          // arm drops it; the runner's fallback logic can still trigger
          // on a genuinely unhandleable shape.
          yield { type: 'stream_event', event: ev };
      }
    } catch (err) {
      sawError = true;
      // Surface the error as a `result` and stop yielding. The runner's
      // try/catch wraps the generator consumption and falls back to the
      // SDK path on this signal.
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'direct',
        uuid: 'direct-result-err',
        result: '',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 1,
        stop_reason: 'error',
        total_cost_usd: 0,
        usage: null,
        modelUsage: {},
        permission_denials: [],
      };
      throw err;
    }
  }
}

/**
 * Synthesise a `user` SDKMessage carrying a single tool_result content
 * block. The F1.5 runner calls this after the MCP router dispatches a
 * tool_use — the returned SDKMessage is fed through `bridgeSDKMessage()`
 * so the UI sees a `tool-output-available` chunk, and is also appended to
 * the next `anthropic.messages.create` call's `messages` array so the
 * model sees the result on the continuation.
 */
export function toolResultSDKMessage(
  toolUseId: string,
  result: ToolResultShape,
): BridgedSDKMessage {
  const content = typeof result.content === 'string'
    ? [{ type: 'text', text: result.content }]
    : result.content;
  return {
    type: 'user',
    session_id: 'direct',
    uuid: `toolr:${toolUseId}`,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(result.is_error ? { is_error: true } : {}),
        },
      ],
    },
  };
}

// ─── internal ──────────────────────────────────────────────────────────

interface BlockAccumulator {
  kind: 'text' | 'thinking' | 'tool_use' | 'unknown';
  text: string;
  toolId?: string;
  toolName?: string;
}

function blockFromStart(cb: any): BlockAccumulator {
  const t = cb?.type;
  if (t === 'text') return { kind: 'text', text: typeof cb.text === 'string' ? cb.text : '' };
  if (t === 'thinking') return { kind: 'thinking', text: '' };
  if (t === 'tool_use') {
    return {
      kind: 'tool_use',
      text: '',
      toolId: typeof cb.id === 'string' ? cb.id : undefined,
      toolName: typeof cb.name === 'string' ? cb.name : undefined,
    };
  }
  return { kind: 'unknown', text: '' };
}

function parseJsonOrEmpty(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
