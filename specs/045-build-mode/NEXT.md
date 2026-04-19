# Sprint 045 — NEXT session handoff (session 5)

> Owner: Abdelrahman (ab.tawakol@gmail.com)
> Branch: `feat/045-build-mode` (off `044-doc-handoff-whatsapp`)
> Session 4 closed: 2026-04-20. Gate 4 (canonical template) + Gate 5
> (backend `/api/build/*`) shipped, both green, TUNE intact.

## Where session 4 left off

Gates 0–5 complete. Backend BUILD surface is feature-complete and
hidden behind the `ENABLE_BUILD_MODE` env gate. What landed:

- `backend/src/build-tune-agent/templates/generic-hospitality-seed.md`
  — 20-slot canonical template, fully-filled render baseline 2,494
  tokens / 9,976 chars / version stamp `seed-v1-ba207591dda8c8bc`.
- `backend/src/build-tune-agent/templates/index.ts` — exports
  `GENERIC_HOSPITALITY_SEED`, `GENERIC_HOSPITALITY_SEED_VERSION`,
  `loadSeed()`, `renderSeed(slotValues)`. Slot keys match the
  LOAD_BEARING_SLOTS + NON_LOAD_BEARING_SLOTS constants in
  `tools/write-system-prompt.ts`; the alignment is locked by
  `__tests__/template.test.ts`.
- `backend/src/services/tenant-state.service.ts` —
  `getTenantStateSummary(tenantId)` returns the spec §9
  TenantStateSummary; `getInterviewProgressSummary(tenantId,
  conversationId)` derives slot fills from agent memory under
  `session/{conversationId}/slot/`.
- `backend/src/controllers/build-controller.ts` — 4 handlers:
  `tenantState`, `turn` (SSE via `runTuningAgentTurn` with
  `mode: 'BUILD'` + tenantState + interviewProgress), `approvePlan`
  (records `approvedByUserId` + `approvedAt`, idempotent), `rollbackPlan`
  (calls the rollback tool's transaction-mode path directly via the
  same stub-tool pattern used in integration tests).
- `backend/src/routes/build.ts` — Express router mounted at `/api/build`
  in `app.ts`. Gates the entire route family with a 404 when
  ENABLE_BUILD_MODE is unset (404 BEFORE auth so unauthenticated
  probes can't infer the route exists).
- Schema: `BuildTransaction` gained `approvedByUserId String?` +
  `approvedAt DateTime?`. Pushed via `npx prisma db push` to the
  Railway DB. No data migration; both columns are nullable.
- `system-prompt.ts` BUILD addendum: explicit slot-persistence rule
  (memory key `session/{conversationId}/slot/{slotKey}`) so the
  interview-progress widget has a single source of truth.

Tests: `__tests__/template.test.ts` 9/9 green. Full build-tune-agent
suite 125/125 green (was 116). Integration suite
`build-controller.integration.test.ts` 5/5 green:

| # | Case | Status |
|---|------|--------|
| 1 | GREENFIELD tenant → `isGreenfield: true` | ✅ |
| 2 | One SOP seeded → `isGreenfield: false` | ✅ |
| 3 | POST /turn without ENABLE_BUILD_MODE → 404 | ✅ |
| 4 | POST /turn with ENABLE_BUILD_MODE=true → 200 SSE | ✅ |
| 5 | POST /plan/:id/rollback → reverts artifacts | ✅ |

`ENABLE_BUILD_MODE` stays off. BUILD surface remains unreachable in
prod.

## Session 5 priority — Gate 6 (frontend) + Gate 7 (E2E)

### Gate 6 — Frontend `/build` page

Per spec §"Frontend file plan" + `ui-mockup.html`:

- `frontend/app/build/page.tsx` + `frontend/app/build/layout.tsx`.
- 3-pane layout: 56px activity bar / 288px left rail / flex chat /
  440px preview panel. Mobile: preview collapses behind a drawer
  (don't break the layout but full polish is out of scope).
- Use `frontend/components/tuning/tokens.ts` palette verbatim — purple
  accent (#6C5CE7), category pastels. Do NOT import the main app's
  blue theme.
- New components in `frontend/components/build/`:
  - `chat-surface.tsx` — center column. Reuse / adapt
    `frontend/components/tuning/chat-surface.tsx`. SSE streaming via
    `useChat` posting to `/api/build/turn`.
  - `activity-bar.tsx`, `left-rail.tsx`, `preview-panel.tsx` —
    layout shells.
  - `plan-checklist.tsx` — renders `data-build-plan` SSE parts
    (already emitted by `plan_build_changes` from Gate 2). Hits
    `POST /api/build/plan/:id/approve` + `POST /api/build/plan/:id/rollback`.
  - `preview-result.tsx` — renders `data-test-pipeline-result` SSE
    parts (emitted by `test_pipeline` from Gate 3). One card per
    run: `reply`, `judgeScore`, `judgeRationale`, optional
    `judgeFailureCategory` tag, `judgePromptVersion`. Score < 0.7
    gets a visually distinct (warning-colored) treatment.
  - `tenant-state-banner.tsx` — fetches
    `GET /api/build/tenant-state` on mount, renders GREENFIELD or
    BROWNFIELD opening copy per spec §"Tenant-state detection on
    mount". Placeholder text: GREENFIELD "Tell me about your
    properties..." / BROWNFIELD "What do you want to build or change?"
  - `tokens.ts` — re-export of tuning tokens.
- `frontend/lib/build-api.ts` — fetch client for `/api/build/*`.
  Mirror `frontend/lib/tuning-api.ts` if it exists.

Gate 6 acceptance:
- `/build` renders a 3-pane shell that matches `ui-mockup.html`.
- Tenant-state banner switches between GREENFIELD and BROWNFIELD
  copy based on the API response.
- Sending a message hits `/api/build/turn`, streams SSE, renders
  bubbles + tool-call cards + `data-build-plan` plan checklist +
  `data-test-pipeline-result` preview cards.
- Approve + rollback buttons on the plan checklist call the right
  endpoints and round-trip the UI correctly.

### Gate 7 — End-to-end + final wrap

Per spec §"Acceptance criteria" Ship 2:

End-to-end flow on a fresh GREENFIELD test tenant:
1. Open `/build` → banner shows GREENFIELD copy.
2. Interview fills all 6 load-bearing slots via incident-based
   probes. Each confirmed slot → `memory.create` on the agent side
   under `session/{conv}/slot/{key}`.
3. `plan_build_changes` surfaces an approvable plan in the UI.
4. Manager approves → 3 SOPs + 2 FAQs + 1 `write_system_prompt`
   complete under one `transactionId`.
5. `test_pipeline('can I check out at 2pm?')` returns reply that
   references the tenant's late-checkout rule, judge score ≥ 0.7,
   non-empty rationale.
6. Capture Langfuse trace, attach to PR description.

PR description deliverables (per spec):
- Cache metrics table (TUNE, BUILD, mixed).
- Langfuse trace URLs for the Gate 7 end-to-end flow.
- V1/V3 memo links.
- Brief changelog.
- MASTER_PLAN deferral note (batch-preview subsystem → sprint 047+).

## Open design questions for session 5

- **Slot-persistence proof.** Before opening a paying tenant on
  BUILD, run a Langfuse-instrumented session and verify the agent
  is actually calling `memory.create` with the
  `session/{conv}/slot/{key}` key shape. The BUILD addendum
  instructs it; spot-check that the instruction is being followed.
  If hit rate < 90%, tighten the addendum wording.
- **Tenant-state aggregator runtime cost.** `getTenantStateSummary`
  fires 6 `count` queries in parallel per BUILD turn. Fine for the
  pilot but will want a 30s in-memory cache before the public beta.
  Out of scope for session 5; flag for sprint 046.
- **Approve-then-execute UX.** The `approvePlan` endpoint is a
  no-op record-keeper today (it sets `approvedByUserId` +
  `approvedAt` and that's it). The `validateBuildTransaction`
  helper called by every `create_*` tool flips status to EXECUTING
  on first artifact write. Decide in Gate 6 whether the frontend
  should require approval BEFORE letting the agent send subsequent
  create_* calls (gate the SSE), or rely on the agent's BUILD
  addendum instruction "wait for approval before executing." The
  former is safer; the latter matches the current shipped flow.

## Hard constraints (still in force)

- Do not push commits without confirmation.
- Do not modify Prisma tables outside what's already shipped
  (BuildTransaction + 5 nullable FK columns + the 2 audit columns
  added in session 4).
- Do not add anything to `resolveAllowedTools('BUILD')` that isn't
  working end-to-end with a passing test.
- TUNE behaviour must remain intact at every commit. Run
  `JWT_SECRET=test OPENAI_API_KEY=sk-test npx tsx --test $(find src/build-tune-agent -name "*.test.ts")`
  before every commit.
- `ENABLE_BUILD_MODE` stays off in `.env.example` and any config
  defaults. Flip locally for testing only; revert before commit.
- Frontend Gate 6 is allowed to import from `lib/build-api.ts` and
  `components/tuning/tokens.ts`. Do NOT pull in main-app blue
  theming.
