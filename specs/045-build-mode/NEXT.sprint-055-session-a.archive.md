# Sprint 055 — Session A — Plan-as-Progress + Inline Edit

**Branch:** `feat/055-session-a` (stacks on `feat/054-session-a` → 053-A → 052-A → 051-A → 050-A → main)
**Parent tip expected:** tip of `feat/054-session-a` after F5 close-out. **Verify before starting** — 054-A was mid-flight when this spec was written.
**Session type:** A — frontend-heavy with a small backend behavior flip. No schema change.
**Brainstorm §:** §8 (plan-as-progress) + §11 (direct-manipulation drawer) + in-session pivot (kill the Confirm button).
**Length discipline:** this spec is intentionally ~60% of 054-A. Dispatch subagents, don't over-scope.

---

## 0. Why this sprint exists

Plan mode today (shipped in 045 Gate 6) is a **wall of text with an Approve button**. It restates what the agent just said, then asks the manager to click twice — once to approve the plan, again per-artifact to Apply. That's two gates for the same decision, and the first gate adds no information the manager doesn't already have.

Two changes collapse that:

1. **Plan renders as a Cowork-style progress checklist, not an approval card.** Bulleted task list. `○` pending / `●` current / `✓` done / `×` cancelled. No Approve button on mount — the plan is already approved implicitly by the manager describing what they want. The per-artifact **Apply** button in the drawer (shipped 053-A D3) remains the only gate. Revert stays available via the write-ledger (shipped 053-A D4).

2. **Preview in the drawer becomes editable before Apply.** Today the drawer shows the agent's dry-run output read-only. The manager either Applies it or asks the agent to redo it. This sprint lets the manager tweak the preview text in place and then Apply the tweaked version. Direct manipulation — cheaper than a chat round-trip for typos, tone, or a missing sentence.

Everything else (plan rationale, target chip, previewDiff disclosure, test ritual) keeps its existing behavior. This is a UX compression sprint, not a re-architecture.

---

## 1. Non-negotiables

- **`ai.service.ts` stays untouched.** Frontend + BUILD-agent-layer only.
- **No schema change.** `BuildTransaction.approvedAt` already exists; we just change when it's set. `BuildArtifactHistory` already records the applied body — inline-edit writes the edited body through the same apply path.
- **Apply in the drawer is still the only write gate.** Auto-approve on plan mount does NOT execute any writes — it only flips the BuildTransaction from `PLANNED` → `EXECUTING` so subsequent `create_*` calls aren't blocked waiting on a ghost click. The writes themselves still require per-artifact Apply.
- **Sanitiser parity holds.** Inline-edited bodies go through the same sanitiser as agent-authored bodies. Preview output and storage output must be byte-identical for the same input.
- **Graceful degradation.** Legacy plan cards (pre-055 conversations, no approved state) still render correctly when reloaded. Inline-edit is an opt-in UI affordance — if disabled, the drawer falls back to the 053-A D3 behavior.
- **Branch discipline.** Stack on `feat/054-session-a`. Do NOT rebase onto main.

---

## 2. Pre-flight gate

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a feat/053-session-a feat/054-session-a
```

Write the actual SHAs into PROGRESS.md at session start. 054-A was live when this spec was written; its tip SHA is not in this file. **Look it up, don't guess.**

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && npm test
```

Record actuals in PROGRESS.md. 054-A was adding frontend tests (F1 rationale input, F2 rationale card, F3 variant ritual, F4 ratio headline) and a handful of backend tests. Starting counts will differ from 053-A close-out; take them at face value.

### 2.3 Existing capability probe

Before writing code, confirm the pieces being reused:

```
grep -n "approvePlan\|approvedAt" backend/src/controllers/build-controller.ts
grep -n "PlanChecklist\|data-build-plan" frontend/components/studio/studio-chat.tsx
grep -n "pendingBody\|apiApplyArtifact" frontend/components/studio/artifact-drawer.tsx
grep -n "PLANNED.*EXECUTING\|status === 'PLANNED'" backend/src/build-tune-agent/tools/build-transaction.ts
```

Expected: `approvePlan` exists + idempotent; `PlanChecklist` renders `data-build-plan` parts; drawer already accepts `pendingBody` and renders Preview/Apply; `build-transaction.ts` flips `PLANNED → EXECUTING` on first write reference. If any are missing, stop — the sprint assumes all four.

---

## 3. Gates

Four gates. Each gate is one commit on `feat/055-session-a`. **F1 + F2 are independent and should be dispatched to parallel subagents** (one owns the plan card + backend flip; the other owns inline-edit). F3 + F4 integrate.

### F1 — Plan card → progress checklist, Confirm button removed

**Scope:** repurpose `frontend/components/build/plan-checklist.tsx` from approval card to progress tracker. No Approve button. No Dismiss button on mount. Rows render with state glyph + type chip + name + target chip + optional previewDiff disclosure. The existing "Roll back" affordance stays but moves to a header overflow menu (three-dot) — it's rare and shouldn't crowd the primary reading line.

**Row states:**
- `○ pending` — greyed, italic name, not yet referenced by any `create_*` call
- `● current` — the item that the next tool call will reference (inferred from the sequence of incoming `data-build-write` SSE parts)
- `✓ done` — item whose artifact has a matching `BuildArtifactHistory` row in this transaction
- `× cancelled` — transaction rolled back, or a plan item that never fired (agent changed direction mid-turn)

**State inference rule:** the frontend derives row state from the existing `data-build-write` / `data-build-history` stream. The backend does not need a new progress event. If writes arrive in a different order than the plan items, match by `{ type, name }` + sanitised-slug fallback.

**Kill the Confirm button:**
- On mount, `PlanChecklist` calls `apiApproveBuildPlan(transactionId)` once, silently. Success → state transitions to `approved` immediately. No toast, no visible delta. Idempotent server-side so re-renders don't double-approve.
- If auto-approve fails (network blip, 500), render a small "Couldn't confirm plan — retry" inline pill at the top of the card, retrying via the same endpoint. Do NOT block row rendering.
- The backend `approvePlan` controller already returns idempotently (`alreadyApproved: true`). No backend change needed for the happy path.

**Per-row hover affordance:** on hover, a `+` icon appears at the right edge of the row. Click → inserts a `@item:<type>:<name>` mention into the chat composer (doesn't send, just seeds). This matches the Cowork Progress-card pattern (hover `+` opens a contextual chat bubble). Keyboard: focus the row + `Enter` does the same.

**Out of scope for F1:** a separate progress sidebar, per-row comment threads, undo-on-hover. Keep the surface in the existing card — no new chrome.

**Frontend tests:**
- Auto-approve fires exactly once per mount; double-render doesn't re-call.
- Row state derivation: plan with 3 items, feed 2 `data-build-history` events → rows 1+2 show `✓`, row 3 shows `○` (or `●` if it's the next expected).
- Hover `+` seeds composer with correct mention string.
- Legacy plan (no `approvedAt`) renders without crashing; headline degrades to "Plan proposed" rather than "Approved".

**Backend tests:**
- `approvePlan` remains idempotent under concurrent calls (spam 5 in parallel → one DB write, five success responses).

**Acceptance:** manager sees a live progress bar of the plan filling in as the agent writes. No mandatory click. Per-artifact Apply in drawer still gates every write.

### F2 — Inline edit in drawer preview

**Scope:** extend `frontend/components/studio/artifact-drawer.tsx` so that when `pendingBody` is present AND the drawer is in preview state (053-A D3), the rendered preview becomes editable. On Apply, the edited body flows through the same `apiApplyArtifact` call with `dryRun: false`.

**Interaction:**
- Preview loads as today — click Preview → dry-run renders in the body area.
- A new **Edit** affordance (pencil icon, top-right of the preview pane) toggles edit mode.
- In edit mode: each artifact view (sop / faq / system_prompt / tool / property_override) swaps its read-only renderer for a minimal editor — textarea for SOP / system_prompt, per-row input for FAQ, JSON-editor for tool/property_override.
- Any edit triggers a re-preview under the hood (debounced 400ms) so the sanitiser runs and the "before/after diff toggle" stays honest.
- Apply button stays primary; it now submits the edited body. Original agent-proposed body is retained in component state and shown via a "Reset to agent draft" secondary button.

**Viewer reuse:** the 051-A artifact-view components are read-only. Create an `-editor` sibling for each (e.g. `sop-editor.tsx`). Keep the editors small — wrap the native textarea/input, no rich-text. Markdown SOPs stay plain-text-editable; preview still renders markdown.

**Sanitiser parity check (critical):** after an edit, the preview request must return a `sanitizedBody` identical to what `apiApplyArtifact({dryRun:false})` would persist given the same input. Add a frontend assertion in dev mode that flags drift.

**Rationale carry:** when the manager edits a preview and Applies, the history row's rationale field prepends `[edited-by-operator]` to the agent's original rationale. (Or stores the operator's own rationale if the UI adds a "why" prompt — see F3 below.)

**Frontend tests:**
- Pencil toggles edit mode; Reset restores agent draft.
- Debounced re-preview fires once per idle burst, not per keystroke.
- Apply submits the edited body (capture the `apiApplyArtifact` call arg).
- Read-only behavior preserved when `pendingBody` absent (drawer opened from session-artifacts rail / deep link).

**Backend tests:**
- Apply with an operator-edited body stores the edited content in `BuildArtifactHistory.bodyApplied`, and `metadata.rationalePrefix = 'edited-by-operator'` when the flag is set.

**Acceptance:** a manager who sees a typo in the agent's SOP preview can fix it in place and hit Apply — no chat round-trip.

### F3 — Edit rationale prompt (lightweight)

**Scope:** when the operator edits the preview (F2) and clicks Apply with a non-trivial delta (>10 edit-distance OR multi-line changes), show a single-field inline prompt above the Apply button: *"Why did you change this? (optional, helps the agent learn)"*. Max 200 chars. If provided, stored as `BuildArtifactHistory.metadata.operatorRationale`.

**Out of scope:** full rationale modal, required input, agent-consumed feedback loop (that's a later sprint). This is just a capture channel — downstream features can read `operatorRationale` later.

**Frontend tests:**
- Threshold logic: trivial edits don't show the prompt; material edits do.
- Empty rationale still allows Apply (optional field).

**Acceptance:** edits above threshold capture a free-text "why" that rides along in metadata. Below threshold, no friction.

### F4 — Ledger + drawer surface inline-edit provenance

**Scope:** the write-ledger row (shipped 053-A D4) and the drawer's history view (shipped 054-A F2) both render a small chip when `metadata.rationalePrefix === 'edited-by-operator'`:

- Ledger row: `✏️ Edited` chip after the artifact name.
- Drawer rationale card: headline extended with `(edited by operator)` and the `operatorRationale` shown below the agent's original rationale.

**Frontend tests:**
- Both surfaces render the chip when the metadata is present.
- Neither surface regresses when the metadata is absent.

**Acceptance:** the provenance of every edit is visible wherever history is surfaced — plan checklist → ledger → drawer.

---

## 4. Parallelization plan (REQUIRED — dispatch subagents)

Claude Code for this sprint MUST dispatch Task-tool subagents rather than serialize gates. Two independent work-streams:

- **Stream A (plan-checklist + backend):** F1 end-to-end. Owns `plan-checklist.tsx`, `build-controller.ts` idempotency test, chat composer seed hook.
- **Stream B (drawer + editors):** F2 + F3 end-to-end. Owns `artifact-drawer.tsx`, the new `-editor.tsx` view siblings, and the rationale-prompt micro-component.

F4 is serial after A + B both land; it's a 30-minute merge-surface gate. Do not parallelize F4.

Dispatch pattern:

```
Task(subagent_type: "general-purpose",
     description: "Stream A: plan-as-progress + auto-approve",
     prompt: [F1 scope copied verbatim from §3 above, including non-negotiables + tests])

Task(subagent_type: "general-purpose",
     description: "Stream B: inline edit + rationale prompt",
     prompt: [F2 + F3 scope copied verbatim, including non-negotiables + tests])
```

**Send both in a single message** (two Task calls in parallel). Wait for both to return. Verify each landed a commit on `feat/055-session-a`. Then serially execute F4 yourself (it's small).

If either stream fails tests, re-dispatch the failing stream with the specific failure pasted in. Do not hand-fix via serial edits unless the failure is clearly a merge artifact.

---

## 5. Close-out checklist

- [ ] All four gates shipped as commits on `feat/055-session-a`
- [ ] Frontend tests green; backend tests green; record deltas in PROGRESS.md
- [ ] Manual smoke: post a 3-artifact plan turn, watch the progress checklist fill in without any Approve click; edit one preview in the drawer; Apply; see `✏️ Edited` in the ledger + drawer
- [ ] Sanitiser parity assertion triggered zero times during the smoke
- [ ] NEXT.md written for sprint-056 (candidate: compose-at-cursor, or the 049 explore-report P1 sweep if the user re-opens it)
- [ ] Archive this spec to `NEXT.sprint-055-session-a.archive.md` at close

---

## 6. Risks + mitigations

- **Auto-approve surprises the operator.** Mitigation: the plan card still says "Plan approved" (quietly, top-right timestamp) so it's visible without being loud. The per-artifact Apply gate means nothing writes without an explicit click.
- **Inline-edit drift from agent assumptions.** If the operator edits a SOP that the agent is about to cite in the same turn, the citation slug could stall. Mitigation: the 052-A citation-slug regression lock + 051-A viewer-faithfulness tests already cover the render path. The agent will see the edited body on the next tool call since caches bust on apply.
- **JSON editors for tool/property_override are fiddly.** Mitigation: fall back to "paste the full JSON" textarea for the edge cases; don't build a schema-aware tree editor this sprint.
- **Subagent dispatches produce divergent file layouts.** Mitigation: the prompts hand each subagent a specific file list and forbid touching files outside it. F4 is the integration gate that catches anything missed.

---

## 7. Explicit out-of-scope

- Compose-at-cursor (highlight text → scoped agent chat). Candidate for sprint-056.
- Per-row comment threads on plan items.
- Plan mutation after approval (adding / removing items mid-turn).
- Operator-rationale feedback loop into the agent (reading `operatorRationale` in future turns).
- 049 explore-report P1 sweep items (user deferred these).
