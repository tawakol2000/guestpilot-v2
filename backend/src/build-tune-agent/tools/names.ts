/**
 * Tool-name constants. Kept in a standalone module (no runtime imports) so
 * hooks/tests can depend on the names without pulling in all tool handlers
 * + their transitive service graph.
 */
export const TUNING_AGENT_SERVER_NAME = 'tuning-agent';

export const TUNING_AGENT_TOOL_NAMES = {
  studio_get_context: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_context`,
  // Sprint 060-D Phase 7d — index-then-fetch split.
  studio_search_corrections: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_search_corrections`,
  studio_get_correction: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_correction`,
  // Sprint 060-D Phase 7c — index-then-fetch split of fetch_evidence_bundle.
  studio_get_evidence_index: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_evidence_index`,
  studio_get_evidence_section: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_evidence_section`,
  // 060-D: propose_suggestion + suggestion_action merged into studio_suggestion.
  studio_suggestion: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_suggestion`,
  studio_memory: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_memory`,
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
  // Sprint 060-D Phase 7 — index-then-fetch split of get_current_state.
  studio_get_tenant_index: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_tenant_index`,
  studio_get_artifact: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_artifact`,
  // Sprint 056-A F2 — "Ask-the-past" edit-history query (BUILD + TUNE).
  studio_get_edit_history: `mcp__${TUNING_AGENT_SERVER_NAME}__studio_get_edit_history`,
} as const;
