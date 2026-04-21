# Sprint 054 — Session A — Self-Narrating Studio: Rationale + Test Ritual

**Branch:** `feat/054-session-a` (stacks on `feat/053-session-a` → 052-A → 051-A → 050-A → main)
**Parent tip expected:** `4883a18` (feat/053-session-a close-out)
**Session type:** A — prompt-engineering-first with UI polish + small backend. Smaller sprint than 053-A; no schema change.
**Brainstorm §:** §7 (test_pipeline first-class ritual) + §13 (RejectionMemory legibility, partial) + Bundle C mid-stream pivot.

> **Amendment (F3 + F4, during-sprint):** the verification ritual is
> three-variant, not one. The agent proposes up to three distinct-but-
> equivalent triggers along a direct / implicit / framed axis; the tool
> runs them in parallel via Promise.all over (pipeline, judge) pairs;
> storage shape is `{ variants: [...], aggregateVerdict, ritualVersion }`;
> the executor guardrail is "up to 3 test_pipeline calls per ritual
> window, 4th rejected" (was: 1). The F4 headline renders as a ratio
> (`3/3 passed`, `2/3 passed — 1 failed`, `0/3 passed`) with per-variant
> rows collapsed. Single-variant rituals read honestly (`1/1 passed`,
> never `1/3`). Everything else in §3 below holds unchanged.

---

## 0. Why this sprint exists

After 052-A + 053-A, the Studio surface is **safe**: viewers are faithful, preview-before-apply works, a write-ledger records every change with a revert path. But the surface is **mute**: it shows *what* changed and *who* changed it, not *why*, and it doesn't verify that the change actually did what the agent intended. The manager has to infer the agent's reasoning from scrollback and trust that the edit produced the desired guest-facing behavior.

The fix isn't more UI — it's making the agent **narrate itself** and **verify itself**. Two changes:

1. **Every write carries a rationale.** A one-sentence, human-readable explanation of why the agent made this specific edit, attached to the history row, rendered in the ledger and drawer.
2. **Every write offers a single verification test.** After a successful write, the agent proposes *exactly one* representative guest message to run through the tenant's real reply pipeline. User confirms. One `test_pipeline` call. Verdict + reasoning rendered in chat, linked back to the triggering edit in the ledger.

This replaces the "revert-UX polish" scope because with rationale + verification, revert becomes a last resort rather than an expected workflow. Good history + self-verification means you can *accept* edits from the agent because you understand and trust them, not because undo is easy.

The plumbing for verification already exists: `test_pipeline` tool, Sonnet 4.6 judge (`test-judge.ts`), and the `data-test-pipeline-result` renderer are all in place from feature-045. This sprint doesn't build them. It makes them a **ritual** — automatic after every write, bounded to a single call, and visually tied to the edit that triggered them.

---

## 1. Non-negotiables (carried forward)

- **`ai.service.ts` stays untouched.** Prompt + tool + history changes live in the BUILD agent layer.
- **No schema change.** `BuildArtifactHistory.metadata` is already JSON. Rationale and test-result linkage both fit inside it. If someone wants to add a new column, push back — this sprint does not carry a schema change.
- **Sanitiser coverage.** Rationale strings are user-facing text — no secrets expected, but run them through the existing sanitiser anyway. Belt + suspenders.
- **Graceful degradation.** Pre-sprint history rows without a `rationale` render as `No rationale recorded` (neutral text, not an error). Never crash on missing fields.
- **Single-call discipline on the test ritual.** Per ritual instance, exactly ONE `test_pipeline` call. No chaining. No retry loops. If the test fails, the agent either proposes a new edit (starting a new ritual) or asks the user what to do. This is prompt-enforced AND guarded at the tool-executor layer.
- **Admin-only surfaces stay admin-only.** No posture changes this sprint.
- **Branch discipline.** Stack on `feat/053-session-a`. Do NOT rebase onto main.

---

## 2. Pre-flight gate

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a feat/053-session-a
```

Expected (from sprint-053-A close-out):
- `feat/050-session-a` → `d103c14`
- `feat/051-session-a` → `41b339c`
- `feat/052-session-a` → `7d49103`
- `feat/053-session-a` → `4883a18`

If tips don't match, stop and surface. (Sprint-053-A paid SHA-drift interest twice now — brief's 275 vs actual 309 backend baseline. Verify numbers below before assuming.)

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && npm test
```

Expected (from sprint-053-A close-out):
- Frontend: **141/141**
- Backend: **340/340**

Re-verify before writing any code. If the actual count differs, note it in PROGRESS.md at session start.

### 2.3 Existing capability probe

Before F1–F4 work, confirm the pieces we're NOT building actually exist and work:

```
grep -rn "test_pipeline" backend/src/build-tune-agent/
grep -rn "data-test-pipeline-result" frontend/components/studio/
grep -rn "test-judge" backend/src/build-tune-agent/
```

Expected: `test_pipeline` tool registered, judge module present, standalone-part renderer wired in studio-chat.tsx. If any are missing, stop — the sprint premise was that these pipes already exist.

---

## 3. Gates

Five gates. Each gate is one commit on `feat/054-session-a`.

### F1 — Rationale required on every write tool

**Scope:** each write tool in the BUILD agent gains a required `rationale: string` parameter. The agent MUST provide it on every call. History rows store it in `metadata.rationale`.

**Write tools in scope** (same set as 053-A D1):
- `write_sop` (+ variants/overrides)
- `write_faq`
- `write_system_prompt`
- `write_tool_definition`
- `write_property_override`

**Validation rules:**
- Required string, minimum 15 chars, maximum 280 chars.
- Must not be empty, whitespace-only, or placeholder text (`"updating"`, `"edit"`, `"change"`, etc. — maintain a small blocklist).
- On validation failure: tool call returns an error message pointing at the missing/invalid rationale. Agent must retry with a real rationale.

**System-prompt change:**
- In `backend/src/build-tune-agent/system-prompt.ts`, add a `<write_rationale>` block that instructs the agent: every write must include a specific, user-readable `rationale` explaining *why this edit*, citing the conversation signal that motivated it if applicable.
- Include 2–3 good examples and 1–2 bad examples in the prompt block (the bad examples ARE the blocklist contents — teaches by counter-example).
- Version-stamp the block (`RATIONALE_PROMPT_VERSION = "054-a.1"`) so future drift surfaces in tests.

**Storage:**
- D2's history-emission helper writes `rationale` into `metadata.rationale`. Sanitiser runs over the string (belt + suspenders — no secrets expected, but cheap insurance).
- Retain full metadata shape from 053-A: `{ rationale, revertsHistoryId?, ... }`.

**Dry-run path:**
- In dry-run mode (053-A D1), rationale is ALSO required. Same validation. Preview payload includes rationale in its return value so the drawer can render it in the preview banner.

**Tests (+~6 backend):**
- Each write tool rejects missing/short/blocklist rationale with a clear error shape.
- Valid rationale → stored in `metadata.rationale`, sanitised.
- Dry-run with valid rationale → preview payload includes rationale, no history row.
- System-prompt block is version-stamped and included in compiled prompt (regression test asserts presence).

**Commit message sketch:** `feat(build): require rationale on every write tool (F1)`

---

### F2 — Rationale rendering in ledger + drawer

**Scope:** the rationale surfaces in two places on the frontend.

**Write-ledger rail (right rail, "Recent writes"):**
- Each row gains an expand-chevron on the right edge.
- Click chevron → row expands to show rationale text (full width, `inkMuted` color, small italic "Rationale:" label followed by the string).
- Rows with no rationale (pre-F1 history) render `No rationale recorded` in `inkFaint` color.
- Expansion state is local to the rail (not persisted — resets on page reload). Collapsible.

**Artifact drawer — history view:**
- When opening an artifact drawer from a ledger row (053-A D4 flow), the drawer's body area gets a **new header slot** above the diff: a small card with `Rationale` label + rationale text. Not collapsible — always visible when a history row is being viewed.
- In regular (non-history) drawer views, the rationale card does not appear.
- If rationale is absent (pre-F1), show `No rationale recorded` in the same card shape (do NOT hide the card — consistency is more valuable than visual cleanliness for older rows).

**Styling notes:**
- Both surfaces use the same rationale-card component. Factor it into `frontend/components/studio/artifact-views/rationale-card.tsx`.
- Rationale text is user-readable — no monospace, no truncation in the drawer (truncate at 2 lines in the rail row with "…" + click-to-expand).
- Do NOT render rationale as markdown. It's a single plain-text sentence. If the agent writes a markdown-looking rationale, it renders as literal text. (Prevents prompt-injection of formatting into the ledger.)

**Tests (+~6 frontend):**
- Ledger row renders chevron; click expands; expanded content shows rationale.
- Ledger row with missing rationale shows `No rationale recorded`.
- Drawer history view shows rationale card above diff.
- Drawer non-history view does NOT show rationale card.
- Rationale with markdown-looking syntax renders as literal text (no `**bold**` parsing).
- `rationale-card.tsx` shared component renders identically in both surfaces.

**Commit message sketch:** `feat(build): rationale card in ledger + drawer history view (F2)`

---

### F3 — Post-write test ritual (prompt + tool + linkage)

**Scope:** after every successful write-tool call, the agent proposes ONE verification test. User confirms via a question-choices card. One `test_pipeline` call runs. Result is linked back to the triggering history row.

**Prompt-side — ritual definition:**
- In `system-prompt.ts`, add a `<verification_ritual>` block that instructs the agent:
  1. After EVERY successful write-tool call, propose a single representative trigger message that would exercise the edit (e.g. if SOP is "late-checkout for VIPs," trigger is "Hi, I'm staying in the Penthouse, can I keep my room until 6pm?").
  2. Emit a `data-question-choices` card with the proposed trigger as context and choices `["Yes, test it", "Skip"]`.
  3. On `"Yes, test it"` → call `test_pipeline` **exactly once** with the proposed trigger. Do not retry. Do not batch.
  4. On `"Skip"` → acknowledge briefly and move on.
  5. After the test completes (pass or fail), DO NOT automatically propose another test. If the test failed, the agent may propose a NEW edit (which starts its own fresh ritual). Never loop tests on the same edit.
- Version-stamp the block (`VERIFICATION_RITUAL_VERSION = "054-a.1"`).

**Tool-executor-level guardrail:**
- In the tool executor, track per-turn test-ritual state. If `test_pipeline` is called more than once within a single ritual window (defined as: between a write-tool-call and the next write-tool-call OR end-of-turn), reject the second call with an error that surfaces in the agent's context.
- This is defense-in-depth. Prompts can fail; the executor guardrail guarantees single-call discipline.

**Linkage:**
- When `test_pipeline` runs in a ritual context (i.e. the most recent prior tool call in this turn was a write tool that produced a history row), the tool executor writes the test result back into that history row's `metadata.testResult`:
  ```
  metadata.testResult = {
    triggerMessage: string,
    pipelineOutput: string,       // the reply-AI's response
    verdict: "passed" | "failed",  // judge verdict
    judgeReasoning: string,        // judge's one-sentence explanation
    judgePromptVersion: string,    // from test-judge.ts
    ranAt: ISO8601 string,
    ritualVersion: string          // VERIFICATION_RITUAL_VERSION
  }
  ```
- If `test_pipeline` is called OUTSIDE a ritual context (user-initiated test, no preceding write), do NOT write to any history row. Result renders in chat only.
- The ritual-context check is based on the in-memory turn state, not a DB lookup. Simple and fast.

**Tests (+~8 backend):**
- Prompt block presence + version stamp (regression).
- Single-call guardrail: second `test_pipeline` in same ritual window → rejected.
- Test result written to triggering history row's `metadata.testResult`.
- User-initiated `test_pipeline` (no preceding write) → no history row mutation.
- Verdict + judge reasoning populated from judge output.
- Malformed judge output → test result still recorded with `verdict: "failed"` and `judgeReasoning: <judge-error>`.

**Commit message sketch:** `feat(build): post-write verification ritual (F3)`

---

### F4 — Test result UX polish + chain linkage in the ledger

**Scope:** make the verdict and judge reasoning the center of gravity of `data-test-pipeline-result`, link test results bidirectionally to the ledger, and surface the pass/fail state in the ledger rail.

**`data-test-pipeline-result` renderer changes:**
- The card's headline is now the VERDICT (`Passed` / `Didn't work`), styled bold. Not the trigger message, not "Test result."
- Directly below: the judge's one-sentence reasoning. This is the second-most-prominent element.
- Below that: collapsed details — trigger message, pipeline output (the reply-AI's response), timings. Collapsed by default; click to expand.
- Failed-verdict cards have a subtle amber/red edge accent (not the entire background); passed-verdict cards have no accent (quiet success).
- If the test result has a linked `sourceWriteHistoryId` (from F3 ritual context), render a small chip at the top of the card: `Testing: UPDATE sop — late_checkout` (or equivalent). Click → opens artifact drawer in history view for that row.

**Ledger rail — verdict chips:**
- Rows whose history has `metadata.testResult` render a small passed/failed chip inline next to the timestamp.
- Chip color: neutral green for `passed`, neutral amber for `failed`. Small, unobtrusive — not a dominant element.
- Click chip → opens the artifact drawer in history view, scrolled to the test-result section (see below).

**Artifact drawer — history view test-result section:**
- Below the rationale card (F2) and below the diff, a new "Verification" section renders if `metadata.testResult` exists.
- Same shape as the chat renderer (verdict + judge reasoning + collapsed details) but lives inline in the drawer for persistent viewing.
- Does NOT re-run the test. It's a rendering of the stored result.

**Tests (+~6 frontend):**
- Renderer headline is the verdict; judge reasoning is second-most-prominent.
- Failed verdicts have the accent; passed do not.
- Source-write chip renders when linkage exists; clicking it fires the drawer-open event with the correct history id.
- Ledger rail row renders verdict chip when `testResult` present; no chip otherwise.
- Drawer history view renders verification section when `testResult` present; absent otherwise.
- Clicking rail verdict chip opens drawer scrolled to verification section.

**Commit message sketch:** `feat(build): verdict-forward test result UX + ledger linkage (F4)`

---

### F5 — Verification + PROGRESS.md + NEXT.md

**Verification checklist:**
- Frontend tests pass, count target `141 → ~153` (+~12).
- Backend tests pass, count target `340 → ~354` (+~14).
- `tsc --noEmit` clean both sides.
- Grep: `ai.service.ts` untouched (no imports of `BuildArtifactHistory`, `test_pipeline`, rationale logic).
- Grep: no new Prisma migration files.
- Manual five-step smoke (document in PROGRESS.md):
  1. Open BUILD session. Ask the agent to tighten the late-checkout SOP. Agent edits.
  2. Ledger row appears with a rationale expand-chevron. Expand — rationale reads specifically and cites the reason.
  3. Agent proposes a test. Question-choices card renders. Click "Yes, test it."
  4. `data-test-pipeline-result` card renders with verdict headline, judge reasoning, and source-write chip.
  5. Click the source-write chip → drawer opens in history view → verification section at the bottom matches the chat card. Rail row now shows verdict chip.
- Negative smoke: manually trigger `test_pipeline` outside a write (user-initiated). Result renders in chat but NO history row is mutated (verify by opening the most recent history row — no testResult).

**PROGRESS.md:**
- New §Sprint-054-A block with commit SHAs, test deltas, manual smoke log, negative-smoke result.
- Close out the "ledger self-narration" arc from the Bundle C mid-stream pivot.
- Note remaining carry-overs:
  - 050-A staging walkthrough (still pending).
  - Sprint-053-A caveat #3 flaky `messages-copilot-fromdraft.integration.test.ts` (still deferred).
  - 053-A open questions #1 (tool-call-ID column), #2 (property_override sanitisation), #3 (session vs tenant ledger scope) — still deferred.

**NEXT.md rewrite:**
- Archive current NEXT → `NEXT.sprint-054-session-a.archive.md`.
- New NEXT.md surfaces 055-A candidates:
  - **Primary: sprint-049 correctness carry-over sweep** (P1-2/3/4/5/6 + F1 + flaky test fix). Paydown — defensible as "we just expanded the surface; tighten before moving on."
  - **Alternate: Bundle D opener** (session task board + queued follow-ups). New feature bundle.
  - **Tertiary: tiered permissions** (Bundle C closing half). Deferred from 054-A per user scope decision; park until a second persona needs it.

**Commit message sketch:** `chore(build): sprint-054-A close-out — self-narrating studio live (F5)`

---

## 4. Size budget + scope creep watch

- Test delta target: +~26 total (+~12 frontend, +~14 backend). Smaller sprint than 053-A by design.
- Zero new dependencies. Zero schema changes. If either shows up, stop and surface.
- Per-gate commit discipline. F3 is the biggest gate (prompt + guardrail + linkage); if it exceeds ~250 LOC net, pressure-test whether the guardrail belongs in a standalone F3.5 commit.
- **Do not build:**
  - Revert-UX polish (explicitly descoped per user — rationale + verification make it unnecessary).
  - Tiered permissions dial (descoped — no second persona yet).
  - Tool-call-ID column (descoped — no clear benefit per user).
  - Try-it composer as a standalone drafting surface (descoped — test ritual is the simpler answer).
  - Version slider, inline-edit-from-drawer, grouped ledger rows — all parked.

---

## 5. Watch-outs specific to this sprint

- **Blocklist phrasing drift.** The blocklist (`"updating"`, `"edit"`, `"change"`, etc.) in F1 is a prompt-engineering dial, not a security control. If the agent starts writing `"updating the late-checkout SOP because..."` the blocklist only catches a bare `"updating"` — a longer sentence starting with it passes. That's intentional: the blocklist exists to force agents past the laziest completions, not to enforce a rationale schema. Don't over-engineer it.
- **Version-stamp drift.** Two new version strings this sprint (`RATIONALE_PROMPT_VERSION`, `VERIFICATION_RITUAL_VERSION`). Each has a regression test. If a later sprint mutates the prompt block without bumping the version, the regression test should fail with a clear message. Make that explicit in the test assertion.
- **Ritual-context in-memory state.** F3's guardrail tracks ritual state in turn-local memory. That means: (a) it's fine for single-turn ritual completion, (b) if a turn ends mid-ritual (rare — user closes the session between write and choice), the ritual dies with the turn and re-engagement is user-initiated. This is acceptable. Do NOT add DB persistence for ritual state — it's not worth the complexity.
- **User-initiated test_pipeline calls.** These must continue to work (the feature is orthogonal to the ritual). F3's linkage logic must check ritual context before mutating any history row. If a user types "run a test with this message: ..." the pipeline call succeeds and renders, but NO history row is touched.
- **Rationale prompt-injection via markdown.** F2 renders rationale as literal text, not markdown. This is a deliberate sanity rail — an agent that writes `"# CRITICAL"` as rationale doesn't get to stamp a bold heading into your ledger rail. Test this explicitly.
- **Empty judge output.** If the judge fails or returns malformed output (it's an LLM call; it can happen), the test result should still persist with `verdict: "failed"` and `judgeReasoning: <error-placeholder>`. Never drop the test result on judge failure — the user still deserves to know the test was attempted.

---

## 6. Handoff — what 054-A does NOT land

- Revert-UX polish (browser-confirm stays; rationale + verification render it lower priority).
- Tiered permissions dial.
- Try-it composer as a draft-surface (descoped in favor of the test ritual).
- Tool-call-ID column on history rows.
- Version slider.
- Inline-edit-from-drawer.
- Grouped ledger rows / CSV export.
- 050-A staging walkthrough (still pending).
- Sprint-049 correctness carry-overs (primary 055-A candidate).

---

## 7. Close-out checklist

Mirror the 053-A close-out format:
- Per-gate commits with SHAs.
- Frontend + backend test counts (before / after / delta).
- `tsc --noEmit` status both sides.
- Dep budget: zero new deps. Zero schema changes. Flag explicitly.
- Caveats / scope drift — honest. If F3 single-call guardrail got bypassed by a prompt path, note it.
- Branch posture line: `feat/054-session-a (<tip>) stacks on feat/053-session-a (4883a18)...`
- NEXT.md pointer to the 055-A candidates.
- Confirm: rationale block version + ritual block version both stamped and tested.

---

## 8. Open questions (do not resolve in-sprint; surface in close-out)

- **Agent-generated trigger message quality.** F3 has the agent propose a representative guest message for each test. Quality is prompt-dependent. After live use, we may want to let the user edit the proposed trigger before running the test ("Yes, test it with this tweak"). Parked until we see real data.
- **Historical rationale backfill.** F2 renders `No rationale recorded` for pre-F1 rows. Do we ever want to backfill the most recent N rows by asking the agent to recall/reconstruct? Probably not — reconstructed rationale is worse than no rationale (it's confabulated). Leaving as-is.
- **Failed-test escalation.** Today, a failed verification test just renders with amber accent and the agent moves on. Should a failed test auto-escalate to "want me to revise the edit and try again"? Feels like a loop we explicitly avoided. Worth revisiting after live use.
