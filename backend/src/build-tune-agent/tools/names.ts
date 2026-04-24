/**
 * Tool-name constants. Kept in a standalone module (no runtime imports) so
 * hooks/tests can depend on the names without pulling in all tool handlers
 * + their transitive service graph.
 */
export const TUNING_AGENT_SERVER_NAME = 'tuning-agent';

export const TUNING_AGENT_TOOL_NAMES = {
  studio_get_context: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_context`,
  search_corrections: `mcp__${TUNING_AGENT_SERVER_NAME}__search_corrections`,
  fetch_evidence_bundle: `mcp__${TUNING_AGENT_SERVER_NAME}__fetch_evidence_bundle`,
  propose_suggestion: `mcp__${TUNING_AGENT_SERVER_NAME}__propose_suggestion`,
  suggestion_action: `mcp__${TUNING_AGENT_SERVER_NAME}__suggestion_action`,
  studio_memory: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_memory`,
  get_version_history: `mcp__${TUNING_AGENT_SERVER_NAME}__get_version_history`,
  studio_rollback: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_rollback`,
  // Sprint 045, Gate 2 — BUILD-mode artifact creators.
  studio_create_faq: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_create_faq`,
  studio_create_sop: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_create_sop`,
  studio_create_tool_definition: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_create_tool_definition`,
  // 060-D: verb alignment — write_system_prompt → studio_create_system_prompt.
  studio_create_system_prompt: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_create_system_prompt`,
  studio_plan_build_changes: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_plan_build_changes`,
  // Sprint 045, Gate 3 — single-message test tool (callable in both modes).
  studio_test_pipeline: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_test_pipeline`,
  // Sprint 046, Session A — full-artifact grounding tool (callable in both modes).
  get_current_state: `mcp__${TUNING_AGENT_SERVER_NAME}__get_current_state`,
  // Sprint 046, Session B — card-shaped I/O wrappers (callable in both modes).
  ask_manager: `mcp__${TUNING_AGENT_SERVER_NAME}__ask_manager`,
  emit_audit: `mcp__${TUNING_AGENT_SERVER_NAME}__emit_audit`,
  // Sprint 056-A F2 — "Ask-the-past" edit-history query (BUILD + TUNE).
  get_edit_history: `mcp__${TUNING_AGENT_SERVER_NAME}__get_edit_history`,
  // Sprint 058-A F4 — end-of-turn session-diff summary card emitter.
  emit_session_summary: `mcp__${TUNING_AGENT_SERVER_NAME}__emit_session_summary`,
  // Sprint 046 — card emitters for the two operator-visible surfaces
  // the agent requested inside its own Studio session.
  diff_versions: `mcp__${TUNING_AGENT_SERVER_NAME}__diff_versions`,
  emit_interview_progress: `mcp__${TUNING_AGENT_SERVER_NAME}__emit_interview_progress`,
} as const;
