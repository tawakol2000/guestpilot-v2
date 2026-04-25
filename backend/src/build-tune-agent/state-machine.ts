/**
 * Sprint 060-C — Studio mode restructure: shared types + helpers for the
 * narrow hybrid state machine.
 *
 * Outer modes (BUILD | TUNE) are the privilege boundary; inner cognitive
 * states (scoping | drafting | verifying) gate which mutation tools the
 * agent can reach in any given turn. The full snapshot lives on
 * TuningConversation.stateMachineSnapshot (JSONB) — see schema.prisma.
 *
 * The DB is the only source of truth. Region C renders <current_state>
 * fresh from the snapshot every turn; the PreToolUse hook reads the
 * snapshot at hook time; transitions are agent-proposed + host-confirmed,
 * never inferred from agent-emitted text.
 */
import { TUNING_AGENT_TOOL_NAMES } from './tools/names';

export type OuterMode = 'BUILD' | 'TUNE';
export type InnerState = 'scoping' | 'drafting' | 'verifying';

export const INNER_STATES: readonly InnerState[] = ['scoping', 'drafting', 'verifying'];
export const OUTER_MODES: readonly OuterMode[] = ['BUILD', 'TUNE'];

export interface PendingTransition {
  to: InnerState;
  because: string;
  proposed_at: string;
  expires_at: string;
  token: string;
}

export interface StateMachineSnapshot {
  outer_mode: OuterMode;
  inner_state: InnerState;
  transition_ack_pending: boolean;
  pending_transition: PendingTransition | null;
  last_transition_at: string | null;
  last_transition_reason: string | null;
}

export const DEFAULT_SNAPSHOT: StateMachineSnapshot = {
  outer_mode: 'BUILD',
  inner_state: 'scoping',
  transition_ack_pending: false,
  pending_transition: null,
  last_transition_at: null,
  last_transition_reason: null,
};

/** 24h expiry on a pending transition proposal — long enough for an
 * operator to step away and come back, short enough that stale
 * proposals don't pollute future turns. */
export const TRANSITION_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort coercion of an unknown JSONB value into a snapshot,
 * filling in defaults for missing fields. Tolerates legacy rows.
 */
export function coerceSnapshot(raw: unknown): StateMachineSnapshot {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SNAPSHOT };
  const r = raw as Partial<StateMachineSnapshot>;
  const outer: OuterMode = r.outer_mode === 'TUNE' ? 'TUNE' : 'BUILD';
  const inner: InnerState =
    r.inner_state === 'drafting' || r.inner_state === 'verifying'
      ? r.inner_state
      : 'scoping';
  return {
    outer_mode: outer,
    inner_state: inner,
    transition_ack_pending: r.transition_ack_pending === true,
    pending_transition: coercePendingTransition(r.pending_transition),
    last_transition_at: typeof r.last_transition_at === 'string' ? r.last_transition_at : null,
    last_transition_reason: typeof r.last_transition_reason === 'string' ? r.last_transition_reason : null,
  };
}

function coercePendingTransition(raw: unknown): PendingTransition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PendingTransition>;
  if (r.to !== 'scoping' && r.to !== 'drafting' && r.to !== 'verifying') return null;
  if (typeof r.token !== 'string' || !r.token) return null;
  if (typeof r.because !== 'string') return null;
  return {
    to: r.to,
    because: r.because,
    proposed_at: typeof r.proposed_at === 'string' ? r.proposed_at : new Date().toISOString(),
    expires_at: typeof r.expires_at === 'string' ? r.expires_at : new Date(Date.now() + TRANSITION_EXPIRY_MS).toISOString(),
    token: r.token,
  };
}

/**
 * Per-state allowed-tool sets — read by the PreToolUse hook and described
 * in the <state_machine> system-prompt block. Keep these in sync.
 *
 * Notes:
 * - studio_test_pipeline is allowed in scoping (dry-run before drafting)
 *   AND verifying (the natural place). Disallowed in drafting (drafting
 *   posture is for mutation, not evaluation).
 * - studio_memory is allowed everywhere — the tool itself differentiates
 *   read (`view`/`list`) from write (`create`/`update`/`delete`) ops.
 * - studio_propose_transition is the only path out of scoping/drafting.
 *   Verifying auto-exits via runtime hook after test_pipeline returns.
 */
const READ_TOOLS: readonly string[] = [
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
];

export const STUDIO_PROPOSE_TRANSITION_TOOL_NAME =
  `mcp__tuning-agent__studio_propose_transition`;

export const ALLOWED_TOOLS_BY_STATE: Record<InnerState, readonly string[]> = {
  scoping: [
    ...READ_TOOLS,
    TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
    STUDIO_PROPOSE_TRANSITION_TOOL_NAME,
  ],
  drafting: [
    ...READ_TOOLS,
    STUDIO_PROPOSE_TRANSITION_TOOL_NAME,
    TUNING_AGENT_TOOL_NAMES.studio_create_sop,
    TUNING_AGENT_TOOL_NAMES.studio_create_faq,
    TUNING_AGENT_TOOL_NAMES.studio_create_tool_definition,
    TUNING_AGENT_TOOL_NAMES.studio_create_system_prompt,
    TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes,
    TUNING_AGENT_TOOL_NAMES.studio_rollback,
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
  ],
  verifying: [
    ...READ_TOOLS,
    TUNING_AGENT_TOOL_NAMES.studio_test_pipeline,
  ],
};

/** Find the first state that permits the given tool — used to suggest
 * a target state in the PreToolUse deny message. Returns null if no
 * state allows it (shouldn't happen for registered tools). */
export function findStateAllowingTool(toolName: string): InnerState | null {
  for (const state of INNER_STATES) {
    if (ALLOWED_TOOLS_BY_STATE[state].includes(toolName)) return state;
  }
  return null;
}

/** Strip MCP server prefix for friendlier user-facing messages. */
export function shortToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+__/, '');
}
