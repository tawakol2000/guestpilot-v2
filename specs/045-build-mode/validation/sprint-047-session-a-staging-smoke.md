# Sprint 047 — Session A: Staging wet-test

**Purpose.** Four manual click-through checks that must pass on staging
before `feat/047-session-a` (or its merge to main) is flipped to
production. Session A's S1 is the largest behavioural change on the
046+047 branch — apply-on-accept actually writes for the first time —
and is the one thing that can't be unit-tested without a real JWT +
live Railway DB.

**Status:** ☐ pending staging deploy.

**Deploy target.** Railway staging, `feat/047-session-a` branch head
(commit `14a19e7` at session close; verify at run time with
`git rev-parse HEAD`). Vercel preview on the paired frontend branch.

**Required env on the staging instance.**
- `ENABLE_BUILD_MODE=true`
- `ANTHROPIC_API_KEY` — live key, not a placeholder.
- `DATABASE_URL` pointing at the staging Postgres (not production).
- At least one tenant with a real Hostaway-sync'd property set and
  ≥1 existing SOP + ≥1 existing FAQ so §C-2 has something to
  propose against.

---

## Pre-flight — nullable-FK audit

Before the staging deploy, from the repo root:

```bash
grep -rn "sourceMessageId" backend/src frontend
```

Flag any callsite that:
- dereferences with `!` (non-null assertion)
- is typed `string` (not `string | null`) on a function parameter
  that receives the field
- is serialised into a response the frontend expects to always have

Previously this column was NOT NULL; Session A's `prisma db push`
made it nullable so Studio-origin accepts (which have no inbox-message
anchor) can write. Existing callsites may still treat it as required
at the type level or at runtime.

**Exit criterion.** Either (a) grep comes back with zero hits outside
the writer and rollback paths that already graceful-skip null, or
(b) each surfaced callsite is patched in a follow-on commit on
`feat/047-session-a` before the staging deploy.

---

## C-1 — Accept a Studio-origin suggested fix and verify the write

**Setup.** Sign in as a manager on the staging frontend. Open a
tenant that already has SOPs or FAQs (so the agent has something to
propose a concrete edit against, not a greenfield walkthrough).

**Steps.**

1. Go to the Studio tab (`/?tab=studio`).
2. Send: `Review my checkout SOP and suggest one improvement.`
3. Wait for the agent to emit a `data-suggested-fix` card. Confirm
   the card shows rationale + before/after diff + an Accept button.
4. Click **Accept**. Toast should say "Fix accepted."
5. Open a second browser tab to the SOPs page (or the relevant
   artifact page). Confirm the artifact text has actually changed
   to the `after` content from the card.
6. In a DB client (Prisma Studio or psql), query:
   ```sql
   SELECT id, status, "appliedAt", "sourceMessageId", "diagnosticCategory"
   FROM "TuningSuggestion"
   WHERE "tenantId" = '<your tenant id>'
   ORDER BY "createdAt" DESC
   LIMIT 3;
   ```
   Expect one fresh row with `status = 'ACCEPTED'` and `appliedAt`
   set to ~now. `sourceMessageId` will be NULL for Studio-origin
   accepts — that's the schema change.

**Pass criteria.**
- [ ] Artifact text actually changed on disk.
- [ ] A `TuningSuggestion` row exists with `status='ACCEPTED'` and
      `appliedAt` populated.
- [ ] No 500 in the browser devtools Network tab on the accept call.
- [ ] Toast renders "Fix accepted", not an error.

**Failure modes to watch for.**
- Controller returns 500 with `ACCEPT_FAILED` — check Railway logs
  for the stack trace. Most likely a null-pointer on the newly
  nullable `sourceMessageId` in a downstream consumer.
- Accept appears to succeed but the artifact is unchanged — the
  controller hit the PENDING-row path but the dispatcher silently
  no-op'd. Check `build-controller.ts#acceptSuggestedFix` resolved
  the correct branch (PENDING vs preview).
- Toast says success but no `TuningSuggestion` row appears — the
  preview-id branch didn't persist. Check `writeAcceptedSuggestion`
  (or equivalent) actually committed.

---

## C-2 — Agent no longer apologises about the 48h cooldown

**Setup.** Same staging tenant. Pick an artifact you just
modified in C-1 or one that has an `appliedAt` within the last 48h.

**Steps.**

1. Open a fresh conversation in the Studio tab (new chat, not a
   continuation).
2. Send: `Take another look at <that artifact> — I think there's
   still a gap.`
3. Read the full agent response end to end.

**Pass criteria.**
- [ ] No mention of "48 hour cooldown," "cooldown window,"
      "blocked by the hook," or similar language.
- [ ] The agent may reference that the artifact was "recently
      edited" (via the `data-advisory` with `kind: 'recent-edit'`)
      but treats it as context, not as a reason to refuse.
- [ ] If the agent proposes a new edit, it does so at confidence
      set by its own judgment — no artificial backoff.

**Failure modes to watch for.**
- Agent opens with "I notice a 48 hour cooldown is in effect…" →
  principle #8 retirement did not ship, or the system-prompt cache
  is serving a stale prefix. Check Langfuse for the actual Region A
  bytes sent.

---

## C-4 — BUILD-write advisory fires on a recently-touched artifact

**Setup.** BUILD mode requires `ENABLE_BUILD_MODE=true` on the
backend. Use the same tenant.

**Steps.**

1. In Studio, send: `Let's switch to BUILD. Rewrite the coordinator
   system prompt's escalation section to be more conservative.`
2. Wait for the agent to emit its build plan or call
   `write_system_prompt` directly.
3. Observe whether a `data-advisory` card with `kind: 'recent-edit'`
   renders above the write.

**Pass criteria.**
- [ ] Advisory card renders with the recent-edit copy ("This artifact
      was last edited on <ISO timestamp>.").
- [ ] The write itself still executes — advisory is non-blocking.
- [ ] The new SOP/prompt text is written (verify on the artifact
      page).

**Failure modes to watch for.**
- Write executes but no advisory renders → §2.4 wiring shipped but
  the hook didn't fire for this tool name. Check
  `pre-tool-use.ts#BUILD_WRITE_TOOLS` includes the tool the agent
  called.
- Advisory renders but the write is blocked → the extension
  regressed the "advisory only, never block" invariant. Critical.
  Check for a `continue: false` in the BUILD-write path of
  `pre-tool-use.ts`.

---

## C-5 — Audit-report View buttons actually render artifacts

**Setup.** Same tenant. Conversation with enough history that an
audit makes sense — or greenfield, the agent will still emit an
audit card on a broad "review my setup" prompt.

**Steps.**

1. In Studio, send: `Review my full setup — prompts, SOPs, FAQs,
   tools, properties. Tell me the biggest gaps.`
2. Wait for the agent to emit a `data-audit-report` card with 3+
   rows.
3. Identify a row that is NOT the top finding (no Fix button,
   only a View button — should be every row except one).
4. Click **View**.
5. Observe the next agent turn.

**Pass criteria.**
- [ ] Clicking View sends a visible user turn (should read
      something like `Show me the current sop.` or
      `Show me the current faq (abc123).`).
- [ ] Agent responds with the artifact contents — likely via a
      `get_current_state` call whose result is rendered in the
      next assistant turn.
- [ ] Repeating on a second non-top-finding row works the same
      way (no silent failures on the second click).

**Failure modes to watch for.**
- Click does nothing → `onViewRow` prop not wired in
  `studio-chat.tsx`, or the prop is wired but `onSendText` isn't
  passed down. §2.5 regression.
- Click sends the prompt but the agent doesn't call
  `get_current_state` — the agent is ignoring natural-language
  intent. Not a session-A issue; log but don't block the flip.

---

## Exit

**If all four pass** — proceed with the flip. Merge
`feat/047-session-a` → `main` (or `feat/046-studio-unification` →
`main` with Session A rolled in, depending on §0.1 decision). Update
this file with `Status: ✅ PASSED on YYYY-MM-DD` and add a line at
the bottom noting the commit sha of the deploy that passed.

**If any fail** — stop. Do not flip. File the failing check(s) as
issues on `feat/047-session-a` and fix in a follow-on commit before
re-running the smoke.

**Sprint 047 Session B is blocked** on this smoke passing per the
Session B pre-flight gate in
[`sprint-047-session-b.md`](../sprint-047-session-b.md) §0.1.

End of wet-test.
