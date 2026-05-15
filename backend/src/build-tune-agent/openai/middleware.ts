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
import { detectElisionMarker } from '../validators/elision-patterns';

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
 *
 * 2026-05-15 (M1): scope by tenantId. `conversationId` flows from the
 * chat request body and is user-controllable; defence-in-depth filter so
 * a guessed cross-tenant id can't leak snapshot state.
 */
export async function refreshInnerState(state: MiddlewareState): Promise<InnerState> {
  try {
    const conv = await state.prisma.tuningConversation.findFirst({
      where: { id: state.conversationId, tenantId: state.tenantId },
      select: { stateMachineSnapshot: true },
    });
    const snapshot = coerceSnapshot(conv?.stateMachineSnapshot);
    state.innerState = snapshot.inner_state;
  } catch {
    /* fall through with stale state */
  }
  return state.innerState;
}

/**
 * PostToolUse validator for studio_suggestion(op='propose'). Mirrors the
 * Anthropic path's validator in hooks/post-tool-use.ts. Returns a
 * validation-error string when the proposed suggestion is structurally
 * wrong; the runner forwards this to the next round as a synthetic
 * function_call_output so the model self-corrects.
 */
export function validateSuggestionOutput(
  toolNamePrefixed: string,
  args: Record<string, unknown>,
): string | null {
  if (toolNamePrefixed !== TUNING_AGENT_TOOL_NAMES.studio_suggestion) return null;
  const op = (args.op as string | undefined) ?? '';
  if (op !== 'propose') return null;

  const a = args as {
    category?: string;
    editFormat?: string;
    proposedText?: string | null;
    oldText?: string | null;
    newText?: string | null;
    beforeText?: string | null;
  };
  const category = a.category;
  const editFormat = a.editFormat ?? 'full_replacement';

  if (category === 'NO_FIX' || category === 'MISSING_CAPABILITY') {
    if (a.proposedText || a.oldText || a.newText) {
      return `${category} must have proposedText/oldText/newText all null`;
    }
    return null;
  }

  if (editFormat === 'search_replace') {
    if (!a.oldText || !a.newText) {
      return 'editFormat=search_replace requires both oldText and newText (non-empty)';
    }
    if (a.oldText === a.newText) {
      return 'editFormat=search_replace requires oldText !== newText';
    }
  } else {
    if (!a.proposedText || a.proposedText.length === 0) {
      return 'editFormat=full_replacement requires a non-empty proposedText';
    }
  }

  const textToCheck = editFormat === 'search_replace' ? (a.newText ?? '') : (a.proposedText ?? '');
  const elision = detectElisionMarker(textToCheck);
  if (elision) {
    return `proposed text contains an elision marker (${elision}). Include the complete text, not a placeholder`;
  }

  if (editFormat === 'full_replacement' && a.beforeText && /<[A-Za-z_][A-Za-z0-9_-]*\b/.test(a.beforeText)) {
    const beforeCounts = countXmlTags(a.beforeText);
    const afterCounts = countXmlTags(textToCheck);
    for (const [tag, before] of beforeCounts) {
      const after = afterCounts.get(tag) ?? 0;
      if (before === 0 && after !== 0) {
        return `XML tag <${tag}> is unbalanced in proposed text (net ${after} unmatched opens)`;
      }
    }
  }

  return null;
}

function countXmlTags(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /<\/?([A-Za-z_][A-Za-z0-9_-]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  // The .exec(...) below is RegExp.prototype.exec — not child_process.
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const isClose = full.startsWith('</');
    const isSelfClose = /\/>\s*$/.test(full);
    if (isSelfClose) continue;
    const delta = isClose ? -1 : 1;
    counts.set(tag, (counts.get(tag) ?? 0) + delta);
  }
  return counts;
}
