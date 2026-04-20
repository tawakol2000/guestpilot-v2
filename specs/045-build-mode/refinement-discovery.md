# Sprint 045 — Refinement Discovery Report

> Audit date: 2026-04-20
> Branch: `feat/045-build-mode`
> Auditor: Claude (Opus 4.7) via four parallel Explore subagents + spot-verification
> Scope: discovery only. No code or doc edits made. No screenshots captured —
> static audit (see §F).

---

## Summary

Sprint 045's gate-by-gate close was clean, but the shipped artifact has a
small cluster of **real drift issues** that will bite the first manager to
actually use `/build` in anger. The most critical is that the BUILD system
prompt still instructs the agent to call a tool named `preview_ai_response`
— a tool that was explicitly re-scoped to `test_pipeline` in session 3 and
no longer exists in the allow-list. The agent will try to call it, the SDK
will deny, and the manager will see a confusing failure mid-interview.

Three other items land in the "fix before flipping the flag in prod" bucket:
`BuildTransaction` can get stuck in `EXECUTING` forever (no code path ever
sets `COMPLETED`), the rollback button fires `window.confirm()` instead of a
styled modal, and CLAUDE.md's "Key Services" table omits every sprint-045
service so new contributors have no map of the BUILD surface. Roughly a day
of focused work to fix the critical set; the rest can wait for sprint 046 or
be marked as accepted-for-pilot.

Count: **23 findings** across six audit areas. **2 critical**, **7
moderate**, **6 minor**, **8 investigate/pass-noted**. No silent omissions —
every thing the subagents flagged has been cross-checked.

---

## A. Code-versus-spec contradictions

### A1. BUILD system prompt still names `preview_ai_response` [critical]

**Where:** [backend/src/build-tune-agent/system-prompt.ts:207,209,284,480-481](backend/src/build-tune-agent/system-prompt.ts:207)
**Spec:** §11 (re-scoped 2026-04-19) — the tool is `test_pipeline`, single
message in, Sonnet-4.6-graded reply out. Golden-set/adversarial batch
infrastructure is deferred to sprint 047+.
**Code:** Four distinct places in the shared system prompt still describe
`preview_ai_response`:
- `TOOLS_DOC` lines 207, 209 — names it as a callable tool for both BUILD
  and TUNE allow-lists.
- `TOOLS_DOC` line 284 — full entry: `preview_ai_response({testMessages,
  includeGoldenSet?, includeAdversarial?, judgeModel?})`.
- BUILD addendum orchestration block lines 480-481 — instructs the agent
  to "run `preview_ai_response` against the property's golden set + 5-10
  agent-generated adversarial messages per new SOP."

The actual registered tool is `test_pipeline` ([backend/src/build-tune-agent/tools/test-pipeline.ts](backend/src/build-tune-agent/tools/test-pipeline.ts))
with single-message parameters. If the agent follows the prompt
literally, it will emit a tool call for `preview_ai_response`, the SDK's
`allowed_tools` filter will deny it, and the manager will see a failed
tool invocation.

**Severity: critical.** This is the #1 ship-blocker. The individual
tool-file descriptions (`create_*`, `test_pipeline`) are correct, but the
shared prompt that gates agent behavior is wrong.

---

### A2. BUILD allow-list includes `rollback`; spec §2 table does not [moderate]

**Where:** [backend/src/build-tune-agent/runtime.ts:106](backend/src/build-tune-agent/runtime.ts:106)
**Spec:** §2 allow-list table — BUILD mode = `get_context, memory,
search_corrections, create_sop, create_faq, write_system_prompt,
create_tool_definition, plan_build_changes, test_pipeline,
get_version_history`. No `rollback`.
**Code:** BUILD allow-list at runtime.ts:101-115 includes `rollback` (11
tools instead of 10).

Adding rollback to BUILD is arguably a reasonable design choice — the
manager might want to undo a plan mid-interview — but it contradicts the
spec table and the deviation isn't recorded in PROGRESS.md's "Decisions
made this sprint" section. Either the spec table needs an update, or the
allow-list needs trimming.

**Severity: moderate** — functional drift, not a bug, but the gap between
spec and code is exactly the kind of thing that confuses reviewers in
sprint 046.

---

### A3. Individual tool descriptions match spec §11 [pass]

Verified by reading each of the six BUILD/orchestration tool files:
- [create-sop.ts:43-54](backend/src/build-tune-agent/tools/create-sop.ts:43)
- [create-faq.ts:21-31](backend/src/build-tune-agent/tools/create-faq.ts:21)
- [write-system-prompt.ts:75-84](backend/src/build-tune-agent/tools/write-system-prompt.ts:75)
- [create-tool-definition.ts:40-51](backend/src/build-tune-agent/tools/create-tool-definition.ts:40)
- [plan-build-changes.ts:20-26](backend/src/build-tune-agent/tools/plan-build-changes.ts:20)
- [test-pipeline.ts:81-87](backend/src/build-tune-agent/tools/test-pipeline.ts:81)

Each tool's description string carries the WHEN TO USE / WHEN NOT TO USE
/ PARAMETERS / RETURNS template verbatim. No drift at the tool-file
level. The drift is exclusively in the shared system prompt (see A1).

---

### A4. Slot keys align perfectly between template and constants [pass]

[backend/src/build-tune-agent/templates/generic-hospitality-seed.md](backend/src/build-tune-agent/templates/generic-hospitality-seed.md)
declares 20 `{{}}` placeholders; [write-system-prompt.ts:39-64](backend/src/build-tune-agent/tools/write-system-prompt.ts:39)
defines `LOAD_BEARING_SLOTS` (6) + `NON_LOAD_BEARING_SLOTS` (14). Names
and counts match exactly. The template.test.ts suite (9 tests) locks
this alignment; drift will break CI.

---

### A5. SSE part types round-trip cleanly [pass]

Backend emits `data-build-plan` ([plan-build-changes.ts:77](backend/src/build-tune-agent/tools/plan-build-changes.ts:77))
and `data-test-pipeline-result` ([test-pipeline.ts:164](backend/src/build-tune-agent/tools/test-pipeline.ts:164));
frontend parses both in [build-chat.tsx](frontend/components/build/build-chat.tsx)
and passes the first into [plan-checklist.tsx](frontend/components/build/plan-checklist.tsx),
the second into [test-pipeline-result.tsx](frontend/components/build/test-pipeline-result.tsx).
No emit-without-parse or parse-without-emit asymmetry.

---

## B. Runtime bugs and edge cases

### B1. `BuildTransaction` can get stuck in `EXECUTING` forever [critical]

**Where:** [backend/src/build-tune-agent/tools/build-transaction.ts:50-70](backend/src/build-tune-agent/tools/build-transaction.ts:50)
+ entire build-controller.ts + plan-build-changes.ts flow
**Behavior:** `PLANNED → EXECUTING` flips on the first `create_*` call
that references the transactionId. No code path ever flips `EXECUTING →
COMPLETED` or `EXECUTING → PARTIAL`. The status-code enum includes
`COMPLETED | PARTIAL` but nothing writes them.
**Consequences:**
- A successful 3-artifact plan ends with status still `EXECUTING`.
  Manager has no "this transaction completed cleanly" signal.
- A mid-plan failure (e.g. `create_faq` throws) leaves the transaction
  in `EXECUTING`. The guard at line 51 only blocks new items if status
  is `COMPLETED | PARTIAL | ROLLED_BACK`, so **further `create_*` calls
  on the same txId still succeed** and silently add items to the broken
  plan.
- `TransactionHistory` UI has no way to visually distinguish "in flight"
  from "stuck".

**Severity: critical.** This is the second ship-blocker. Orphaned
transactions accumulate one per BUILD session. Even absent failure, the
most recent transaction always shows as executing because nothing closes
it.

---

### B2. `ENABLE_BUILD_MODE` env check is stricter than its comment claims [minor]

**Where:** [backend/src/build-tune-agent/config.ts:38-44](backend/src/build-tune-agent/config.ts:38)
**Behavior:** Checks `trim().toLowerCase()` against a whitelist of
`'1' | 'true' | 'yes' | 'on'`. `"TRUE"` works after lowercasing;
`" true "` works after trimming. `"enabled"`, `"yeah"`, integer `1`
through env (which always arrives as string), empty string all correctly
fail-closed.

The comment on line 38 says "Any truthy string enables BUILD" — this
overstates flexibility. The implementation is a whitelist, not a
truthy check.

**Severity: minor** — strict fail-closed is the safe default. Just a
doc-comment bug.

---

### B3. Second rollback call on same transaction returns 409 [pass]

Verified at [version-history.ts:212](backend/src/build-tune-agent/tools/version-history.ts:212)
and [build-controller.ts:341](backend/src/controllers/build-controller.ts:341).
If status is already `ROLLED_BACK`, the tool returns an error;
controller sniffs the message and maps it to HTTP 409. Not idempotent-OK
(a user double-tapping gets an error, not a no-op success) but not a
cascade-delete either. Acceptable behavior; worth documenting.

---

### B4. `hasRunThisTurn` guard scopes correctly [pass]

[test-pipeline.ts:89,122-128](backend/src/build-tune-agent/tools/test-pipeline.ts:89)
stores the flag on `ToolContext.turnFlags`, which is recreated fresh
every turn at [runtime.ts:294](backend/src/build-tune-agent/runtime.ts:294).
No cross-conversation leak; no cross-turn leak. A tool error still
sets `hasRunThisTurn=true` (good — prevents retry-loops on the same
turn). Test at [test-pipeline.test.ts:130-140](backend/src/build-tune-agent/tools/__tests__/test-pipeline.test.ts:130)
confirms.

---

### B5. `bypassCache` does NOT reach the SOP-content cache [moderate]

**Where:** [test-pipeline-runner.ts:78](backend/src/build-tune-agent/preview/test-pipeline-runner.ts:78)
+ [sop.service.ts:51,101](backend/src/services/sop.service.ts:51)
**Behavior:** The bypass flag only propagates to `getTenantAiConfig`.
The dry pipeline run also calls `collectSopContext()` → `getSopContent()`,
and `getSopContent()` has its own in-module 5-minute cache that is not
parameterized by any bypass flag.
**Consequence:** A manager writes a new SOP via `create_sop`, then
immediately runs `test_pipeline`. The tenant-config is fresh (bypass
works), but the SOP lookup returns stale data for up to 5 minutes. The
`test_pipeline` result doesn't reflect the freshly-written artifact.

**Severity: moderate.** Directly contradicts the sprint's R4 mitigation
claim ("test_pipeline is the done-oracle — the manager runs a
representative guest message after each meaningful create_* and confirms
the judge score…"). If the new SOP isn't visible to the run, the
manager can't trust the score.

---

### B6. `getInterviewProgressSummary` handles missing memory gracefully [pass]

[tenant-state.service.ts:196-224](backend/src/services/tenant-state.service.ts:196).
Empty memory → 0 coverage, no throw. Misnamed slot keys (e.g.
`slot_brand_voice` vs expected `slot/brand_voice`) don't match the
prefix → silently return 0. Unknown slot keys that happen to match the
prefix are filtered against `ALL_SLOT_KEYS` before counting. Null
conversationId is pre-checked in the controller at
[build-controller.ts:91-94](backend/src/controllers/build-controller.ts:91)
(rejects 400 before reaching the service).

---

### B7. `/api/build/*` 404-before-auth ordering is correct [pass]

[backend/src/routes/build.ts:23-46](backend/src/routes/build.ts:23) —
`isBuildModeEnabled()` middleware at line 29-35 runs before
`authMiddleware` at line 37. Unauthenticated probes see 404, not 401.
Matches spec §1 hard-gate requirement.

---

### B8. `write_system_prompt` does not invalidate tenant-config cache [moderate/accepted]

**Where:** [write-system-prompt.ts:216-224](backend/src/build-tune-agent/tools/write-system-prompt.ts:216)
**Status:** Documented in PROGRESS.md ("tenant-config cache invalidation
deferred to 60s TTL on write_system_prompt"). A comment in the tool
file explains the transitive-import problem (`tenant-config.service →
ai.service → socket.service → middleware/auth → process.exit(1)`).
**Consequence:** Post-write, the main AI pipeline keeps serving the old
prompt for up to 60 seconds. BUILD flows don't care because
`test_pipeline` bypasses the cache. But if the manager clicks
"ship to prod" and a real guest message arrives within the TTL window,
the guest gets the pre-write behavior.

**Severity: moderate** but **accepted-for-pilot** per PROGRESS.md.
NEXT.md §1.2 already scopes the lean-extraction fix for sprint 046.

---

## C. Design-flow issues

### C1. TUNE hooks implicitly exempt BUILD tools, not explicitly [moderate]

**Where:** [pre-tool-use.ts](backend/src/build-tune-agent/hooks/pre-tool-use.ts)
+ [post-tool-use.ts](backend/src/build-tune-agent/hooks/post-tool-use.ts)
The pre-tool hook's compliance/cooldown/oscillation logic only fires on
`suggestion_action`; everything else passes through with
`{ continue: true }`. That is what the spec wants — spec §13 says
"cooldown/oscillation checks skip entirely for the new BUILD tools" —
but the skip is achieved by omission (nothing intercepts them), not by
a named guard. If a future sprint adds a hook check that assumes
generic "any tool counts," BUILD tools will silently leak into
TUNE-style gating without anyone noticing at review time.

**Severity: moderate** — latent fragility, no current bug.

---

### C2. No server-side enforcement of "approved before execute" [investigate]

**Where:** [build-transaction.ts:40-71](backend/src/build-tune-agent/tools/build-transaction.ts:40)
+ [plan-build-changes.ts](backend/src/build-tune-agent/tools/plan-build-changes.ts)
The spec relies on the agent's BUILD addendum to wait for `approvedAt`
before calling `create_*` on a transactionId. Server-side,
`validateBuildTransaction` checks only that the transaction exists and
is not terminal; it does NOT check `approvedAt`. A prompt-level agent
failure → writes proceed without explicit sanction.

NEXT.md §4 already flags this as a pilot-acceptable / beta-blocker
open question. Confirming here that nothing has changed.

**Severity: investigate / accepted-for-pilot.**

---

### C3. No `EXECUTING → COMPLETED` transition [critical — see B1]

Repeat of B1. Architecturally this is a state-machine hole more than a
runtime bug; grouping it here too for completeness. The fix belongs in
the tool-layer — a `finalizeBuildTransaction(txId, outcome)` call emitted
when the agent declares the plan done, or a timer-based sweeper.

---

### C4. Slot-persistence instruction is clear but untested [moderate]

**Where:** [system-prompt.ts](backend/src/build-tune-agent/system-prompt.ts)
BUILD addendum (grep for `session/{conversationId}/slot/`)
The instruction names the exact memory-key format and when to write.
However:
- No integration test seeds these memory entries.
- No test asserts the agent actually writes them.
- The entire `<interview_progress>` dynamic block depends on this
  discipline holding at runtime.

If the agent's adherence rate on this directive drops below ~90%, the
interview-progress widget silently shows under-coverage, graduation
detection fails, and the manager gets mis-signaled completion state.

NEXT.md §4 open-question #1 flags the adherence rate as "to be
measured in prod." Fine as a sprint-046 item; flagged here so it isn't
forgotten.

**Severity: moderate** — load-bearing feature with no regression net.

---

### C5. `create_tool_definition` doesn't invalidate tenant-config cache [minor]

**Where:** [create-tool-definition.ts:140](backend/src/build-tune-agent/tools/create-tool-definition.ts:140)
Invalidates the tool-cache, not the tenant-config cache. If the system
prompt's `{SYSTEM_TOOLS_AVAILABLE}` placeholder ever gets cached
upstream of tool-cache, a newly-created tool won't appear in the main
pipeline for 60s. No current bug; future-fragility.

---

## D. Documentation drift

### D1. CLAUDE.md "Key Services" table omits every sprint-045 service [critical]

**Where:** [CLAUDE.md:33-59](CLAUDE.md:33)
Missing entries:
- `tenant-state.service.ts` — shipped Gate 5; `getTenantStateSummary` +
  `getInterviewProgressSummary` are called every BUILD turn.
- `test-judge.ts` + `test-pipeline-runner.ts` — shipped Gate 3; core of
  the preview loop.
- Memory service in `build-tune-agent/memory/service.ts` — load-bearing
  for slot persistence.

New contributors orienting via CLAUDE.md see zero map of the BUILD
surface. Given the repo is multi-sprint with 045 being freshly-shipped,
this is a real onboarding hazard. Severity bumped to **critical**
because the sprint is declared "closed" but the orientation doc
suggests it wasn't shipped.

---

### D2. PROGRESS.md token baselines are observational, not locked [minor]

**Where:** [PROGRESS.md:67-73](specs/045-build-mode/PROGRESS.md:67)
vs [prompt-cache-stability.test.ts:189-221](backend/src/build-tune-agent/__tests__/prompt-cache-stability.test.ts:189)
The test logs token counts and asserts the 2048-token floor; it does
NOT lock the exact baseline numbers (2,399 / 2,856 / 3,475 / 3,748).
If someone edits the system prompt, the numbers drift without breaking
CI. PROGRESS.md reads as authoritative, but the test is looser than
PROGRESS.md claims.

---

### D3. `preview_ai_response` references in spec files are properly scoped [pass]

[spec.md](specs/045-build-mode/spec.md) and
[system-prompt.md](specs/045-build-mode/system-prompt.md) mention
`preview_ai_response` only in historical / re-scope context with
explicit "deferred" language. No stale active claims. (Note: the
active-claim drift is exclusively in the runtime system prompt —
see A1.)

---

### D4. MASTER_PLAN and NEXT have no ghost items [pass]

MASTER_PLAN.md §107-139 correctly claims what shipped and correctly
defers DECISIONS.md / ONBOARDING_STATE.md to sprint 046. NEXT.md §1-3
lists forward-looking work only, no ghosted-already-done items.

---

## E. UX concerns

### E1. Rollback confirmation uses `window.confirm()` [moderate]

**Where:** [transaction-history.tsx:56](frontend/components/build/transaction-history.tsx:56)
+ [plan-checklist.tsx:64](frontend/components/build/plan-checklist.tsx:64)
Both rollback buttons trigger the browser-native confirm dialog instead
of a styled modal that lists what will be deleted. Flagged in NEXT.md
§2.1 as acknowledged pilot debt. Acceptable for internal use; must fix
before public beta.

---

### E2. `build/tokens.ts` re-export doesn't exist [minor]

**Where:** spec §Frontend file plan names
`frontend/components/build/tokens.ts` as a re-export of the tuning
palette. In the codebase, that file does not exist; build components
import directly from `frontend/components/tuning/tokens.ts`. Functionally
equivalent and still satisfies "palette inherited verbatim," but the
spec's file list is off-by-one.

---

### E3. No SSE-warming loading state [minor]

**Where:** [build-chat.tsx:125-170](frontend/components/build/build-chat.tsx:125)
Between the user pressing Send and the first SSE chunk arriving,
only the send button is disabled and the placeholder changes. No
skeleton, no shimmer, no "thinking…" bubble. On slow-cold-start the
user gets an unexplained pause. The existing `TypingIndicator` only
activates once `status === 'streaming'`.

---

### E4. Empty `judgeRationale` renders empty `<p>` [minor]

**Where:** [test-pipeline-result.tsx:100-102](frontend/components/build/test-pipeline-result.tsx:100)
No fallback text. If the judge returns an empty rationale (should be
rare but not impossible), the card shows a score and nothing else.

---

### E5. A11y gaps on ActivityIcon and score icons [minor]

**Where:** [page.tsx:322-342](frontend/app/build/page.tsx:322) +
[test-pipeline-result.tsx:65,71](frontend/components/build/test-pipeline-result.tsx:65)
Activity-bar icon buttons use `title` only, no `aria-label`. Score
icons in test-pipeline-result have no label. WCAG 2.1 AA gap; not
critical for pilot but visible to screen-reader users.

---

### E6. Transaction history shows only the most recent transaction [minor]

**Where:** [transaction-history.tsx](frontend/components/build/transaction-history.tsx)
+ tenant-state response shape
By design per Gate 6 — NEXT.md §2.1 lists the pagination endpoint as
sprint-046 work. No bug, worth flagging for the first manager who
rolls back twice in quick succession and can't see the earlier
transactions.

---

### E7. Tenant-state endpoint fires 6 parallel `count()` queries per turn [minor]

**Where:** [tenant-state.service.ts](backend/src/services/tenant-state.service.ts)
`getTenantStateSummary`. Fine for pilot traffic; NEXT.md §2.1 already
scopes a 30s in-memory cache for public beta.

---

### E8. Palette purity passes [pass]

No `blue-`, `indigo-`, `slate-`, `gray-` classes in `frontend/components/build/`
or `frontend/app/build/`. All accents pull from the `TUNING_COLORS`
purple/violet system.

---

### E9. Mockup layout dimensions match exactly [pass]

[ui-mockup.html:157](specs/045-build-mode/ui-mockup.html:157) spec:
`56px 288px 1fr 440px`. [page.tsx:236](frontend/app/build/page.tsx:236)
code: `'56px 288px 1fr 440px'`.

---

## F. Visual audit

**Static visual audit — screenshots not captured.** The sprint shipped via
direct branch deploy, and the local dev loop was not booted for this
audit (port-conflict risk, avoidance of accidental `ENABLE_BUILD_MODE`
leakage). Nine state descriptions below, reconstructed from component
code.

Directory `specs/045-build-mode/refinement-screenshots/` has been created
but left empty so the user can drop in live captures from a controlled
run.

### 01 — BROWNFIELD landing
`/build` mounts, `GET /api/build/tenant-state` returns `isGreenfield: false`.
`TenantStateBanner` renders a brownfield hero: "What do you want to
build or change?" Left rail shows `SetupProgress` with aggregate counts
(e.g., "23 SOPs · 74 FAQs · 0 custom tools · 20 properties"). Chat
column is empty. Preview panel is empty.

### 02 — Interview empty input
Same layout as 01 but the textarea is focused. Placeholder reads "What
do you want to build or change?" Send button is disabled (empty input).
No message bubbles yet.

### 03 — Interview mid-turn
User has submitted first message. `useChat` status flips to
`'submitted'` → `'streaming'`. `TypingIndicator` (purple-violet dots)
appears below the user bubble once status is `streaming`. The agent's
assistant bubble streams in progressively. Send button disabled
throughout; textarea remains focused.

### 04 — Plan checklist with items
An assistant turn emits `data-build-plan` SSE part. `MessageRow` routes
it to `PlanChecklist`, which renders below the assistant bubble: plan
rationale at the top, then a bulleted list of items (`type` · `name` ·
`rationale` per item). Green "Approve" button bottom-right, subtle
"Roll back" button top-right (visible only after approval; `window.confirm`
firing on click).

### 05 — Test pipeline result
On `data-test-pipeline-result`, the preview panel (right column) shows
a card titled "Test result". Score badge (green if ≥0.7, amber with
`AlertTriangle` icon if <0.7). Reply text in a bordered box. Rationale
beneath. Latency + replyModel + judgePromptVersion stamp at the
bottom.

### 06 — Transaction history
Left-rail widget below `SetupProgress`. Title "Recent transaction".
Shows one row with plannedItems names, status badge, "Roll back" button.
Empty state reads "No transactions yet" (brownfield with no BUILD history).

### 07 — Rollback confirm modal
**Does not exist.** Clicking "Roll back" triggers `window.confirm("Roll
back the last build transaction?")` — browser-native dialog, not a
styled modal. See E1.

### 08 — Propagation banner
Rendered above the chat column after a successful `approvePlan` POST.
Purple-violet background, copy "Applying changes — main pipeline picks
these up in up to 60 seconds." Client-side 60s countdown; auto-dismisses.
Does not persist across navigation (state resets on remount).

### 09 — Disabled screen
Triggered when `GET /api/build/tenant-state` returns 404. Frontend
catches `BuildModeDisabledError`. Page renders [build-disabled.tsx](frontend/components/build/build-disabled.tsx)
— lock-card hero reading "Build mode is not enabled for this
environment. Set `ENABLE_BUILD_MODE=true` to open this surface."

---

## Proposed refinement priority

### Must fix before `ENABLE_BUILD_MODE=true` in production

1. **A1** — purge `preview_ai_response` from system-prompt.ts; replace
   the four references with `test_pipeline` semantics. Agent will
   reliably fail-to-call otherwise. ~1 hr.
2. **B1 / C3** — close the `BuildTransaction` state machine. Write
   `COMPLETED` on clean plan finish; write `PARTIAL` on partial failure.
   Tighten `validateBuildTransaction` to reject writes on `PARTIAL`
   (already rejected) AND `EXECUTING` beyond N seconds old, or surface a
   stuck-transaction cleanup. ~3 hr.
3. **D1** — update CLAUDE.md "Key Services" table with the three
   sprint-045 services. ~15 min.

### Should fix before public beta (sprint 046 candidates)

4. **A2** — reconcile BUILD allow-list vs spec §2 (either add rollback
   to the spec table with rationale, or remove it from the allow-list).
5. **B5** — propagate `bypassCache` to `getSopContent` inside the dry
   pipeline run, or refactor `test_pipeline` to invalidate the SOP
   cache for the test call. Otherwise the sprint's R4 mitigation
   silently breaks.
6. **C2** — server-side enforce `approvedAt` before allowing `create_*`
   writes on a transaction. NEXT.md §4 already flags; decide now so
   public beta doesn't ship with the permissive pilot rule.
7. **C4** — add an integration test that exercises the
   slot-persistence round-trip (agent writes memory → widget reads it).
   Current load-bearing feature has zero regression net.
8. **E1** — replace both `window.confirm` rollbacks with a styled
   modal that lists what will be deleted.
9. **B8** — land NEXT.md §1.2 (lean `invalidateTenantConfigCache`
   extraction). Closes a fragile 60s window for the live pipeline.

### Nice to have / probably won't ship this sprint

10. **B2** — tighten the `ENABLE_BUILD_MODE` comment to match the
    whitelist. Cosmetic.
11. **D2** — either lock token baselines in the stability test or
    rephrase PROGRESS.md to say "observational."
12. **E2** — either create the spec-referenced `build/tokens.ts`
    re-export or strike it from the spec file list.
13. **E3** — add a skeleton/shimmer during the `submitted`-before-
    `streaming` window.
14. **E4** — fallback text for empty `judgeRationale`.
15. **E5** — WCAG aria-label pass on ActivityIcon + score icons.
16. **E6 / E7** — transaction history pagination + tenant-state cache
    (already in NEXT.md §2.1).
17. **C1 / C5** — explicit named guards on hook intercepts; defensive
    cache invalidation from `create_tool_definition`. Fragility hardening.

### Investigate / accepted as-is

- **B3** — rollback idempotency under concurrent callers. No known
  failure; add a test when public beta traffic arrives.
- **B7** — 404-before-auth gate is correct; leave alone.
- **A4 / A5 / B4 / B6 / D3 / D4 / E8 / E9** — pass, no action.

---

**End of report.** Total length: ~3,600 words.
