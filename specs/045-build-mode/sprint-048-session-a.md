# Sprint 048 — Session A: Copilot edit signal + Discuss-in-tuning wiring

> Two production bugs surfaced by Abdelrahman after sprint 047 closed.
> This session jumps the sprint-048 candidate scope in `NEXT.md` §2.1
> — those three candidates defer to Session B or sprint 049. The
> fixes here are small but touch operator-facing UX, so they land
> first.
>
> Owner: Abdelrahman. Base branch: `feat/048-session-a` off
> `feat/047-session-c` (HEAD at Session C close, commit `d46aefe`).
> End-of-stack merge-to-`advanced-ai-v7` remains the close-out ritual
> — this session just extends the stack by one more segment.

---

## 0. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — project constitution. Critical
   rules #1 (never break guest messaging flow) + #3 (graceful
   degradation) apply; the fixes below touch the inbox send path
   and must fail closed, never loud.
2. [`NEXT.md`](./NEXT.md) — sprint-047 close-out + sprint-048
   kickoff. This session's two fixes are inserted as §1.5-style
   high-priority items ahead of the three candidates already listed.
3. [`PROGRESS.md`](./PROGRESS.md) "Sprint 047 — Session C" for the
   end-of-stack merge posture and the admin-flag checklist.
4. [`sprint-046-plan.md`](./sprint-046-plan.md) §8 (legacy-Copilot
   contract) for why `fromDraft` is a gated signal in the first
   place — sprint-10 follow-up locked the backend down after false
   positives poisoned the criticalFailure signal.
5. [`validation/sprint-047-session-a-staging-smoke.md`](./validation/sprint-047-session-a-staging-smoke.md)
   — still open. End-of-stack merge wet-test after this session
   lands.

---

## 0.1 Pre-flight — branch base

Before cutting `feat/048-session-a`:

- **Has `feat/047-session-c` been merged to `advanced-ai-v7` yet?**
  If yes, branch off `advanced-ai-v7`. If no (Abdelrahman's default
  end-of-stack posture), branch off `feat/047-session-c` at commit
  `d46aefe` and expect the later end-of-stack merge to roll this
  session in.
- No schema changes in this session. No `prisma db push` required.
  Both fixes are wiring-only.

---

## 1. Scope — Session A

Two bugs. Both surgical. Ship as separate commits.

### 1.1 Copilot edit signal doesn't fire

**Symptom.** In legacy Copilot mode (`Conversation.aiMode === 'copilot'`
+ `Tenant.shadowModeEnabled === false`), when the operator sees the
AI's pending suggestion in the pill above the compose area, edits
the text, and sends — the tuning diagnostic (`runDiagnostic` +
`writeSuggestionFromDiagnostic`) never fires. No suggestion ever
lands in `/tuning` from a Copilot-mode edit.

**Root cause (two paths, both broken):**

1. **Path A — `apiSendMessage` → `messages.controller.ts#send`**
   (backend L170-205). Backend CORRECTLY gates diagnostic-fire
   behind `fromDraft === true` in the request body — the sprint-10
   follow-up lockdown intended to stop false positives when
   unrelated typed replies happened to coincide with a pending
   draft.

   Frontend `inbox-v5.tsx:2534-2570#sendReply()` calls
   `apiSendMessage(selectedConv.id, text, channelOverride)` with NO
   options object — so `fromDraft` is silently omitted on every
   send, which means the diagnostic never fires.

   The UI also never seeds `replyText` from `aiSuggestion`. There
   is no "edit this suggestion" affordance — the pill only exposes
   an approve-as-is arrow (L5016-5033). Operators who *want* to
   edit have to retype from scratch, which the backend rightly
   doesn't count as an edit.

2. **Path B — `apiApproveSuggestion` → `conversations.controller.ts#approveSuggestion`**
   (backend L517-592). Backend accepts an `editedText` body
   parameter and uses it in place of `pendingReply.suggestion`,
   but never fires `runDiagnostic` even when `editedText !==
   pendingReply.suggestion`. And the frontend only ever calls this
   endpoint with the unchanged suggestion (L5020:
   `await apiApproveSuggestion(selectedConv.id, s)` where `s =
   aiSuggestion`).

**Design decision — which path to wire:**

Use Path A (`apiSendMessage` + `fromDraft: true`). Two reasons:

- The backend already has the dedup + similarity split there; the
  `approveSuggestion` controller would need the same machinery
  duplicated.
- Path A already writes `originalAiText` + `editedByUserId` on the
  `Message` row for audit. `approveSuggestion` creates a
  `role: 'AI'` message with no edit-trail — which is itself a small
  bug, but not one to fix in this session.

**Fix — frontend only (preferred scope):**

1. **Add an "Edit" affordance on the suggestion pill.** Next to the
   existing approve-arrow button at `inbox-v5.tsx:5016`, add a
   small pencil/edit icon button. On click:
   - Copy `aiSuggestion` into `replyText` via `setReplyText(aiSuggestion)`.
   - Clear the pill: `setAiSuggestion(null)` (same pattern the
     approve flow uses after send).
   - Set a new state flag `seededFromDraft: true` — a `useState<string | null>`
     that stores the original AI draft text for later comparison
     at send time.
   - Focus the textarea so the cursor is live.

2. **Teach `sendReply()` about the draft-seed flag.** In
   `inbox-v5.tsx:2534`, when `seededFromDraft` holds the original
   AI text AND the final `text.trim()` differs from it AND
   `selectedConv.aiMode === 'copilot'`, call:
   ```ts
   apiSendMessage(selectedConv.id, text, channelOverride, { fromDraft: true })
   ```
   Otherwise keep the current call shape.

3. **Reset `seededFromDraft` on send** (both success and error
   paths — mirror `resetTextarea()` placement) AND on conversation
   switch (`selectConversation` at L2522) AND when a new
   `ai_suggestion` arrives for the same conversation (the socket
   handler at L2142).

4. **Equivalence check.** If the user seeds from the draft but
   sends the text unchanged, `fromDraft` should stay false — the
   backend's diagnostic is for EDITS, not approvals. The
   `similarity < 0.3` split + the `shouldProcessTrigger` 60s dedup
   already handle this, but passing `fromDraft: false` when
   `text === seededFromDraft` saves a pointless backend roundtrip
   through the diagnostic pipeline.

**Fix — skip backend changes for Path B.** Document in PROGRESS.md
that `approveSuggestion` still doesn't fire diagnostics even when
`editedText` differs, but note that the frontend never exercises
that branch. A future session can unify the two paths — not now.

**Tests:**

- Frontend vitest: `inbox-v5.editPill.test.tsx` — render a
  Copilot-mode conversation with a pending suggestion, click the
  new Edit button, assert `replyText` is now the suggestion text
  and `aiSuggestion` is null. Then mutate `replyText`, call the
  send handler, assert the `apiSendMessage` mock was called with
  `{ fromDraft: true }`.
- Backend integration test: `messages-copilot-fromdraft.integration.test.ts`
  — with a real `PendingAiReply.suggestion` row, POST
  `/api/conversations/:id/messages` with `fromDraft: true` and
  content differing from the suggestion. Assert a
  `TuningSuggestion` row gets created within 2s (fire-and-forget,
  so poll with a short timeout). Already-existing trigger-dedup
  should prevent a second fire within 60s — add a second POST
  asserting no new `TuningSuggestion` row.

**Acceptance.** SC-1a: editing a Copilot suggestion and sending it
produces a `TuningSuggestion` row visible in `/tuning` within 5
seconds. SC-1b: approving the suggestion unchanged produces no
such row. SC-1c: typing a fresh reply in Copilot mode (no edit
affordance used) produces no such row.

### 1.2 "Discuss in tuning" button needs feedback + smoke

**Symptom.** Abdelrahman flagged that clicking "discuss in tuning"
on an AI message in the inbox doesn't visibly work. Code audit
found no definitive backend or routing bug — the button creates a
`TuningConversation` with the correct anchor and switches to the
Studio tab, which should rehydrate correctly. The most likely
failure modes are silent errors:

- `apiCreateTuningConversation` 500s (e.g., backend error loading
  `TuningConversation` row) → only `console.error`, no toast.
- Studio bootstrap effect fails loading `apiGetBuildTenantState`
  → the user sees "Couldn't load Studio" toast but nothing pointing
  back to the inbox click.
- Button is rendered but the click target is tiny (`padding: '1px
  4px'`, `fontSize: 9`) — user may be clicking adjacent whitespace.

**Fix:**

1. **Toast on failure.** Replace `console.error('[DiscussInTuning]
   failed:', err)` at `inbox-v5.tsx:4679` with:
   ```ts
   toast.error('Could not open tuning discussion', {
     description: err instanceof Error ? err.message : String(err),
   })
   ```
   Match the pattern `/tuning/sessions/page.tsx:401-403` already
   uses. Import `toast` from `sonner` at the top of the file if
   not already present (inbox-v5.tsx already uses `sonner` in a
   couple of places — verify).

2. **Busy state + visible click target.** Track a
   `discussingMsgId: string | null` state. While a discuss call is
   in flight, disable the button and show a subtle spinner (the
   pattern `/tuning/sessions/page.tsx:437-445` already implements
   is a good template). Bump the button's `padding` to `'2px 6px'`
   and `fontSize` to 10 so operators don't mis-click.

3. **Verify end-to-end.** Add a vitest for the button's click
   handler: mock `apiCreateTuningConversation` to resolve with a
   fake conversation, assert `updateStudioConversationId` was
   called with the right id and `setNavTab('studio')` followed.
   Then mock it to reject, assert the toast fires.

4. **Server-side smoke.** A one-liner to verify the endpoint works
   for Abdelrahman's tenant:
   ```bash
   curl -sS -X POST https://<staging>/api/tuning/conversations \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"triggerType":"MANUAL","anchorMessageId":"<real-msg-id>"}'
   ```
   Document in `validation/sprint-048-discuss-in-tuning-smoke.md`
   so the actual failure mode (if any) is visible — the code path
   audit came back clean, so staging output will tell us if it's a
   runtime issue or a UX issue.

**Acceptance.** SC-2a: clicking the button with a working backend
switches to Studio and shows the new conversation. SC-2b: clicking
with a failing backend shows a toast with the error message, not
a silent log. SC-2c: the button is visibly disabled while a
discuss call is in flight.

---

## 2. Out of scope — explicitly deferred

- **Backend wiring of `conversations.controller.ts#approveSuggestion`
  to fire the diagnostic on `editedText !== suggestion`.** The
  frontend never exercises that path today — fix later if the
  pill's arrow grows an edit-then-send option.
- **Unifying Path A + Path B.** The two legacy-Copilot code paths
  (`/messages` vs `/approve-suggestion`) do subtly different
  things (HOST role vs AI role message rows; different audit
  fields). A unification pass is a sprint 049 candidate.
- **Shadow Mode preview edit signal.** Already works —
  `shadow-preview.controller.ts:148-187` fires the diagnostic on
  preview edits. This session is Copilot-only.
- **The three `NEXT.md` §2.1 candidates** (raw-prompt editor edit
  path, RejectionMemory retention sweep, reject-card rationale
  input). All defer to Session B.

---

## 3. Non-negotiables

- `ai.service.ts` untouched. Main guest pipeline is not in scope.
- No schema changes. No `prisma db push`.
- `fromDraft` must default to `false` on every existing call site
  that doesn't go through the new edit affordance — the sprint-10
  false-positive lockdown is load-bearing.
- Diagnostic fire remains fire-and-forget. A 500 from the
  diagnostic pipeline must not bubble up to the HTTP response.
- Toast on failure must not leak stack traces — `err.message`
  only, not `err.toString()` or `JSON.stringify(err)`.

---

## 4. Sequencing + gate sheet

| Gate | Item                                                          | Status |
|------|---------------------------------------------------------------|--------|
| A1   | Edit-suggestion pill affordance + `seededFromDraft` state     | ☐      |
| A2   | `sendReply()` passes `fromDraft: true` when seeded + edited   | ☐      |
| A3   | Frontend vitest for A1/A2                                     | ☐      |
| A4   | Backend integration test for `fromDraft: true` fire path      | ☐      |
| A5   | Discuss-in-tuning toast + busy state + visible click target   | ☐      |
| A6   | Discuss-in-tuning vitest                                      | ☐      |
| A7   | `validation/sprint-048-discuss-in-tuning-smoke.md` (one-liner)| ☐      |
| A8   | Backend + frontend suites green; `tsc --noEmit` clean         | ☐      |
| A9   | PROGRESS.md updated + NEXT.md rewritten for Session B or close| ☐      |

Order: A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9. A3 and A4 can
be parallelised after A2 lands.

---

## 5. Success criteria

- **SC-1a.** Copilot-mode edit + send creates a `TuningSuggestion`
  row within 5s (fire-and-forget, so poll-friendly).
- **SC-1b.** Copilot-mode approve-as-is creates zero new
  `TuningSuggestion` rows.
- **SC-1c.** Copilot-mode fresh-type reply (no edit pill used)
  creates zero new `TuningSuggestion` rows. This preserves the
  sprint-10 false-positive guard.
- **SC-2a.** Clicking "discuss in tuning" on an AI message, with a
  working backend, opens Studio pinned to a new conversation with
  the AI message as anchor.
- **SC-2b.** Clicking with a 500 / network failure shows a toast,
  not silent failure.
- **SC-2c.** Button is disabled + spinner-stamped while the create
  call is in flight.
- **SC-3.** All backend + frontend suites green locally.
- **SC-4.** `tsc --noEmit` clean on both sides.
- **SC-5.** PROGRESS.md gains a "Sprint 048 — Session A"
  subsection; NEXT.md rewrites to Session B scope or sprint 049
  kickoff.

---

## 6. Exit handoff

Same pattern as sprint 047 sessions:

### 6.1 Commit + push

Per-gate commits. Branch `feat/048-session-a`. Push with
`--set-upstream` on first push.

### 6.2 Archive NEXT.md

Move `specs/045-build-mode/NEXT.md` →
`specs/045-build-mode/NEXT.sprint-048-session-a.archive.md`.

### 6.3 Update PROGRESS.md + write NEXT.md

If sprint-048 continues with Session B, NEXT.md becomes that
scope. If Session A lands alone and sprint-048 closes, NEXT.md
becomes the sprint-049 kickoff. End-of-stack merge-to-main is
still pending per sprint-047 Session C's exit — flag it in the
handoff.

---

## 7. Help channels

- If the A1 edit affordance surfaces a conflict with existing
  pill layout (the pill is position-absolute with a fixed-width
  right-aligned arrow button), land a minimum-viable version and
  file polish as a Session B scope item. Don't block the signal
  fix on styling.
- If the A4 integration test reveals the diagnostic pipeline is
  actually failing at runtime (not just ungated), stop and
  surface in PROGRESS.md "Decisions made → Blocked". The fix
  target then moves to the diagnostic service, not the
  controller gating.
- If the A7 smoke-curl reveals the Discuss endpoint is 500ing on
  staging/prod, treat it as a P1 and fix the backend before
  shipping A5/A6 polish — the toast-on-failure work is worthless
  if the endpoint never succeeds.

End of session brief.
