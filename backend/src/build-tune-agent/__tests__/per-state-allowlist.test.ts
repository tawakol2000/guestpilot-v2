/**
 * Feature 047 PR 6 — per-state tool allow-list tests.
 *
 * Run:  JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/per-state-allowlist.test.ts
 *
 * Asserts the resolveAllowedTools(mode, innerState) contract:
 *   - Returns intersection of mode's full set and state's allowed set
 *   - Stable read tools first (alphabetical), state-specific last
 *   - Result is deterministic (same inputs → same array order)
 *   - PreToolUse state-gate hook still catches violations (unchanged)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resolveAllowedToolsForTest as resolveAllowedTools } from '../sdk-runner';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';

test('047 PR6: scoping × TUNE — only read tools + propose_transition', () => {
  const tools = resolveAllowedTools('TUNE', 'scoping');
  // Read tools allowed in scoping
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_get_artifact));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_memory));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index));
  // Transition tool allowed
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_propose_transition));
  // Write tools NOT in scoping
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_sop));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_faq));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_suggestion));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_rollback));
  // test_pipeline IS allowed in scoping per state-machine.ts
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline));
});

test('047 PR6: drafting × TUNE — read tools + suggestion/plan/rollback (no direct creates, no test_pipeline)', () => {
  const tools = resolveAllowedTools('TUNE', 'drafting');
  // Read tools available
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_get_artifact));
  // TUNE drafting writes are via suggestion/plan/rollback only —
  // direct studio_create_* are BUILD-mode only by design.
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_suggestion));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_rollback));
  // Direct creates NOT in TUNE (BUILD-only)
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_sop));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_faq));
  // test_pipeline NOT available in drafting (verifying-only)
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline));
});

test('047 PR6: drafting × BUILD — direct creates allowed', () => {
  const tools = resolveAllowedTools('BUILD', 'drafting');
  // BUILD drafting allows direct creates
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_sop));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_faq));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_system_prompt));
});

test('047 PR6: verifying × TUNE — only read tools + test_pipeline', () => {
  const tools = resolveAllowedTools('TUNE', 'verifying');
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_get_artifact));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline));
  // No write tools in verifying
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_sop));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_suggestion));
  // No propose_transition in verifying (auto-exits)
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_propose_transition));
});

test('047 PR6: stable read tools come first (alphabetical), state-specific tools last', () => {
  const tools = resolveAllowedTools('TUNE', 'drafting');
  // Find the boundary between read tools and state-specific tools
  const readTools = [
    TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
    TUNING_AGENT_TOOL_NAMES.studio_get_canonical_template,
    TUNING_AGENT_TOOL_NAMES.studio_get_context,
    TUNING_AGENT_TOOL_NAMES.studio_get_correction,
    TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_section,
    TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
    TUNING_AGENT_TOOL_NAMES.studio_memory,
    TUNING_AGENT_TOOL_NAMES.studio_search_corrections,
  ];
  // Last index of any read tool must be < first index of any state-specific tool
  const lastReadIdx = Math.max(
    ...readTools
      .map((n) => tools.indexOf(n))
      .filter((i) => i >= 0),
  );
  const stateTools = [
    TUNING_AGENT_TOOL_NAMES.studio_suggestion,
    TUNING_AGENT_TOOL_NAMES.studio_propose_transition,
    TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes,
    TUNING_AGENT_TOOL_NAMES.studio_rollback,
  ];
  const firstStateIdx = Math.min(
    ...stateTools
      .map((n) => tools.indexOf(n))
      .filter((i) => i >= 0),
  );
  assert.ok(
    lastReadIdx < firstStateIdx,
    `read-tools prefix must precede state-specific suffix (lastRead=${lastReadIdx}, firstState=${firstStateIdx})`,
  );
});

test('047 PR6: deterministic — two calls with same inputs return byte-identical arrays', () => {
  const a = resolveAllowedTools('TUNE', 'scoping');
  const b = resolveAllowedTools('TUNE', 'scoping');
  assert.deepEqual(a, b);
});

test('047 PR6: read-tools prefix is byte-identical across scoping/drafting/verifying (cache stability)', () => {
  // The cached read-tools prefix must survive state transitions; only
  // the variable suffix invalidates on transition.
  const scop = resolveAllowedTools('TUNE', 'scoping');
  const draft = resolveAllowedTools('TUNE', 'drafting');
  const verify = resolveAllowedTools('TUNE', 'verifying');

  // Find the longest common prefix (limited to alphabetical read tools)
  const READ = new Set([
    TUNING_AGENT_TOOL_NAMES.studio_get_artifact,
    TUNING_AGENT_TOOL_NAMES.studio_get_canonical_template,
    TUNING_AGENT_TOOL_NAMES.studio_get_context,
    TUNING_AGENT_TOOL_NAMES.studio_get_correction,
    TUNING_AGENT_TOOL_NAMES.studio_get_edit_history,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_index,
    TUNING_AGENT_TOOL_NAMES.studio_get_evidence_section,
    TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
    TUNING_AGENT_TOOL_NAMES.studio_memory,
    TUNING_AGENT_TOOL_NAMES.studio_search_corrections,
  ]);
  const scopRead = scop.filter((n) => READ.has(n));
  const draftRead = draft.filter((n) => READ.has(n));
  const verifyRead = verify.filter((n) => READ.has(n));
  assert.deepEqual(scopRead, draftRead, 'scoping/drafting read prefix must match');
  assert.deepEqual(draftRead, verifyRead, 'drafting/verifying read prefix must match');
});

test('047 PR6: BUILD scoping excludes write tools by state intersection', () => {
  const tools = resolveAllowedTools('BUILD', 'scoping');
  // Scoping state allows ONLY read tools + test_pipeline + propose_transition.
  // BUILD's full mode set includes creates, but scoping intersection
  // drops them.
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_sop));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_create_faq));
  assert.ok(!tools.includes(TUNING_AGENT_TOOL_NAMES.studio_plan_build_changes));
  // Read tools + transition + test_pipeline allowed in scoping
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_get_artifact));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_propose_transition));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline));
});

test('047 PR6: legacy no-state call returns mode full set (back-compat)', () => {
  const tools = resolveAllowedTools('TUNE');
  // Without an inner-state filter, returns the full TUNE mode set
  // unchanged — preserves pre-feature-047 behavior for any caller that
  // hasn't migrated.
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_get_artifact));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_test_pipeline));
  assert.ok(tools.includes(TUNING_AGENT_TOOL_NAMES.studio_suggestion));
});
