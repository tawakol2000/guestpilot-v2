# Sprint 045 — NEXT session handoff (session 6)

> Owner: Abdelrahman (ab.tawakol@gmail.com)
> Branch: `feat/045-build-mode` (off `044-doc-handoff-whatsapp`)
> Session 5 closed: 2026-04-20. Gate 6 (frontend `/build` page) shipped;
> BROWNFIELD + disabled states verified against the prod Railway DB
> with `ENABLE_BUILD_MODE=true` flipped on locally. TUNE intact.

## Where session 5 left off

Gates 0–6 complete. BUILD has a working UI behind `ENABLE_BUILD_MODE`.
What landed:

- `frontend/lib/build-api.ts` — typed fetch client for `/api/build/*`,
  with `BuildModeDisabledError` on 404 and wire-shape types for
  `data-build-plan` + `data-test-pipeline-result`.
- `frontend/components/build/*` — 8 components matching
  `ui-mockup.html` at ≥1280px widths. Palette verbatim from
  `components/tuning/tokens.ts` (no main-app blue).
- `frontend/app/build/{layout,page}.tsx` — SPA route at `/build` with
  auth gate, tenant-state bootstrap, `TuningConversation` reuse via URL
  param, and the 3-pane grid (56 / 288 / 1fr / 440).
- Backend deploy unblock: fixed a latent TS error in
  `build-tune-agent/tools/__tests__/test-pipeline.test.ts` that was
  causing `npm run build` to fail on Railway. Local `npx tsc --noEmit`
  on `/backend` is now green.

Smoke test against the prod Railway DB (tenant
`cmmth6d1r000a6bhlkb75ku4r`, 23 SOPs / 74 FAQs / 0 tools / 20
properties):

| # | Case | Status |
|---|------|--------|
| 1 | `/build` route returns 200 (no auth crash) | ✅ |
| 2 | BROWNFIELD banner + Setup Progress + Preview empty-state renders | ✅ |
| 3 | Unset `ENABLE_BUILD_MODE` → BuildDisabled "lock" screen | ✅ |
| 4 | GREENFIELD banner copy | ⏸️ code-verified only, wet test deferred to Gate 7 |
| 5 | `/api/build/turn` SSE round-trip (plan → approve → test_pipeline) | ⏸️ Gate 7 |

`ENABLE_BUILD_MODE` reverted to unset in `backend/.env` before the
session close. BUILD surface unreachable in prod until staging rollout.

## Session 6 priority — Gate 7 (end-to-end + final wrap)

Per spec §"Acceptance criteria" Ship 2:

### Gate 7.1 — Fresh GREENFIELD walk-through

1. Create a clean test tenant (no SOPs, no global FAQs, no custom tools,
   ≥1 property imported from Hostaway). Fastest path: use the existing
   `backend/scripts/` pattern or mint a tenant directly in Prisma.
2. Log in to `/build` on the clean tenant. Confirm the GREENFIELD
   banner + hero copy renders.
3. Drive the interview through all 6 load-bearing slots
   (`property_identity`, `checkin_time`, `checkout_time`,
   `escalation_contact`, `payment_policy`, `brand_voice`) via
   incident-based probes. Confirm each confirmed slot fires
   `memory.create` with key `session/{conv}/slot/{slotKey}` (inspect
   via Langfuse trace or Prisma `AgentMemory` table directly).
4. Expect `plan_build_changes` to emit `data-build-plan` after the 6
   slots land — verify the PlanChecklist renders with 3 SOPs + 2 FAQs
   + 1 `write_system_prompt` under one `transactionId`.
5. Click **Approve plan**. Confirm the approve endpoint records
   `approvedByUserId` + `approvedAt`; confirm the agent's follow-up
   create_* calls actually write under the same `transactionId`.
6. `test_pipeline('can I check out at 2pm?')` renders a
   `data-test-pipeline-result` card in the right preview pane with
   reply, judge score ≥ 0.7, non-empty rationale.
7. Click **Roll back**. Confirm the three artifact classes revert
   (cross-check via `getTenantStateSummary` + the rollback tool's
   structured output).

### Gate 7.2 — Cache metrics + Langfuse attachment

- Drive a few TUNE-only, BUILD-only, and mixed sessions with
  `ENABLE_BUILD_MODE=true` in staging. Read the Langfuse
  `claude.prompt.cacheRead` / `cacheWrite` counters on the
  tools-array, shared, and addendum regions. Target per the spec: TUNE
  ≥ 0.998, mixed ≥ 0.995. If not hit, revisit the Gate 1 "Cache
  breakpoints" decision (automatic prefix caching vs explicit
  cache_control).
- If the cache-hit ratio is below target, that's the one Gate 1
  decision worth reopening in sprint 046 — not a Gate 7 blocker unless
  it's <0.95 on mixed sessions.

### Gate 7.3 — PR wrap

Open a PR on `feat/045-build-mode` targeting
`feat/044-doc-handoff-whatsapp` (confirm base with `gh pr view` /
`git log` before push). Description includes:

- Cache-metrics table (TUNE / BUILD / mixed, each row = read count +
  hit ratio + sample count).
- Langfuse trace URLs for the Gate 7.1 end-to-end flow.
- V1 / V3 memo links (`specs/045-build-mode/validation/`).
- Brief changelog per gate (0 through 7).
- MASTER_PLAN deferral note (batch-preview subsystem → sprint 047+).
- Screenshots from `specs/045-build-mode/screenshots/` — the
  BROWNFIELD 3-pane render was already captured in session 5; add
  GREENFIELD + a mid-interview + a plan-approved state during Gate 7.1
  execution.

## Open design questions for session 6

- **Slot-persistence proof.** Instrument a session with Langfuse and
  verify `memory.create` is actually being called with the
  `session/{conv}/slot/{key}` shape. If the instruction is being
  ignored at rate >10%, tighten the BUILD addendum in
  `system-prompt.ts` (`Gate 1` module). The rest of the UI assumes the
  agent is following this instruction.

- **Approve-then-execute gating.** Still undecided (carried from
  session 4 NEXT.md). The current UI approves by recording
  `approvedByUserId` + `approvedAt` and relies on the agent's BUILD
  addendum ("wait for approval before executing") to honor the gate.
  The stricter alternative is to gate the SSE stream on server side:
  reject follow-up `create_*` calls on a PLANNED transaction whose
  `approvedAt` is null. Decide during Gate 7.1 execution — if the
  agent happily runs past the approval step with today's rule, flip to
  the server-side gate. Probably ok for pilot, required for public
  beta.

- **Transaction history pagination.** `TransactionHistory` shows only
  the most recent transaction (`tenantState.lastBuildTransaction`).
  Listing more requires a new backend endpoint. Add to the sprint 046
  backlog — not load-bearing for the pilot.

- **Tenant-state aggregator caching.** Still open from session 4.
  `getTenantStateSummary` fires 6 `count` queries in parallel per
  BUILD turn. Add a 30s in-memory cache before the public beta.

## Hard constraints (still in force)

- Do not push commits without confirmation.
- Do not modify Prisma tables outside what's already shipped
  (BuildTransaction + 5 nullable FK columns + the 2 audit columns
  added in session 4).
- `ENABLE_BUILD_MODE` stays off in `.env.example` and any production
  config defaults. Flip on locally / in staging only.
- TUNE behaviour must remain intact at every commit. Run
  `JWT_SECRET=test OPENAI_API_KEY=sk-test npx tsx --test $(find src/build-tune-agent -name "*.test.ts")`
  before every commit.
- Frontend must keep using `components/tuning/tokens.ts` verbatim —
  do not import the main-app blue palette.
- Do not add SSE part types beyond `data-build-plan` +
  `data-test-pipeline-result` (+ the existing TUNE parts) without
  backend changes and an updated spec §11.
