# Sprint 045 — NEXT session handoff

> Owner: Abdelrahman (ab.tawakol@gmail.com)
> Branch: `feat/045-build-mode` (off `044-doc-handoff-whatsapp`)
> Session 1 closed: 2026-04-19, Gate 1 complete (architecture invisible
> to users). Session 2+ continues into Gate 2 onwards.

## Where session 1 left off

Gates 0 + 1 complete. TUNE behaviour is intact (13/13 system-prompt
tests pass; full 59-test build-tune-agent suite green). The agent is
now mode-aware (BUILD vs TUNE) but BUILD requests are gated off behind
`ENABLE_BUILD_MODE` and there are no BUILD tools registered yet, so
opening the existing `/tuning` surface still works exactly as before.

## Session 2 kickoff — unblock checklist

1. **Read this file + PROGRESS.md.** PROGRESS tracks gate-level status;
   this file says what to do next.
2. **Set `ANTHROPIC_API_KEY` in the shell** so V1 can run:
   `export ANTHROPIC_API_KEY=<key>` — then run V1 as the first task
   (spec §V1 procedure, ~$1).
3. **Decide the V1 test scaffold.** Cheapest: write
   `specs/045-build-mode/validation/V1-live.ts` as a standalone script
   that calls the Agent SDK's `query()` with a minimal MCP server of 4
   no-op tools, varies `allowedTools` between turns, and reads
   `cache_read_input_tokens` from each assistant message's usage field.
   The runtime already logs this (grep for `[TuningAgent] usage` in
   `runtime.ts`) — the validation script just needs to isolate the
   allowed_tools variable.
4. **Start Gate 2.** See the task ladder below.

## Gate 2 task ladder (this session's priority)

Order: simpler → complex. Each tool gets a unit-test file per spec.

1. `create_faq` — simplest. Writes a FaqEntry, respects transactionId.
   Pattern: mirror `propose_suggestion`'s shape but with a real DB
   insert. **Update `TUNING_AGENT_TOOL_NAMES` + `tools/index.ts`
   + `resolveAllowedTools()` in `runtime.ts`** as each tool lands.

2. `create_sop` — creates SopDefinition + SopVariant (or
   SopPropertyOverride if propertyId present). Check `@@unique` on
   `SopDefinition(tenantId, category)` — if a definition already exists
   for the category, reuse it and create a new variant.

3. `create_tool_definition` — writes a ToolDefinition with the
   webhook fields. Respect `@@unique(tenantId, name)`.

4. `write_system_prompt` — larger. Writes a new AiConfigVersion AND
   updates TenantAiConfig.systemPromptCoordinator or screening. Must
   enforce: ≤2,500 tokens, coverage ≥0.7 + all 6 load-bearing slots
   non-default (checked against `slotValues`), explicit manager
   sanction. Set `buildTransactionId` on the AiConfigVersion.

5. `plan_build_changes` — creates a BuildTransaction with status='PLANNED',
   emits a `data-build-plan` SSE part to the frontend. Does NOT execute
   anything.

6. `preview_ai_response` — biggest. Depends on Gate 3 (preview
   subsystem). Build in this order: golden-set → adversarial → rubric
   judge → opus judge → wire tool. See Gate 3 notes below.

### Tool registration

When each Gate 2 tool lands, update in this order:

- `backend/src/build-tune-agent/tools/names.ts` — add name constants.
- `backend/src/build-tune-agent/tools/index.ts` — register with MCP server.
- `backend/src/build-tune-agent/runtime.ts:resolveAllowedTools()` —
  add BUILD-path names to the BUILD allow-list, TUNE-available ones
  (plan/preview) to both lists.
- Unit test under `backend/src/build-tune-agent/tools/__tests__/`.

### Tool-description text

Copy the **WHEN TO USE / WHEN NOT TO USE** text for each tool verbatim
from spec §11. The dispatch reliability of the whole agent depends on
those discriminators — do not paraphrase. The `tools` XML block in
`system-prompt.ts` already summarises them; the actual tool description
goes on the `tool()` factory call.

## Gate 3 task ladder (preview subsystem)

Order: golden-set → adversarial → rubric → opus → wire.

1. `preview/golden-set.ts` — 30 canonical hospitality messages covering
   the common request shapes. Each has a rubric expected-shape.
2. `preview/adversarial.ts` — generator that takes a newly-created SOP
   and produces 5-10 adversarial messages probing its constraints.
3. `preview/judge-rubric.ts` — deterministic rubric: SOP mentioned?
   Escalation contact when appropriate? Banned phrases avoided?
   Channel constraints respected?
4. `preview/judge-opus.ts` — Opus 4.6 with a grading prompt. Uses
   randomized ordering to avoid position bias (Zheng et al.). **NEVER
   Sonnet 4.6 grading Sonnet 4.6 output.**
5. `preview_ai_response` tool — wire golden-set + adversarial, emit
   `data-preview-failure` SSE parts on failures.

## Gate 4 — canonical template

Write `backend/src/build-tune-agent/templates/generic-hospitality-seed.md`
per spec §10. Twenty slots, inline guidance comments, default markers.
Target: fully-filled render = 1,500–2,500 tokens.

## Gate 5 — backend API

- `controllers/build-controller.ts` with 4 endpoints per spec §"Backend
  file plan".
- `routes/build.ts` — JWT-gated, tenant-scoped, ENABLE_BUILD_MODE env flag.

## Gate 6 — frontend /build page

- Three-pane layout from `ui-mockup.html`.
- Use `frontend/components/tuning/tokens.ts` palette verbatim.
- Component list per spec §"Frontend file plan".

## Gate 7 — E2E + final wrap

- End-to-end flow: GREENFIELD tenant → interview → plan → approve →
  create × N → preview → green.
- PR description with cache metrics table, Langfuse trace URLs, V1/V3
  memo links, changelog.

## Known divergences from spec (document with user before closing sprint)

See PROGRESS.md "Decisions made this sprint" section. Two items:

1. **Cache breakpoints are automatic, not explicit.** SDK constraint;
   behaviour equivalent at 5-min TTL. Revisit if Langfuse shows
   sub-0.995 hit on mixed sessions.
2. **V1 live validation deferred.** Theoretical argument strong;
   deferred only on API-key access, not design doubt. Must run before
   BUILD flips on in staging.

## Open design question for next session

- **BUILD-mode rollback UX** when `write_system_prompt` was part of a
  plan. Current implementation restores the prior AiConfigVersion's
  stored `config.systemPromptCoordinator` / `config.systemPromptScreening`
  into TenantAiConfig. But AiConfigVersion's `config` field is `Json` —
  what exactly do sprint-10's writes put in there? If it's the full
  tenant-config snapshot, we're good. If it's only the *delta*, the
  rollback needs a different strategy. Verify by reading an
  AiConfigVersion row from prod before enabling BUILD.
