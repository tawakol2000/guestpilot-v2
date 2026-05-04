# Implementation Plan: Studio Token Efficiency

**Branch**: `047-studio-token-efficiency` | **Date**: 2026-05-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/047-studio-token-efficiency/spec.md`

## Summary

Cut Studio (BUILD/TUNE) per-turn token consumption by 30-50% and per-turn cost by 40-60% by (1) shipping per-round Langfuse measurement so every other change is verifiable, (2) honoring the existing-but-ignored `verbosity:'concise'` parameter on `studio_get_artifact`, (3) adding `mode:'index'` and `section:'<name>'` parameters to enable section-level drill-down, (4) adding prompt-level read-budget rules with an observability-only PreToolUse warning hook, (5) slimming the default `studio_get_context` payload, (6) compacting the per-state tool allow-list, and (7) (stretch) pre-rendering anchor data into Region C. All changes are additive parameter extensions or prompt edits; no DB schema changes, no new tools registered. The 19-tool surface stays at 19. Each story ships as one PR; PR 1 (measurement) lands first so subsequent levers are measurable. Decision-quality is gated by automated `node:test` integration tests that stub the LLM call and assert on output structure.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend only — no frontend changes)
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk` 0.2.109 (SDK transport), `@anthropic-ai/sdk` (direct transport when `BUILD_AGENT_DIRECT_TRANSPORT=true`), `langfuse` Node SDK (observability), `zod/v4` (tool schemas), Prisma ORM (read-only — no schema changes)
**Storage**: PostgreSQL via Prisma — **no schema changes**. Reads existing `SopDefinition`/`SopVariant`/`FaqEntry`/`TenantAiConfig`/`AgentMemory`/`TuningConversation` tables.
**Testing**: `node:test` via `npx tsx --test` for unit + integration tests. Test fixtures are in-memory (no DB calls in CI).
**Target Platform**: Linux server (Railway production deploy)
**Project Type**: Backend service (web-service). Frontend has zero changes — tool returns are still JSON, rendering layers ignore unknown fields.
**Performance Goals**:
- P90 per-round input tokens ≤45K (currently ~70K)
- Median per-round input tokens ≤30K (currently ~50K)
- Median rounds-per-turn ≤3 (currently ~5)
- Cache hit rate ≥75% (currently 57.8%)
- Median per-turn cost ≤$0.03 (currently ~$0.08-0.10)

**Constraints**:
- MUST NOT regress on 4 named decision-quality eval cases (FR-010, automated CI tests)
- MUST work identically in SDK transport (default) and direct transport (`BUILD_AGENT_DIRECT_TRANSPORT=true`)
- MUST degrade gracefully when Langfuse is disabled (no errors, no blocking)
- Each PR MUST be independently revertable via `git revert` with no DB migration

**Scale/Scope**:
- ~20-50 Studio sessions/day per active tenant currently
- Each session: 5-15 user turns; each turn: 3-8 internal `messages.create` rounds
- Existing 19-tool MCP surface, ~12K cached system prompt, ~5K cached tools block

## Constitution Check

*GATE: All gates must pass before Phase 0. Re-checked after Phase 1.*

| Principle | Compliance | Notes |
|---|---|---|
| **I. Graceful Degradation (NON-NEGOTIABLE)** | ✅ PASS | FR-011 explicitly requires no-op when Langfuse disabled. PreToolUse warning hook for read-budget never blocks calls. Lever I (per-state allow-list) preserves the PreToolUse runtime hook as a backstop. No new hard dependencies. |
| **II. Multi-Tenant Isolation (NON-NEGOTIABLE)** | ✅ PASS | No DB schema changes. All tool handlers continue to receive `ToolContext.tenantId` and filter every Prisma query by it. No global state introduced. Section `hashId` is HMAC-signed against the tenant's existing pointer scheme. |
| **III. Guest Safety & Access Control (NON-NEGOTIABLE)** | ✅ PASS | Studio is operator-facing; no guest data path is touched. The reply pipeline (which IS guest-facing) is explicitly out of scope per spec section "Related work". |
| **IV. Structured AI Output** | ✅ PASS | Coordinator/screening JSON schemas unchanged. Studio agent's data-part shapes (`data-suggested-fix` etc.) unchanged. New `mode:'index'` return shape is purely additive. |
| **V. Escalate When In Doubt** | ✅ PASS | No impact on escalation triggers, task manager dedup, or escalation-enrichment service. Studio writes don't fire escalations. |
| **VI. Observability by Default** | ✅ PASS — STRENGTHENED | Story 1 / FR-001 explicitly improves observability by capturing per-round usage that's currently lost. PreToolUse warning hook (FR-005) adds new span tags. `AiApiLog` writes from the reply pipeline are unchanged. |
| **VII. Tool-Based Architecture** | ✅ PASS | Tool count stays at 19 (extending existing `studio_get_artifact` and `studio_get_context` with optional params, not adding new tools). The 5-round bound on the tool-use loop is unchanged. Tool scope by reservation status is unchanged. Per-state allow-list (Lever I) is a refinement of existing scope enforcement. |
| **VIII. FAQ Knowledge Loop** | ✅ PASS | FAQ entries and `get_faq` tool path unchanged. `studio_get_artifact` for FAQ kind respects existing scope (GLOBAL/PROPERTY) and status (SUGGESTED filtered out, only ACTIVE returned). |

**Result:** All 8 principles pass. **No constitution violations to justify.** No entries in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/047-studio-token-efficiency/
├── spec.md              # Feature spec (clarified 2026-05-04, 5 Q&A integrated)
├── plan.md              # This file
├── research.md          # Phase 0 output — resolves three open questions
├── data-model.md        # Phase 1 output — Round, Section, Verbosity, ReadBudget, ToolAllowList
├── contracts/           # Phase 1 output — tool I/O contracts
│   ├── studio_get_artifact.contract.md
│   ├── studio_get_context.contract.md
│   └── observability.langfuse-generation.contract.md
├── quickstart.md        # Phase 1 output — local verification per PR
└── tasks.md             # Phase 2 output (created by /speckit.tasks — NOT this command)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── build-tune-agent/
│   │   ├── tools/
│   │   │   ├── get-artifact.ts            # PR 2/3 — verbosity, mode:'index', section:'<name>'
│   │   │   ├── get-context.ts             # PR 5 — verbosity, slim concise default
│   │   │   ├── get-evidence-section.ts    # PR 5 — verbosity for reasoning_trace + tool_call sections
│   │   │   └── lib/
│   │   │       ├── pointer.ts             # PR 3 — extend metadata to carry section hashId
│   │   │       └── section-extractor.ts   # PR 3 (new) — markdown-heading split + single-section fallback
│   │   ├── system-prompt.ts               # PR 4 — <read_budget>, <no_speculative_reads>, <disabled_artifacts>
│   │   ├── sdk-runner.ts                  # PR 1 (per-round emit) + PR 6 (per-state tool registration)
│   │   ├── runtime-direct.ts              # PR 1 — direct-transport bridge per-round emit
│   │   ├── state-machine.ts               # PR 6 — read source for per-state allow-list
│   │   └── hooks/
│   │       └── read-budget-warn.ts        # PR 4 (new) — PreToolUse warning hook (no block)
│   ├── services/
│   │   └── observability.service.ts       # PR 1 — extend logAgentGeneration with roundIndex; usageDetails fix
│   └── controllers/
│       └── (no changes)
└── scripts/
    ├── langfuse-cost-audit.ts             # already shipped — extend for per-round group-by
    ├── langfuse-trace-detail.ts           # already shipped — render per-round tree
    └── measure-prompt.ts                  # already shipped — used by quickstart

backend/src/build-tune-agent/__tests__/
├── decision-quality.test.ts               # PR 1 (new) — 4 stubbed-LLM eval tests, hard CI gate
├── get-artifact.test.ts                   # PR 2/3 (new or extended) — verbosity/mode/section coverage
├── get-context.test.ts                    # PR 5 (new or extended) — slim default coverage
├── system-prompt.test.ts                  # PR 4 (extended) — assert new prompt blocks
├── sdk-runner.test.ts                     # PR 1 + PR 6 (extended) — per-round emit + per-state allow-list
└── prompt-cache-stability.test.ts         # PR 6 (extended) — cache-prefix stability across states
```

**Structure Decision:** Single backend project. All source under `backend/src/build-tune-agent/` (the Studio agent module) and `backend/src/services/observability.service.ts` (cross-cutting Langfuse helpers). One new directory entry: `backend/src/build-tune-agent/tools/lib/section-extractor.ts` for the section-extraction heuristic, plus `backend/src/build-tune-agent/hooks/read-budget-warn.ts` for the PreToolUse warning hook. Frontend is untouched.

## Complexity Tracking

> No constitution violations. Section omitted.

---

# Phase 0 — Research

Three open questions from the spec, resolved here so Phase 1 can produce concrete contracts. Detailed write-up lives in `research.md` (sibling document); summarized below.

## Q1: Section extraction heuristic for SOPs

**Decision:** Markdown headings (`##`/`###`) primary; single-section fallback when no headings found. Section name = heading text; section body = content between consecutive headings (or to EOF for the last). Section `summary` = first non-empty paragraph after the heading, capped at 80 chars. Section `tokens` = `Math.ceil(body.length / 3.6)` (matches existing `measure-prompt.ts` approximation).

**Rationale:** Tenants in the codebase already use `##` for major SOP sections in canonical templates. Markdown is the de-facto authoring format. Fallback is honest about absence of structure rather than inventing pseudo-sections.

**Alternatives considered:**
- Paragraph splitting with N-token grouping → rejected: produces opaque names the agent can't reason about
- LLM-based summarization to invent section names → rejected: adds non-deterministic LLM call per artifact load
- Always single-section → rejected: defeats Story 3 for system prompts which DO have heading structure

**Implementation:** `backend/src/build-tune-agent/tools/lib/section-extractor.ts`, exports `extractSections(body: string, fallbackTitle: string): Section[]`. Pure function, no I/O, unit-tested against fixtures.

## Q2: Cache breakpoint behavior under per-state tool registration

**Decision:** Order tools array such that *stable* tools (read tools always available) come FIRST and *state-variable* tools (write tools, test_pipeline) come LAST. The `cache_control: { type: 'ephemeral' }` marker stays on the LAST tool entry per existing `withLastToolCacheControl` helper. Cache invalidates only on the variable suffix; the read-tools prefix stays warm across state transitions.

**Rationale:** Anthropic's prompt cache invalidates from the first byte that differs onward. Stable-first ordering means scoping↔drafting transitions only invalidate the trailing ~1-2K of the tools block, not the leading ~3K of read-tool descriptions.

**Alternatives considered:**
- Two separate tool registrations per state → rejected: doubles cache-write cost on first turn after transition
- No compaction (Lever I disabled) → rejected: defeats the lever's purpose
- Move cache_control marker to last *stable* tool → considered, adds complexity for no extra benefit

**Implementation:** `sdk-runner.ts` builds tools in two passes — stable read tools first (deterministic alphabetical order), then state-specific tools (deterministic order). `withLastToolCacheControl` continues to mark the last entry. Verified by `prompt-cache-stability.test.ts` extension asserting cached-prefix bytes are byte-identical across scoping/drafting/verifying for a fixture tenant.

## Q3: PreCompact hook investigation (Lever H — deferred)

**Decision: Defer Lever H entirely from this feature.** SDK v0.2.109 exposes `PreToolUse`/`PostToolUse`/`Stop` hooks and a partial `PreCompact` surface, but the contract for rewriting `tool_result` blocks in the messages array is not stable across SDK versions. Risk of breaking agent reasoning ("what was that SOP I just read?") plus cache-invalidation cascade if stub bytes differ from original returns puts this in spike-required territory.

**Rationale:** PRs 1-7 target a 30-50% per-turn token reduction without touching the messages array. If post-deploy data shows we're still above target, Lever H gets its own feature with a dedicated SDK-spike sprint.

**Alternatives considered:**
- Ship behind feature flag default-OFF → rejected: untested code paths decay
- Direct-transport-only implementation → considered, deferred to follow-up sprint

**Follow-up:** Open a separate spec (`/speckit.specify`) titled "Studio messages-array compaction" once post-deploy data on PRs 1-7 is in.

---

# Phase 1 — Design & Contracts

## Data model

`data-model.md` will define five entities. None are persisted (no DB changes); all are runtime structures flowing through tool returns and Langfuse generations.

| Entity | Persistence | Lifetime |
|---|---|---|
| Round | Langfuse only | Per `messages.create` call inside one SDK query |
| Section | In-memory + Langfuse pointer metadata | Per artifact fetch (re-derived each call) |
| Verbosity | Tool param enum | Per tool call |
| ReadBudget | Prompt + observability counter | Per turn |
| ToolAllowList | sdk-runner-internal | Per turn (depends on state+mode) |

## Contracts

Three contract documents under `contracts/` capturing the new tool I/O shapes:

### `studio_get_artifact.contract.md`

Schema additions to existing tool:

```ts
// Existing (unchanged):
pointer: z.string().min(8).max(2048)
verbosity: z.enum(['concise', 'detailed']).optional()  // default 'concise' (NEW behavior; was de-facto 'detailed')

// New:
mode: z.enum(['full', 'index']).optional()              // default 'full'
section: z.string().min(1).max(120).optional()
```

Output shapes per (kind × mode × verbosity × section):

- `system_prompt × full × detailed`: existing shape preserved byte-for-byte
- `system_prompt × full × concise`: `{kind, variant, version, text: <head excerpt + truncation marker>, sections: [...], fullCharLength}`
- `system_prompt × index × *`: `{kind, variant, version, sectionList: [{name, summary, tokens, hashId}], fullCharLength}` — no body text
- `system_prompt × * × section:'<name>'`: `{kind, variant, version, sectionName, text: <one section>, neighborSections: [<prev>, <next>]}`
- `sop × *`: same shape pattern as system_prompt; `mode:'index'` returns single-section fallback when no markdown headings found
- `faq × index × *` / `tool × index × *`: rejected with error "kind X does not support index mode; use mode:'full' with verbosity:'concise'"

Validation:
- Unknown `section:'<name>'` → error listing valid section names
- `verbosity` defaults to `'concise'` (changed from de-facto-detailed)
- Tampered `hashId` rejected via HMAC verification (existing pointer scheme reused)

### `studio_get_context.contract.md`

Schema additions:

```ts
verbosity: z.enum(['concise', 'detailed']).optional()  // default 'concise'
```

Output shapes:

- `concise`: `{conversation: {id, title, anchorMessageId, anchorMessage: {text, role}}, lastInbox: <max 3>, lastEditSummary: <string|null>}` — target ≤2K tokens
- `detailed`: existing 7.8K-token shape preserved byte-for-byte

### `observability.langfuse-generation.contract.md`

`logAgentGeneration` signature extension:

```ts
logAgentGeneration({
  name: 'tuning-agent.query',
  model: string,
  inputTokens: number,           // fresh input only (input_tokens from API)
  outputTokens: number,
  cacheReadTokens: number,       // cache_read_input_tokens
  cacheCreationTokens: number,   // cache_creation_input_tokens
  metadata: {
    roundIndex: number,          // NEW: 1-based, monotonic within a query
    parentSpanId?: string,       // NEW: optional, for explicit parent-child
    tenantId: string,
    conversationId: string,
    toolCallsInRound?: string[]  // NEW: tool names invoked in this round
  }
})
```

Emit cadence: **live** — called inside the `for await` loop of `sdk-runner.ts` at the moment each `assistant` SDK message arrives with `usage`. Direct-transport bridge in `runtime-direct.ts` calls the same function from its `for await` over the streaming `messages.create` response.

Cost calculation: Langfuse model-pricing layer reads `usageDetails` keys (`input`, `output`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and computes cost per the configured Sonnet 4.6 pricing.

## Quickstart

`quickstart.md` will document local verification commands per PR:

```bash
# PR 1 — Per-round measurement
cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts
cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/sdk-runner.test.ts
# After deploy, trigger one Studio turn, then:
cd backend && npx tsx scripts/langfuse-trace-detail.ts --hours 1
# Expect: per-round generation tree under tuning-agent.query parent

# PR 2 — Verbosity in get_artifact
cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-artifact.test.ts
# Look for: concise default returns ≤1500 tokens

# PR 3 — Section drill-down
# Same test file extended; assert mode:'index' returns sectionList; section:'<name>' returns one section

# PR 4 — Read-budget + prompt rules
cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/system-prompt.test.ts
# Assert <read_budget>, <no_speculative_reads>, <disabled_artifacts> blocks present

# PR 5 — Slim get_context
cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-context.test.ts
# Assert default ≤2000 tokens

# PR 6 — Per-state tool allow-list
cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/sdk-runner.test.ts
# Assert per-state filtering; PreToolUse hook still catches violations as backstop

# Post-deploy targets check (after each PR)
cd backend && npx tsx scripts/langfuse-cost-audit.ts --hours 24
# Track: median per-round input, p90, cache hit %, median per-turn cost
```

## Agent context update

After this plan lands, `.specify/scripts/bash/update-agent-context.sh claude` refreshes `CLAUDE.md` with:

- New tool params: `studio_get_artifact` accepts `mode`/`section`; `studio_get_context` accepts `verbosity`
- New per-round Langfuse capture (works in both SDK and direct transports)
- New file paths: `tools/lib/section-extractor.ts`, `hooks/read-budget-warn.ts`, `__tests__/decision-quality.test.ts`
- Decision-quality test gate: PR cannot merge if `decision-quality.test.ts` fails

## Constitution re-check (post-Phase-1)

Re-validating after Phase 1 design:

| Principle | Pre-Phase-1 | Post-Phase-1 |
|---|---|---|
| I. Graceful Degradation | ✅ | ✅ — read-budget warn hook explicitly never blocks; Langfuse-disabled path is no-op |
| II. Multi-Tenant Isolation | ✅ | ✅ — section `hashId` HMAC includes tenantId in signed payload |
| III. Guest Safety | ✅ | ✅ — Studio-only feature, guest path untouched |
| IV. Structured AI Output | ✅ | ✅ — get_artifact / get_context output schemas extended additively; old callers see new optional fields they can ignore |
| V. Escalate When In Doubt | ✅ | ✅ — no impact |
| VI. Observability | ✅ STRENGTHENED | ✅ STRENGTHENED — per-round generations + read-budget span tags + disabled-artifact-fetched span tags |
| VII. Tool-Based Architecture | ✅ | ✅ — tool count stays at 19; max-5-rounds bound respected (read budget caps lower than the SDK's max-rounds anyway) |
| VIII. FAQ Knowledge Loop | ✅ | ✅ — FAQ entries unaffected; `studio_get_artifact` for faq kind continues to filter status=ACTIVE |

**No new violations introduced by the design.**

## Phase 2 outlook (NOT executed by this command)

`/speckit.tasks` will translate this plan into a `tasks.md` with one task per PR, file-level subtasks, and a dependency graph. Natural sequence:

1. **PR 1** — Lever J: Per-round Langfuse capture (`sdk-runner.ts` + `observability.service.ts` + `decision-quality.test.ts`). Highest priority; everything below is verified through this.
2. **PR 2** — Lever A: Honor `verbosity:'concise'` in `get-artifact.ts` (handler change + test).
3. **PR 3** — Levers B+C: `mode:'index'` + `section:'<name>'` (handler + new `section-extractor.ts` lib + tests).
4. **PR 4** — Levers D+E + disabled-SOP rule: prompt blocks + `read-budget-warn.ts` PreToolUse hook + tests.
5. **PR 5** — Lever F: Slim `get-context.ts` default + verbosity (handler + test).
6. **PR 6** — Lever I: Per-state tool allow-list (`sdk-runner.ts` + `prompt-cache-stability.test.ts` extension).
7. **PR 7** (stretch) — Lever G: `<conversation_anchor>` Region C block (`system-prompt.ts` + runtime context-builder).

After PR 5 we expect to be at the SC-001..SC-005 targets; PRs 6-7 are stretch wins.
