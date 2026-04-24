/**
 * Sprint 057-A F1 — Human-readable verb labels for tool calls in the
 * ToolChainSummary chip row.
 *
 * The tool names from the AI SDK arrive in the form
 * `mcp__tuning-agent__<name>`. Strip the prefix before map lookup.
 * Function-valued entries receive the parsed args so they can interpolate
 * dynamic counts (e.g. "Planned 3 writes").
 */
export const TOOL_VERB_MAP: Record<string, string | ((args: Record<string, unknown>) => string)> = {
  get_current_state:      'Read state',
  get_context:            'Read context',
  get_faq:                'Got FAQ',
  get_sop:                'Got SOP',
  get_edit_history:       'Checked history',
  plan_build_changes:     (args) => {
    const n = Array.isArray(args?.items) ? args.items.length : 0
    return n > 0 ? `Planned ${n} writes` : 'Planned writes'
  },
  create_sop:             'Wrote SOP',
  create_faq:             'Wrote FAQ',
  write_system_prompt:    'Rewrote prompt',
  create_tool_definition: 'Defined tool',
  test_pipeline:          'Ran test',
  search_corrections:     'Searched fixes',
  propose_suggestion:     'Proposed fix',
  suggestion_action:      'Applied fix',
  emit_audit:             'Audited',
  ask_manager:            'Asked you',
  fetch_evidence_bundle:  'Pulled evidence',
  memory:                 'Stored memory',
  get_version_history:    'Checked versions',
  rollback:               'Rolled back',
  search_replace:         'Replaced text',
  emit_session_summary:   'Session recap',
  diff_versions:          'Compared versions',
  emit_interview_progress:'Interview progress',
}

const SERVER_PREFIX = 'mcp__tuning-agent__'

/**
 * Returns a human-readable verb for a tool name. Strips the
 * `mcp__tuning-agent__` prefix before looking up in TOOL_VERB_MAP.
 * Falls back to underscore→space conversion for unmapped names.
 */
export function toolVerb(toolName: string, args?: Record<string, unknown>): string {
  const shortName = toolName.startsWith(SERVER_PREFIX)
    ? toolName.slice(SERVER_PREFIX.length)
    : toolName
  const entry = TOOL_VERB_MAP[shortName]
  if (!entry) return shortName.replace(/_/g, ' ')
  if (typeof entry === 'function') return entry(args ?? {})
  return entry
}
