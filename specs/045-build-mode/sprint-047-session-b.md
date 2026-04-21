# Sprint 047 — Session B: Observability + cleanup

> Second session of sprint 047. Theme: finish the observability story
> started in sprint 046 Session A (BuildToolCallLog) and clear out
> the housekeeping items that have been deferred since Session D.
>
> Owner: Abdelrahman. Branch: `feat/047-session-b` — cut off the
> merged-to-main base once Session A's staging smoke passes. See
> §0.1 pre-flight.

---

## 0. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md)
2. [`sprint-047-session-a.md`](./sprint-047-session-a.md) — the
   previous session's scope. You need to know what shipped so you
   don't undo a bug-fix by accident.
3. [`validation/sprint-047-session-a-staging-smoke.md`](./validation/sprint-047-session-a-staging-smoke.md)
   — must be `Status: ✅ PASSED` before you cut the branch.
4. [`NEXT.md`](./NEXT.md) — sprint 047 backlog. §1.1 and §1.2 are
   the source-of-truth for this session's scope.
5. [`sprint-046-plan.md`](./sprint-046-plan.md) §4.5 — the
   `BuildToolCallLog` admin trace view spec (D9 deferred from sprint
   046). You are implementing this.

Then the code you'll touch:

- `backend/src/controllers/build-controller.ts` — add the new
  `GET /api/build/traces` handler.
- `backend/src/routes/build.routes.ts` (or wherever build routes
  live — check the controller's mount point).
- `backend/src/services/build-tool-call-log.service.ts` — add the
  retention sweep + the new query helper for traces.
- `backend/src/middleware/auth.ts` — look up how role-gating is
  done today; you'll need an admin-only guard.
- `frontend/components/studio/studio-surface.tsx` — the right-rail
  gear menu lives here.
- `frontend/app/build/page.tsx`, `frontend/app/tuning/page.tsx`,
  `frontend/app/tuning/agent/page.tsx` — the three redirect stubs
  to delete.
- `backend/package.json` — check for vitest/jest; if missing, scoped
  addition for the frontend harness (S2 below).

---

## 0.1 Pre-flight — staging smoke gate

**This session is blocked** until
[`validation/sprint-047-session-a-staging-smoke.md`](./validation/sprint-047-session-a-staging-smoke.md)
is marked `Status: ✅ PASSED` with the deploy commit sha recorded at
the bottom of the file.

If the smoke hasn't run yet, stop. Surface to Abdelrahman. The
Session A changes (Studio-origin accept path, BUILD-write advisory,
the nullable `sourceMessageId`) all need real-tenant click-through
coverage before new work lands on top.

If any of the four checks failed, stop. File the failing check as
an issue on `feat/047-session-a` and fix there, not here.

---

## 1. Context — why this session exists

Sprint 046 Session A landed `BuildToolCallLog` as a backend-only
trace store. Every tool call the agent makes in a BUILD or TUNE
turn writes a row with tenant, conversation, turn, tool, params,
duration, success, and any error. Nothing reads these rows yet.

Plan §4.5 scoped a read-only admin drawer that lets operators debug
agent behaviour in production: "why did the agent propose that fix"
becomes answerable without SSH'ing into Railway. This was
deferred at sprint 046 Session D because it's a net-new feature
surface and Session D was already a cleanup sprint.

Alongside that, the same Session A added `BuildToolCallLog` without
a retention policy. Rows accumulate forever. A 30-day sweep was
filed as a deferred item; it's small enough to belong in the same
session as the trace view (same table, same service).

Finally, three redirect stubs (`/build`, `/tuning`, `/tuning/agent`)
have been shipping a 302 courtesy redirect since Session C. The
courtesy period expired at sprint 046 close. They can go.

One more item surfaced from Session A's own caveats: the frontend
has no test harness. S5's wiring in Session A ships `tsc`-verified
but not unit-covered. Bringing up vitest for `frontend/components/`
is small, foundational, and unblocks a lot of follow-on sessions.

Scope is four items. Nothing here changes agent behaviour — it's a
tools + cleanup session.

---

## 2. Scope — in this session

### 2.1 Frontend test harness

**Files:** `frontend/package.json`, `frontend/vitest.config.ts` (new),
`frontend/components/studio/__tests__/audit-report.test.tsx` (new).

Stand up vitest with `@testing-library/react` for Next.js 16 + React
19. Keep it minimal — one test file exercising the Session A S5
wiring so we have a working reference.

**Setup steps.**
1. `cd frontend && npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react`
2. Create `vitest.config.ts` with the `jsdom` environment and the
   standard React plugin. Mirror the backend's `vitest.config` shape
   if one exists; otherwise use the vitest + React Next.js 16
   defaults.
3. Add a `test` script to `frontend/package.json`:
   `"test": "vitest run"`, `"test:watch": "vitest"`.
4. Create the first test: mount `<AuditReportCard>` with three rows
   (one top finding + two non-top), click the second row's View
   button, assert a passed-in `onViewRow` spy received the expected
   row.
5. Run `npm test` from `frontend/` — must pass.

**Out of scope for this harness.** Component tests for every Studio
card. The goal is the harness + one reference test. Follow-on
sessions can back-fill coverage as they touch each card.

**Acceptance.** `npm test` in `frontend/` green. CI does not yet
run it — that's a separate concern for whoever owns the Vercel
config.

### 2.2 Admin-only `BuildToolCallLog` trace view — backend

**Plan reference:** §4.5. **NEXT.md reference:** §1.1 first bullet.

**Env flag.**
- Add `ENABLE_BUILD_TRACE_VIEW` (separate from `ENABLE_BUILD_MODE`
  so tenant admins can't see raw tool calls by accident). Default
  off. Read via the existing `config/` module pattern — mirror how
  `ENABLE_BUILD_MODE` is loaded.

**Endpoint.** `GET /api/build/traces?limit=&cursor=&tool=&turn=`

- `limit` — optional, default 50, max 200.
- `cursor` — opaque id-based cursor (use the row `id`; cursor is
  `id <= cursorId`, order by `createdAt DESC, id DESC`).
- `tool` — optional exact-match filter.
- `turn` — optional integer filter.
- Scoped to the requester's tenant. Never cross-tenant.

**Response shape:**
```ts
{
  rows: Array<{
    id: string
    conversationId: string
    turn: number
    tool: string
    paramsHash: string
    durationMs: number
    success: boolean
    errorMessage: string | null
    createdAt: string  // ISO
  }>
  nextCursor: string | null
}
```

**Auth gate.** Two layers:
1. `ENABLE_BUILD_TRACE_VIEW !== 'true'` → 404 (not 403 — don't even
   signal the endpoint exists).
2. Requester role must be `admin` or equivalent. Check the existing
   middleware; if there's no admin role today, add one as a boolean
   `isAdmin` column on the User model (prisma db push) with a
   default of false. This is out of scope to populate broadly —
   flip it manually for Abdelrahman on staging + production.

**Tests.**
- Unit: controller returns 404 when the env flag is off.
- Unit: controller returns 403 for non-admin user.
- Integration: with flag on + admin user, returns rows scoped to
  tenant, paginated, filterable by tool + turn.
- Unit: cursor round-trip — fetch page 1, fetch page 2 with the
  returned cursor, assert no overlap + rows cover the full set.

**Acceptance.** `npm test -- build-controller` + `-- trace` green.
Manual smoke from a curl against staging once the flag is flipped:
`curl -H "Authorization: Bearer $JWT" 'https://<staging>/api/build/traces?limit=5'`.

### 2.3 Admin trace drawer — frontend

**Files:** `frontend/components/studio/trace-drawer.tsx` (new),
`frontend/components/studio/studio-surface.tsx` (edit — add the
right-rail gear menu entry).

**UX contract.**
- Gear icon in the Studio right-rail footer (already present?
  verify — if not, add one). Opens a right-side drawer, same style
  as existing Studio cards.
- Drawer header: "Agent trace" + a close button.
- Body: a scrollable list of `BuildToolCallLog` rows for the
  current conversation only. Columns: turn, tool, duration,
  success dot, expandable row for `paramsHash` + `errorMessage`.
- Cursor pagination: "Load older" button at the bottom when
  `nextCursor !== null`. No infinite scroll — admins will page
  explicitly.
- When `ENABLE_BUILD_TRACE_VIEW` is off on the backend, the gear
  icon does not render. Don't show a broken menu entry.
- When the user isn't admin, the gear icon also doesn't render.
  Same failure mode as flag-off — silent.

**Feature-flag detection on the frontend.** The frontend doesn't
have direct access to the backend env. Either:
- **Option A.** Add a `GET /api/build/capabilities` endpoint that
  returns `{ traceViewEnabled: boolean, isAdmin: boolean }`.
  Frontend calls this once at Studio mount.
- **Option B.** Piggyback on the existing session / auth response.

Prefer Option A — keeps the capabilities signal out of the hot
auth path. Small new endpoint, no data, cheap.

**Tests.** Use the harness from §2.1. One component test: mount
the drawer with three rows, assert row rendering + the "Load
older" button calls the provided fetch-more callback.

**Acceptance.** `npm test` green in `frontend/`. Manual smoke:
with the flag on + admin, gear icon renders in Studio, drawer
opens, shows rows from the current conversation.

### 2.4 30-day retention sweep on `BuildToolCallLog`

**File:** `backend/src/jobs/build-tool-call-log-retention.ts` (new).

**Pattern.** Mirror the existing `backend/src/jobs/` folder (check
what cron/BullMQ patterns are in use — debounce poll, FAQ
maintenance, sync jobs should be representative). Pick the
heavier-weight pattern only if BullMQ is already configured;
otherwise use the same polling pattern the others use.

**Schedule.** Once per day. Pick a low-traffic hour (e.g., 03:00
UTC). Deletes rows where `createdAt < now() - 30 days`. Bounded
batch — 10,000 rows per run, re-queues itself if more remain.

**Idempotency.** Safe to double-run. Just a bounded DELETE.

**Tests.**
- Unit: insert rows with varied createdAt, run the sweep, assert
  only rows ≥30d old were deleted.
- Unit: bounded batch — insert 15,000 old rows, one run deletes
  exactly 10,000, second run deletes the remaining 5,000.

**Acceptance.** `npm test -- retention` green. Add to the startup
registration path so it actually runs in production.

### 2.5 Delete the three redirect stubs

**Files to delete:**
- `frontend/app/build/page.tsx`
- `frontend/app/tuning/page.tsx`
- `frontend/app/tuning/agent/page.tsx`

Before deleting, verify in Vercel / any available analytics that
deep links to these routes in the last 7 days are zero or
near-zero. If there's meaningful traffic (say >5 hits/day),
extend the courtesy period by rewriting the redirect to a pinned
Studio tab path with a query param we can later filter in analytics
— and note it in NEXT.md for Session C to revisit.

Otherwise, delete the files and any route-specific components that
only those pages used. Run `npm run build` in `frontend/` to
confirm no broken imports.

**Acceptance.** `npm run build` green in `frontend/`. Direct
navigation to `/build`, `/tuning`, `/tuning/agent` returns Next.js
404 (not our custom redirect).

---

## 3. Out of scope — explicitly deferred to Session C

Do not touch this session:

- **Cross-session rejection memory.** NEXT.md §1.2 second bullet.
  Requires a design decision on cardinality (tenant /
  tenant+artifact / tenant+artifact+section). Open a design brief
  before implementation.
- **Dashboards merge** into main Analytics tab. Depends on operator
  feedback. Surface in sprint 047 retro.
- **Raw-prompt editor drawer.** Admin-only. Bigger surface than
  the trace drawer; worth its own session.
- **R1 persist-time truncation (Path B).** Conditional on Langfuse
  showing prose-heavy turns surviving Path A's advisory without
  self-correction. Evaluate after a week of Session A data.
- **R2 enforcement observability dashboard.** Langfuse dashboard
  work; out of the code-session pattern.
- **Oscillation advisory on BUILD writes.** Session A intentionally
  deferred — requires confidence on BUILD creators, which they
  don't carry today. Keep as-is unless product requirements change.

---

## 4. Sequencing + gate sheet

| Gate | Item                                                     | Status |
|------|----------------------------------------------------------|--------|
| B1   | Frontend vitest harness + reference AuditReport test     | ☐      |
| B2   | `GET /api/build/traces` endpoint + env-flag + admin gate | ☐      |
| B3   | Admin trace drawer (frontend) + capabilities endpoint    | ☐      |
| B4   | 30-day retention sweep job                               | ☐      |
| B5   | Delete `/build`, `/tuning`, `/tuning/agent` stubs        | ☐      |
| B6   | Backend + frontend tests green; `tsc --noEmit` clean     | ☐      |
| B7   | PROGRESS.md updated + NEXT.md rewritten for Session C    | ☐      |

Order: B1 → B2 → B3 → B4 → B5 → B6 → B7. B2 must land before B3
(drawer needs the endpoint).

---

## 5. Success criteria

- **C-1.** `cd frontend && npm test` passes. At least one real
  component test exercises Session A S5's `onViewRow` wiring via
  the same harness.
- **C-2.** `GET /api/build/traces` returns tenant-scoped rows for
  an admin with the flag on; 404s for non-admins or flag-off.
  Cursor pagination works (no duplicate rows across pages).
- **C-3.** Admin gear icon + trace drawer render in Studio when
  capabilities allow; absent otherwise. Drawer shows current-
  conversation rows with cursor pagination.
- **C-4.** Retention sweep deletes only rows older than 30 days,
  in bounded batches, without blocking the main event loop.
- **C-5.** Navigating to `/build`, `/tuning`, `/tuning/agent` in
  the deployed staging returns 404, not a redirect.
- **C-6.** `tsc --noEmit` clean, backend + frontend. All test
  suites green locally.
- **C-7.** PROGRESS.md gains a Sprint 047 Session B subsection
  with gates + decisions + deferrals.
- **C-8.** NEXT.md rewritten for sprint 047 Session C (candidates:
  cross-session rejection memory, raw-prompt editor drawer, any
  overflow from Session A's staging smoke).

---

## 6. Non-negotiables

- `ai.service.ts` untouched. No change to the main guest messaging
  pipeline.
- Prisma changes (the `isAdmin` column if needed) via `prisma db
  push`, not migrations.
- `BuildToolCallLog` retention must be bounded per run. A single
  unbounded DELETE against a large table is a lock-hold risk.
- Trace view is admin-only. Not tenant-admin, not tenant-member.
  Only platform admin. If the existing role model doesn't
  cleanly separate those, pick the strictest available and log
  the limitation in PROGRESS.md.
- The redirect-stub deletion is a real user-facing change for
  anyone with deep links. Verify traffic before deleting.
- Do not push without tests green locally. Railway + Vercel
  auto-deploy — bad push, bad deploy.

---

## 7. Exit handoff

Three steps, same pattern as Session A:

### 7.1 Commit + push

Per-gate commits. Branch `feat/047-session-b`. Push with
`--set-upstream` on first push.

### 7.2 Archive the current NEXT.md

Move `specs/045-build-mode/NEXT.md` →
`specs/045-build-mode/NEXT.sprint-047-session-b.archive.md`.

### 7.3 Update PROGRESS.md and write NEXT.md for Session C

PROGRESS.md append:

```markdown
## Sprint 047 — Session B (observability + cleanup)

Completed: YYYY-MM-DD.

| Gate | Item | Status | Notes |
|------|------|--------|-------|
| B1   | ...  | ✅     | ...   |
| ...  | ...  | ...    | ...   |

### Decisions made this session

- Capabilities endpoint location + shape.
- Admin role gating (new column vs existing signal).
- Retention sweep cadence.

### Deferred to next session

- (anything that slipped)
```

NEXT.md rewrite — scope Session C around:
- Cross-session rejection memory (design exercise + implementation).
- Raw-prompt editor drawer (admin-only).
- Any follow-on from the Session A staging smoke if issues
  surfaced in production.

---

## 8. Help channels

- If the frontend test harness (§2.1) explodes on config (Next.js
  16 + React 19 + vitest can be finicky), stop and surface in
  PROGRESS.md. Don't ship a half-working config that green-lights
  broken tests.
- If the admin role model (§2.2) doesn't cleanly exist, pick the
  strictest boundary you have (tenant owner? first user per
  tenant?) and flag the gap. Do not ship an endpoint behind a
  weaker gate than "admin" without surfacing it.
- If the retention sweep (§2.4) BullMQ/cron wiring doesn't match
  what the rest of `backend/src/jobs/` uses, match the existing
  pattern even if you'd prefer a different one. Consistency beats
  novelty for maintenance.

End of session brief.
