/**
 * PostToolUse hook — runs after every tool call. Responsibilities:
 *   1. Langfuse span logging (tool name + brief output summary). The tool
 *      handler also emits a span via startAiSpan, so this hook's log is a
 *      complementary "observed-from-outside" record of tool calls.
 *   2. Category-stats update on `suggestion_action(apply | edit_then_apply
 *      | reject)` — already done inside the tool handler, so we avoid
 *      double-counting here. This hook's job is to log, not mutate.
 *   3. Preference-pair capture is ALSO handled inside `suggestion_action`
 *      (because the handler has the before/rejected/preferred triple in
 *      scope). The hook observes the resulting status and logs the
 *      outcome to Langfuse.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import type { HookContext } from './shared';

export function buildPostToolUseHook(_ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const post = input as PostToolUseHookInput;

    // Synthesize a span so Langfuse captures tool activity even if the
    // handler itself didn't. Truncate heavy payloads.
    const span = startAiSpan(`tuning-agent.hook.${post.tool_name}`, truncateForLog(post.tool_input));
    try {
      span.end(truncateForLog(post.tool_response));
    } catch {
      /* noop */
    }
    return { continue: true } as HookJSONOutput;
  };
}

function truncateForLog(v: unknown): unknown {
  // Sprint 09 fix 12: the old implementation did
  //   JSON.parse(s.slice(0, 4000) + '..."TRUNCATED"')
  // which ALWAYS threw because slicing mid-JSON produces invalid syntax,
  // so every over-4000-char payload fell through to
  //   { note: 'unserializable' }
  // losing all detail. Return a truncated string instead — the log field
  // accepts any JSON value and a partial body is far more useful than a
  // generic marker.
  try {
    const s = JSON.stringify(v);
    if (!s) return v;
    if (s.length <= 4000) return v;
    return s.slice(0, 4000) + '…[truncated]';
  } catch {
    return { note: 'unserializable' };
  }
}
