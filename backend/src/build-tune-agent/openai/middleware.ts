/**
 * Inline middleware for the OpenAI Responses API path.
 *
 * The Claude Agent SDK has a hook system (`PreToolUse`, `PostToolUse`,
 * `PreCompact`, `Stop`) that enforces state-machine gating, read-budget
 * advisories, tool-call tracing, and post-tool validation. The OpenAI
 * Responses API has no equivalent — we re-implement the same checks as
 * synchronous calls in the runner's tool-dispatch loop.
 *
 * Each function is independent and side-effect minimal; they share the
 * `MiddlewareState` carried per-turn by the runner.
 */
import type { PrismaClient } from '@prisma/client';
import {
  ALLOWED_TOOLS_BY_STATE,
  coerceSnapshot,
  findStateAllowingTool,
  shortToolName,
  type InnerState,
} from '../state-machine';
import { READ_BUDGET_BY_STATE } from '../hooks/read-budget-warn';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';
import { detectApplySanction, detectRollbackSanction } from '../hooks/shared';
import { logToolCall } from '../../services/build-tool-call-log.service';
import { DATA_PART_TYPES } from '../data-parts';

const READ_TOOLS = new Set<string>([
  TUNING_AGENT_TOOL_NAMES.studio_get_context,
  TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
  TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
  TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index,
  TUNING_AGENT_TOOL_NAMES.studio_get_evidence_section,
  TUNING_AGENT_TOOL_NAMES.studio_search_corrections,
  TUNING_AGENT_TOOL_NAMES.studio_get_correction,
  TUNING_AGENT_TOOL_NAMES.studio_get_canonical_template,
  TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
  TUNING_AGENT_TOOL_NAMES.studio_memory,
]);

export interface MiddlewareState {
  prisma: PrismaClient;
  tenantId: string;
  conversationId: string;
  turn: number;
  innerState: InnerState;
  /** Last user message — drives compliance sanction detection. */
  lastUserMessage: string;
  /** Per-turn read-tool counter. */
  readsThisTurn: number;
  emitDataPart: (part: {
    type: string;
    id?: string;
    data: unknown;
    transient?: boolean;
  }) => void;
}

export interface GateResult {
  ok: boolean;
  /** When ok=false, this is the synthetic tool-output string the runner sends back. */
  denyReason?: string;
}

/**
 * State-machine gate. Returns ok=false with a descriptive reason if the
 * tool isn't allowed in the current inner_state. Matches `pre-tool-use.ts`
 * behaviour for the Anthropic path.
 */
export function gateToolByState(
  toolNamePrefixed: string,
  state: MiddlewareState,
): GateResult {
  const allowed = ALLOWED_TOOLS_BY_STATE[state.innerState];
  if (allowed.includes(toolNamePrefixed)) return { ok: true };
  const target = findStateAllowingTool(toolNamePrefixed);
  const allowedNames = allowed.map(shortToolName).join(', ');
  const targetHint = target
    ? `To use ${shortToolName(toolNamePrefixed)}, call studio_propose_transition({to: '${target}', because: ...}) first.`
    : `Tool ${shortToolName(toolNamePrefixed)} is not registered in any state's allowlist.`;
  return {
    ok: false,
    denyReason:
      `Tool ${shortToolName(toolNamePrefixed)} is blocked in ${state.innerState} state. ` +
      `Available tools in ${state.innerState}: ${allowedNames}. ${targetHint}`,
  };
}

/**
 * Compliance gate for studio_suggestion(apply / edit_then_apply) and
 * studio_rollback. Returns ok=false if the manager's last turn didn't carry
 * an explicit sanction phrase.
 */
export function gateToolByCompliance(
  toolNamePrefixed: string,
  args: Record<string, unknown>,
  state: MiddlewareState,
): GateResult {
  if (toolNamePrefixed === TUNING_AGENT_TOOL_NAMES.studio_rollback) {
    if (!detectRollbackSanction(state.lastUserMessage)) {
      return {
        ok: false,
        denyReason:
          `Compliance check failed: the manager's last turn did not explicitly sanction a rollback (e.g. "roll back", "revert it", "undo the change"). Ask for confirmation before invoking rollback.`,
      };
    }
    return { ok: true };
  }
  if (toolNamePrefixed === TUNING_AGENT_TOOL_NAMES.studio_suggestion) {
    const op = (args.op as string | undefined) ?? '';
    const isWrite = op === 'apply' || op === 'edit_then_apply';
    if (!isWrite) return { ok: true };
    if (!detectApplySanction(state.lastUserMessage)) {
      return {
        ok: false,
        denyReason:
          `Compliance check failed: the manager's last turn did not explicitly sanction an apply (e.g. "apply it", "go ahead", "do it now", "yes, apply"). Either ask the manager to confirm, or use op:'queue' instead.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Read-budget tracking. Returns the post-increment count and emits a
 * non-blocking `data-advisory` when the per-state budget is exceeded.
 * Never blocks the call — the budget is advisory only.
 */
export function recordReadBudget(
  toolNamePrefixed: string,
  state: MiddlewareState,
): void {
  if (!READ_TOOLS.has(toolNamePrefixed)) return;
  state.readsThisTurn += 1;
  const budget = READ_BUDGET_BY_STATE[state.innerState];
  if (state.readsThisTurn > budget) {
    try {
      state.emitDataPart({
        type: DATA_PART_TYPES.advisory,
        data: {
          kind: 'read_budget_exceeded',
          innerState: state.innerState,
          budget,
          reads: state.readsThisTurn,
          toolName: toolNamePrefixed,
        },
        transient: true,
      });
    } catch {
      /* swallow */
    }
  }
}

/**
 * Fire-and-forget Langfuse-equivalent trace via BuildToolCallLog.
 * Mirrors the post-tool-trace hook on the Anthropic path.
 */
export function traceToolCall(opts: {
  state: MiddlewareState;
  toolNameRaw: string;
  args: unknown;
  durationMs: number;
  success: boolean;
  errorMessage?: string | null;
}): void {
  const { state } = opts;
  void logToolCall(state.prisma, {
    tenantId: state.tenantId,
    conversationId: state.conversationId,
    turn: state.turn,
    tool: opts.toolNameRaw,
    params: opts.args,
    durationMs: opts.durationMs,
    success: opts.success,
    errorMessage: opts.errorMessage ?? null,
  });
}

/**
 * Helper for the runner: refresh the cached state-machine snapshot from
 * the DB. Called between tool dispatches when a `studio_propose_transition`
 * was confirmed via UI mid-turn (rare; usually the state stays put).
 */
export async function refreshInnerState(state: MiddlewareState): Promise<InnerState> {
  try {
    const conv = await state.prisma.tuningConversation.findUnique({
      where: { id: state.conversationId },
      select: { stateMachineSnapshot: true },
    });
    const snapshot = coerceSnapshot(conv?.stateMachineSnapshot);
    state.innerState = snapshot.inner_state;
  } catch {
    /* fall through with stale state */
  }
  return state.innerState;
}
