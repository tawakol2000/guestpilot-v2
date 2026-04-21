# Sprint 058 — Session A — Cache Fix, Versioning, Cancelability, Polish + 057 Bug Sweep

**Branch:** `feat/058-session-a` (stacks on `feat/057-session-a` → 056 → 055 → 054 → 053 → 052 → 051 → 050 → main)
**Parent tip expected:** tip of `feat/057-session-a` after F1+F2+F3 close-out. Verify with `git rev-parse` at session start.
**Session type:** A — overnight run on **Opus 4.7 with 1M context**. Backend + frontend surface, no schema change except one nullable column on `BuildArtifactHistory` (for F6 version tags). Schema change applied via `prisma db push` per constitution.
**Brainstorm §:** §3.1 (latency/cache), §4 (versioning as undo), §11.3 (cancel-in-flight), §16 (infra hygiene), 057-A post-ship screenshot regressions.
**Length discipline:** nine gates. This is a deliberately fat overnight sprint because the runner is Opus with 1M context and parallel subagent dispatch. **Three streams, dispatched in a single message.** Do not serialize.

---

## 0. Why this sprint exists

Seven sprints of 045-line work have given the product write faithfulness, plans, previews, rationale, three-variant tests, progress checklists, inline-edit, compose-at-cursor, retrieval, a tool-chain summary, typographic attribution, scroll discipline, and a queue. What it still does NOT have is the set of properties that make it feel like **mature infrastructure** instead of a heroic demo:

1. **Cost.** 056-A shipped the cache-telemetry pipe but the explicit `cache_control` breakpoints never landed because the Agent SDK's `options.systemPrompt` is string-only. The `[TuningAgent] usage` line has been logging `cached_fraction ≈ 0` for four sprints and everyone has been pretending it's fine. It is not fine — every turn re-reads ~14k system-prompt tokens at full price. Fix the bypass once.

2. **Reversibility.** 053-A shipped a write-ledger and per-row revert. 054-A added rationale. 055-A added operator-rationale on edit. But there is still no way to see **every version of an artifact over time**, diff any two versions, or revert to a version that is neither "the current one" nor "the one immediately before it." The history is there in `BuildArtifactHistory` — the UI surface is not.

3. **Cancellation.** A plan appears, three `○ pending` rows queue up, and the operator realizes halfway through that item 2 is wrong. Today the only options are (a) let it finish and revert, or (b) reload the page. There is no "skip this row" affordance. That turns every wrong plan into a full rollback.

4. **Observability of the session itself.** The operator ends a 45-minute session with seven artifact touches, three test rituals, and one rollback — and they have to reconstruct what happened from the scrollback. A session-diff summary card emitted at turn-end (when the agent decides the turn has landed) plus a sticky tenant-state banner closes the gap.

5. **Compose-time ergonomics.** 057 added queue-while-busy, 056 added compose-at-cursor. What's still missing is a "polish my sloppy prompt before I send it" button — the single most-requested Cowork-adjacent affordance from early managers. Small, cheap, shippable in one gate.

6. **057-A regressions (from last night's screenshots).** The 057 ship introduced six visible bugs. Documented under **F9 Bug Sweep** below. These get folded into this sprint rather than a separate hotfix because they're interdependent with the queue and attribution work.

Each of the nine gates below closes one of those holes.

---

## 0.1 Screenshot analysis — six regressions from 057-A (dependencies for F9)

The user attached eight screenshots of live 057-A Studio at sprint close. These are the six issues I extracted with direct pixel-level confirmation:

1. **React minified error #310 on Studio mount.** Shown as a browser-level error overlay with the standard React production-build message. #310 in React 19 is almost always a hooks order change — most likely the new F3b queue `useEffect` in `studio-chat.tsx` is conditional on a ref value that mutates between render and commit, or the new tool-chain summary in F1 is unmounting mid-stream without cleaning up a portal. The crash is intermittent — it renders fine on initial load but fires when a long turn is mid-stream and a new message arrives. Needs a dedicated error boundary wrapping `<StudioChat>` + a root-cause pass.

2. **Duplicate "Agent reasoning · viewAgent reasoning · view" text.** Directly reading `reasoning-line.tsx`: the component renders `"Agent reasoning · view"` as a single button with NO trailing whitespace. In `studio-chat.tsx` line 661-667, every `reasoning` part gets its own `<ReasoningLine>`, laid out with no separator. When the SDK emits two consecutive `reasoning` parts (common at chunk boundaries), the output runs together as `"Agent reasoning · viewAgent reasoning · view"`. Two fixes in combination: (a) merge consecutive `reasoning` parts by concatenating their `text` before rendering, (b) give `ReasoningLine` trailing margin or wrap it in a flex row with `gap`.

3. **"(unsupported card: step-start)" visible in the message body.** `step-start` is an AI-SDK internal delimiter marking the start of a new reasoning/tool/text step. `studio-chat.tsx` line 1109-1120 has an unknown-part fallback that renders a muted placeholder for any unrecognized `type`. Add a silent-drop allow-list for SDK internal markers (`step-start`, `step-finish`, `start`, `finish`, `start-step`, `finish-step`) — any type starting with `step-` or matching the known lifecycle set returns `null`.

4. **Session-artifacts rail says "No artifacts touched in this session yet" while two artifacts are visible in chat.** `session-artifacts.tsx` receives its list from a prop, probably sourced from a state slice that's populated by `data-build-history` SSE parts during the current turn but NOT hydrated from the server on page reload. Reproduce by: (a) send a turn that writes an artifact, (b) reload the page, (c) observe rail is empty while chat still shows the write. The fix: on mount, fetch prior `BuildArtifactHistory` rows for this `conversationId` and seed the rail. Backend endpoint likely already exists (054-A F2); if not, add it.

5. **Composer shows "Agent is replying..." as a DISABLED placeholder instead of allowing queue-while-busy.** This directly contradicts 057 F3b, which says: allow typing with a "Queued (N)" badge while streaming. The screenshot shows the composer grayed out and the operator locked out until the turn finishes. Likely cause: the 057 F3b commit merged the queue state + badge UI but kept the old `disabled={isStreaming}` on the textarea. The fix is one line (remove the disabled attribute) + a visual check that the queue state still works end-to-end.

6. **Session list is cluttered with empty "Studio session · 0 messages" rows.** Every page reload creates a fresh `TuningConversation` row when the currently-selected session fails to rehydrate (see `studio-surface.tsx` line 165-173). Combined with the generic hardcoded title (`'Studio session'` or `'Studio — initial setup'`), the session list sidebar ends up full of identical, empty, useless rows. Two fixes: (a) auto-name sessions from first user message or first artifact touched, (b) add a server-side GC that deletes empty (zero-message) sessions older than 1 hour OR a UI-level hide toggle that filters zero-message sessions from the list by default.

All six fixes land in **F9 Bug Sweep** as sub-gates F9a–F9f.

---

## 1. Non-negotiables

- **`ai.service.ts` stays untouched.** Guest-reply pipeline is on OpenAI and out of scope forever in the 045-line.
- **BUILD agent tool surface stays stable.** F4 adds one new tool (`emit_session_summary`) and F1 changes how the system prompt is transmitted, not what it says. No other prompt changes.
- **Schema change (minimal):** F6 adds one nullable column `BuildArtifactHistory.versionLabel String?`. Applied via `prisma db push` per constitution §Development Workflow. No migration of existing rows required (null = unlabeled, which is the default).
- **Apply in the drawer is still the only write gate.** Version-revert (F3) and named-version-revert (F6) both write through the existing `/api/build/history/:id/revert` endpoint (053-A D4). Arbitrary-version-diff (F7) is read-only.
- **Cache fix does NOT change correctness.** F1 swaps transport (Agent SDK → direct `@anthropic-ai/sdk` call) for the one query where we need block-array system prompts. Hooks, MCP, allowedTools, session persist — all must still work identically. If any test fails, the stream stops and reports.
- **Cancel (F2) is advisory.** Cancelling a `○ pending` row flips a server-side flag that the agent reads on its next tool call and chooses to skip. It does NOT kill an in-flight `create_*` call. If the agent is mid-write when cancel fires, the write completes and the cancel is a no-op. Documented in the toast ("Agent was already past this item").
- **Graceful degradation.** Every new surface (Versions tab, enhance-prompt button, sticky banner, session-diff card) falls back to empty-state or hides itself when its data isn't available. No card is ever the sole cause of layout breakage.
- **Overnight-run discipline.** Every subagent is instructed **STOP ON TEST FAILURE. DO NOT PRESS ON.** Clean failure with a diagnostic dump > silent bleed through remaining gates. See §4.
- **Branch discipline.** Stack on `feat/057-session-a`. Do NOT rebase onto main.

---

## 2. Pre-flight gate

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a feat/053-session-a feat/054-session-a feat/055-session-a feat/056-session-a feat/057-session-a
```

Write SHAs into `specs/045-build-mode/PROGRESS.md`. Verify `feat/057-session-a` tip matches the user's close-out report from the turn that kicked this sprint off.

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && npm test
```

Expected from 057-A close-out: frontend ~240/240 (057 added ~20 tests to 056's 220 baseline). Backend has 2 pre-existing failures carried since 056; record the actual count — do NOT try to fix those failures in this sprint. Any NEW failure introduced by a subagent means that stream stops and reports.

### 2.3 Cache telemetry baseline (F1 prerequisite)

BEFORE writing any code, run a real BUILD-mode turn against staging and grep the `[TuningAgent] usage` log line:

```
grep "\[TuningAgent\] usage" backend/logs/*.log | tail -5
# or tail the dev server while triggering a 2-turn BUILD conversation
```

Record `cache_read`, `cache_created`, `input`, and `cached_fraction` from turn 1 and turn 2 of the same fresh conversation into PROGRESS.md. Expected 057-A baseline: `cached_fraction < 0.10` on turn 2 (the 056-A stub shipped `explicitCacheControlWired: false`). If you see `cached_fraction >= 0.50` on turn 2, stop and read `prompt-cache-blocks.ts` — caching is unexpectedly already working, F1 reduces to verification + docs.

### 2.4 Screenshot-regression repro

Before starting F9, verify each of the six bugs reproduces against the 057-A tip. Record each verdict into PROGRESS.md's "058 pre-flight" section. If a bug no longer repros, that sub-gate reduces to "add a regression test and move on." If a new bug shows up that wasn't in §0.1, add it as F9g and proceed.

### 2.5 Existing-capability probe

```
grep -n "BuildArtifactHistory\|versionLabel\|historyId" backend/src/controllers/build-controller.ts backend/prisma/schema.prisma
grep -n "PlanChecklist\|PLAN_ITEM_CANCELLED\|planItemCancelled" frontend/components/build/plan-checklist.tsx backend/src/build-tune-agent/tools/plan-build-changes.ts
grep -n "queuedMessages\|isStreaming\|disabled.*streaming" frontend/components/studio/studio-chat.tsx
grep -n "step-start\|unsupported card" frontend/components/studio/studio-chat.tsx
grep -n "session/[{]conv" backend/src/services/tenant-state.service.ts
```

Expected: `BuildArtifactHistory` exists + is indexed; `PlanChecklist` has row-state logic but no cancel button; `queuedMessages` state exists from 057-A F3b; `step-start` currently falls into the unsupported-card fallback; `tenant-state.service.ts` reads `session/{conv}/slot/*` memory keys. If any probe comes up empty, stop — a sprint assumption is violated.

---

## 3. Gates

Nine gates. Three streams. **Dispatch all three subagent tasks in a single message** (three Task calls in parallel). See §4.

### F1 — Cache fix: SDK bypass + explicit `cache_control`

**Scope:** make Anthropic prompt caching actually work for the BUILD agent by bypassing the Agent SDK's string-only `systemPrompt` and calling `@anthropic-ai/sdk` directly with a content-block array. Keep the SDK for hooks, MCP, allowedTools, session persistence — bypass only the single `messages.create` (streaming) call.

**Investigation first (required):**
- Read `backend/src/build-tune-agent/runtime.ts` around the `query({ ... })` call (line ~409-441).
- Read `backend/src/build-tune-agent/prompt-cache-blocks.ts` — 056-A shipped the block-splitter helper (splits assembled prompt at `__SHARED_MODE_BOUNDARY__` and `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`).
- Read `backend/src/build-tune-agent/system-prompt.ts` — confirm the two boundary markers are still present and literal-string-matched.
- Run §2.3 baseline turn. Confirm `cached_fraction` is near zero on turn 2. If it's not, the fix reduces to documentation.

**Implementation:**
- Introduce a new function `runBuildTurnDirect` in `runtime.ts` (or a sibling file `runtime-direct.ts`) that:
  - Takes the same input as the existing `runBuildTurn` wrapper.
  - Splits the assembled system prompt into three blocks using `splitPromptForCacheControl` (already in 056-A's `prompt-cache-blocks.ts`).
  - Calls `@anthropic-ai/sdk` `messages.create({ stream: true })` with:
    - `system: [{ type: 'text', text: regionA, cache_control: { type: 'ephemeral' } }, { type: 'text', text: regionB, cache_control: { type: 'ephemeral' } }, { type: 'text', text: regionC }]`
    - `tools: [...toolsArray, { ...lastTool, cache_control: { type: 'ephemeral' } }]` (attach `cache_control` to the last tool — this caches the full tools block per Anthropic docs)
    - `messages: [...]` — the conversation history.
    - `model`, `max_tokens`, `thinking` config as today.
  - Pipes the SSE stream through the same `stream-bridge.ts` pipeline that the SDK path uses, so downstream consumers (frontend SSE parts, hooks, MCP responses, session persistence) see no difference.
  - Re-implements the hook points that the SDK provides (`preToolUse`, `postToolUse`, etc.) by inspecting the event stream. The existing hooks in `backend/src/build-tune-agent/hooks/` are plain functions — they can be invoked directly from the direct path.
- Gate the direct path behind an env flag `BUILD_AGENT_DIRECT_TRANSPORT=true`. Default ON in dev + staging, OFF in prod initially. The operator flips it after smoke. Documented in CLAUDE.md.
- MCP: if the BUILD agent has MCP servers attached via the SDK, the direct path must reproduce the MCP tool-call loop (SDK → server → response → SDK). The minimum viable version is: enumerate MCP tools at startup, include them in the `tools` array, handle `tool_use` blocks by routing `mcp__*` names to the MCP client manually. If this turns out to be a large refactor, the stream stops and reports — we'll scope a follow-up sprint.

**Tests:**
- `runtime-direct.test.ts`: mock `@anthropic-ai/sdk`, assert the direct call sends `system` as an array of 3 text blocks with cache_control on blocks 0 and 1.
- `runtime-direct.test.ts`: assert `cache_control` is attached to the last tool in `tools[]`.
- `runtime-direct.test.ts`: assert stream events are forwarded through `stream-bridge.ts` identically to the SDK path (snapshot-compare for one realistic turn).
- `prompt-cache-blocks.test.ts` (exists): extend to assert the three-block emission is byte-identical across two turns of the same tenant + mode.
- Integration: real live turn against staging with `BUILD_AGENT_DIRECT_TRANSPORT=true`. Record `cached_fraction` on turn 2. Expected: `>= 0.70`.
- LangFuse spot-check: the existing `data-cache-stats` SSE part from 056-A should now populate non-zero values.

**Acceptance:** turn 2 of a fresh BUILD conversation logs `cached_fraction >= 0.70`. Claude Console cache dashboard starts registering hits within ~10 minutes of the first direct-transport turn. All pre-existing BUILD-agent tests stay green.

**Risk note:** the MCP tool-call loop reproduction is the hairiest part. If the direct path breaks tool-calling end-to-end, the stream MUST stop and report — we do not want to ship a silent regression on tool use for the sake of cache hits.

### F2 — Cancel pending plan row

**Scope:** add a `×` button on `○ pending` rows of `PlanChecklist`. Click → advisory server-side flag that the agent reads on its next tool call and skips the matching item. `● current` rows (agent is already writing) and `✓ done` rows get no × button.

**Backend surface:**
- New endpoint `POST /api/build/plan-items/:transactionId/cancel` — body `{ index: number }` (0-based position of the item in the plan's `items[]` array).
- Controller writes into `BuildTransaction.cancelledItemIndexes Int[]` (new column on the existing table — nullable default empty array, applied via `prisma db push`).
- On the agent's next `create_*` tool call, the tool pre-flight (already exists in `build-transaction.ts`) checks: is this item's index in `cancelledItemIndexes`? If yes, return early with `{ ok: false, reason: 'plan_item_cancelled' }` and the agent will receive that as the tool-result. Prompt nudge in the BUILD addendum: when a `plan_item_cancelled` result comes back, skip that item silently and continue with the rest of the plan.
- Tenant-scoped: endpoint verifies the transaction belongs to the current tenant before writing.

**Frontend:**
- In `plan-checklist.tsx`, on hover of a `○ pending` row, render a `×` button at the right edge (next to the existing `+` button from 055-A F1). Tooltip: "Skip this item".
- Click → `apiCancelPlanItem(transactionId, index)` → row state flips to `× cancelled` immediately (optimistic) with a subtle line-through style.
- If the server returns `{ alreadyExecuting: true }` (the agent was already past this item), the row stays `● current` or `✓ done` and show a toast: "Agent was already past this item — use Revert instead".
- The cancel button is NOT shown on an already-cancelled row, an already-executing row, or an already-done row.

**Tests:**
- Backend: POST-then-read roundtrip. Concurrent POSTs to the same index → one DB write, both succeed.
- Backend: agent pre-flight returns `plan_item_cancelled` for a cancelled index.
- Backend: tenant isolation.
- Frontend: × button only on `○` rows; click optimistically transitions to `×`; API call fires once.
- Frontend: server "already executing" path shows the toast.

**Acceptance:** operator sees a 4-item plan, hovers row 2, clicks ×. Row 2 turns to `× cancelled`. Agent's next tool call (which would have been `create_sop` for row 2) comes back as skipped; agent moves on to row 3.

### F3 — Version history + any-version revert (Versions tab in drawer)

**Scope:** add a **Versions** tab to `artifact-drawer.tsx`. Lists every `BuildArtifactHistory` row for this artifact, newest first. Each row shows: timestamp, operation (`CREATE`/`UPDATE`/`DELETE`/`REVERT`), rationale excerpt, operator-edit chip if applicable, "Revert to this version" button.

**Backend:**
- Reuse the `get_edit_history` tool from 056-A F2 for the data. If the drawer's history fetch was previously via a separate endpoint, migrate to reuse.
- New endpoint `POST /api/build/history/:id/revert-to` — like the existing 053-A D4 `/revert` endpoint, but takes an explicit target version rather than "undo most recent." Implementation: look up the target row's `bodyApplied`, write a new `BuildArtifactHistory` row with `operation='REVERT'`, `bodyApplied` copied from target, `metadata.revertedFromHistoryId = targetId`, `rationale` = "Reverted to version from <timestamp>". Tenant-scoped.
- Apply-layer: the revert writes through the same apply service that `create_*` tools use, so sanitiser parity holds.

**Frontend:**
- `artifact-drawer.tsx` currently has tabs (or tab-like regions) for Preview, History, etc. Add a third tab **Versions** that lists every history row for this artifact.
- Each row: timestamp pill, operation badge, rationale excerpt (truncated at 120 chars, hover-expand), "Revert to this" button.
- Click "Revert to this" → confirmation dialog (reuse `ConfirmRollbackDialog`) → POST to `/revert-to` → drawer re-fetches → preview now shows the reverted body → Apply button unchanged.
- When the list is empty (brand-new artifact), show "No prior versions" empty state.
- When a row is the currently-applied version, disable its Revert button and show "Current" chip.

**Tests:**
- Backend: `/revert-to` with a valid target creates a new history row with correct linkage; tenant isolation holds.
- Backend: `/revert-to` with a target that belongs to another artifact → 404.
- Frontend: Versions tab renders all rows, newest first; "Current" chip on the first row; "Revert to this" opens confirmation and fires the API call on confirm.
- Frontend: post-revert, the Preview tab shows the reverted body.

**Acceptance:** open any artifact drawer, click the Versions tab, see 5 rows for a well-edited SOP. Click "Revert to this" on row 4 (two versions ago). Confirm. The drawer now previews the older body and lets you Apply it as the current version. (Result: a new history row on top that re-asserts the old content.)

### F4 — Session-diff summary (turn-end card)

**Scope:** add a new BUILD-agent tool `emit_session_summary` that the agent calls once, at the end of a turn it judges "complete" (not mid-tool-loop). Emits a `data-session-diff-summary` SSE part the frontend renders as a compact card: "This turn — created 2 SOPs, edited 1 FAQ, ran 1 test (2/3 passed), reverted 0."

**Tool definition** (`backend/src/build-tune-agent/tools/emit-session-summary.ts`):

```
emit_session_summary({
  written: { created: number, edited: number, reverted: number },
  tested: { runs: number, totalVariants: number, passed: number },
  plans: { cancelled: number },
  note: string | null,    // free-text 1-liner, max 120 chars
}) → { ok: true }
```

**Prompt nudge** in BUILD addendum (Region B):

> At the end of a turn — not mid-loop — when you believe the work is at a natural stopping point, call `emit_session_summary` once with the tally of writes, tests, reverts, and cancellations you performed in this turn. This renders a summary card to the manager. Do NOT call it during a tool loop; call it as your last action, right before your final text reply.

**Validation:** the tool is a write-only emit, no side effects. Must be called at most once per turn — second call in the same turn returns `{ ok: false, reason: 'already_emitted_this_turn' }`.

**Frontend:**
- New SSE part handler for `data-session-diff-summary`.
- New component `session-diff-card.tsx` renders a compact horizontal row: `✏️ Wrote 2 · 🔧 Edited 1 · 🧪 Tested 1 (2/3) · ⤺ Reverted 0 · ✖ Cancelled 0` plus the optional `note` on a second line.
- Card renders once per turn, anchored to the end of that turn's assistant message.
- Attribution: grey-for-AI per 057-A F2 grammar.

**Tests:**
- Tool respects once-per-turn rule.
- Frontend renders the card when the SSE part is received; renders nothing when absent.
- Graceful on partial data (e.g. only `written` present).

**Acceptance:** a multi-artifact turn ends with a compact tally card that tells the operator "here's what this turn did" without them scrolling back.

### F5 — Sticky tenant-state banner

**Scope:** a slim banner at the top of the Studio chat area showing `tenant-state` (GREENFIELD / BROWNFIELD) + system-prompt status (active version, last edited ago). Sticks to the top of the scroll area; does not scroll away during long turns.

**Data source:** `apiGetBuildTenantState()` already returns this (used in `studio-surface.tsx` bootstrap). Poll on mount + re-fetch after any `data-build-history` event that touches a `system_prompt` artifact.

**Component:** new `tenant-state-banner.tsx`. Renders as a 32-px-tall row: left-aligned state pill (`GREENFIELD` / `BROWNFIELD` with color coding), then a middle caption ("System prompt — v7, edited 2h ago by you" or "v3, unedited since seed"), then a right-aligned open-prompt-drawer chevron.

**Placement:** at the very top of `studio-chat.tsx`, INSIDE the scroll container so it naturally sticks. `position: sticky; top: 0; z-index: 5`. Styled to match the Studio palette (`STUDIO_COLORS.surfaceSunken` background, thin `hairlineSoft` bottom border).

**Interaction:**
- Click the prompt-status caption → opens the system-prompt drawer (existing 051-A viewer) in read mode.
- If the tenant is GREENFIELD and no prompt exists yet, the caption reads "No system prompt yet — ask the agent to write one" with a seed-suggestion button.

**Tests:**
- Banner renders GREENFIELD vs BROWNFIELD states with correct color coding.
- Caption updates after a `data-build-history` event for a `system_prompt` artifact.
- Click caption opens the prompt drawer.

**Acceptance:** the operator never loses track of which tenant they're configuring or what the current prompt looks like — the banner is always in view at the top of the chat.

### F6 — Named version tags (rides on F3)

**Scope:** add a `versionLabel String?` column to `BuildArtifactHistory` (nullable). Let the operator tag any history row with a short label ("pre-checkin-SOP-cleanup", "before the 4pm change", "stable"). Show tags on the Versions tab (F3) and in the ledger. Revert by tag name as a shortcut — "Revert to last 'stable'".

**Schema:**
- Add `versionLabel String?` to `BuildArtifactHistory`. Apply via `prisma db push`. No migration.
- Index: `@@index([tenantId, versionLabel])` for fast "latest by tag" lookups.

**Backend:**
- New endpoint `POST /api/build/history/:id/tag` — body `{ label: string }`. Max 40 chars, alphanum + dashes only. Stores label on the history row. Returns the updated row.
- New endpoint `DELETE /api/build/history/:id/tag` — removes the label.
- Reuse `/revert-to` from F3 for the actual revert. Front end converts "revert to tag X" into "find the most recent history row with label=X, POST to /revert-to with that id."

**Frontend:**
- On the Versions tab (F3), each row has a small "Tag" pencil button. Click → inline input (max 40 chars) → save → label chip renders on the row.
- Existing labeled rows: the label chip renders to the right of the timestamp. Click the chip → offers "Remove tag" menu.
- Add a top-of-Versions-tab dropdown: "Jump to tag" — select any existing label for this artifact → scrolls that row into view.
- Ledger row (from 053-A D4): if the history row has a label, show it as a small chip to the left of the artifact name.

**Tests:**
- Backend: tag + untag roundtrip; tenant isolation.
- Backend: label validation (length, charset) → 400 on invalid.
- Frontend: tag input validates charset; label chip renders on tagged rows; "Jump to tag" scrolls.

**Acceptance:** operator tags version 4 as "before-early-check-in-rework," makes six more edits, then a month later they can return to the Versions tab, click "Jump to tag: before-early-check-in-rework," and revert to that exact version.

### F7 — Arbitrary-version diff

**Scope:** on the Versions tab (F3), two checkboxes per row (A / B). Pick any two rows → click "Diff A → B" button at the top → opens a diff viewer showing the body change between the two selected versions.

**Diff renderer:** reuse the 053-A D3 preview-diff rendering. The diff inputs are `historyRowA.bodyApplied` and `historyRowB.bodyApplied`. No new backend endpoint — the data is already in the rows fetched for the Versions tab.

**UX detail:**
- "Diff A → B" button stays disabled until exactly two rows are selected.
- Clicking a third checkbox replaces the oldest of the currently-selected two (A gets overwritten, B becomes the new A).
- The diff opens as a drawer-within-the-drawer (or a modal — whichever fits the existing layout pattern); close returns to the Versions tab with selections preserved.
- A "Revert to version A" / "Revert to version B" button at the bottom of the diff view lets the operator pick a side directly.

**Tests:**
- Two-row selection logic: third click replaces oldest.
- Diff opens with correct A / B bodies; close restores Versions tab state.
- "Revert to A" fires the same `/revert-to` endpoint from F3.

**Acceptance:** operator picks version 4 and version 7 of a SOP, opens the diff, sees exactly what changed, clicks "Revert to A." The revert is one click deep.

### F8 — Enhance-prompt composer button (✨)

**Scope:** a small ✨ button to the left of the send button in the Studio composer. Click → runs the current composer draft through a Nano rewrite that polishes grammar, tightens phrasing, and preserves intent. Replaces the composer text with the rewrite; operator can Undo once via `⌘Z` (component-level undo, not browser-level).

**Backend:**
- New endpoint `POST /api/build/enhance-prompt` — body `{ draft: string }`. Non-streaming.
- Calls `gpt-5-nano` (existing model, used for summaries and task dedup — see CLAUDE.md Models Used table) with a short system prompt: "Rewrite the manager's draft for clarity and concision. Preserve every factual detail. Do not add scope. Return only the rewrite, no preamble. Max 3 sentences."
- Tenant-scoped (same auth middleware as other `/api/build/*` endpoints).
- Rate-limited: 20 requests per minute per conversation → 429.

**Frontend:**
- ✨ button: shown only when the composer has ≥ 10 characters of text.
- Click → button enters loading state (small spinner), API call fires, response replaces composer text.
- Store the pre-enhance draft in component state; `⌘Z` within 15 seconds restores it. Toast on restore: "Restored your original".
- If the API errors, toast: "Couldn't enhance — try again" and leave the draft as-is.

**Tests:**
- Backend: endpoint returns a rewrite for a valid input; tenant isolation; rate limit.
- Frontend: button shows at >=10 chars, hides below; click replaces text; ⌘Z within 15s restores original; undo expires after 15s.

**Acceptance:** operator types "please look at the check in sop its not great make it better", clicks ✨, text becomes "Please review the check-in SOP — it needs tightening and a clearer tone." Hits enter. Agent gets the polished version.

### F9 — Bug sweep (screenshot-derived)

All six sub-gates below are small, scoped fixes. Each gets at least one regression test. Land as one or more commits on `feat/058-session-a`. Do NOT fold these into the other gates — keep them isolated for easy cherry-pick/revert.

#### F9a — React #310 error boundary + root-cause

**Step 1 (error boundary — required regardless):** wrap `<StudioChat>` in an error boundary in `studio-surface.tsx`. On crash, render a recoverable card: "Something broke in the chat view. Reload to recover. [Copy diagnostic to clipboard]." Diagnostic copy includes the error message, stack, and the last 3 SSE part types received. Use React 19's `<ErrorBoundary>` pattern (class component or a small wrapper).

**Step 2 (root cause):** reproduce #310 by running a long tool-loop turn on staging with `BUILD_AGENT_DEV_TOOLS=true` (non-minified builds show the real message). Most likely culprits:
- The 057 F3b queue `useEffect` has a hook-order dependency on a ref that mutates during streaming.
- The 057 F1 ToolChainSummary mounts/unmounts based on `toolParts.length`, which can go from `0` to `>0` mid-render.
- The 057 F2 `AttributedText` component is created inside a render function and re-created each render.

Whichever it is, fix it + add a test that specifically mounts the minimal failing case (mock SSE stream with reasoning → tool → text in rapid succession).

**Step 3 (guard rail):** add a `studio-chat-hooks.test.tsx` that asserts hook-call count is stable across a representative sequence of props changes. This is a lint-style regression lock for future refactors.

**Tests:** error boundary renders diagnostic on forced throw; root-cause test reproduces the specific #310 scenario and passes after fix; hook-count-stability test passes.

**Acceptance:** Studio never crashes the whole page; if any error sneaks through, the operator sees a recovery card not the React default overlay.

#### F9b — Reasoning-line dedup / merge

Two changes in combination, both in `studio-chat.tsx` around line 613-667:

1. **Merge consecutive reasoning parts** in the classifier loop. Currently every `p.type === 'reasoning'` part gets its own entry in `reasoningParts`. Change the loop to concatenate `p.text` into the previous entry when the previous classified part was also `reasoning`. Result: one `<ReasoningLine>` per reasoning streak, not per chunk.
2. **Defensive gap between ReasoningLines** in the render at line 661-667. Wrap the map in `gap-1` or similar, so even if two `<ReasoningLine>` instances do render, they don't run text-without-whitespace together.

**Tests:**
- Classifier loop: feed [reasoning(a), reasoning(b), text(c), reasoning(d)] → produces one reasoning with "ab", one text, one reasoning with "d".
- Render: two ReasoningLines have visible separation.

**Acceptance:** screenshots show "Agent reasoning · view" exactly once per reasoning streak, never doubled.

#### F9c — Silent drop of SDK step-* markers

In `studio-chat.tsx` line 1109-1120 (the unsupported-card fallback), add an early-return guard before the muted-placeholder render:

```
// AI SDK internal lifecycle markers — these are delimiters, not content.
// Render nothing for them.
const SDK_INTERNAL_TYPES = new Set([
  'step-start', 'step-finish', 'start-step', 'finish-step',
  'start', 'finish',
])
if (SDK_INTERNAL_TYPES.has(type) || type?.startsWith('step-')) return null
```

Keep the muted placeholder for genuinely unknown types — those signal a real gap.

**Tests:**
- `StandalonePart({ part: { type: 'step-start' } })` renders nothing.
- `StandalonePart({ part: { type: 'data-some-unknown' } })` still renders the muted placeholder.

**Acceptance:** no "(unsupported card: step-start)" ever shows in the UI.

#### F9d — Session-artifacts rail hydration

In `studio-surface.tsx` bootstrap (line ~147-193), after the conversation is loaded or created, call a backend endpoint that returns `BuildArtifactHistory` rows for this conversation's transactions. Seed the rail state with those rows so a page reload preserves the "artifacts touched in this session" display.

**Backend:**
- New endpoint (or reuse if one exists): `GET /api/build/sessions/:conversationId/artifacts` → returns `[{ historyId, artifactType, artifactId, artifactName, touchedAt, operation }]`.
- Tenant-scoped. Filtered to history rows whose `BuildTransaction.conversationId` matches.

**Frontend:**
- After `apiGetTuningConversation` returns, call the new endpoint. Populate session-artifacts state from the response before `<SessionArtifacts>` renders.
- Continue to listen to `data-build-history` SSE parts for live updates during the session — the hydration is only the initial seed.

**Tests:**
- Backend: endpoint returns correct rows for the conversation; tenant isolation.
- Frontend: mock conversation with 2 prior artifacts → rail shows them on mount, not empty state.

**Acceptance:** operator writes 2 artifacts, reloads the page, sees the rail populated with those 2 artifacts — no more "No artifacts touched in this session yet" lie.

#### F9e — Composer-while-busy (057 F3b restoration)

In `studio-chat.tsx` composer render, remove the `disabled={isStreaming || isSending}` attribute from the textarea (if present — the commit history from 057 F3b may have partially reverted this).

Verify the queue logic from 057 F3b still works end-to-end:
- Typing while `isStreaming` → text appends to local draft, composer shows it.
- Clicking send while busy → appends to `queuedMessages`, clears draft, shows "Queued (N)" badge.
- When status returns to `'ready'`, queue flushes one at a time.

Placeholder text change: instead of "Agent is replying...", the composer's placeholder while streaming reads "Type to queue — will send when the agent finishes". Keep the placeholder `color` muted.

**Tests:**
- Textarea is NOT disabled during streaming.
- Typing while streaming updates the draft state.
- Send while streaming adds to queue; badge appears; queue flushes on ready.

**Acceptance:** operator can type a follow-up while the agent is mid-turn. 057 F3b works as specified.

#### F9f — Session list auto-naming + empty-session cleanup

Three changes:

**1. Auto-name on first user message.** In `studio-surface.tsx`, after the operator's first user message of a session is sent, if the conversation's title is still the default (`'Studio session'` or `'Studio — initial setup'`), call a new endpoint `PATCH /api/tuning-conversations/:id/title` with `{ title: autoTitleFromFirstMessage(text) }`. `autoTitleFromFirstMessage` truncates the message to 50 chars, strips trailing punctuation, capitalizes the first letter.

**2. Auto-name on first artifact touched (fallback).** If the first message is vague ("hi", "test", <15 chars), skip step 1. On the first `data-build-history` event, set the title to `{operation} ${artifactType}: ${artifactName}` (truncated to 50 chars). First-write wins — no overwrites.

**3. Empty-session cleanup.** In the session list sidebar (wherever it's rendered — find the file with `'Studio session'` in it), add a default filter that hides conversations with `messageCount === 0` AND `createdAt > 1h ago`. Add a "Show empty sessions" toggle that defaults to off. Optional backend GC: add a cron job under `backend/src/jobs/` that deletes zero-message sessions older than 24h (defer the cron if it's out of budget; the filter alone is enough to ship).

**Tests:**
- `autoTitleFromFirstMessage('please look at the check in sop...')` → `'Please look at the check in sop'`.
- Session with 0 messages is hidden by default in the list; toggle reveals it.
- First-write auto-name sets the title correctly when the first message was too short.

**Acceptance:** session list stops being a graveyard of "Studio session · 0 messages" rows. Meaningful sessions get meaningful names from first intent.

---

## 4. Parallelization plan (REQUIRED — dispatch subagents)

Three streams. **Dispatch all three in a single message** (three Task calls in parallel). Wait for all three to return before starting the close-out smoke.

- **Stream A (backend-heavy) — F1 + F4 + F8-backend + F9d-backend:** cache fix, session-summary tool, enhance-prompt endpoint, session-artifacts hydration endpoint. All within `backend/src/`. Minimal frontend touch (just the SSE wiring for F4's card — keep the component itself in Stream B's scope).

- **Stream B (frontend-heavy) — F2 + F3 + F5 + F6 + F7 + F8-frontend + F9d-frontend:** cancel row, Versions tab, sticky banner, version tags, arbitrary diff, enhance-prompt button, session-artifacts hydration wiring. Plus the session-diff-card component from F4 (Stream A emits the SSE part; Stream B renders it).

- **Stream C (bug sweep) — F9a + F9b + F9c + F9e + F9f:** React #310 error boundary + root cause, reasoning-line dedup, step-marker silent drop, composer-while-busy restoration, session auto-naming. Pure regression work. Touches `studio-chat.tsx`, `studio-surface.tsx`, a new error boundary component, and the session list. Keep it isolated from Streams A/B — if the other streams crash each other's work, C's fixes land as the safety net.

**Overlap:** all three streams touch `studio-chat.tsx`. Each subagent is briefed with an explicit file-list and the specific function bodies they're allowed to edit. If a merge conflict happens at close, prefer Stream C's edits for that file (C is the regression-safety stream), then layer A/B on top. Run tests after each merge.

**Dispatch pattern (from Claude Code's kickoff):**

```
Task(subagent_type: "general-purpose",
     description: "Stream A: cache fix + F4 tool + F8 endpoint + F9d backend",
     prompt: [F1 + F4 + F8-backend + F9d-backend scope, verbatim + pre-flight SHAs])

Task(subagent_type: "general-purpose",
     description: "Stream B: versioning + banner + enhance button + artifacts wiring",
     prompt: [F2 + F3 + F5 + F6 + F7 + F8-frontend + F9d-frontend scope, verbatim + pre-flight SHAs])

Task(subagent_type: "general-purpose",
     description: "Stream C: 057 regression sweep",
     prompt: [F9a + F9b + F9c + F9e + F9f scope, verbatim + pre-flight SHAs + §0.1 screenshot-analysis block])
```

All three Task tool calls in the SAME message. Send and wait. Do NOT serialize.

### 4.1 Overnight-run discipline (mandatory — this is an unsupervised Opus run)

Every subagent prompt MUST include this language verbatim:

> **Stop-on-failure.** If any test you write or run fails, STOP. Do not continue to the next gate. Do not "press on" with the assumption that you'll fix it later. Write a clear diagnostic report to `specs/045-build-mode/058-stream-{A|B|C}-failure.md` with: the failing test name, the last 50 lines of test output, the last 10 lines of the file you were editing when the failure happened, and your current hypothesis for the cause. Then exit. The main thread will triage and re-dispatch with a fix prompt.
>
> **Clean failure > silent bleed.** An agent that stops cleanly at gate 3 of 9 is recoverable. An agent that pushes through with broken tests and a tangled branch is not. Bias hard toward stopping.
>
> **File-list discipline.** You own only the files listed in your scope. If you need to edit a file outside your list to complete a gate, stop and report instead. The other streams are running in parallel and will clobber cross-stream edits.
>
> **Commit per gate, not per sprint.** Each gate (F1, F2, F3, ...) is one commit on `feat/058-session-a`. Smaller commits are fine. One giant commit at the end is not — it makes cherry-pick/revert impossible and makes failure recovery harder.
>
> **Test counts.** Baseline from §2.2 is recorded. Your expected test delta is documented per-gate. If the delta is wildly off (e.g. you added 5 tests where 20 were expected, or 50 where 20 were expected), stop and report — something about the gate went sideways.

---

## 5. Close-out checklist

- [ ] Nine gates shipped as commits on `feat/058-session-a`. Minimum 9 commits; more if subagents split their work.
- [ ] Frontend tests green; backend tests green; record deltas in PROGRESS.md. Expected net frontend delta: +40 to +60 tests. Backend: +10 to +20.
- [ ] F1 cache verification: `cached_fraction >= 0.70` on turn 2 of a staging conversation with `BUILD_AGENT_DIRECT_TRANSPORT=true`. Before/after numbers recorded in PROGRESS.md.
- [ ] Screenshot repro verification: each of the six bugs in §0.1 has a passing regression test AND the manual repro no longer triggers the bug.
- [ ] Manual smoke:
  - (a) run a 3-artifact plan turn, cancel row 2 mid-flight → row 2 goes to `×`, agent skips to row 3
  - (b) open an artifact drawer, click Versions tab, revert to the third-from-latest version
  - (c) tag any version as "stable," write 3 more versions, jump-to-tag "stable," revert
  - (d) pick two versions on the Versions tab, click "Diff A → B," revert to A
  - (e) type a sloppy prompt, click ✨, see it rewritten
  - (f) at end of a multi-artifact turn, see the session-diff card tally
  - (g) banner at top shows BROWNFIELD + current prompt version
  - (h) reload the page → session-artifacts rail still populated, session list no longer shows empty rows, current session has a meaningful auto-name
  - (i) run a long reasoning turn → no duplicate "Agent reasoning · view" text, no "(unsupported card: step-start)," composer is typeable during streaming, page never crashes with React #310
- [ ] NEXT.md written for sprint-059 (candidate: mobile-responsive Studio OR multi-operator real-time presence OR agent-consumed operator-rationale feedback loop)
- [ ] Archive this spec to `NEXT.sprint-058-session-a.archive.md` at close.

---

## 6. Risks + mitigations

- **F1 MCP reproduction depth.** The direct-transport path must handle MCP tool calls as capably as the SDK. If MCP integration is deeper than anticipated, Stream A stops and reports; do NOT ship a direct path that breaks MCP tool use. Fallback: gate F1 behind `BUILD_AGENT_DIRECT_TRANSPORT=false` by default and ship the docs + telemetry investigation only.
- **F1 stream-bridge compatibility.** `stream-bridge.ts` is currently shaped around the SDK's event types. Mapping the raw Anthropic SDK events to the same shape needs careful attention to `tool_use` / `tool_result` / `thinking` block types. Include a snapshot-test of a real turn's SSE output pre-and-post-F1 to guard against drift.
- **F2 cancel race.** Operator cancels row 2 at the exact moment the agent's `create_sop` for row 2 is in-flight. The tool pre-flight check (§F2) races the cancel write. Mitigation: the pre-flight check is a transactional read on `cancelledItemIndexes`; the worst case is one unnecessary write that's immediately revertible via the ledger. Document this in the toast copy.
- **F3 + F6 + F7 compound surface.** Three gates all hang off the new Versions tab. If one crashes the tab, all three look broken. Mitigation: each gate has its own isolated React component inside the tab; an error in one renders a narrow empty-state instead of breaking the tab.
- **F6 schema change.** `versionLabel` is nullable with a sensible default (empty). No migration risk. If `prisma db push` fails on staging, Stream A stops and reports.
- **F8 Nano abuse.** Enhance-prompt is tenant-scoped and rate-limited (20/min/conversation). Mitigation is already in the spec; verify the limiter fires during smoke.
- **F9a root-cause unreachable.** If the #310 reproducer can't be pinned down, the error boundary alone ships — the sprint doesn't block on the deeper fix. Document "root cause pending follow-up" in PROGRESS.md if so.
- **Stream collision on `studio-chat.tsx`.** All three streams touch this file. Mitigation: each subagent is given a specific function-body allow-list; Stream C's edits take precedence on merge conflict. Run the full frontend test suite after every merge.
- **Overnight run exhaustion.** Opus 4.7 with 1M context is the right call for this breadth, but a single 9-gate run might exhaust token budget. If the main thread hits a budget ceiling, it re-dispatches the failing stream(s) with a fresh Opus context, reusing the same spec prompts.

---

## 7. Explicit out-of-scope

- Mobile-responsive Studio (candidate for sprint-059).
- Multi-operator real-time presence (operator A sees operator B editing the same SOP).
- Agent-consumed operator-rationale feedback loop (reading `metadata.operatorRationale` to tune future behavior). Still deferred from 055-A.
- Cross-artifact version tags (a single tag covering a set of artifacts — e.g. "pre-launch-snapshot"). F6 is single-artifact only.
- Rich-text enhance-prompt (markdown formatting, multi-paragraph rewrites). F8 stays single-paragraph.
- Session-wide rollback (revert every artifact touched in a session at once). Revert stays per-artifact.
- Plan mutation after approval (adding items mid-turn). Only cancelling existing items is in scope.
- Full MCP direct-transport overhaul if F1's MCP reproduction turns out to be a 2-sprint project. Document the gap and move on.
- Backend cron for empty-session GC (F9f step 3). Frontend filter is enough for this sprint.
