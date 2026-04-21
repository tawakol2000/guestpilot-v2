# Sprint 049 — Session A: Legacy-Copilot repair + tuning-nav hardening

> Six-item bundle. Five are the discovery-report findings
> ([sprint-049-discovery-report.md](./sprint-049-discovery-report.md)):
> two P0s in the same controller (`approveSuggestion` skips the tuning
> diagnostic AND orphans the suggestion on Hostaway failure), two
> UX-feedback items the operator hits weekly, and one stale-API
> cleanup. The sixth is
> [sprint-049-explore-report.md](./sprint-049-explore-report.md) **P1-3**
> folded in as a log-tag-only observability pass — every
> fire-and-forget diagnostic swallower gets a structured
> `[TUNING_DIAGNOSTIC_FAILURE]` tag so a silent outage is greppable
> in Railway logs. DB-backed badge defers to sprint-050 once we have
> production log signal to calibrate. All operator-surface, no schema.
>
> Owner: Abdelrahman. Base branch: `feat/049-session-a` off
> `feat/048-session-a` (HEAD `c206db0` at sprint-048 close). End-of-
> stack merge posture unchanged; chain is now
> 045→046→047-A→047-B→047-C→048-A→049-A.

---

## 0. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — critical rules #1 (never break
   guest messaging flow) and #2 (graceful degradation) both apply.
   `approveSuggestion` is the legacy-Copilot send surface — a bad
   fix here strands sent messages or double-delivers.
2. [`sprint-049-discovery-report.md`](./sprint-049-discovery-report.md)
   — this session's scope sheet is a subset of its punch list.
   Findings #1, #2, #4, #7 and additional-sweep **F2** land here;
   F1 (dead `/api/tuning/complaints` POST) and D1 (webhook drop-
   through) explicitly defer to Session B. Read the classifications
   and verified line refs before touching code.
3. [`sprint-049-explore-report.md`](./sprint-049-explore-report.md)
   — §2 P1-3 ("Tuning diagnostic / suggestion-writer errors fully
   invisible") is the sixth gate (§1.5 below). Read the three
   fire-and-forget call sites it names before editing.
4. [`NEXT.md`](./NEXT.md) — sprint-048 closed; sprint-049 pointer.
5. [`sprint-046-plan.md`](./sprint-046-plan.md) §8 — legacy-Copilot
   contract, especially the sprint-10 follow-up lockdown on
   `fromDraft` that gates the diagnostic. The `approveSuggestion`
   wire-up in §1.1 inherits that gate by design.
6. [`sprint-048-session-a.md`](./sprint-048-session-a.md) §1.1 —
   the Path A half of the legacy-Copilot fix. Session 049-A lands
   the Path B half, closing out the divergence.
7. [`PROGRESS.md`](./PROGRESS.md) sprint-048 Session A subsection
   — the extract-to-helper testing pattern (`shouldSendAsFromDraft`
   / `seedReplyFromDraft` / `handleDiscussInTuning`). Reuse it for
   any new frontend logic below.

---

## 0.1 Pre-flight

Before cutting `feat/049-session-a`:

- **Confirm the discovery report is committed** on `feat/048-session-a`.
  If the report file is uncommitted, commit it on 048-A first so the
  branch chain stays clean. (`git log --stat -- specs/045-build-mode/sprint-049-discovery-report.md`)
- **No schema changes this session.** No `prisma db push`.
- **No frontend-to-backend contract changes** beyond what's already
  specified. No new API routes.

---

## 1. Scope — Session A

Five items. Ship as per-gate commits.

### 1.1 `approveSuggestion` controller repair (findings #1 + #2, both P0)

`conversations.controller.ts#approveSuggestion` (L517-592) has two
bugs on the same code path. Fix together — the ordering and the
diagnostic fire share state (the `pendingReply` row, the
`editedText` comparison, the `cancelPendingAiReply` cleanup).

**Bug #1 — diagnostic never fires.** Backend accepts `editedText`
and sends it, but never calls `runDiagnostic` even when `editedText
!== pendingReply.suggestion`. Path A (`messages.controller.ts`
L170-205) got this right when sprint 048-A wired `fromDraft`;
Path B (here) never did.

**Bug #2 — Hostaway failure orphans state.** Per discovery report
§audit-verification.#2: the handler clears `PendingAiReply`, writes
the `Message` row, and THEN awaits Hostaway. If Hostaway throws,
the 500 response races against an already-committed DB state. Also
skips `cancelPendingAiReply` — the sibling debounce row stays live
and a second AI reply can fire on top of the "already-sent-ish"
message. Operator sees "500" with no retry surface.

**Fix shape:**

1. **Reorder the send path.** Hostaway first, DB writes second.
   Match the shadow-preview pattern in
   `shadow-preview.controller.ts` L97-128: atomic state transition
   → Hostaway call → commit or rollback. The canonical flow:
   - Read `pendingReply` (unchanged).
   - Call Hostaway. On failure, return 502 with
     `{ error: 'HOSTAWAY_DELIVERY_FAILED', detail: err.message }`
     and do NOT touch `PendingAiReply`.
   - On success, write the `Message` row (include
     `originalAiText: pendingReply.suggestion` and
     `editedByUserId: userId` when `editedText` is present — audit
     trail parity with Path A).
   - Update conversation `lastMessageAt`.
   - Broadcast `message` event.
   - Now clear the `PendingAiReply` and call
     `cancelPendingAiReply(id, prisma)` (mirroring
     `messages.controller.ts:168`).
2. **Wire the diagnostic fire.** After the successful send, if
   `editedText && editedText.trim() !== pendingReply.suggestion.trim()`,
   fire `runDiagnostic` + `writeSuggestionFromDiagnostic` — same
   pattern as `messages.controller.ts` L176-205. EDIT vs REJECT
   split via `semanticSimilarity` (< 0.3 → REJECT_TRIGGERED). Dedup
   through `shouldProcessTrigger` with the freshly-written
   message id. Fire-and-forget; errors swallowed per CLAUDE.md #2.
3. **Surface the failure path to the UI.** The existing frontend
   caller (`inbox-v5.tsx:5020`) only handles a throw by restoring
   `aiSuggestion` state. Check that the restore still works with
   the new 502 response shape — if not, adjust the caller to
   read the `error` field and toast it like the 048-A
   discuss-in-tuning fix.

**Tests:** `approveSuggestion.integration.test.ts`:
- (a) edited `editedText` differing from `pendingReply.suggestion`
  → diagnostic fires, `TuningSuggestion` row within 5s;
  `originalAiText` + `editedByUserId` on the `Message` row.
- (b) approve-as-is (`editedText === pendingReply.suggestion` OR
  omitted) → no diagnostic row.
- (c) Hostaway throw → no `Message` row, `PendingAiReply` intact,
  502 response with error detail. Retry succeeds.
- (d) Hostaway success then diagnostic-pipeline failure (mocked) →
  message delivered, 200 response, no 500 bubbled up.

**Acceptance.** SC-1a through SC-1d in §5.

### 1.2 Dead `/tuning` + `/tuning/agent` route cleanup (finding #4)

Per discovery report: `frontend/app/tuning/` has no `page.tsx` at
the root and no `agent/` subdirectory. The top-nav at
`frontend/components/tuning/top-nav.tsx` links to both, and
`frontend/app/tuning/playground/page.tsx:363` has a third reference
to `/tuning/agent`. All three 404 at runtime.

**Fix shape:**

1. **`tuning/top-nav.tsx`** — remove the `/tuning` (Suggestions)
   and `/tuning/agent` (Agent) nav entries. Keep `/tuning/sessions`,
   `/tuning/history`, `/tuning/pairs`, `/tuning/playground`,
   `/tuning/capability-requests` — those routes exist.
2. **`tuning/playground/page.tsx:363`** — remove or rewrite the
   "Edit agent →" link. Options: (a) delete the line entirely,
   (b) point to `/tuning/sessions`, (c) deep-link into the Studio
   tab via `?tab=studio&conversationId=...` if the playground has
   a selected session id at that point. Pick (a) if no session
   context, (b) if there's always a selected session.
3. **Grep for other dead refs.** `grep -rn "/tuning/agent\|/tuning"` in
   `frontend/` for any component/link/router.push missed above.
   If `/tuning` (no subpath) is referenced as a route target,
   rewrite to `/tuning/sessions` which is the new default landing.

**Tests:** one vitest for `top-nav.tsx` asserting the rendered nav
doesn't include `/tuning` or `/tuning/agent` hrefs.

**Acceptance.** SC-2: top-nav renders only valid routes; manual
click-through on every tuning nav entry lands on a non-404 page.

### 1.3 Document-checklist toast feedback (finding #7, narrowed)

Per discovery report §additional-sweep.7: two call sites in
`inbox-v5.tsx` swallow errors on operator-facing writes —
L3030 and L3058 (document-checklist updates; exact line numbers
per the report, verify before editing). `apiRateMessage` calls
are fine-as-is (telemetry; no operator-visible promise).

**Fix shape:** for each of the two checklist callers, replace
`.catch(console.error)` (or equivalent) with a toast:

```ts
.catch((err) => {
  toast.error('Failed to update document checklist', {
    description: err instanceof Error ? err.message : String(err),
  })
  console.error(err)
})
```

Mirror the 048-A pattern (`toast.error` from `sonner`, message-only
description, keep the `console.error` for dev observability).

**No backend changes.** The `apiUpdateConversationChecklist` (or
whichever function) already returns an error shape the frontend
can read.

**Tests:** not mandatory for a two-line change. If the discovery
report found a third site with an adjacent pattern, decide at
commit time whether a vitest is warranted.

**Acceptance.** SC-3: operator sees a toast on checklist-write
failure, not a silent no-op.

### 1.4 Stale API endpoint cleanup (finding F2)

Per discovery report §additional-sweep.F2 — exact endpoint + file
path per the report. The shape is a frontend `api*` function or
backend route with no live counterpart. Remove the dead code
(either delete the orphaned route + its router registration, or
delete the orphaned `api*` function + its imports).

**Fix shape:** surgical deletion. No behavioural change — the code
is unused. Per-commit scope: one endpoint per commit if the report
surfaces more than one, so a revert is cheap.

**If F1 (dead `POST /api/tuning/complaints`) is structurally
identical to F2**, consider rolling it into this commit. Otherwise
defer F1 to Session B — the discovery report flagged F1 may need
coordination with downstream consumers (ios-handoff.md mentions it).

**Tests:** grep-based verification that the deleted function/route
has no references after the change. `tsc --noEmit` must stay clean.

**Acceptance.** SC-4: stale endpoint is gone; no imports broken;
both `tsc --noEmit` runs clean.

### 1.5 Fire-and-forget failure surfacing (P1-3, log-tag only)

Per [sprint-049-explore-report.md §2 P1-3](./sprint-049-explore-report.md):
three fire-and-forget paths currently swallow errors into a bare
`console.error(...)` with no structured tag, no metric, no row. A
30-minute OpenAI outage leaves zero trace in the product. Closing the
full observability loop (DB table + `/tuning` badge) needs schema work
we're not doing in this session; this gate is the **log-tag-only**
subset so operator/devops can greppably find the failures tomorrow.

Four call sites (verify line refs before editing):

1. [`shadow-preview.controller.ts:164-186`](backend/src/controllers/shadow-preview.controller.ts)
   — shadow-mode diagnostic fire (the shape to mirror on the other three).
2. [`shadow-preview.controller.ts:121-123`](backend/src/controllers/shadow-preview.controller.ts)
   — shadow-mode compaction fire-and-forget. Currently `void`'d with
   no catch at all; wrap it.
3. [`messages.controller.ts:182-201`](backend/src/controllers/messages.controller.ts)
   — Path A diagnostic fire (sprint-048 Session A).
4. **`conversations.controller.ts#approveSuggestion`** — Path B
   diagnostic fire, **added by §1.1 A2 in this session**. Apply the
   same structured tag in the same commit or as a follow-up commit
   before A7 closes.

**Fix shape:** replace each `console.error('[ShadowPreview] ... failed:', err)`
(and equivalent) with:

```ts
console.error('[TUNING_DIAGNOSTIC_FAILURE]', {
  phase: 'diagnostic' | 'suggestion-write' | 'compaction',
  path: 'shadow-preview' | 'messages' | 'conversations',
  tenantId,
  messageId,
  triggerType,      // EDIT_TRIGGERED | REJECT_TRIGGERED | null for compaction
  reason: err instanceof Error ? err.message : String(err),
  stack: err instanceof Error ? err.stack : undefined,
})
```

Two separate logs if `runDiagnostic` and `writeSuggestionFromDiagnostic`
are in the same try/catch: split the try blocks so the `phase` field
is meaningful. If that's more than a 3-line refactor, leave `phase:
'diagnostic'` for the combined case and land the split in sprint 050.

**No schema changes.** No new model, no new endpoint, no badge. Those
ship in sprint-050 once a week of Railway log signal tells us what
threshold / grouping is right.

**Tests:** one backend unit test per call site that mocks the inner
service to throw and asserts `console.error` was called with
`'[TUNING_DIAGNOSTIC_FAILURE]'` as the first arg. Four tests total.
Reuse `vi.spyOn(console, 'error')` pattern from the suite.

**Acceptance.** SC-5: `grep -rn "TUNING_DIAGNOSTIC_FAILURE" backend/src/`
returns exactly four sites. Each unit test passes.

---

## 2. Out of scope — explicitly deferred

- **Discovery F1 — dead `POST /api/tuning/complaints`.** Needs a
  read of `docs/ios-handoff.md` to confirm no mobile client still
  calls it. Session B or later.
- **Discovery D1 — webhook drop-through on auto-create-failed.**
  P2, but touches `webhooks.controller.ts` — the guest-message
  intake path. CLAUDE.md rule #1 says never break it; a risky fix
  doesn't belong in a bundled session. Standalone sprint work.
- **`NEXT.md` §3 candidates** (raw-prompt editor edit path,
  RejectionMemory retention sweep, reject-card rationale input,
  Path A/B unification at the service layer). Still deferred.
- **Full Path A ⇔ Path B semantic parity audit.** Session A fixes
  the diagnostic fire divergence, not the full contract (e.g.,
  `Message.role` is `HOST` on Path A vs `AI` on Path B, different
  audit fields on each). A unification pass stays on sprint 050's
  candidate list.
- **`DiagnosticFailure` table + `/tuning` observability badge** (from
  sprint-049-explore-report §2 P1-3). §1.5 in this session ships the
  log-tag-only half. The DB-backed half (schema, retention, badge,
  admin-only query endpoint) defers to sprint-050 once a week of
  production log signal calibrates the threshold.
- **P1-4 transactional diagnostic+suggestion+evidence writes**,
  **P1-6 atomic-claim revert race**, **P1-2 judge infra → tool-error**,
  **P1-5 PREVIEW_LOCKED 409 UI race**. All from sprint-049-explore-report.
  Carry forward to sprint-050 candidate list.

---

## 3. Non-negotiables

- `ai.service.ts` untouched. Guest pipeline is not in scope.
- No schema changes. No `prisma db push`.
- `approveSuggestion` must preserve its existing happy-path
  behaviour — a send that succeeds today must still succeed. The
  reorder is the risky part; guard with the new integration tests
  before pushing.
- Diagnostic fire stays fire-and-forget. A 500 from the diagnostic
  pipeline must not bubble up to the HTTP response.
- Toast copy must not leak stack traces — `err.message` only.
- `fromDraft` gating on Path A stays as 048-A shipped it. This
  session only adds the equivalent Path B gate via the
  `editedText !== suggestion` comparison.

---

## 4. Sequencing + gate sheet

| Gate | Item                                                           | Status |
|------|----------------------------------------------------------------|--------|
| A1   | `approveSuggestion` reorder: Hostaway first, rollback-safe     | ☐      |
| A2   | `approveSuggestion` diagnostic fire + `cancelPendingAiReply`   | ☐      |
| A3   | Backend integration tests for A1+A2 (4 cases)                  | ☐      |
| A4   | Dead tuning nav + playground link cleanup (finding #4)         | ☐      |
| A5   | Document-checklist toast feedback (finding #7 narrowed)        | ☐      |
| A6   | Stale API endpoint cleanup (finding F2 per discovery report)   | ☐      |
| A7   | `[TUNING_DIAGNOSTIC_FAILURE]` structured log tag (§1.5, 4 sites) | ☐    |
| A8   | Backend + frontend suites green; `tsc --noEmit` clean          | ☐      |
| A9   | PROGRESS.md "Sprint 049 — Session A" + NEXT.md rewrite         | ☐      |

Order: A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9. A1 and A2 share
`approveSuggestion`; land as two commits on the same branch with
A2 depending on A1 landing the reorder first. A7 depends on A2
(Path B diagnostic fire must exist before its log-tag gets applied).

---

## 5. Success criteria

- **SC-1a.** Editing a Copilot suggestion via `approveSuggestion`
  and sending creates a `TuningSuggestion` row within 5s.
- **SC-1b.** Approving unchanged (no `editedText`, or equal text)
  creates zero new `TuningSuggestion` rows.
- **SC-1c.** Hostaway failure leaves `PendingAiReply` intact and
  produces no `Message` row. A retry succeeds.
- **SC-1d.** Hostaway success followed by a diagnostic-pipeline
  throw returns 200; no error bubbles to the caller.
- **SC-2.** Top-nav + playground contain no dead `/tuning` or
  `/tuning/agent` references. Manual click-through on every
  tuning-nav entry lands on a real page.
- **SC-3.** Document-checklist write failures surface a toast to
  the operator.
- **SC-4.** The F2 stale endpoint is gone; no orphaned imports;
  `tsc --noEmit` clean on both sides.
- **SC-5.** `grep -rn "TUNING_DIAGNOSTIC_FAILURE" backend/src/`
  returns exactly four sites. Each site is reached by a unit test
  that throws inside the fire-and-forget inner service and asserts
  the structured log fires.
- **SC-6.** All backend + frontend test suites green locally
  (245+ backend unit, integration +new from A3, frontend vitest
  including the nav test from A4, unit tests from A7).
- **SC-7.** PROGRESS.md gains a "Sprint 049 — Session A"
  subsection documenting decisions + any caveats. NEXT.md rewrites
  to Session B scope (likely F1 + D1 + one NEXT.md §3 candidate)
  or sprint 050 kickoff scoped around the deferred explore-report
  P1s and the DB-backed observability half of P1-3.

---

## 6. Exit handoff

### 6.1 Commit + push

Per-gate commits. Branch `feat/049-session-a`. Push with
`--set-upstream` on first push.

### 6.2 Archive NEXT.md

Move `specs/045-build-mode/NEXT.md` →
`specs/045-build-mode/NEXT.sprint-049-session-a.archive.md`.

### 6.3 Update PROGRESS.md + write NEXT.md

If Session B continues in sprint-049, NEXT.md becomes that scope
(F1 + D1 + one §3 candidate). If Session A is sprint-049's only
session, NEXT.md is the sprint-050 kickoff.

---

## 7. Help channels

- If the `approveSuggestion` reorder reveals that existing frontend
  callers depend on the current DB-then-Hostaway ordering (e.g.,
  optimistic UI that reads the `Message` row before the 502 can
  land), stop and surface in PROGRESS.md "Decisions made →
  Blocked". Do not half-reorder — the race surface is worse than
  either extreme.
- If the document-checklist toast work reveals the API function
  doesn't return a readable error shape (some `apiFetch` wrappers
  swallow the response body), normalise the error shape first
  rather than papering over it with a generic toast.
- If F2's stale endpoint turns out to have a non-obvious live
  consumer (e.g., a legacy admin script or a scheduled job), land
  a `deprecated: true` flag and a logged warning instead of the
  deletion, and file the deletion as a Session B task.

End of session brief.
