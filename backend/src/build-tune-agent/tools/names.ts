/**
 * Tool-name constants. Kept in a standalone module (no runtime imports) so
 * hooks/tests can depend on the names without pulling in all tool handlers
 * + their transitive service graph.
 */
export const TUNING_AGENT_SERVER_NAME = 'tuning-agent';

export const TUNING_AGENT_TOOL_NAMES = {
  get_context: `mcp__${TUNING_AGENT_SERVER_NAME}__get_context`,
  search_corrections: `mcp__${TUNING_AGENT_SERVER_NAME}__search_corrections`,
  fetch_evidence_bundle: `mcp__${TUNING_AGENT_SERVER_NAME}__fetch_evidence_bundle`,
  propose_suggestion: `mcp__${TUNING_AGENT_SERVER_NAME}__propose_suggestion`,
  suggestion_action: `mcp__${TUNING_AGENT_SERVER_NAME}__suggestion_action`,
  memory: `mcp__${TUNING_AGENT_SERVER_NAME}__memory`,
  get_version_history: `mcp__${TUNING_AGENT_SERVER_NAME}__get_version_history`,
  rollback: `mcp__${TUNING_AGENT_SERVER_NAME}__rollback`,
  // Sprint 045, Gate 2 — BUILD-mode artifact creators.
  create_faq: `mcp__${TUNING_AGENT_SERVER_NAME}__create_faq`,
} as const;
