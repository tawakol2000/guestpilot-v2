# Sprint 053 — Session A — Bundle C.1: Dry-Run Seam, Artifact History, Write-Ledger

**Branch:** `feat/053-session-a` (stacks on `feat/052-session-a` → `feat/051-session-a` → `feat/050-session-a` → `main`)
**Parent tip expected:** `7d49103` (feat/052-session-a close-out)
**Session type:** A — plumbing-first. Backend-heavy with rail-slot UI.
**Brainstorm §:** Bundle C, opening half. Complement sprint (Bundle C closing half — tiered permissions + Try-it composer) planned as 053-B or 054-A.

---

## 0. Why this sprint exists

After 052-A we can **view** any artifact end-to-end: rendered body, semantic diff, deep-linkable sections, citation sentinels. But every write today is invisible: the agent mutates an SOP, the manager sees a chat message claiming it wrote something, and… that's it. No preview, no history, no undo. One bad tool call nukes a production SOP and the only recovery path is manager memory + git-style grep through postgres.

That "write-is-a-cliff" posture is the single biggest reason the Studio surface isn't yet safe to hand to a non-technical manager. Bundle C as a whole addresses it — tiered permissions, Try-it composer, dry-run preview, write-ledger. This sprint opens the bundle by landing the **plumbing + observational layer**: the dry-run seam, the history table, the preview-before-apply flow, and the write-ledger rail slot.

The deliberate companion work (tiered permissions dial + Try-it composer) is parked for 053-B because it's a **posture-shifting** change — it reclassifies who can do what — whereas this sprint is **additive**: it adds safety nets under the existing "admin-only, one-click-apply" behavior without changing who's authorized to apply.

---

## 1. Non-negotiables (carried forward)

- **`ai.service.ts` stays untouched.** The dry-run seam lives in the tool-executor layer (or caller-side), not in the main pipeline.
- **Graceful degradation.** If `BuildArtifactHistory` insert fails, the write MUST NOT roll back. History is observational, not load-bearing. Log + continue.
- **Sanitiser coverage.** History rows for `tool_definition` MUST run `sanitiseToolArguments` on `prevBody`/`newBody` before storage. Do NOT bake secrets into a new DB table.
- **Admin-only surfaces stay admin-only.** Write-ledger rail is admin-visible only — same capability gate as the raw-prompt editor.
- **No schema changes without `npx prisma db push` in-session.** Constitution §Development Workflow.
- **Branch discipline.** Stack on `feat/052-session-a`. Do NOT rebase onto `main` — the three-sprint stack lives together until the combined 050+051+052+053 staging walkthrough.

---

## 2. Pre-flight gate

Before writing any code, run these checks **in order** and report the output.

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a
```

Expected output (from sprint-052-A close-out):
- `feat/050-session-a` → `d103c14`
- `feat/051-session-a` → `41b339c`
- `feat/052-session-a` → `7d49103`

If the tips don't match, **stop**. Report the divergence; do not improvise. (Sprint-052-A already noted SHA drift from its brief — we're not paying that interest a second time.)

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && npm test
```

Expected baseline (from sprint-052-A close-out):
- Frontend: 123/123
- Backend: 275/275

Both must pass before this sprint adds anything. If either is red at baseline, stop.

### 2.3 Schema snapshot

```
cd backend && npx prisma db pull --print | head -40
```

Confirm there is no existing `BuildArtifactHistory` model. (There shouldn't be — but if a previous aborted sprint left a carcass, surface it now.)

---

## 3. Gates

Five gates. Each gate is one commit on `feat/053-session-a`.

### D1 — Dry-run seam in write tools

**Scope:** every write tool in the BUILD agent gains a `dryRun?: boolean` parameter. When true, the tool validates input, composes the would-be payload, and returns `{ preview: <full payload>, diff: <summary> }` — but performs NO DB write and emits NO history row.

**Write tools in scope:**
- `write_sop` (and its variants/overrides)
- `write_faq`
- `write_system_prompt`
- `write_tool_definition`
- `write_property_override`

(If any of these don't exist today under those exact names, audit the tool catalog in `backend/src/build-tune-agent/tools/` and name them accurately — the spec is "all SOP/FAQ/system-prompt/tool-def/property-override write paths," not the specific string names above.)

**Implementation notes:**
- The seam lives in the tool executor layer — ideally as a shared helper `runOrPreview(args, writeFn)` so each tool doesn't re-implement the branch.
- Validation MUST still run in dry-run mode. A dry-run that wouldn't have passed validation returns an error, not a preview.
- Preview payload SHOULD include the exact fields the DB write would have used — so the downstream diff view can render it faithfully.
- Sanitise the preview payload for tool_definition writes BEFORE returning (same rule as D2 storage).

**Tests (+~10 backend):**
- For each write tool: `dryRun: true` → returns preview, DB unchanged, no history row.
- For each write tool: `dryRun: false` (or omitted) → behaves as today.
- Dry-run validation failure → returns error shape, not a silent success.
- Dry-run preview payload for a `write_tool_definition` with an API-key parameter → key is redacted in the preview.

**Commit message sketch:** `feat(build): add dryRun seam to write tools (D1)`

---

### D2 — BuildArtifactHistory table

**Scope:** new Prisma model that captures every successful write from D1-scoped tools, plus the foundation for revert + version-slider (parked for later sprints).

**Prisma model:**

```prisma
model BuildArtifactHistory {
  id             String   @id @default(cuid())
  tenantId       String
  artifactType   String   // "sop" | "faq" | "system_prompt" | "tool_definition" | "property_override"
  artifactId     String   // FK-ish; points at the artifact's primary key. String because types differ.
  operation      String   // "CREATE" | "UPDATE" | "DELETE" | "REVERT"
  prevBody       Json?    // null for CREATE
  newBody        Json?    // null for DELETE
  actorUserId    String?
  actorEmail     String?
  conversationId String?  // BUILD session context, if available
  metadata       Json?    // { revertsHistoryId?, ... }
  createdAt      DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, artifactType, artifactId, createdAt])
  @@index([tenantId, conversationId, createdAt])
}
```

Apply with `npx prisma db push` (constitution §Development Workflow).

**Write-path integration:**
- Each write tool in D1 — after the real write — emits exactly one history row.
- Emission is best-effort: wrap in try/catch, log on failure, do NOT roll back the real write.
- For `tool_definition`, `prevBody` and `newBody` MUST be sanitised via `sanitiseToolArguments` (or equivalent) before storage.
- `actorEmail` comes from the JWT claim on the request. `actorUserId` comes from the same source.
- `conversationId` is threaded through from the BUILD agent context when available (it always should be — but tolerate absent).

**SystemPromptView prev-body retire:**
- Sprint 052-A C2 read `AiConfigVersion` for system_prompt prev-bodies via `getBuildArtifactPrevBody`. Retire that path in favor of `BuildArtifactHistory`.
- Keep `AiConfigVersion` untouched (it has independent uses) — just stop reading it from the build-artifact-detail endpoint.
- If no history row exists for a given artifact (e.g. created before this sprint), return `prevBody: null`. Diff view already handles that gracefully.

**Tool diff toggle unlock:**
- Sprint 052-A C3 shipped ToolView JSON-diff as renderer-only because no history table existed. Unlock the toggle now: when `BuildArtifactHistory` has a row for this tool_definition, surface the "Diff" tab with the previous body.
- No new UI for this — the seam already exists on `BuildArtifactDetail` as `prevParameters`/`prevWebhookConfig`. Populate them from the backend.

**Tests (+~10 backend):**
- History row written on each of the five write tools' success path.
- History row NOT written on dry-run.
- tool_definition history row has sanitised prev/new bodies.
- BuildArtifactDetail endpoint returns `prevBody` from history for the most recent prior version.
- BuildArtifactDetail endpoint returns `prevBody: null` for artifacts with no history (pre-sprint-053 artifacts).
- History emission failure (simulate with mocked insert throwing) — real write succeeds, error logged, no crash.

**Commit message sketch:** `feat(build): BuildArtifactHistory table + write-path emission (D2)`

---

### D3 — Dry-run preview in ArtifactDrawer

**Scope:** the drawer surfaces a "Preview" button next to (before) "Apply." Click calls the write tool with `dryRun: true`, renders the preview in the existing diff views from 052-A, and shows a banner making the non-saved state obvious.

**UI contract:**
- Drawer footer area gains a `Preview` primary button and a subordinate `Apply` button. Initial state: `Preview` active, `Apply` disabled.
- Click `Preview` → fetch call to the write tool with `dryRun: true`. Spinner on the button. On response, render the preview body via the existing per-type view, diff mode ON by default, against the current saved body as `prevBody`.
- Banner above the content: `Preview — not saved yet` (amber-tinted, `STUDIO_COLORS.warningSurface` or equivalent; if that token doesn't exist, use `#FFF5E4` inline and leave a TODO for a token pass). Banner includes a "Clear preview" link that dismisses the preview and re-enables `Preview`.
- After preview is rendered, `Apply` button enables. Click `Apply` → fetch the same tool with `dryRun: false` (or omitted). On success, close drawer, toast, refresh artifact detail + write-ledger rail.
- If the preview response is a validation error, render the error inline in the drawer body area, keep `Apply` disabled, `Preview` re-enabled.

**Implementation notes:**
- The write-tool fetch path goes through the existing BUILD agent tool-call infra. If there's no user-initiated path to a write tool (today the agent is the only caller), this sprint ADDS one: a thin `/api/build/artifacts/:type/:id/apply` endpoint that accepts `{ dryRun: boolean, body: <per-type payload> }` and dispatches to the same tool-executor layer.
- That endpoint MUST enforce admin-only (same middleware as raw-prompt editor).
- No new UI layout — just footer buttons + banner + reusing the per-type views.

**Tests (+~8 frontend):**
- `Preview` click → fetches with dryRun, renders diff, shows banner.
- `Apply` disabled until a valid preview renders.
- `Apply` click → fetches without dryRun, closes drawer, fires refresh.
- Validation-error preview response → inline error, `Apply` stays disabled.
- Banner dismissal → clears preview, re-enables `Preview`.

**Commit message sketch:** `feat(build): dry-run preview in ArtifactDrawer (D3)`

---

### D4 — Write-ledger rail slot

**Scope:** new right-rail slot (below the existing state-snapshot and recent-tests sections) titled "Recent writes." Shows up to 10 history rows scoped to the current session's conversation, most recent first.

**Row shape:**
- Icon (per artifact type, reuse drawer icons)
- Line 1: `{operation} {artifactType} — {artifactId or name}` (e.g. `UPDATE sop — late_checkout`)
- Line 2: `{actorEmail} · {relative timestamp}` (e.g. `ab.tawakol@gmail.com · 2m ago`)
- Click-to-open: opens ArtifactDrawer in diff mode, `newBody` from the history row as current, `prevBody` from the row as prev, banner reads `Viewing write from {timestamp}`.
- Secondary action: a `Revert` link (only on UPDATE rows; not on CREATE because that's a delete, not a revert, and we're explicitly NOT shipping delete-via-revert this sprint).

**Revert flow:**
- Click `Revert` → opens drawer in diff mode, but swaps the semantic: content is `prevBody` (what we're reverting TO), diff is against the current saved body. Banner: `Reverting to {timestamp} version`.
- Buttons: `Preview Revert` (dry-run the write with `prevBody` as the payload) and `Confirm Revert` (apply).
- A successful revert writes a new history row with `operation: "REVERT"` and `metadata: { revertsHistoryId: <source row id> }`.

**Data source:**
- Backend: `GET /api/build/artifacts/history?conversationId=X&limit=10` returning sanitised history rows. Tenant-scoped via middleware.
- Frontend: SWR or equivalent, revalidate on drawer-close event.

**Tests (+~8 frontend, +~3 backend):**
- Rail renders empty state when no writes.
- Rail renders 1/5/10 rows with correct shape.
- Click-to-open triggers drawer with history-row content.
- Revert on UPDATE row: shows correct diff orientation + confirm writes a REVERT history row.
- Revert is hidden on CREATE rows.
- Backend endpoint enforces tenant scope.
- Backend endpoint sanitises tool_definition rows (belt + suspenders — D2 already sanitised at write, this catches any pre-D2 rows that might slip through in the future).

**Commit message sketch:** `feat(build): write-ledger rail + revert flow (D4)`

---

### D5 — Verification + PROGRESS.md + NEXT.md

**Verification checklist:**
- Frontend tests pass, count target `123 → ~155` (+~32).
- Backend tests pass, count target `275 → ~300` (+~25).
- `tsc --noEmit` clean both sides.
- `npx prisma db push` applied cleanly; schema snapshot in `prisma/schema.prisma` shows the new model.
- No import of `BuildArtifactHistory` from `ai.service.ts` (grep). The seam stays clean.
- Manual five-step smoke (document in PROGRESS.md):
  1. Open BUILD session, trigger agent to propose an SOP edit.
  2. Open artifact drawer, click Preview — diff renders with banner.
  3. Click Apply — drawer closes, rail shows the new write.
  4. Click the rail row — drawer re-opens in history view.
  5. Click Revert → Preview Revert → Confirm Revert. Rail shows REVERT row.

**PROGRESS.md:**
- New §Sprint-053-A block with commit SHAs, test deltas, manual smoke log.
- Close out the 052-A ledger-unlock carry-over (tool diff toggle now lit).
- Note the one remaining 050-A carry-over (staging walkthrough — still pending).

**NEXT.md rewrite:**
- Archive current NEXT.md to `NEXT.sprint-053-session-a.archive.md`.
- New NEXT.md surfaces two 054-A candidates:
  - Bundle C closing half: tiered permissions dial + Try-it composer (primary candidate — closes the bundle).
  - Correctness carry-over sweep: sprint-049 P1-2/3/4/5/6 + F1 (alternate candidate if user prefers paydown).
- Note unblocked-but-deferred items: artifact version slider (history table is in place), inline-edit-from-drawer (viewer + preview path exists now).

**Commit message sketch:** `chore(build): sprint-053-A close-out — ledger + revert live (D5)`

---

## 4. Size budget + scope creep watch

- Gate-for-gate commit discipline. If a gate balloons past ~300 LOC net, STOP and surface it — we'd rather split than merge a bloated gate.
- Test delta target: +~40 across both sides. Previous sprints landed +34 (050-A), +36 (051-A), +40 (052-A). This one is slightly larger because of the schema + new rail — that's expected, but a +80 delta is a red flag and means scope drifted.
- Backend LOC > frontend LOC is expected this sprint. Opposite posture from 052-A.
- **Do not** build: tiered permissions dial, Try-it composer, version slider, delete-via-revert, inline-edit-from-drawer, a11y sweep. All parked.

---

## 5. Watch-outs specific to this sprint

- **`AiConfigVersion` is NOT going away.** Only the build-artifact-detail endpoint's read of it for system_prompt prev-bodies retires. Other callers stay intact.
- **History emission must not re-order within a transaction.** If the write + history-insert are in the same txn and history insert fails, the whole thing rolls back — defeating the "observational" guarantee. Emit history OUTSIDE the txn, try/catch, log on failure. This is spelled out in D2 but worth restating.
- **Sanitiser parity:** D1 sanitises preview payloads; D2 sanitises stored history. Same function, same key list. If they drift, you get asymmetric redaction (preview shows a secret, history hides it, or vice versa). Write a shared test that asserts they produce identical output for the same input.
- **Tenant isolation in the ledger endpoint.** The `conversationId` filter is a hint, not a security boundary. The security boundary is the tenant middleware. Test that a tenant-A user calling with a tenant-B conversationId returns zero rows (not an error — just empty).
- **Revert of a revert.** Nothing special — a revert of REVERT row N is a new UPDATE that happens to restore row N-1's prevBody state. Don't special-case it; just make sure the data flows.

---

## 6. Handoff — what 053-A does NOT land

This sprint delivers the safety net. It does NOT deliver the posture change. After this sprint, a manager with admin rights can: preview before applying, see a ledger of what was written, and revert individual writes. They still need admin rights to do any of it.

**Bundle C closing half (054-A candidate):**
- Tiered permissions dial (suggest-only / one-click-apply / autopilot) with non-admin users able to use suggest-only mode.
- Try-it composer: a chat-adjacent panel that lets a user compose an artifact proposal without sending a chat message — dry-run-only surface, no write capability.
- Deferred write-ledger polish: grouped rows (e.g. "5 writes in this session" collapsible), filter by artifact type, export as CSV.

**Unblocked by this sprint, still parked:**
- Artifact version slider (history table now exists — just needs UI).
- Inline-edit-from-drawer (preview path exists — just needs an editor input in the drawer).
- Audit-quote emit (orthogonal, but benefits from the apply endpoint existing).

---

## 7. Close-out checklist

Mirror the 052-A close-out format:

- Per-gate commits with SHAs
- Frontend + backend test counts (before / after / delta)
- `tsc --noEmit` status both sides
- Dep budget: target is ZERO new deps this sprint. If one shows up, justify it explicitly.
- Caveats / scope drift — be honest. If D3 grew tentacles into a new endpoint, note it. If a gate slipped, note it.
- Branch posture line: `feat/053-session-a (<tip>) stacks on feat/052-session-a (7d49103)...`
- NEXT.md pointer to the two 054-A candidates.

---

## 8. Open questions (do not resolve in-sprint; surface in close-out)

- Should `BuildArtifactHistory` rows carry the BUILD session's tool-call ID so a revert can surface "this was the write that came from this tool call"? Adds a column, not strictly needed for this sprint's safety-net, but cheap to add now and expensive to backfill.
- Sanitisation of `property_override` history rows — today overrides are plain text with no keys, but the schema is `Json`, meaning someone could stash credentials there. Do we run the same sanitiser? Argue for: cheap insurance. Argue against: overrides have domain meaning and redacted rows are hard to read.
- Should the ledger rail be session-scoped or tenant-scoped by default? Session-scoped matches "what did this BUILD session do" intent; tenant-scoped matches "what's happening to our config across the org" intent. Starting with session-scoped in this sprint; flag if the user asks for tenant-scoped.
