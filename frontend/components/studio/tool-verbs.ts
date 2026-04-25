/**
 * Sprint 057-A F1 — Human-readable verb labels for tool calls in the
 * ToolChainSummary chip row. Updated for sprint 060-D tool surface.
 *
 * The tool names from the AI SDK arrive in the form
 * `mcp__tuning-agent__<name>`. Strip the prefix before map lookup.
 * Function-valued entries receive the parsed args so they can interpolate
 * dynamic counts (e.g. "Planned 3 writes").
 */
export const TOOL_VERB_MAP: Record<string, string | ((args: Record<string, unknown>) => string)> = {
  // Index-then-fetch (sprint 060-D phase 7)
  studio_get_tenant_index:       'Read tenant index',
  studio_get_artifact:           'Read artifact',
  studio_get_evidence_index:     'Pulled evidence index',
  studio_get_evidence_section:   'Read evidence section',
  studio_search_corrections:     'Searched fixes',
  studio_get_correction:         'Read correction',
  // Renamed surface
  studio_get_context:            'Read context',
  studio_get_edit_history:       'Checked history',
  studio_plan_build_changes:     (args) => {
    const n = Array.isArray(args?.items) ? args.items.length : 0
    return n > 0 ? `Planned ${n} writes` : 'Planned writes'
  },
  studio_create_sop:             'Wrote SOP',
  studio_create_faq:             'Wrote FAQ',
  studio_create_system_prompt:   'Rewrote prompt',
  studio_create_tool_definition: 'Defined tool',
  studio_test_pipeline:          'Ran test',
  studio_suggestion:             (args) => {
    const op = typeof args?.op === 'string' ? args.op : ''
    if (op === 'propose') return 'Proposed fix'
    if (op === 'apply') return 'Applied fix'
    if (op === 'reject') return 'Rejected fix'
    if (op === 'edit_then_apply') return 'Edited & applied'
    return 'Suggestion action'
  },
  studio_memory:                 'Stored memory',
  studio_rollback:               'Rolled back',
  studio_get_canonical_template: 'Loaded template',
  // Static / non-tuning-agent tools (used inside the dry-run pipeline)
  get_faq:                       'Got FAQ',
  get_sop:                       'Got SOP',
  search_replace:                'Replaced text',
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
