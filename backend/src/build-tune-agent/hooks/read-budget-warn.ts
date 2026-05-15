/**
 * Feature 047 PR 4 — read-budget warning hook.
 *
 * NON-blocking PreToolUse hook. Tracks read-tool calls per turn against a
 * per-state cap (scoping=4, drafting=2, verifying=1). When the budget is
 * exceeded, attaches a `read_budget_exceeded: true` Langfuse span tag on
 * the offending tool span. Never returns `{decision: 'block'}`.
 *
 * The cap is prompt-level guidance backed by an observability signal — if
 * the agent exceeds the budget, we observe the deviation in Langfuse and
 * decide whether to harden later. Per spec clarify-session Q1 / FR-005.
 *
 * Counter resets per-turn (keyed by conversationId).
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';
import { coerceSnapshot, type InnerState } from '../state-machine';
import type { HookContext } from './shared';

const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
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

// 2026-05-15 polish (harness-observed): drafting=2 was too aggressive.
// A drafting turn legitimately needs: get_context (orient) + get_artifact
// (read the thing being edited) + sometimes get_evidence_index (re-check
// the originating witness) + memory (preferences). With reasoning=high
// the agent reads more deliberately too, so a budget of 4 keeps the
// advisory off for legitimate sessions and only fires when the agent
// genuinely wanders. The advisory is non-blocking; this just tunes when
// the read-budget warning surfaces.
export const READ_BUDGET_BY_STATE: Record<InnerState, number> = {
  scoping: 5,
  drafting: 4,
  verifying: 2,
};

interface ReadBudgetCounter {
  conversationId: string;
  turn: number;
  reads: number;
  /** Inner-states that have already emitted a read_budget_exceeded advisory
   * this turn. Without this, the advisory fires on every subsequent read
   * past the budget — the operator only needs the nudge once. */
  firedForStates: Set<InnerState>;
}

// Module-level counter map. Keyed by conversationId; reset per-turn by
// the runtime (which calls resetReadBudgetForTurn at query start).
const counters = new Map<string, ReadBudgetCounter>();

export function resetReadBudgetForTurn(conversationId: string, turn: number): void {
  counters.set(conversationId, { conversationId, turn, reads: 0, firedForStates: new Set() });
}

export function getReadBudgetCount(conversationId: string): number {
  return counters.get(conversationId)?.reads ?? 0;
}

export function buildReadBudgetWarnHook(
  getCtx: () => HookContext,
): HookCallback {
  return async (rawInput: HookInput): Promise<HookJSONOutput> => {
    if (rawInput.hook_event_name !== 'PreToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const input = rawInput as PreToolUseHookInput;
    const toolName = input.tool_name;
    if (!READ_TOOL_NAMES.has(toolName)) {
      return {};
    }

    const ctx = getCtx();
    const convId = ctx.conversationId;
    if (!convId) return {};

    let counter = counters.get(convId);
    if (!counter || counter.turn !== ctx.turn) {
      // First read of this turn — initialize/reset.
      counter = { conversationId: convId, turn: ctx.turn, reads: 1, firedForStates: new Set() };
      counters.set(convId, counter);
      return {};
    }
    counter.reads += 1;

    // Look up current state from the persisted snapshot (best-effort).
    let innerState: InnerState = 'scoping';
    try {
      const conv = await ctx.prisma.tuningConversation.findUnique({
        where: { id: convId },
        select: { stateMachineSnapshot: true },
      });
      const snapshot = coerceSnapshot(conv?.stateMachineSnapshot);
      innerState = snapshot.inner_state;
    } catch {
      // If snapshot fetch fails, default to the most permissive state's
      // budget (scoping=4) — never block on observability path.
      innerState = 'scoping';
    }
    const budget = READ_BUDGET_BY_STATE[innerState];

    if (counter.reads > budget && !counter.firedForStates.has(innerState)) {
      counter.firedForStates.add(innerState);
      // Emit a non-blocking advisory data-part (the runtime forwards it
      // to the active Langfuse span for the operator to inspect post-hoc).
      // No `decision` field → SDK proceeds with the call as normal.
      try {
        ctx.emitDataPart?.({
          type: 'data-advisory',
          data: {
            kind: 'read_budget_exceeded',
            innerState,
            budget,
            reads: counter.reads,
            toolName,
          },
          transient: true,
        });
      } catch {
        /* swallow — never block on observability failure */
      }
    }

    return {};
  };
}
