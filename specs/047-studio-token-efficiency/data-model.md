# Phase 1 Data Model: Studio Token Efficiency

**Feature:** 047-studio-token-efficiency
**Created:** 2026-05-04
**Companion:** [plan.md](./plan.md), [research.md](./research.md)

This feature introduces no DB schema changes. All entities below are runtime-only structures that flow through tool returns, prompt blocks, and Langfuse generations.

---

## Entity 1: Round

A single `messages.create` API call inside one Studio agent turn.

| Field | Type | Source | Notes |
|---|---|---|---|
| `roundIndex` | `number` | runtime counter | 1-based, monotonic within a `tuning-agent.query` |
| `parentTraceId` | `string` | Langfuse | the parent `tuning-agent.query` span this round belongs to |
| `model` | `string` | API request | e.g. `claude-sonnet-4-6` |
| `inputTokens` | `number` | API response `usage.input_tokens` | fresh tokens only |
| `outputTokens` | `number` | API response `usage.output_tokens` | |
| `cacheReadTokens` | `number` | API response `usage.cache_read_input_tokens` | from prefix cache |
| `cacheCreationTokens` | `number` | API response `usage.cache_creation_input_tokens` | newly cached |
| `toolCallsInRound` | `string[]` | SDK stream | tool names invoked in this round (max 1 tool call per round in current SDK behavior, but array form keeps the contract flexible) |
| `startTime` | `ISO 8601 string` | runtime | when the API call started |
| `endTime` | `ISO 8601 string` | runtime | when the response stream completed |

**Persistence:** Langfuse only (via `trace.generation(...)`). Not stored in PostgreSQL.

**Lifetime:** One per `messages.create` call. Multiple rounds per `tuning-agent.query` span. Multiple queries per `TuningConversation` row.

**Validation:**

- `roundIndex >= 1` and monotonically increases within one query.
- `inputTokens + cacheReadTokens + cacheCreationTokens > 0` for any non-trivial round (a round with all zeros indicates the SDK didn't surface usage — bug, not data).
- `toolCallsInRound.length <= 5` (SDK's max-rounds bound).

**State transitions:** None — rounds are immutable once emitted.

---

## Entity 2: Section

A named segment of a multi-section artifact (system prompt or SOP).

| Field | Type | Source | Notes |
|---|---|---|---|
| `name` | `string` | extractor (markdown heading text) or fallback (artifact title) | 1-120 chars; matches the heading text verbatim |
| `summary` | `string` | extractor (first non-empty paragraph after heading) | ≤80 chars, `…`-truncated if longer |
| `body` | `string` | extractor (content between consecutive headings) | included only when `mode='full'` AND `section='<name>'` |
| `tokens` | `number` | `Math.ceil(body.length / 3.6)` | approximation matching `measure-prompt.ts` |
| `hashId` | `string` | HMAC-SHA256(tenantId, artifactId, name, body[:200])[:16] | tamper guard for `section` parameter |

**Persistence:** None — derived on every `studio_get_artifact(mode:'index')` call. The `hashId` lets the agent pass section identity back without forging.

**Lifetime:** Per artifact fetch. Re-derived each call.

**Validation:**

- For system prompts: section list comes from existing `v.sections` field if present; otherwise from extractor.
- For SOPs: section list comes from extractor; falls back to single-section list `[{name: <SOP title>, summary: <first 80 chars of body>, ...}]` when no markdown headings detected.
- For FAQ / tool kinds: section list rejected — these are atomic, no drill-down supported.
- `name` MUST match a name returned by `mode:'index'` (server validates against the freshly-extracted list; tampered names rejected).

**State transitions:** None — sections are immutable derivations of artifact bodies.

---

## Entity 3: Verbosity

An enum gating tool-return shape.

| Value | Behavior |
|---|---|
| `'concise'` | (NEW DEFAULT for `studio_get_artifact` and `studio_get_context`) Return a head excerpt + structural metadata. Target ≤2K tokens regardless of underlying artifact size. |
| `'detailed'` | Return the existing full shape byte-for-byte. Used when the agent has decided to actually read or modify the artifact. |

**Persistence:** None — request-scoped tool param.

**Lifetime:** Single tool call.

**Validation:**

- Defaults to `'concise'` when the parameter is omitted.
- The `'detailed'` shape MUST be byte-equivalent to today's tool return (back-compat for any caller that explicitly asks for it).

**State transitions:** None.

---

## Entity 4: ReadBudget

A per-state cap on read-tool calls within one user turn.

| State | Read budget |
|---|---|
| `scoping` | 4 |
| `drafting` | 2 |
| `verifying` | 1 (`studio_test_pipeline` only) |

**Persistence:** None — counter held in `ToolContext` extension, reset at turn start.

**Lifetime:** One counter per user turn.

**Validation:**

- Counter increments inside the PreToolUse warning hook when a read tool fires.
- When `count > budget[state]`, the hook attaches `read_budget_exceeded: true` Langfuse span tag and returns `{}` (does NOT block).
- Read tools counted: `studio_get_*` (except `studio_get_tenant_index` which is the catalog and counts as 1 even though it's metadata-only), `studio_search_corrections`, `studio_get_correction`, `studio_memory(op:'view'|'list')`.
- Write tools and transition tools NOT counted toward the read budget.

**State transitions:** Counter resets to 0 at the start of each user turn (signal: `tuning-agent.query` span starts).

---

## Entity 5: ToolAllowList

The set of tool names registered with the SDK for a given `(state, mode)` combination.

| State × Mode | Stable read tools (always present) | State-specific tools added |
|---|---|---|
| `scoping × TUNE` | the 10 read tools | `studio_propose_transition` |
| `drafting × TUNE` | the 10 read tools | `studio_create_*` (4), `studio_plan_build_changes`, `studio_propose_transition`, `studio_rollback`, `studio_suggestion` |
| `verifying × TUNE` | the 10 read tools | `studio_test_pipeline` |
| `scoping × BUILD` | the 10 read tools | `studio_propose_transition` |
| `drafting × BUILD` | the 10 read tools | `studio_create_*` (4), `studio_plan_build_changes`, `studio_propose_transition`, `studio_rollback` (no `studio_suggestion` — that's TUNE-only) |
| `verifying × BUILD` | the 10 read tools | `studio_test_pipeline` |

**Persistence:** None — derived per-turn from `state-machine.ts#TUNING_AGENT_TOOL_NAMES_BY_INNER_STATE`.

**Lifetime:** Per turn.

**Validation:**

- Stable read tools come FIRST in the registered tools array (alphabetical).
- State-specific tools come LAST in deterministic order.
- The `cache_control` marker stays on the absolute last tool entry (existing `withLastToolCacheControl` helper).
- The PreToolUse `pretooluse-state-gate.ts` hook continues to enforce state at runtime as a backstop, even though disallowed tools aren't registered.

**State transitions:** Allow-list rebuilt at turn start based on the current snapshot's `inner_state` and `outer_mode`. State changes happen across turn boundaries (host-confirmed transitions), so no mid-turn reshuffling.

---

## Cross-entity relationships

```
TuningConversation (existing DB row)
  └── tuning-agent.query (Langfuse parent span, 1+ per conversation)
        ├── Round (1..N children, this feature)
        │     ├── Section (returned by 0..N get_artifact calls in this round)
        │     └── ReadBudget counter increment (per read-tool call)
        └── ToolAllowList (1 per query, derived from state+mode)

Verbosity is a parameter on get_artifact and get_context calls — not an entity in the relationship graph but a modifier on Section returns and tool-result shapes.
```

---

## Validation rules summary

| Rule | Where enforced |
|---|---|
| `verbosity` defaults to `'concise'` | Tool handler in `get-artifact.ts` / `get-context.ts` |
| `mode:'index'` rejected for FAQ / tool kinds | `get-artifact.ts` switch on `kind` |
| Unknown `section:'<name>'` rejected with valid-names list | `get-artifact.ts` after section extraction |
| Section `hashId` HMAC-verified | reuse existing `pointer.ts` `decodePointer` pattern |
| Round `inputTokens + cacheReadTokens + cacheCreationTokens > 0` | Langfuse generation emit (warn log if 0, not an error) |
| Read budget counter resets per turn | `sdk-runner.ts` at `tuning-agent.query` start |
| Tools array stable-prefix + variable-suffix ordering | `sdk-runner.ts` per-state assembly |

No new DB constraints. No new migrations.
