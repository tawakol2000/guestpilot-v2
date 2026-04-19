# Sprint 045 — NEXT session handoff (session 4)

> Owner: Abdelrahman (ab.tawakol@gmail.com)
> Branch: `feat/045-build-mode` (off `044-doc-handoff-whatsapp`)
> Session 3 closed: 2026-04-19. Gate 3 (`test_pipeline`) + Gate 4 scaffolding
> decisions done. Prefix-stability threshold bumped to 2048.

## Where session 3 left off

Gates 0, 1, 2, and 3 complete. Gate 3 was re-scoped from a full
batch-preview subsystem to a single-message `test_pipeline` tool (the
golden-set + adversarial + rubric + LLM-judging batch plan moved to
sprint 047+; see MASTER_PLAN.md). Shipped:

- `preview/test-judge.ts` — Sonnet 4.6 grader, version-stamped prompt
  (`JUDGE_PROMPT_VERSION = 'test-judge/v1 — 2026-04-19'`), deterministic
  paragraph shuffling of tenant context for position-bias mitigation,
  graceful score=0 on network failure.
- `preview/test-pipeline-runner.ts` — simplified dry pipeline. Reuses
  the tenant's coordinator / screening system prompt, pre-injects all
  enabled SOPs + all ACTIVE FAQs, runs one OpenAI Responses-API call,
  returns `{ reply, replyModel, tenantContextSummary, latencyMs }`.
  Cross-module, doesn't touch `ai.service.ts#generateAndSendAiReply`.
- `tools/test-pipeline.ts` — MCP tool, per-turn `hasRunThisTurn` guard
  (returns `TEST_ALREADY_RAN_THIS_TURN` on a second call in the same
  turn), emits `data-test-pipeline-result` SSE.
- `services/tenant-config.service.ts` — optional
  `{ bypassCache: true }` option on `getTenantAiConfig`. Production
  hot path (`generateAndSendAiReply`) unchanged.
- `runtime.ts` — `test_pipeline` in BOTH BUILD and TUNE allow-lists.
  Per-turn `turnFlags: Record<string, boolean>` added to ToolContext.

Also in session 3:

- **Prefix-stability threshold 1024 → 2048.** Sonnet 4.5/4.6 require
  ≥2048 tokens for an independent cached layer; the older 1024-token
  floor no longer applies. `prompt-cache-stability.test.ts` updated
  and now logs a `tools_only` baseline too (2,399 tokens across 14
  tools — above the 2048 floor, but noted as informational).
- **V1 status flipped from ⏸️ deferred to ✅ validated.** The theoretical
  argument was decisive given the SDK's client-side `allowedTools`
  filter; production Langfuse traces on staging rollout confirm the
  PASS. `validation/V1-live.ts` retained as a deterministic fallback
  if production data is ever ambiguous.
- Session 3 added three tests files (+21 tests) to take the suite from
  95 to 116. TUNE behaviour intact at every commit.

`ENABLE_BUILD_MODE` stays off. BUILD surface is still not user-reachable.

## Session 4 priority — Gate 4 (canonical template) and Gate 5 (backend API)

Gate 3's re-scope freed a significant chunk of sprint-045 scope. Session
3 did NOT start Gate 4 in the same session as planned — push that to
session 4 and bundle it with Gate 5 backend wiring.

### Gate 4 — `GENERIC_HOSPITALITY_SEED.md` canonical template

Write `backend/src/build-tune-agent/templates/generic-hospitality-seed.md`
per spec §10. Twenty slots, inline guidance comments, `<!-- DEFAULT: change me -->`
markers. Target: fully-filled render = 1,500–2,500 tokens.

Hard constraint: the slot keys must match the 20 names that
`write_system_prompt` already validates against: `LOAD_BEARING_SLOTS` +
`NON_LOAD_BEARING_SLOTS` in `tools/write-system-prompt.ts`. Don't
rename slots here without updating that constant — the tool will
reject renders whose slots don't align.

Add a render-round-trip unit test: feed a fully-filled slot dictionary,
render, assert 1,500 ≤ tokens ≤ 2,500 (chars × 0.25 heuristic, like the
prefix-stability tests).

### Gate 5 — backend `/api/build/*` endpoints

- `controllers/build-controller.ts`:
  - `GET /api/build/tenant-state` → `TenantStateSummary` (spec §9).
    Needs a new `tenant-state.service.ts` that aggregates
    SopDefinition count, FaqEntry counts by scope, ToolDefinition
    custom count, property count, last BuildTransaction row.
  - `POST /api/build/turn` → runs a BUILD-mode `runTuningAgentTurn`
    with `mode: 'BUILD'` + `tenantState` + `interviewProgress`.
  - `POST /api/build/plan/:id/approve` → no-op record keeper;
    create_* tools flip tx to EXECUTING on first reference, so
    approval is UI-side state. Could be used to surface an
    `approvedByUserId` audit field — add one if the PR reviewer asks.
  - `POST /api/build/plan/:id/rollback` → calls `rollback` with
    transactionId. Already supported by the rollback tool from Gate 1.
- `routes/build.ts` — JWT-gated, tenant-scoped, `ENABLE_BUILD_MODE`
  env flag gates the whole route set.

## Gate 6 — frontend /build page

- Three-pane layout from `specs/045-build-mode/ui-mockup.html`.
- Use `frontend/components/tuning/tokens.ts` palette verbatim. Do NOT
  import the main app's blue theme.
- Tenant-state detection on mount per spec §"Tenant-state detection on
  mount". GREENFIELD / BROWNFIELD banner variants.
- `PlanChecklist` renders `data-build-plan` parts (already emitted by
  `plan_build_changes` from Gate 2).
- `PreviewResult` renders `data-test-pipeline-result` parts (emitted
  by `test_pipeline` from Gate 3). One card per run — reply,
  judgeScore, rationale, optional failureCategory tag, promptVersion.
  Visually distinguish score <0.7.

## Gate 7 — E2E + final wrap

- End-to-end flow: GREENFIELD tenant → interview → plan → approve →
  create × N → `test_pipeline('can I check out at 2pm?')` → green
  (reply references the tenant's late-checkout rule, judge score ≥0.7,
  non-empty rationale).
- PR description with cache metrics table, Langfuse trace URLs,
  V1/V3 memo links, changelog, and the MASTER_PLAN deferral note.

## Known divergences from spec (document with user before closing sprint)

See PROGRESS.md "Decisions made this sprint" section. Four items now:

1. **Cache breakpoints are automatic, not explicit.** SDK constraint;
   behaviour equivalent at 5-min TTL. Revisit if Langfuse shows
   sub-0.995 hit on mixed sessions.
2. **V1 live validation accepted via production traces.** Synthetic
   fallback at `validation/V1-live.ts` if prod data is ambiguous.
3. **tenant-config cache invalidation deferred to 60s TTL** on
   `write_system_prompt` and `create_tool_definition`. `test_pipeline`
   now has a `bypassCache` escape hatch so the BUILD manager's
   verification round sees fresh writes immediately; production hot
   path still uses the cache.
4. **Batch preview subsystem deferred to sprint 047+.** See
   MASTER_PLAN.md → Sprint 047+. `test_pipeline` (single-message) is
   the sprint-045 verification primitive.

## Open design questions for session 4

- **Interview-progress signal.** The BUILD system prompt already
  reads `<interview_progress>` from the dynamic suffix. Nothing yet
  populates `InterviewProgressSummary` server-side. Gate 5 needs to
  add a `tracker` service that reads `TuningMessage` history for the
  conversation and counts filled slots from agent-produced
  `data-slot-filled` parts (or infer from `plan_build_changes`
  rationales). Simpler: let the agent itself track it in `memory`
  under `session/{conversationId}/slot/{slotKey}` and derive the
  summary at turn-build time.
- **Rollback UX after `write_system_prompt`.** Rollback restores the
  prior AiConfigVersion's stored `config.systemPromptCoordinator` /
  `config.systemPromptScreening` into TenantAiConfig. The Gate-2
  write now stores both fields plus `slotValues` +
  `sourceTemplateVersion` in `AiConfigVersion.config`, so the rollback
  has everything it needs. Verify by reading an AiConfigVersion row
  from the DB after a BUILD session before enabling BUILD in prod.

## Hard constraints (still in force)

- Do not push commits without confirmation.
- Do not modify tables outside the BuildTransaction + 5 nullable FK
  columns already shipped.
- Do not add anything to `resolveAllowedTools('BUILD')` that isn't
  working end-to-end with a passing test.
- TUNE behaviour must remain intact at every commit. Run
  `JWT_SECRET=test OPENAI_API_KEY=sk-test npx tsx --test $(find src/build-tune-agent -name "*.test.ts")`
  before every commit.
- `ENABLE_BUILD_MODE` stays off. BUILD surface is still not user-
  reachable.
