# Sprint 047 — Session A: Finish the 046 happy path

> First session of sprint 047. Scope is a deep-dive audit's fix list:
> five concrete bugs/gaps in the shipped-but-not-quite-functional
> sprint-046 Studio branch. No new features this session.
>
> Owner: Abdelrahman. Branch: **see §0.1 below** — pre-flight decision
> required before cutting the branch.

---

## 0. Read-before-you-start

These are mandatory reads, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — project constitution, critical
   rules, build/run commands. §"Critical Rules" is non-negotiable.
2. [`sprint-046-plan.md`](./sprint-046-plan.md) §§4.1, 4.4, 5.2, 5.5,
   6.3 — the contract-level specs for the response contract, rejection
   memory, recent-edit advisory, output linter, and audit-report card.
   Everything in this session's scope points back to one of these.
3. [`NEXT.md`](./NEXT.md) — sprint 047 kickoff scope. This session
   supersedes NEXT.md §1 as the first concrete work; NEXT.md's §1.1 /
   §1.2 shopping list remains the backlog for later sessions.
4. [`PROGRESS.md`](./PROGRESS.md) "Sprint 046 — closed" — the sprint-046
   exit state. Tells you what shipped and what was deferred.

Then read the code you'll touch:

- `backend/src/controllers/build-controller.ts` — `acceptSuggestedFix`
  is a documented stub (L301-343) and `rejectSuggestedFix` (L356-441)
  is the pattern to mirror.
- `backend/src/build-tune-agent/tools/suggestion-action.ts` — the
  existing apply path you're calling from the controller.
- `backend/src/build-tune-agent/tools/propose-suggestion.ts` — where
  `preview:*` ids are minted; the accept path for ephemeral ids needs
  to reconstruct the write from the emitted `data-suggested-fix` row.
- `backend/src/build-tune-agent/system-prompt.ts` — principle #8 is
  the stale one (grep for `48h cooldown`).
- `backend/src/build-tune-agent/output-linter.ts` — R1 advisory text
  lives in `buildLinterAdvisories`.
- `backend/src/build-tune-agent/hooks/pre-tool-use.ts` — the
  recent-edit advisory is gated on `suggestion_action`; needs to
  extend to BUILD write tools.
- `frontend/components/studio/studio-chat.tsx` — `<AuditReportCard>`
  mount is missing the `onViewRow` prop wiring.

---

## 0.1 Pre-flight — confirm branching strategy with owner

Per [`NEXT.md`](./NEXT.md) §2 open question 1, sprint 046 is
branch-deployed on `feat/046-studio-unification`, **not merged to
main**. Before cutting `feat/047-session-a`, confirm with Abdelrahman:

- **Option A.** Merge `feat/046-studio-unification` → `main` first,
  then branch `feat/047-session-a` off main. Clean base, but assumes
  046 is production-ready (spoiler: the five fixes in this session
  are exactly the reasons it isn't).
- **Option B.** Branch `feat/047-session-a` off
  `feat/046-studio-unification`, land this session's fixes, then
  merge the combined branch to main. This is the likely path given
  Accept-is-a-stub is a blocker for the 046 flip.

**Default: Option B.** If Abdelrahman isn't available at kickoff,
proceed with B and note it in PROGRESS.md. Do not branch off main
without the 046 branch merged — the Studio tab simply isn't there.

---

## 1. Context — why this session exists

A post-sprint-046 code audit surfaced five items that are either
regressions, documented stubs, or spec divergences that make the
shipped branch only partially functional. The Studio tab renders,
the agent grounds on turn 1, proposes fixes, and emits audit cards
— but:

1. When the manager clicks **Accept** on a suggested-fix card, the
   server no-ops. `acceptSuggestedFix` was written as a stub in
   Session C with `"real apply wiring lands in Session D"`; Session D
   closed without landing it.
2. The agent's shared prompt still contains a principle instructing
   it to work around a 48h cooldown that Session D removed. The agent
   will apologize for a constraint that no longer exists.
3. The R1 linter advisory tells managers `"(card omitted — …)"` when
   the linter never omits anything (own docstring, L14-17).
4. BUILD-mode writes (create_sop, create_faq, write_system_prompt,
   create_tool_definition) skip the recent-edit advisory entirely.
   Plan §5.2 scoped the advisory to both suggested-fix and BUILD-write
   paths.
5. The audit-report card's **View** buttons on non-top-finding rows
   call an undefined `onViewRow` prop. The button renders, onClick
   fires into a no-op.

Together these are the gap between "branch ships" and "product
works end-to-end." This session closes that gap. No new scope.

---

## 2. Scope — in this session

Five concrete changes. Each is a commit. Order matters — #1 is the
biggest, land it first.

### 2.1 Wire `acceptSuggestedFix` for real

**File:** `backend/src/controllers/build-controller.ts` L309-343.

Replace the stub with a real write path. Two cases to handle:

**Case A — `fixId` matches a PENDING TuningSuggestion row.**
Call the existing apply path in `suggestion-action.ts`
(`action: 'apply'`) via a direct function call — do not re-enter the
agent for this. The manager's click in the Studio UI **is** the
compliance signal, so bypass the hook-layer's
`detectApplySanction` check by setting
`compliance.lastUserSanctionedApply = true` on a short-lived context,
or by exposing an `applyFromController` helper in
`suggestion-action.ts` that takes an explicit `sanctionedBy: 'ui'`
argument. Prefer the helper approach — keeps the hook's sanction
check intact for agent-initiated paths, and the UI click is an
auditable user action with its own log trail.

**Case B — `fixId` is a `preview:*` ephemeral id.** No database row
exists. The `data-suggested-fix` payload the frontend rendered has
everything needed to execute the write: `target`, `before`, `after`,
`category`, `rationale`. Accept a POST body shaped like:

```ts
{
  target: FixTarget,
  before: string,
  after: string,
  category: string,
  rationale: string,
  conversationId: string,
}
```

Validate with zod, then execute the same apply path as Case A
(category → artifact dispatcher in `suggestion-action.ts`). Persist
a TuningSuggestion row with `status: 'ACCEPTED'` + `appliedAt: now()`
so the recent-edit/oscillation hooks have a history entry to detect
against, and so admin-only trace views can reconstruct the accept.

**Frontend changes in the same commit:**
- `frontend/lib/build-api.ts#apiAcceptSuggestedFix` — extend the body
  to include the above fields when no DB id exists (detect by
  prefix `preview:`).
- `frontend/components/studio/studio-chat.tsx` L432-445 — thread
  `conversationId`, `before`, `after`, `rationale`, `category`,
  `target` from the card into the accept call.

**Tests:**
- Unit: accept with a PENDING row → suggestion status flips to
  ACCEPTED, artifact is written, TuningSuggestion.appliedAt set.
- Unit: accept with a `preview:*` id + full payload → new
  TuningSuggestion row created in ACCEPTED state + artifact written.
- Unit: accept with a missing `conversationId` on a preview id →
  400 `MISSING_CONVERSATION_ID`.
- Integration: the recent-edit advisory fires on a second
  suggestion_action apply targeting the same artifact within 48h
  (proves the Case B write actually populated history).

**Acceptance.** Full E2E smoke: in a staging conversation, the agent
emits a `data-suggested-fix`, manager clicks Accept, artifact is
actually modified (diff visible in `/sops` or wherever the target
lives), and a second accept on the same artifact surfaces the
recent-edit advisory.

### 2.2 Retire stale principle #8

**File:** `backend/src/build-tune-agent/system-prompt.ts` L163-165.

The current text:

> 8. Cooldown is real. 48h cooldown on the same artifact target is
>    enforced by a hook for edits in TUNE mode. If a suggestion is
>    blocked, explain to the manager and offer alternatives rather
>    than arguing with the hook.

Replace with a principle matching actual runtime behaviour per plan
§5.2:

> 8. Recent edits surface as advisories, not blocks. If a
>    `data-advisory` with `kind: 'recent-edit'` or `'oscillation'`
>    accompanies a proposal, acknowledge it plainly ("This was edited
>    Nh ago — here's why I still recommend the change") rather than
>    backing off by default. The manager is the decider.

Update the `prompt-cache-stability.test.ts` baseline for Region A
by whatever delta results (likely neutral; same rough length).
Record new baseline in PROGRESS.md.

**Acceptance.** `prompt-cache-stability.test.ts` green with updated
baseline. Agent no longer apologizes about a 48h cooldown in
manual smoke.

### 2.3 Fix the R1 advisory text

**File:** `backend/src/build-tune-agent/output-linter.ts`
`buildLinterAdvisories` R1 branch (~L166-173).

Pick one path:

- **Path A (preferred, low risk).** Rewrite the message to match
  actual behaviour: `"Agent reply was long-form prose without a
  structured card. Asking for a card-shaped summary usually helps."`
  Keep the advisory transient, drop the phrase "card omitted" — it
  isn't accurate.
- **Path B.** Actually truncate the persisted text to the first
  sentence at persistence time and keep the original wording. This
  requires a hook into the Vercel AI SDK `onFinish` path that
  rewrites the DB-persisted text part. Heavier lift; defer unless
  Langfuse shows prose-heavy turns surviving Path A's advisory
  without self-correction.

Default: ship Path A. Document the choice in PROGRESS.md decisions.

**Tests:** update `output-linter.test.ts` assertions for the new R1
advisory message.

**Acceptance.** Tests green; manual smoke shows the advisory text
reading as true.

### 2.4 Extend recent-edit advisory to BUILD writes

**File:** `backend/src/build-tune-agent/hooks/pre-tool-use.ts`.

The current hook early-returns on L62-64 for anything except
`suggestion_action`. Plan §5.2 scoped recent-edit and oscillation
advisories to `suggested_fix OR plan_build_changes item` — in
practice, BUILD mode writes directly via `create_sop`, `create_faq`,
`create_tool_definition`, `write_system_prompt` and skips the
advisory entirely.

Extend the hook to:

1. Recognize the BUILD creator tool names as a separate intercept
   path: `BUILD_WRITE_TOOLS = [create_sop, create_faq,
   create_tool_definition, write_system_prompt]`.
2. For each, derive a `FixTarget`-shaped target from the tool input
   (reuse `artifactTargetWhere` logic — BUILD creators carry
   sopCategory, faqEntryId, variant, etc. inline in `pre.tool_input`).
3. Emit the same `data-advisory` payloads (`kind: 'recent-edit'`,
   `kind: 'oscillation'`) when the target was last written within
   the respective window. Never block.

No compliance check on BUILD creators — they're direct-write by
design, not manager-sanctioned applies.

**Tests:** extend `pre-tool-use.test.ts`:
- create_sop on an artifact last written 10h ago → advisory emitted.
- create_sop on an artifact never written → no advisory.
- create_faq with no advisory ever emitted doesn't block the tool.

**Acceptance.** Tests green.

### 2.5 Wire audit-report View buttons

**File:** `frontend/components/studio/studio-chat.tsx` L466-485.

The `<AuditReportCard>` mount passes `onFixTopFinding` but not
`onViewRow`. Every non-top-finding row renders a View button that
onClicks into undefined. Wire:

```tsx
onViewRow={(row) => {
  const label =
    row.artifactId
      ? `Show me the current ${row.artifact} (${row.artifactId}).`
      : `Show me the current ${row.artifact}.`
  onSendText?.(label)
}}
```

This sends a natural-language turn that the agent will route into
`get_current_state` with the matching scope. Consistent with how
the rest of Studio talks to the agent.

**Tests:** component-level React test: mount the card with 3 rows
(1 top, 2 non-top), click a non-top View button, assert the
provided `onSendText` mock received the expected string.

**Acceptance.** Manual smoke in the same conversation that surfaced
the audit-report in the screenshot: every View button on the card
produces an assistant turn that renders the relevant artifact.

---

## 3. Out of scope — explicitly deferred

Do not touch in Session A, even if tempting:

- D9 admin-only `BuildToolCallLog` trace view + 30-day retention
  sweep — sprint 047 Session B/C per NEXT.md §1.1.
- Cross-session rejection memory — design exercise, Session B.
- R2 enforcement observability dashboard — Session B or C.
- Raw-prompt editor drawer — admin-only, later session.
- Deletion of `/build`, `/tuning`, `/tuning/agent` redirect stubs —
  low risk, can ship with any later session.
- Any new agent tools, new data-part types, new Studio cards.

If you find yourself adding a feature, stop. This session is a
bug-fix session.

---

## 4. Sequencing + gate sheet

| Gate | Item                                                     | Status |
|------|----------------------------------------------------------|--------|
| S1   | `acceptSuggestedFix` wired for PENDING + preview ids     | ☐      |
| S2   | Stale principle #8 replaced; cache baseline updated      | ☐      |
| S3   | R1 advisory text fixed (Path A unless owner overrides)   | ☐      |
| S4   | Recent-edit/oscillation extended to BUILD writes         | ☐      |
| S5   | Audit-report View buttons wired via `onSendText`         | ☐      |
| S6   | Full backend + frontend test suites green; `tsc` clean   | ☐      |
| S7   | PROGRESS.md updated + NEXT.md rewritten for Session B    | ☐      |

Don't move a gate forward until the prior one compiles and tests
green.

---

## 5. Success criteria (this session)

Session A is done when all of these are true:

- **C-1.** Manager clicks Accept on a suggested-fix card in staging,
  the target artifact is actually modified, and a fresh
  `TuningSuggestion` row with `status: 'ACCEPTED'` + `appliedAt`
  exists.
- **C-2.** Fresh conversation's agent no longer mentions any 48h
  cooldown constraint. Manual 5-turn smoke in BUILD + TUNE modes.
- **C-3.** R1 advisory text accurately describes what happened (no
  "omitted" phrasing unless truncation actually ships).
- **C-4.** BUILD `create_sop` on a recently-edited SOP emits a
  `data-advisory` with `kind: 'recent-edit'` without blocking.
- **C-5.** Every non-top-finding View button in a
  `data-audit-report` card fires an agent turn that renders the
  target artifact.
- **C-6.** `tsc --noEmit` clean (backend + frontend). `npm test`
  green across `build-tune-agent/*`, controllers, and
  `frontend/components/studio/*`.
- **C-7.** PROGRESS.md has a "Sprint 047 — Session A" subsection
  with S1–S7 gate status + decisions + any deferrals.
- **C-8.** NEXT.md rewritten for sprint 047 Session B, covering
  the sprint-047 backlog items in NEXT.md §1.1 / §1.2 that make
  sense as the next unit of work.

---

## 6. Non-negotiables

- Never break the main guest messaging flow. `ai.service.ts` is not
  in scope; if the accept-wiring work in §2.1 touches service code
  reused by the main pipeline, add a regression test.
- Prisma changes (none planned) apply via `prisma db push`, not
  migrations.
- The recent-edit advisory extension (§2.4) must never block a tool
  call. Advisory only.
- The accept path (§2.1) must be idempotent — double-clicks on
  Accept from a flaky network must not create two TuningSuggestion
  rows or apply the same edit twice. Use `fixId` as an idempotency
  key in the controller.
- Auth: every new POST accepts + reject endpoint uses the existing
  `AuthenticatedRequest` middleware + tenantId scoping. No
  shortcuts.
- Do not push without tests green locally. Railway auto-deploys the
  branch — a bad push is a bad deploy.

---

## 7. Exit handoff

At session end, do all three:

### 7.1 Commit + push

Single commit per gate is fine. Branch per §0.1 decision. Push with
`--set-upstream` on first push.

### 7.2 Archive the current NEXT.md

Move `specs/045-build-mode/NEXT.md` →
`specs/045-build-mode/NEXT.sprint-047-kickoff.archive.md`. That file
is the sprint-047 kickoff scope and isn't the live handoff doc
anymore.

### 7.3 Update PROGRESS.md and write NEXT.md

PROGRESS.md — append:

```markdown
## Sprint 047 — Session A (bug-fix: finish the 046 happy path)

Completed: YYYY-MM-DD.

| Gate | Item | Status | Notes |
|------|------|--------|-------|
| S1   | ...  | ✅     | ...   |
| ...  | ...  | ...    | ...   |

### Decisions made this session

- §2.3 path chosen: A or B, why.
- §2.1 apply helper signature: details.

### Deferred to next session

- (anything that slipped)
```

NEXT.md — rewrite for sprint 047 Session B. Base the scope on
NEXT.md §1.1 + §1.2 backlog + whatever surfaced during this
session's smoke tests.

---

## 8. Help channels

- If the `acceptSuggestedFix` apply helper can't land without
  touching `suggestion-action.ts`'s hook-compliance flow cleanly,
  stop and surface in PROGRESS.md "Decisions made → Blocked". The
  right shape may be a new `applyArtifactChange` service function
  that both the hook-gated agent path and the controller path call
  into. Don't paper it over with a `skipComplianceCheck: true` flag
  on the existing function.
- If the BUILD-write advisory wiring in §2.4 would require
  reshaping the hook event flow (e.g., a tool the hook doesn't
  currently intercept), log the finding and ship only the clean
  subset. Partial advisory is fine; a broken hook is not.
- If `prompt-cache-stability.test.ts` drifts more than ~200 tokens
  from the §2.2 rewrite, pause and re-examine — the replacement
  principle should be roughly length-neutral.

End of session brief.
