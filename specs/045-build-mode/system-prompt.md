# Claude Code session prompt — sprint 045 (Build Mode, Ship 1+2)

Paste this into a fresh Claude Code session. It is intentionally
self-contained.

---

You are executing sprint 045 of the GuestPilot v2 repository. The goal is
to ship **Build mode** for the tuning agent — unified into a single
build+tune agent with mode addenda gated by UI context.

**This is a large, load-bearing sprint.** Read every spec reference in
full before writing any code. If you are unclear on a design decision,
stop and ask rather than guess — the spec is the source of truth, and
assumptions are expensive.

---

## Required reading (read all of these, in order, before any code)

1. `/CLAUDE.md` — project orientation (tech stack, services map, critical
   rules, AI pipeline flow).
2. `specs/045-build-mode/MASTER_PLAN.md` — vision, North-Star, sprint
   ladder. Orients why this sprint matters.
3. `specs/045-build-mode/spec.md` — the sprint spec. Authoritative source
   for scope, architecture decisions, file plan, acceptance criteria, and
   empirical validation tasks. Do not diverge from it without explicit
   sanction from the user (`ab.tawakol@gmail.com`).
4. `/sessions/charming-festive-babbage/mnt/uploads/BUILD + TUNE- architecture brief for a unified serviced-apartments agent.md` —
   the research brief the spec derives from. The spec is the tldr; the
   brief is the evidence. When the spec has a §-reference, look up the
   brief section for deeper reasoning.
5. `specs/045-build-mode/ui-mockup.html` — locked-in three-pane layout.
   The frontend must match the structure, palette, and component patterns
   shown here.
6. `backend/src/tuning-agent/system-prompt.ts` — current system-prompt
   assembler (sprint 10 ordering). You will modify this file
   substantially.
7. `backend/src/tuning-agent/tools/propose-suggestion.ts` — the tool
   implementation pattern. Mirror it for the 6 new tools.
8. `backend/src/tuning-agent/hooks/pre-tool-use.ts` — the hook pattern.
   Make surgical changes only.
9. `backend/prisma/schema.prisma` — for the schema changes in spec §15.
10. `frontend/components/tuning/tokens.ts` — the design palette. Use
    verbatim; do NOT import the main app's blue theme.

---

## Execution order (hard gates — do not skip)

### Gate 0: empirical validations (spec §V1-V3)

Before writing any production code, run the three empirical-validation
tasks from the spec.

1. **V1** — confirm `allowed_tools` per-request does NOT invalidate the
   `tools` array cache on Sonnet 4.6 via the Claude Agent SDK.
2. **V2** — A/B terminal-recap location: dynamic_suffix vs user-message
   `<system-reminder>`. Pick the winner.
3. **V3** — confirm `<!-- DEFAULT: change me -->` markers round-trip
   through the template renderer and land byte-identical in the persisted
   artifact.

Each validation produces a short memo at `specs/045-build-mode/validation/V<n>-result.md`.
Commit the memos. Update the spec's fallback notes if any validation
fails. DO NOT proceed to Gate 1 until all three are resolved.

### Gate 1: Ship 1 — architecture (invisible to users)

Order: rename → system prompt → tools array → hooks → runtime.

1. Rename `backend/src/tuning-agent/` → `backend/src/build-tune-agent/`.
   Leave a re-export shim at the old path for one sprint.
2. Modify `system-prompt.ts`:
   - Persona rewrite (mode-agnostic identity).
   - Principles surgery (move NO_FIX-as-default + edit-format to TUNE
     addendum; rename "anti-sycophancy" principle to "truthfulness over
     validation").
   - Add `<build_mode>` addendum block (per spec §6).
   - Add `<tune_mode>` addendum block (per spec §7).
   - Split `<critical_rules>` — universal → shared; fragment rule → TUNE;
     new BUILD rules → BUILD.
   - Add `<tenant_state>` dynamic-suffix block (BUILD only).
   - Add `<terminal_recap>` dynamic-suffix block, mode-selected, location
     per V2 winner.
3. Configure three cache breakpoints in the system-prompt assembly:
   breakpoint 1 on tools array, breakpoint 2 at end of shared system,
   breakpoint 3 at end of mode addendum. Use explicit
   `cache_control: { type: 'ephemeral' }` blocks in the request body —
   do not rely on automatic caching alone for a 3-breakpoint layout.
4. Add `BuildTransaction` table + `buildTransactionId` nullable foreign
   keys on SopVariant, FaqEntry, ToolDefinition, AiConfigVersion. Apply
   with `npx prisma db push`.
5. Extend `rollback` tool with `transactionId` parameter. Integration
   test the three-artifact rollback-by-transaction path.
6. Modify `runtime.ts`:
   - Accept `mode: 'BUILD'|'TUNE'` on `RunTurnInput`.
   - Assemble mode addendum accordingly.
   - Pass `allowed_tools` per spec §2 table.
   - If `ENABLE_BUILD_MODE` env is not set, BUILD mode requests return
     a disabled-banner data part and do not invoke the model.

Verify Gate 1 acceptance criteria from the spec before continuing.

### Gate 2: Ship 2 — 6 new tools

Order: simpler → complex. Each tool gets a unit-test file.

1. `create_sop` — writes a new SopDefinition + SopVariant (or
   SopPropertyOverride if propertyId present). Respects transactionId.
2. `create_faq` — writes a new FaqEntry (global or property-scoped).
3. `create_tool_definition` — writes a new ToolDefinition (custom
   webhook tool).
4. `write_system_prompt` — writes a new AiConfigVersion with the
   coordinator or screening prompt. Enforces ≤2,500 token cap; enforces
   coverage ≥0.7 + all 6 load-bearing slots non-default; requires
   explicit manager sanction.
5. `plan_build_changes` — creates a PLANNED BuildTransaction, emits a
   `data-build-plan` SSE part to the frontend for UI approval. Does NOT
   execute anything.
6. `preview_ai_response` — runs the tenant's production pipeline against
   test messages. See Gate 3 for the preview subsystem.

Every tool must include the full WHEN TO USE / WHEN NOT TO USE
description from spec §11. Copy the text verbatim — it's tuned for
dispatch discrimination against the other tools.

Every tool must log to Langfuse with the shared transactionId when
present (spec §14).

### Gate 3: Preview subsystem (for `preview_ai_response`)

This is the highest-leverage trust component. Get it right.

1. `preview/golden-set.ts` — 30 canonical hospitality messages covering
   the common request shapes (late checkout, wifi issue, booking change,
   noise complaint, damage report, cleaning request, check-in timing,
   amenity question, local recommendation, payment query, etc.). Each
   has a rubric expected-shape.
2. `preview/adversarial.ts` — generator that takes a newly-created SOP
   and produces 5-10 adversarial messages probing its constraints.
   Prompt template for the generator goes in this file.
3. `preview/judge-rubric.ts` — deterministic rubric. Pass conditions:
   reply mentions relevant SOP? includes escalation contact when
   appropriate? avoids banned phrases? respects channel constraints?
4. `preview/judge-opus.ts` — Opus 4.6 with a grading prompt. Uses
   randomized ordering to avoid position bias (Zheng et al.). NEVER
   Sonnet 4.6 grading Sonnet 4.6 output.
5. Wire `preview_ai_response` tool to run golden-set + adversarial,
   return structured scores. Failures surface via a `data-preview-failure`
   SSE part.

Acceptance: BUILD-graduated test tenant passes ≥0.85 on golden set.

### Gate 4: GENERIC_HOSPITALITY_SEED.md template

Write the canonical template per spec §10. Twenty slots, inline guidance
comments, default markers. Test that a full render produces 1,500-2,500
tokens. If it produces more, tighten.

This is not forked from the current v28 `SEED_COORDINATOR_PROMPT`. It's
written from scratch as a generic hospitality template.

### Gate 5: Backend API + /build route

1. `controllers/build-controller.ts` — endpoints:
   - `GET /api/build/tenant-state` → TenantStateSummary (spec §9).
   - `POST /api/build/turn` → runs a BUILD-mode runtime turn.
   - `POST /api/build/plan/:id/approve` → marks BuildTransaction as
     EXECUTING, allows subsequent create_* calls with this transactionId.
   - `POST /api/build/plan/:id/rollback` → calls rollback with transactionId.
2. `routes/build.ts` — route definitions, JWT-gated, tenant-scoped.
3. `ENABLE_BUILD_MODE` env flag gates the whole route set.

### Gate 6: Frontend /build page

1. `/frontend/app/build/page.tsx` + layout.
2. Three-pane layout matching `ui-mockup.html` structure. Use tuning
   palette (`components/tuning/tokens.ts`) — do NOT use main-app blue.
3. `TenantStateBanner` renders GREENFIELD or BROWNFIELD opening based on
   `/api/build/tenant-state`.
4. `ChatSurface` mirrors tuning chat: SSE streaming, tool-call cards,
   message bubbles. Copy/adapt from `frontend/components/tuning/*` —
   don't over-abstract.
5. `PlanChecklist` renders `data-build-plan` SSE parts with approve/reject
   buttons.
6. `PreviewResult` renders `data-preview-failure` + `data-preview-success`
   parts with confidence-gated failure disclosure (surface only failures,
   cap at 5, plain-language summaries).
7. Mobile: preview panel collapses behind a drawer (out of scope for
   polish this sprint, but don't break the layout).

### Gate 7: End-to-end test

Run the acceptance flow from spec's "Ship 2 visible feature" list:

GREENFIELD tenant → opens `/build` → interview fills all 6 load-bearing
slots via incident-based probes → `plan_build_changes` surfaces
approvable plan → approved → 3 SOPs + 2 FAQs + 1 `write_system_prompt`
complete under one transactionId → `preview_ai_response` runs on golden
set → results render in preview panel → 0 critical failures (≥0.85 pass
rate).

Capture the Langfuse trace. Attach to the PR description.

---

## Constraints and rules (non-negotiable)

1. **Constitution applies.** `/specify/memory/constitution.md` rules hold.
   Never break the main guest-messaging flow. Missing env vars degrade
   silently. AI output must be valid JSON where schemas enforce it. Never
   expose access codes to INQUIRY-status guests. Never commit secrets.

2. **No behavioural regression on /tuning.** Sprint-01-through-10 tests
   must continue to pass. The existing 10 tools must behave identically.
   If you need to change a tune tool, stop and ask.

3. **`npx prisma db push`** for schema changes, per constitution
   §Development Workflow. Do NOT create migration files.

4. **Branch:** `feat/045-build-mode`, branched off
   `feat/044-doc-handoff-whatsapp`. Main↔044 divergence is a separate
   problem; do not try to resolve it here.

5. **Feature flag:** `ENABLE_BUILD_MODE`, default off in all environments.
   Flip to on in staging only after Gate 7 passes and the preview loop's
   red-team rate is ≥0.85.

6. **No `git push` without asking.** Commit liberally; push when the user
   sanctions.

7. **No independent service extraction.** Monorepo only. Module boundary
   only — the `build-tune-agent` folder is the unit of future extraction
   if it ever happens.

8. **Tool descriptions are load-bearing.** Copy the WHEN TO USE / WHEN
   NOT TO USE text from the spec verbatim. The dispatch reliability of
   the whole agent depends on these discriminators.

9. **Judge ≠ generator, always.** `preview_ai_response` must not let the
   Sonnet 4.6 generator grade its own output. Opus 4.6 or the
   deterministic rubric. This is the Zheng et al. self-enhancement bias
   mitigation.

10. **User vocabulary discipline.** The manager sees "SOPs," "FAQs,"
    "system prompt," "tools" in the UI and in the agent's conversation.
    Do NOT abstract these into "policies," "answers," "personality."
    The agent explains what each is if asked.

11. **Ask the user before deleting or moving anything not explicitly in
    the file plan.** The module rename is the one big move; everything
    else is additive.

12. **Progress-log discipline.** Maintain `specs/045-build-mode/PROGRESS.md`
    with a section per gate, updated as you complete each gate. This is
    the handoff artifact for the next session.

---

## Stop and ask conditions

Stop execution and message the user (`ab.tawakol@gmail.com`) when:

- Any of V1/V2/V3 empirical validations fail and the spec fallback doesn't
  obviously apply.
- The Gate 1 cache-metrics acceptance (TUNE cache hit ≥0.998, mixed
  ≥0.995) is not being met and you've already tried adjusting breakpoint
  placement.
- The `preview_ai_response` rubric + Opus judge disagree on more than
  25% of cases. This means one of them is miscalibrated.
- You find an existing system behaviour that the spec assumes but which
  doesn't work as described (e.g. the sprint-10 cache boundary is not
  actually byte-identical turn-to-turn).
- A Prisma schema change would require a data migration on existing
  rows. The spec design says all new FKs are nullable — if something
  forces non-null, stop.

Do not silently diverge. The handoff cost of a wrong guess is higher
than the cost of a 30-second Slack message.

---

## Deliverables at session end

When all 7 gates are passed:

1. A PR on `feat/045-build-mode` targeting the current branch's base
   (likely still `feat/044-doc-handoff-whatsapp` — confirm before push).
2. PR description includes: cache-metrics table (TUNE, BUILD, mixed),
   Langfuse trace URLs for the Gate 7 end-to-end flow, V1/V2/V3 memo
   links, and a brief changelog.
3. `specs/045-build-mode/PROGRESS.md` with a completed section per gate
   and any open follow-ups.
4. `specs/045-build-mode/NEXT.md` — a short handoff doc for sprint 046,
   listing what was deferred and what the first 3 tasks of sprint 046
   should be (Ship 3 content from the research brief: `ONBOARDING_STATE.md`
   + `DECISIONS.md` + TUNE-side read path).

If the session runs out of context mid-sprint, update PROGRESS.md with
the current gate status before the session ends. Do not leave the branch
in an inconsistent state.
