/**
 * Sprint 058-A F1 — Direct-transport scaffold.
 *
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) accepts
 * `systemPrompt` as `string | { type: 'preset'; ... }` only — structured
 * content-block arrays with `cache_control` markers are not exposed through
 * that surface (sdk.d.ts:1475). As a consequence the `[TuningAgent] usage`
 * line has been logging `cached_fraction ≈ 0` for four sprints.
 *
 * This module is the first step toward a `@anthropic-ai/sdk`-direct path for
 * the one `messages.create` call where we need the block-array `system`
 * parameter and the `cache_control` marker on the last tool definition.
 *
 * Current scope (058-A F1):
 *   1. Pure builders for the `messages.create` params — system-block array
 *      with cache_control on Region A + Region B, and cache_control on the
 *      last tool entry. Fully unit-tested.
 *   2. Env flag `BUILD_AGENT_DIRECT_TRANSPORT` (default OFF) gating a future
 *      runtime swap. The runtime.ts path still uses the Agent SDK today.
 *
 * Explicitly deferred (acknowledged as a multi-sprint follow-up):
 *   - Reproducing the Agent-SDK's in-process MCP dispatch loop. Today the
 *     BUILD agent registers ~18 tools via `createSdkMcpServer` and the SDK
 *     routes `mcp__tuning-agent__*` tool_use blocks to those handlers
 *     transparently, including PreToolUse/PostToolUse/PreCompact/Stop
 *     hook dispatch. A direct `messages.create` loop must re-implement that
 *     routing + hooks end-to-end. Until that lands the direct path cannot
 *     drive a full BUILD turn — it only produces the correctly-shaped API
 *     request so the block/tool structure can be unit-tested against
 *     Anthropic's current cache-control contract.
 *   - Session persistence. The Agent SDK stores sessions on the local FS
 *     (unreliable on Railway per runtime.ts:405 comment). The direct path
 *     will replay TuningMessage rows as conversation history instead.
 *   - Stream-bridge parity. stream-bridge.ts is shaped around SDKMessage;
 *     a direct path must map raw Anthropic stream events
 *     (content_block_start / content_block_delta / content_block_stop /
 *     message_delta / message_stop) to the same SDKMessage aggregate shape
 *     before calling bridgeSDKMessage. The shape mapping exists in the
 *     SDK's internals and is recreatable, but not in this sprint.
 *
 * When the deferred work lands, call `buildDirectMessagesCreateParams`
 * from inside the direct runner, pipe the stream through a new
 * `bridgeAnthropicStreamEvent` helper, and fall back to the SDK path if
 * any MCP tool is invoked that the direct router doesn't know about.
 */
import type {
  AnthropicSystemTextBlock,
} from './prompt-cache-blocks';
import {
  buildAnthropicSystemBlocks,
  withLastToolCacheControl,
  isDirectTransportEnabled,
} from './prompt-cache-blocks';

/** Shape of one tool entry accepted by `@anthropic-ai/sdk` messages.create. */
export interface DirectToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  /**
   * Added by `withLastToolCacheControl` when this is the final tool in
   * the array — caches the full tools prefix on subsequent turns.
   */
  cache_control?: { type: 'ephemeral' };
}

export interface DirectMessagesCreateParams {
  model: string;
  max_tokens: number;
  system: AnthropicSystemTextBlock[];
  tools: DirectToolDefinition[];
  messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>;
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** Streaming is always on for the BUILD runtime. */
  stream: true;
}

export interface BuildDirectParamsInput {
  model: string;
  maxTokens: number;
  /** The assembled system prompt — MUST contain the two boundary markers. */
  assembledSystemPrompt: string;
  /** Tools in Anthropic `messages.create` shape (name / description / input_schema). */
  tools: DirectToolDefinition[];
  /** Conversation history — `user` + `assistant` turns. */
  messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>;
  /** Optional extended-thinking config. */
  thinking?: { type: 'enabled'; budget_tokens: number };
}

/**
 * Pure builder: produce the exact params object we would pass to
 * `anthropic.messages.create()` when `BUILD_AGENT_DIRECT_TRANSPORT=true`.
 *
 * Asserted by unit tests:
 *   - `system` is an array of 3 text blocks.
 *   - Blocks 0 and 1 carry `cache_control: { type: 'ephemeral' }`.
 *   - Block 2 carries NO cache_control.
 *   - The last entry in `tools` carries `cache_control: { type: 'ephemeral' }`.
 *   - `stream` is `true`.
 *   - The caller's `tools` array is not mutated.
 *
 * Returning a value rather than performing the call keeps this module
 * trivially testable and keeps the real network call in a thin, separately
 * test-able wrapper when the MCP loop is ready to port.
 */
export function buildDirectMessagesCreateParams(
  input: BuildDirectParamsInput,
): DirectMessagesCreateParams {
  const system = buildAnthropicSystemBlocks(input.assembledSystemPrompt);
  const tools = withLastToolCacheControl(input.tools);
  const params: DirectMessagesCreateParams = {
    model: input.model,
    max_tokens: input.maxTokens,
    system,
    tools,
    messages: input.messages,
    stream: true,
  };
  if (input.thinking) {
    params.thinking = input.thinking;
  }
  return params;
}

export { isDirectTransportEnabled };
