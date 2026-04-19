# Sprint 045 — NEXT session handoff (session 3)

> Owner: Abdelrahman (ab.tawakol@gmail.com)
> Branch: `feat/045-build-mode` (off `044-doc-handoff-whatsapp`)
> Session 2 closed: 2026-04-19, Gate 2 complete (5/5 tools shipped;
> `preview_ai_response` re-scoped into Gate 3 per session-1 NEXT.md).

## Where session 2 left off

Gates 0, 1, and 2 complete. All five Gate-2 tools shipped with unit
tests and registered end-to-end:

- `create_faq` — FaqEntry writer, global / property scope, tx-aware.
- `create_sop` — SopDefinition upsert + SopVariant or SopPropertyOverride,
  kebab-case category validation, duplicate rejection.
- `create_tool_definition` — custom webhook tool, snake_case name +
  https URL + non-empty availableStatuses.
- `write_system_prompt` — graduation-gate write (coverage ≥0.7,
  6 load-bearing non-default, managerSanctioned), AiConfigVersion
  snapshot with buildTransactionId.
- `plan_build_changes` — PLANNED BuildTransaction + data-build-plan
  SSE part; does NOT execute any writes.

TUNE allow-list in `resolveAllowedTools()` is now enumerated explicitly,
so BUILD create_* tools are unreachable in TUNE mode even though they
sit in the same cached `tools` array. TUNE behaviour is untouched at
commit boundaries: full build-tune-agent test suite 95/95 green.

Prefix-stability regression guard ships alongside the tools:
`__tests__/prompt-cache-stability.test.ts`. Baseline token counts
recorded in PROGRESS.md under "Decisions". If the numbers drift ≥10%
or the byte-identity assertions fail, something injected drift into
the shared system section.

`ENABLE_BUILD_MODE` is still off. BUILD surface is not user-reachable.

## Session 3 kickoff — unblock checklist

1. **Read this file + PROGRESS.md.** PROGRESS tracks gate-level status
   and carries the three decisions documented to date (cache_control,
   V1 deferral, tenant-config invalidation deferral).
2. **Set `ANTHROPIC_API_KEY` in the shell** so V1 can run:
   `export ANTHROPIC_API_KEY=<key>` — then run V1 as the first task
   (spec §V1 procedure, ~$1). V1 remains ⏸️ deferred because session 2
   did not have the key. The theoretical argument is strong (the SDK's
   `allowedTools` is a client-side filter — it doesn't alter outbound
   request bytes, so the cached `tools` array should stay warm across
   mode switches). Live verification is a gate for turning BUILD on in
   staging.
3. **Start Gate 3.** See the task ladder below.

## Gate 3 task ladder (this session's priority)

Order: golden-set → adversarial → rubric → opus → wire tool.
`preview_ai_response` is registered in `tools/index.ts` +
`resolveAllowedTools('BUILD')` ONLY at the end of this gate, once all
four dependencies are landing green. Do not add it to the allow-list
before that — a dispatchable but non-functional tool is worse than no
tool.

1. `preview/golden-set.ts` — 30 canonical hospitality messages covering
   common request shapes (late checkout, wifi issue, booking change,
   noise complaint, damage report, cleaning request, check-in timing,
   amenity question, local recommendation, payment query, …). Each
   row: `{ id, guestPersona, message, expectedShape }` where
   expectedShape is a free-text rubric hint (e.g. "should reference
   late-checkout SOP and quote an hour").

2. `preview/adversarial.ts` — generator that takes a newly-created SOP
   (body + triggers) and produces 5–10 adversarial messages probing
   its constraints. Prompt template for the generator goes in this
   file; call through gpt-5.4-mini for consistency with the main
   pipeline. Deterministic seeding when possible so repeated runs
   return the same adversarials and the judge's bias check (§14) has
   a stable comparison set.

3. `preview/judge-rubric.ts` — deterministic rubric. Pass conditions:
   - Reply mentions relevant SOP (use substring match against the
     SOP's `triggers` or `title`).
   - Includes an escalation contact when message has escalation signal
     (reuse `escalation-enrichment.service.ts`).
   - Avoids banned phrases from tenant memory (`memory` tool, key
     prefix `preferences/banned-phrase/`).
   - Respects channel constraints (Airbnb → plaintext, no markdown).
   Return `{ pass: bool, ruleResults: Array<{ rule, pass, detail }> }`.

4. `preview/judge-opus.ts` — Opus 4.6 with a grading prompt. Use
   randomized ordering to avoid position bias (Zheng et al.). **NEVER
   Sonnet 4.6 grading Sonnet 4.6 output.** Keep the grading prompt in
   this file; version-stamp it so future prompt edits don't silently
   re-score old runs. The prompt input is the {golden-set message,
   reply}; the output is `{ score: 0..1, rationale: string,
   failureCategory?: string }`.

5. `preview_ai_response` tool — wire golden-set + adversarial, return
   structured scores. Failures surface via a `data-preview-failure`
   SSE part. Accept the spec §11 params verbatim. The tool runs the
   tenant's production pipeline (import `generateAndSendAiReply` or an
   equivalent dry-run variant from `ai.service.ts`). If that's not
   feasible to call from BUILD without duplicating logic, extract a
   shared `runAiReplyPreview(tenantId, message)` into ai.service.

   Implementation note: the tool description says "Do NOT use more
   than once per BUILD turn without new context — results will be
   identical." Enforce this in the tool by tracking a `hasRunThisTurn`
   flag in ToolContext and returning an error on the second call.
   (Cheap guardrail; prevents budget burn.)

Acceptance: BUILD-graduated test tenant passes ≥0.85 on golden set,
per spec §Ship 2 red-team quality bar.

### Tool registration (when Gate 3 lands)

- `backend/src/build-tune-agent/tools/names.ts` — add `preview_ai_response`.
- `backend/src/build-tune-agent/tools/index.ts` — register with MCP server.
- `backend/src/build-tune-agent/runtime.ts:resolveAllowedTools()` —
  add to BOTH the BUILD list and the TUNE list (callable in both modes
  per spec §2).
- Unit test covering golden-set pass path + adversarial failure path.
- Spec §11 WHEN TO USE / WHEN NOT TO USE text copied verbatim onto the
  `tool()` factory call.

## Gate 4 — canonical template

Write `backend/src/build-tune-agent/templates/generic-hospitality-seed.md`
per spec §10. Twenty slots, inline guidance comments, default markers.
Target: fully-filled render = 1,500–2,500 tokens.

The slot keys must match the 20 names `write_system_prompt` already
validates against: `LOAD_BEARING_SLOTS` + `NON_LOAD_BEARING_SLOTS` in
`tools/write-system-prompt.ts`. Don't rename slots here without
updating that constant — the tool will reject renders whose slots
don't align.

## Gate 5 — backend API

- `controllers/build-controller.ts` with 4 endpoints per spec §"Backend
  file plan":
  - `GET /api/build/tenant-state` → `TenantStateSummary` (spec §9).
    Needs a new `tenant-state.service.ts` that aggregates
    SopDefinition count, FaqEntry counts by scope, ToolDefinition
    custom count, property count, last BuildTransaction row.
  - `POST /api/build/turn` → runs a BUILD-mode `runTuningAgentTurn`
    with `mode: 'BUILD'` + `tenantState` + `interviewProgress`.
  - `POST /api/build/plan/:id/approve` → no-op record keeper;
    create_* tools flip the tx to EXECUTING on first reference, so
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
- `PreviewResult` renders `data-preview-failure` / `data-preview-success`
  parts (emitted by `preview_ai_response` once Gate 3 ships).

## Gate 7 — E2E + final wrap

- End-to-end flow: GREENFIELD tenant → interview → plan → approve →
  create × N → preview → green.
- PR description with cache metrics table, Langfuse trace URLs, V1/V3
  memo links, changelog.

## Known divergences from spec (document with user before closing sprint)

See PROGRESS.md "Decisions made this sprint" section. Three items:

1. **Cache breakpoints are automatic, not explicit.** SDK constraint;
   behaviour equivalent at 5-min TTL. Revisit if Langfuse shows
   sub-0.995 hit on mixed sessions.
2. **V1 live validation deferred.** Theoretical argument strong;
   deferred only on API-key access, not design doubt. Must run before
   BUILD flips on in staging.
3. **tenant-config cache invalidation deferred to 60s TTL** on
   `write_system_prompt` and `create_tool_definition`. ai.service +
   OpenAI init is a heavier dependency than BUILD tools should pull.
   Sprint 046 should extract `invalidateTenantConfigCache` into a
   leaner module; meanwhile, new system prompts propagate after ≤60s.

## Open design questions for session 3

- **preview_ai_response cost budget.** A 30-golden-set + 5–10 adversarial
  run through gpt-5.4-mini + Opus 4.6 judge is non-trivial. Add a
  per-tenant daily cap (e.g. 20 runs/day) in the tool. Land the cap
  in Gate 3, not later — the tool is a dispatchable cost sink.
- **BUILD-mode rollback UX** when `write_system_prompt` was part of a
  plan. Rollback restores the prior AiConfigVersion's stored
  `config.systemPromptCoordinator` / `config.systemPromptScreening`
  into TenantAiConfig. The Gate-2 write now stores both fields plus
  `slotValues` + `sourceTemplateVersion` in `AiConfigVersion.config`,
  so the rollback has everything it needs. Verify by reading an
  AiConfigVersion row from the DB after a BUILD session before
  enabling BUILD in prod.
- **Interview-progress signal.** The BUILD system prompt already
  reads `<interview_progress>` from the dynamic suffix. Nothing yet
  populates `InterviewProgressSummary` server-side. Gate 5 needs to
  add a `tracker` service that reads `TuningMessage` history for the
  conversation and counts filled slots from agent-produced
  `data-slot-filled` parts (or infer from `plan_build_changes`
  rationales). Simpler: let the agent itself track it in `memory`
  under `session/{conversationId}/slot/{slotKey}` and derive the
  summary at turn-build time.

## Hard constraints (still in force)

- Do not push commits without confirmation.
- Do not modify tables outside the BuildTransaction + 5 nullable FK
  columns already shipped.
- Do not add anything to `resolveAllowedTools('BUILD')` that isn't
  working end-to-end with a passing test.
- TUNE behaviour must remain intact at every commit. Run
  `npx tsx --test $(find src/build-tune-agent -name "*.test.ts")`
  before every commit.
- `ENABLE_BUILD_MODE` stays off. BUILD surface is still not user-
  reachable.
