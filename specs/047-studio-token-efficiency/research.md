# Phase 0 Research: Studio Token Efficiency

**Feature:** 047-studio-token-efficiency
**Created:** 2026-05-04
**Companion:** [plan.md](./plan.md)

This document resolves the three open questions flagged in `spec.md` § "Open questions for `/speckit.plan`" and the additional questions surfaced during planning. Each entry uses the **Decision / Rationale / Alternatives considered** format.

---

## R1: Section extraction heuristic for SOPs

### Decision

Use markdown heading lines (`^##\s+` and `^###\s+`) as primary section boundaries. When no headings are found, return a single-section list with the SOP title (from `SopDefinition.toolDescription` or first non-empty line) as the section name.

For each detected section:

- `name` = heading text (stripped of `##`/`###` prefix and trailing whitespace)
- `body` = content from the heading line through the line before the next heading (or to EOF for the last section)
- `summary` = first non-empty paragraph of the body, capped at 80 characters with `…` appended if truncated
- `tokens` = `Math.ceil(body.length / 3.6)` (matches existing approximation in `scripts/measure-prompt.ts`)
- `hashId` = HMAC-SHA256 over `(tenantId, artifactId, sectionName, body[:200])` truncated to first 16 hex chars

### Rationale

1. **Markdown is the de-facto authoring format** for tenant-authored SOPs. Inspection of `backend/src/build-tune-agent/canonical-templates/` shows existing seed SOPs use `##` for major sections.
2. **Honest fallback** is preferable to invented structure. A single-section list with the SOP title signals "this artifact has no sub-structure"; the agent then falls back to `verbosity:'concise'` for that artifact.
3. **`hashId` includes `body[:200]`** so renaming a section without changing its content keeps the hash stable for the body, but content changes invalidate the hash. Tenant scoping prevents cross-tenant section confusion.

### Alternatives considered

| Option | Why rejected |
|---|---|
| Paragraph splitting with N-token grouping (e.g., group consecutive paragraphs ≤2K tokens into pseudo-sections) | Produces opaque names like `para-1`, `para-2`. Agent can't reason about them; defeats Story 3's goal of letting the agent target a specific topic by name. |
| LLM-based summarization to invent section names when none exist | Adds a Sonnet/Haiku call per artifact load, plus non-determinism in test suites. Cost and complexity not justified for a fallback path. |
| Always single-section (no extraction even when headings exist) | Defeats Story 3 for system prompts, which DO have explicit `sections` already returned by `fetchSystemPromptPayload`. Throws away existing structure. |
| Detect any line ending with `:` followed by a blank line (informal headings) | Too many false positives in narrative SOPs ("Steps:", "Note:", etc.). Markdown-heading-only is more conservative. |

### Implementation note

`backend/src/build-tune-agent/tools/lib/section-extractor.ts` exports:

```ts
export interface Section {
  name: string;
  summary: string;
  body: string;
  tokens: number;
  hashId: string;
}

export function extractSections(
  body: string,
  fallbackTitle: string,
  signCtx: { tenantId: string; artifactId: string; secret: string },
): Section[];
```

Pure function, no I/O. Unit-tested with fixtures covering: (a) artifact with `##` headings only, (b) `##` + `###` mixed, (c) no headings (fallback), (d) heading at EOF with empty body, (e) heading with code block fence inside its body.

---

## R2: Cache breakpoint behavior under per-state tool registration

### Decision

In `sdk-runner.ts`, build the tools array in two passes when assembling per-state tools:

1. **Pass 1 — Stable read tools** (always allowed in every state) in deterministic alphabetical order by `name`.
2. **Pass 2 — State-specific tools** (write tools, test_pipeline, propose_transition variants) in deterministic order, appended after Pass 1.

The existing `withLastToolCacheControl(tools)` helper continues to attach `cache_control: { type: 'ephemeral' }` to the LAST entry of the array. Anthropic's prompt cache invalidates from the first byte that differs onward; with stable-first ordering, scoping↔drafting state changes only invalidate the trailing ~1-2K of the tools block (the variable suffix). The leading ~3K of read-tool descriptions stays warm across state transitions.

### Rationale

1. **Anthropic cache semantics** invalidate forward from the first differing byte. Putting variable content at the end isolates invalidation to that suffix.
2. **State transitions are agent-proposed and host-confirmed** — they happen 1-3 times per session at most, on natural turn boundaries. The cost of a cache-write on the variable suffix only is ~$0.005 per transition, which is acceptable.
3. **Deterministic ordering within each pass** ensures the same state always produces byte-identical tools-block bytes, which is necessary for cache prefix matching.

### Alternatives considered

| Option | Why rejected |
|---|---|
| Two separate complete tool registrations per state | Doubles the cache-write cost on first turn after a transition. The variable-suffix-only approach achieves the same allow-list with 5x less cache-write churn. |
| Move `cache_control` marker to the last *stable* tool (so the variable suffix is permanently uncached) | The variable suffix is 1-2K tokens — small enough that caching it is still worth the breakpoint cost. Keeping the marker on the absolute last tool is simpler. |
| Don't compact the tool list (Lever I disabled) | Defeats the lever's purpose. The 19-tool block is ~5K cached today; cutting to ~2-3K for scoping turns is a clean win. |
| Compute a per-state cache key suffix that the SDK appends | SDK doesn't expose this; would require direct-transport-only path. |

### Implementation note

`sdk-runner.ts` near the existing `mcpServers: { [TUNING_AGENT_SERVER_NAME]: mcpServer }` block:

```ts
// PR 6
const STABLE_READ_TOOLS = [
  'studio_get_canonical_template',
  'studio_get_context',
  'studio_get_correction',
  'studio_get_edit_history',
  'studio_get_evidence_index',
  'studio_get_evidence_section',
  'studio_get_artifact',
  'studio_get_tenant_index',
  'studio_memory',
  'studio_search_corrections',
];

const STATE_TOOLS: Record<InnerState, string[]> = {
  scoping: ['studio_propose_transition'],
  drafting: [
    'studio_create_faq',
    'studio_create_sop',
    'studio_create_system_prompt',
    'studio_create_tool_definition',
    'studio_plan_build_changes',
    'studio_propose_transition',
    'studio_rollback',
    'studio_suggestion',
  ],
  verifying: ['studio_test_pipeline'],
};
```

The `state-machine.ts` module already exports `TUNING_AGENT_TOOL_NAMES_BY_INNER_STATE` — reuse that as the source of truth, not duplicate constants. The PR will refactor to derive the two passes from the existing source.

Verified by `prompt-cache-stability.test.ts` extension asserting:

- Stable read-tools prefix is byte-identical across `scoping` / `drafting` / `verifying` for a fixture tenant.
- Variable suffix differs deterministically per state.
- Cache breakpoint marker is on the last entry in all three cases.

---

## R3: PreCompact hook investigation (Lever H — deferred)

### Decision

**Defer Lever H entirely from this feature.** PRs 1-7 in `047-studio-token-efficiency` do not touch the messages array. Lever H (compress old `tool_result` blocks via PreCompact hook) gets its own separate feature once post-deploy data on PRs 1-7 is in.

### Rationale

1. **SDK contract instability.** `@anthropic-ai/claude-agent-sdk` v0.2.109 exposes `PreToolUse`, `PostToolUse`, `Stop`, and a partial `PreCompact` surface, but the contract for rewriting individual `tool_result` content blocks within the messages array is not documented stable across SDK versions. Future SDK upgrades could break the rewrite.
2. **Reasoning fragility.** Replacing a `tool_result` block with a stub like `[tool_result:abc123 — re-fetch via tool]` removes the actual content the agent's prior reasoning referenced. Lost context can cause the agent to re-fetch (round-trip cost) or hallucinate (correctness cost). The trade-off needs measurement we can't do until PR 1's per-round capture is live.
3. **Cache-invalidation cascade.** If the stub bytes differ from the original return for any reason (timestamps, ordering, formatting), the next round's input array bytes shift, invalidating the messages-array cache marker we just shipped (`withLastMessageCacheControl` in commit `2ee304c`). Defeats Lever 4-th-breakpoint.
4. **Targets achievable without Lever H.** PRs 1-7 individually save:
   - PR 2 (verbosity): -10-30% per call to `get_artifact`
   - PR 3 (section drill-down): -50-80% on system_prompt fetches
   - PR 4 (read budget): -30-50% rounds per turn
   - PR 5 (slim get_context): -3-5K per turn
   - PR 6 (per-state tools): -2-3K cached per turn
   These compound to the 30-50% per-turn target without messages-array touching.

### Alternatives considered

| Option | Why rejected (for THIS feature) |
|---|---|
| Ship Lever H behind a feature flag default-OFF | Untested code paths decay. We'd need a real reason to flip the flag eventually, and that reason should drive its own feature. |
| Direct-transport-only Lever H (where we own the messages array fully) | Possible but only addresses the `BUILD_AGENT_DIRECT_TRANSPORT=true` path. Default SDK transport stays unaddressed. Ship as a follow-up. |
| Smaller-scope variant: compress only `studio_get_evidence_section` returns of certain types | Too narrow; doesn't compose with the tool-return mix we observed in real traces. |

### Follow-up

Open a separate spec via `/speckit.specify` titled "Studio messages-array compaction" once post-deploy data on PRs 1-7 is in. Likely scope for that feature:

- SDK-spike: confirm `PreCompact` hook contract with v0.2.109 fixture
- Stub-replacement strategy (deterministic stub bytes to preserve cache)
- Re-fetch behavior measurement (does the agent actually re-fetch when it sees a stub?)
- Direct-transport variant (potentially preferred, depending on SDK spike outcome)

---

## R4: Verbosity back-compat audit

### Decision

Switching the default of `studio_get_artifact.verbosity` from de-facto-`'detailed'` to `'concise'` is **safe** — no existing in-tree caller depends on the de-facto-detailed behavior except the agent itself, which is the intended caller. The agent's prompt will be updated (in PR 4) to teach it that concise is the default and to opt into detailed only when editing.

### Rationale

Audited callers of `studio_get_artifact`:

1. **Agent (MCP dispatch via Claude Agent SDK)** — primary. Behavior change: agent receives ≤1500-token excerpt by default. Mitigated by prompt update in PR 4 explaining the new contract.
2. **Tests** — three test files reference `studio_get_artifact`. They construct stub return values manually rather than calling the real handler with a real pointer, so the default-shape change doesn't affect them.
3. **No HTTP-level callers** — `studio_get_artifact` is registered only on the MCP tool surface, not as a public REST endpoint.

### Alternatives considered

| Option | Why rejected |
|---|---|
| Keep default `'detailed'`, prompt teaches agent to pass `'concise'` | Less reliable — the agent might forget to pass the param. Default-concise is the schema-as-spec pattern that worked for `<output_contract>` defaults in the TUNE addendum. |
| Detect agent vs non-agent callers (e.g., via header or `_caller` arg) | Adds complexity for no real win — there are no non-agent callers worth preserving. |

### Implementation note

PR 2's tests will explicitly assert: (a) no-args call returns concise shape, (b) `verbosity:'detailed'` returns existing shape byte-for-byte, (c) the prompt update in PR 4 includes the new default in `<context_handling>` or the equivalent block.

---

## R5: Anthropic SDK v0.2.109 hook surface audit

### Decision

For PR 4's PreToolUse warning hook (read-budget enforcement), the SDK exposes a `hooks` option on `query()` that accepts an object with hook handlers. The signature confirmed by inspecting `@anthropic-ai/claude-agent-sdk/dist/sdk.d.ts`:

```ts
hooks: {
  PreToolUse?: (input: PreToolUseHookInput) => Promise<PreToolUseHookOutput>;
  // ... others
}
```

`PreToolUseHookOutput` permits `{}` (no-op), `{decision: 'block', reason: string}`, or `{updatedInput: <transformed input>}`. For a non-blocking warning, return `{}` and emit the Langfuse span tag as a side effect.

### Rationale

1. **Existing precedent.** `backend/src/build-tune-agent/hooks/` already contains hook implementations (`pretooluse-state-gate.ts`, `precompact-rejection-memory.ts`). The new `read-budget-warn.ts` follows the same pattern.
2. **Side-effect-only emit is safe.** Returning `{}` doesn't change the agent's behavior. The Langfuse span tag attaches via the existing `getCurrentTrace().span(...)` API.
3. **Counter is per-turn, not per-session.** The hook reads round count from `ToolContext` extended with a per-turn counter that resets at turn start. The state-machine's existing `inner_state` is read from the snapshot.

### Alternatives considered

| Option | Why rejected |
|---|---|
| Return `{decision: 'block'}` to hard-block | Spec clarification (Q1) explicitly chose warn-not-block. |
| Track budget via Langfuse query post-hoc instead of in-process counter | Doesn't help the agent's next round see budget exceeded; we want the span tag attached to the actual offending call. |
| Reset counter at session start instead of turn start | A single user turn is the natural budget window per the spec. Session-level budgets don't match Story 4's intent. |

### Implementation note

`backend/src/build-tune-agent/hooks/read-budget-warn.ts` (new file). Registered in `sdk-runner.ts` alongside existing `pretooluse-state-gate.ts`. Wired so the per-turn read counter increments inside the handler and the span tag attaches when count exceeds the state's budget.

---

## Summary

All three spec-flagged open questions resolved (R1, R2, R3). Two additional questions surfaced during planning and resolved (R4 back-compat, R5 SDK hook surface). No `NEEDS CLARIFICATION` markers remain in the plan's Technical Context. Phase 1 contracts can be authored from these decisions directly.
