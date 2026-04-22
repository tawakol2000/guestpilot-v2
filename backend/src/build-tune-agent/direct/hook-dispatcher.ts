/**
 * Sprint 059-A F1.2 — Hook dispatcher for the direct-transport BUILD path.
 *
 * The Claude Agent SDK wires hooks via the `hooks` option on `query()` and
 * fires them at well-defined lifecycle points:
 *
 *   - PreToolUse   — before a tool call dispatches. May cancel (deny).
 *   - PostToolUse  — after a tool call returns. May add additionalContext
 *                     to the next turn. Must be awaited before the next
 *                     model round — the hook writes `ToolTrace` rows that
 *                     the next turn's read layer depends on (see
 *                     hooks/tool-trace.ts + hooks/post-tool-use.ts).
 *   - Stop         — once per turn, right before the turn closes out.
 *
 * This dispatcher replays those same moments on the direct path. It does
 * NOT re-implement the hook bodies — it wraps the exact callbacks
 * `buildTuningAgentHooks()` produced. The direct-path runner (F1.5) owns:
 *
 *   1. Deciding WHEN to call preToolUse / postToolUse / stop.
 *   2. Synthesising a tool_result with the cancel reason when preToolUse
 *      returns `{ cancel: true }` (spec §3 F1.2: "the router MUST abort
 *      dispatch and return a synthetic tool_result with the reason text,
 *      marked is_error: true").
 *   3. Catching any thrown hook error, logging WARN, and triggering a
 *      direct-path fallback to the SDK path for that turn (§3 F1.2: "We
 *      do NOT swallow hook errors silently").
 *
 * The dispatcher itself propagates throws. It does NOT swallow them and it
 * does NOT retry. The runner decides the fallback policy.
 *
 * Stop is idempotent: the underlying `buildStopHook` keeps an internal
 * counter that it increments per call, but the lifecycle contract is "once
 * per turn". We guard at the dispatcher layer so a double-`stop()` from
 * the runner doesn't double-fire the hook.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { HookContext } from '../hooks/shared';
import type { McpToolResult } from './mcp-router';

/** What preToolUse may tell the runner: cancel and supply a reason. */
export interface HookOutcome {
  cancel?: boolean;
  reason?: string;
}

export interface HookDispatcher {
  /**
   * Fire PreToolUse hooks in the order they were registered. If ANY hook
   * returns `{ continue: false, ... }` with a `deny` permission decision,
   * the outcome carries `cancel: true` and the reason. The caller is
   * responsible for synthesising a tool_result with `is_error: true` and
   * the reason text.
   */
  preToolUse(
    toolName: string,
    input: unknown,
    toolUseId: string,
  ): Promise<HookOutcome>;

  /**
   * Fire PostToolUse hooks in order. Awaited — the caller must not advance
   * to the next model call until this resolves. The hooks write ToolTrace
   * rows that subsequent turns read.
   */
  postToolUse(
    toolName: string,
    input: unknown,
    result: McpToolResult,
    toolUseId: string,
  ): Promise<void>;

  /**
   * Fire the Stop hook once per turn. Idempotent: calling a second time
   * in the same turn is a no-op.
   */
  stop(): Promise<void>;
}

/**
 * Extract a flat `HookCallback[]` for a given lifecycle event out of the
 * nested `{ matcher?, hooks: HookCallback[] }[]` matcher shape returned by
 * `buildTuningAgentHooks()`. The direct path does not use matchers (our
 * tuning-agent hooks don't set one), so we flatten regardless.
 */
function flattenCallbacks(
  matchers: readonly { hooks: HookCallback[] }[] | undefined,
): HookCallback[] {
  if (!matchers) return [];
  const out: HookCallback[] = [];
  for (const m of matchers) {
    for (const cb of m.hooks) out.push(cb);
  }
  return out;
}

/**
 * Extract a useful reason string from a SyncHookJSONOutput. Priority:
 *   1. hookSpecificOutput.permissionDecisionReason (PreToolUse deny path)
 *   2. top-level `reason`
 *   3. stopReason (some hooks surface intent on this field)
 *   4. fallback "hook denied"
 */
function reasonFromOutput(output: HookJSONOutput | undefined): string {
  if (!output || typeof output !== 'object') return 'hook denied';
  const o = output as {
    reason?: string;
    stopReason?: string;
    hookSpecificOutput?: { permissionDecisionReason?: string };
  };
  return (
    o.hookSpecificOutput?.permissionDecisionReason ??
    o.reason ??
    o.stopReason ??
    'hook denied'
  );
}

/**
 * True when a hook's output signals a hard stop (deny / block / cancel).
 * We treat `continue: false` as the SDK does — short-circuit the chain
 * and surface the reason.
 */
function isCancel(output: HookJSONOutput | undefined): boolean {
  if (!output || typeof output !== 'object') return false;
  const o = output as {
    continue?: boolean;
    decision?: 'approve' | 'block';
    hookSpecificOutput?: { permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer' };
  };
  if (o.continue === false) return true;
  if (o.decision === 'block') return true;
  const pd = o.hookSpecificOutput?.permissionDecision;
  if (pd === 'deny') return true;
  return false;
}

/**
 * No-op AbortController for hooks that check `options.signal.aborted`. A
 * real AbortController would let the runner cancel in-flight hooks on
 * turn teardown; for the dispatcher we keep it simple — the runner can
 * pass its own later if the need arises.
 */
function freshAbortOptions() {
  return { signal: new AbortController().signal };
}

export function buildHookDispatcher(
  hooks: Options['hooks'],
  _ctx: HookContext,
): HookDispatcher {
  // Pull the callback arrays once — the SDK's `buildTuningAgentHooks()`
  // returns a stable reference so we can cache the flattened lists.
  const preCbs = flattenCallbacks((hooks as any)?.PreToolUse);
  const postCbs = flattenCallbacks((hooks as any)?.PostToolUse);
  const stopCbs = flattenCallbacks((hooks as any)?.Stop);

  let stopFired = false;

  async function preToolUse(
    toolName: string,
    input: unknown,
    toolUseId: string,
  ): Promise<HookOutcome> {
    // Minimal PreToolUseHookInput — the BaseHookInput fields
    // (session_id / transcript_path / cwd) are not read by our hooks, so we
    // stub them to satisfy the typedef. If a future hook starts reading
    // them the runner will need to supply real values.
    const hookInput: HookInput = {
      hook_event_name: 'PreToolUse',
      session_id: '',
      transcript_path: '',
      cwd: '',
      tool_name: toolName,
      tool_input: input,
      tool_use_id: toolUseId,
    } as any;

    for (const cb of preCbs) {
      // Hook errors propagate up — the runner logs WARN + falls back to
      // the SDK path. Do NOT swallow (spec §3 F1.2).
      const out = await cb(hookInput, toolUseId, freshAbortOptions());
      if (isCancel(out)) {
        return { cancel: true, reason: reasonFromOutput(out) };
      }
    }
    return { cancel: false };
  }

  async function postToolUse(
    toolName: string,
    input: unknown,
    result: McpToolResult,
    toolUseId: string,
  ): Promise<void> {
    const hookInput: HookInput = {
      hook_event_name: 'PostToolUse',
      session_id: '',
      transcript_path: '',
      cwd: '',
      tool_name: toolName,
      tool_input: input,
      tool_response: result,
      tool_use_id: toolUseId,
    } as any;

    // AWAITED in serial order — the hook chain writes ToolTrace rows the
    // next turn depends on. Errors propagate up.
    for (const cb of postCbs) {
      await cb(hookInput, toolUseId, freshAbortOptions());
    }
  }

  async function stop(): Promise<void> {
    // Idempotent — fire at most once per dispatcher instance (one turn).
    if (stopFired) return;
    stopFired = true;

    const hookInput: HookInput = {
      hook_event_name: 'Stop',
      session_id: '',
      transcript_path: '',
      cwd: '',
      stop_hook_active: false,
    } as any;

    for (const cb of stopCbs) {
      await cb(hookInput, undefined, freshAbortOptions());
    }
  }

  return { preToolUse, postToolUse, stop };
}
