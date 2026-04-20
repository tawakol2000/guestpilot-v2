/**
 * Tool-trace hook (sprint 046 Session A).
 *
 * Writes one BuildToolCallLog row per tool invocation. Pre hook records
 * the start time keyed by the SDK's `tool_use_id`; Post hook computes
 * durationMs, success, errorMessage, and fires `logToolCall` in
 * fire-and-forget mode. Never blocks the turn.
 *
 * Distinct from pre-tool-use.ts / post-tool-use.ts (which handle
 * compliance + cooldown + Langfuse) so tracing concerns live in one
 * file and aren't tangled with enforcement logic.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { logToolCall } from '../../services/build-tool-call-log.service';
import type { HookContext } from './shared';

export function buildPreToolTraceHook(ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const pre = input as PreToolUseHookInput;
    const c = ctx();
    const id = pre.tool_use_id ?? `${pre.tool_name}:${Date.now()}`;
    c.toolCallStartTimes.set(id, Date.now());
    return { continue: true } as HookJSONOutput;
  };
}

export function buildPostToolTraceHook(ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const post = input as PostToolUseHookInput;
    const c = ctx();
    if (!c.conversationId) {
      // No conversation scope → nowhere to attach the log row. The BUILD/
      // TUNE endpoints always set conversationId; this only happens in
      // synthetic test harnesses, so skip silently.
      return { continue: true } as HookJSONOutput;
    }
    const id = post.tool_use_id ?? '';
    const start = c.toolCallStartTimes.get(id);
    if (id) c.toolCallStartTimes.delete(id);
    const durationMs = start ? Date.now() - start : 0;

    const response = post.tool_response as { isError?: boolean } | undefined;
    const isError = Boolean(response?.isError);
    const errorMessage = isError
      ? extractErrorText(post.tool_response)?.slice(0, 1000) ?? null
      : null;

    // Fire-and-forget. Never awaited here — a slow insert cannot stall
    // the turn or propagate a rejection into the SDK loop.
    void logToolCall(c.prisma, {
      tenantId: c.tenantId,
      conversationId: c.conversationId,
      turn: c.turn,
      tool: post.tool_name,
      params: post.tool_input,
      durationMs,
      success: !isError,
      errorMessage,
    });

    return { continue: true } as HookJSONOutput;
  };
}

function extractErrorText(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as { content?: Array<{ type?: string; text?: string }> };
  const text = r.content?.find((c) => c?.type === 'text')?.text;
  return typeof text === 'string' ? text : null;
}
