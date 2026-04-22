/**
 * Sprint 059-A F1.1 — MCP tool router for the direct-transport BUILD path.
 *
 * The Claude Agent SDK wraps our in-process tools behind a `mcp__<server>__*`
 * namespace and dispatches `tool_use` blocks to the right handler transparently.
 * When BUILD_AGENT_DIRECT_TRANSPORT=true the direct path does the call to
 * `@anthropic-ai/sdk` itself, so it must reproduce that dispatch. This module
 * is the routing layer: it takes the SDK-shaped tool definitions produced by
 * `tool(...)` (the factory exported from `@anthropic-ai/claude-agent-sdk`),
 * indexes them by both the wire name (`mcp__tuning-agent__create_faq`) and
 * the bare name (`create_faq`), and on dispatch:
 *
 *   1. Validates `input` against the tool's Zod `inputSchema` (same semantics
 *      the SDK applies before calling the handler).
 *   2. Awaits the handler.
 *   3. Packages the `CallToolResult` (`{ content, isError?, structuredContent? }`)
 *      into an Anthropic `tool_result` content-block shape that F1.4's
 *      stream-bridge adapter can feed back into the conversation.
 *
 * Failure semantics mirror what the SDK surfaces today:
 *
 *   - Unknown tool name → `McpUnknownToolError` (propagated up). The F1.5
 *     runner catches this and falls back to the SDK path for the rest of the
 *     turn (§3 non-negotiables: "fallback is mandatory").
 *   - Handler throws (network, DB, Zod validation failure in the handler's
 *     own code, etc.) → caught + returned as an `is_error: true` tool_result.
 *     We do NOT re-throw: the model must see the error as a tool result so it
 *     can recover or escalate.
 *   - Input fails Zod validation at the router boundary → also returned as
 *     `is_error: true`. This keeps the contract symmetric with the SDK: bad
 *     input never crashes the turn.
 *
 * Hooks (PreToolUse / PostToolUse) are NOT the router's concern — F1.2 owns
 * them. The F1.5 runner composes this router + that dispatcher.
 */
import { z } from 'zod/v4';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TUNING_AGENT_SERVER_NAME } from '../tools/names';

/**
 * Context passed through to the router. The in-process tools today close
 * over their ToolContext via the `getCtx()` closure wired in `tools/index.ts`
 * so `ctx` is not handed to the handler directly — this interface exists as
 * future-proofing (a tool that wants out-of-band info can read from here) and
 * to satisfy the spec's signature.
 */
export interface McpDispatchContext {
  conversationId: string;
  tenantId: string;
  mode: 'BUILD' | 'TUNE';
  /** Any additional ctx the handlers need — mirror what the SDK passes today. */
  [key: string]: unknown;
}

/**
 * Anthropic `tool_result` content block shape. This is what F1.4 will feed
 * back as the next `user` turn after a tool call.
 */
export interface McpToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string } | Record<string, unknown>>;
  is_error?: boolean;
}

export class McpUnknownToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Unknown MCP tool: ${toolName}`);
    this.name = 'McpUnknownToolError';
  }
}

export interface McpRouter {
  /**
   * True for both the wire name (`mcp__tuning-agent__create_faq`) and the
   * bare name (`create_faq`). False for anything else.
   */
  has(toolName: string): boolean;

  /**
   * Dispatch a `tool_use` to the matching handler. Behaviour:
   *   - Unknown tool → throws `McpUnknownToolError`.
   *   - Handler throws OR input fails Zod validation → `is_error: true`
   *     tool_result (does NOT throw up).
   *   - Happy path → a `tool_result` block carrying the handler's
   *     `CallToolResult.content`.
   */
  dispatch(
    toolName: string,
    input: unknown,
    ctx: McpDispatchContext,
    toolUseId: string,
  ): Promise<McpToolResult>;
}

/**
 * Strip the `mcp__<server>__` prefix from a wire name. Returns the input
 * unchanged when it doesn't start with the server prefix (i.e. it's already
 * a bare name). The caller can then look the tool up in either form.
 */
function toBareName(toolName: string): string {
  const prefix = `mcp__${TUNING_AGENT_SERVER_NAME}__`;
  if (toolName.startsWith(prefix)) {
    return toolName.slice(prefix.length);
  }
  return toolName;
}

/**
 * Coerce whatever the handler returned into the `content` array expected on
 * an Anthropic `tool_result` block. The handlers we ship return a
 * `CallToolResult` with a `content: [{type:'text', text}]` array, but we
 * accept a looser shape defensively. A string body also round-trips (some
 * lower-layer tests or future handlers may return one).
 */
function normalizeToolResultContent(
  handlerResult: unknown,
): { content: McpToolResult['content']; isError: boolean } {
  if (handlerResult == null) {
    return { content: '', isError: false };
  }
  if (typeof handlerResult === 'string') {
    return { content: handlerResult, isError: false };
  }
  if (typeof handlerResult === 'object') {
    const r = handlerResult as {
      content?: unknown;
      isError?: unknown;
    };
    const isError = r.isError === true;
    if (Array.isArray(r.content)) {
      // Pass the content array through verbatim — the tool handlers already
      // shape text blocks via `asCallToolResult` / `asError` (see tools/types.ts).
      return {
        content: r.content as McpToolResult['content'],
        isError,
      };
    }
    if (typeof r.content === 'string') {
      return { content: r.content, isError };
    }
    // No `content` field: fall back to JSON-stringifying the whole payload
    // so the model sees *something*. Matches the SDK's defensive behaviour.
    return {
      content: JSON.stringify(handlerResult),
      isError,
    };
  }
  // Numbers, booleans, etc. — stringify.
  return { content: String(handlerResult), isError: false };
}

/**
 * Format a thrown value as a tool_result error. Keeps the Error.message
 * short-and-readable for the model (no stack trace spam).
 */
function errorToToolResult(toolUseId: string, err: unknown): McpToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: `Error: ${message}`,
    is_error: true,
  };
}

/**
 * Build the router from the SDK-shaped tool definitions (exactly what
 * `tool(...)` produces inside `tools/index.ts`).
 *
 * We accept `ReadonlyArray` so callers can reuse a frozen tools array from
 * the `buildTuningAgentMcpServer()` output without a defensive copy.
 */
export function buildMcpRouter(
  tools: ReadonlyArray<SdkMcpToolDefinition<any>>,
): McpRouter {
  // Index by BOTH bare and wire name. Both point at the same tool definition.
  // Collisions between two tools with the same bare name would be a
  // configuration error (the SDK would also fail), so we throw at build time.
  const byName = new Map<string, SdkMcpToolDefinition<any>>();
  for (const tool of tools) {
    const bare = tool.name;
    const wire = `mcp__${TUNING_AGENT_SERVER_NAME}__${bare}`;
    if (byName.has(bare) || byName.has(wire)) {
      throw new Error(
        `buildMcpRouter: duplicate tool name "${bare}" — each tool name must be unique.`,
      );
    }
    byName.set(bare, tool);
    byName.set(wire, tool);
  }

  function has(toolName: string): boolean {
    return byName.has(toolName) || byName.has(toBareName(toolName));
  }

  async function dispatch(
    toolName: string,
    input: unknown,
    _ctx: McpDispatchContext,
    toolUseId: string,
  ): Promise<McpToolResult> {
    const tool = byName.get(toolName) ?? byName.get(toBareName(toolName));
    if (!tool) {
      throw new McpUnknownToolError(toolName);
    }

    // Zod validate the input the same way the SDK would before handing it
    // to the handler. `inputSchema` is a raw Zod shape (`{ k: z.string() }`),
    // not a `z.object(...)`. Wrap on the fly. If validation fails we surface
    // the error as an `is_error: true` tool_result — never propagate up —
    // so the model sees the failure in-band and can self-correct, matching
    // SDK semantics on bad tool input.
    let parsedInput: unknown = input;
    try {
      const objectSchema = z.object(tool.inputSchema ?? {});
      parsedInput = objectSchema.parse(input ?? {});
    } catch (err) {
      return errorToToolResult(toolUseId, err);
    }

    let handlerResult: unknown;
    try {
      // Second arg is `extra: unknown` per the SDK typedef. No existing tool
      // handler reads it; we pass an empty object so the param is not
      // `undefined` if a future handler starts consuming it.
      handlerResult = await tool.handler(parsedInput as any, {});
    } catch (err) {
      return errorToToolResult(toolUseId, err);
    }

    const { content, isError } = normalizeToolResultContent(handlerResult);
    const out: McpToolResult = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
    };
    if (isError) out.is_error = true;
    return out;
  }

  return { has, dispatch };
}
