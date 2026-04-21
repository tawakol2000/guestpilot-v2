# Sprint 057 — Session A — Trust & Responsiveness

**Branch:** `feat/057-session-a` (stacks on `feat/056-session-a` → 055 → 054 → 053 → 052 → 051 → 050 → main)
**Parent tip expected:** tip of `feat/056-session-a` after F5. Verify with `git rev-parse` at session start.
**Session type:** A — frontend-only, no schema change, no agent-prompt change.
**Brainstorm §:** §3.2 (tool-call drill-in), §1 principle #1 / Granola (typographic attribution), §3.3 / Windsurf (auto-queue).
**Length discipline:** three gates, all frontend. Shortest sprint in the series.

---

## 0. Why this sprint exists

The product writes faithfully (051-052), previews before applying (053), tracks rationale (054), verifies itself with three-variant tests (054), renders progress checklists (055), supports inline-edit and compose-at-cursor (055-056), and retrieves its own history (056). What it does NOT do yet is feel *observable and responsive during a live turn*.

Three specific friction points from the brainstorms + shipping history:

1. **Tool calls are individually visible but never summarized.** Each `ToolCallChip` opens the drawer, but a manager reading a long agent turn sees "read_state", then a chip, then "get_faq", then another chip, interleaved with text. There's no "here's everything this turn looked at" summary. The decision surface stays obscured.
2. **Typographic attribution is partial.** 050-A set grey-for-AI / black-for-human inside text bubbles, and 055-A carries operator-edit metadata. But cards (ledger rows, test results, proposals) don't consistently apply the grammar — AI-generated rationale blocks read as black, same as operator text.
3. **The chat yanks the scroll when the operator is trying to read scrollback.** Every incoming message fires `scrollTo(scrollHeight)`. During a long tool-loop turn, the operator gets yanked to the bottom three times in a row while trying to read earlier content. And if they want to type a follow-up while the agent is streaming, the composer is disabled — no queue.

Fixing these three doesn't add a feature. It makes the surface legible during active use instead of only after settling.

---

## 1. Non-negotiables

- **`ai.service.ts` stays untouched.** Guest-reply pipeline is not in scope.
- **BUILD agent prompt stays untouched.** This sprint is pure frontend.
- **No schema change.** Tool-call data already flows through `BuildToolCallLog` + SDK SSE parts. Attribution is CSS + metadata read. Queue is in-memory React state.
- **Operator-tier posture unchanged.** F1 reuses the existing `ToolCallDrawer` (050 A2 — operator-tier, sanitised). The admin `TraceDrawer` (047-B) stays admin-only and is NOT touched.
- **Graceful degradation.** If tool-call SSE parts are absent (older conversation replays, feature flag off), the summary chip row renders nothing — it is NEVER the source of message height. The chat must render identically with or without the summary.
- **Branch discipline.** Stack on `feat/056-session-a`. Do NOT rebase onto main.

---

## 2. Pre-flight gate

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a feat/053-session-a feat/054-session-a feat/055-session-a feat/056-session-a
```

Write SHAs into `specs/045-build-mode/PROGRESS.md`. Verify `feat/056-session-a` tip matches the user's close-out report.

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && npm test
```

Expected from 056-A close-out: frontend 220/220. Backend has 2 pre-existing failures (carried from 056); record the actual count, do not try to fix those failures in this sprint.

### 2.3 Existing-capability probe

Confirm the pieces being reused:

```
grep -n "ToolCallDrawer\|openToolDrawer\|ToolCallChip" frontend/components/studio/studio-chat.tsx
grep -n "data-origin\|A1 typographic\|attribution" frontend/components/studio/
grep -n "scrollTo.*scrollHeight\|scrollerRef" frontend/components/studio/studio-chat.tsx
```

Expected: `ToolCallDrawer` wired via `openToolDrawer` callback; A1-grammar `data-origin` attribute used in text bubbles; `scrollerRef` auto-scrolls on `[messages]` change. If any are missing, stop — the sprint assumes all three.

---

## 3. Gates

Three gates. Parallelizable as: **Stream A = F1**, **Stream B = F2 + F3**. Dispatch both in a single message. No serial merge gate — F1 and F2+F3 touch different parts of `studio-chat.tsx` + sibling files, conflicts are minor (reconcile at merge).

### F1 — Collapsed tool-chain summary per agent message

**Scope:** above each assistant message's body (or inside its header region), render a compact single-line summary of every tool call that message made. Click to expand → reveals the per-call chip row already present. Click any chip → existing `ToolCallDrawer` opens (no change to the drawer).

**Summary line shape:**
- Collapsed default: `⚙️ Read state · Got FAQ · Planned 3 writes · Ran test`  (noun phrases derived from tool names; see `TOOL_VERB_MAP` below)
- Max 5 items visible in collapsed form; overflow renders as `… +N more`
- Expand toggle: `▸` on the left; rotates to `▾` when open; `aria-expanded` set correctly
- Expanded state: reveals the full chip row (existing `ToolCallChip` markup) one-per-tool-call in temporal order

**TOOL_VERB_MAP** (central dictionary in a new `frontend/components/studio/tool-verbs.ts`):

```
get_current_state       → 'Read state'
get_context             → 'Read context'
get_faq                 → 'Got FAQ'
get_sop                 → 'Got SOP'
get_edit_history        → 'Checked history'
plan_build_changes      → 'Planned {N} writes'      // N = items.length
create_sop              → 'Wrote SOP'
create_faq              → 'Wrote FAQ'
write_system_prompt     → 'Rewrote prompt'
create_tool_definition  → 'Defined tool'
test_pipeline           → 'Ran test'
search_corrections      → 'Searched fixes'
propose_suggestion      → 'Proposed fix'
suggestion_action       → 'Applied fix'
emit_audit              → 'Audited'
ask_manager             → 'Asked you'
fetch_evidence_bundle   → 'Pulled evidence'
```

Unknown tools fall back to their raw name (snake-case → spaces). Add a `test-utils/tool-verb-map.test.ts` asserting every tool declared in `backend/src/build-tune-agent/tools/names.ts` has a mapping — regression lock for new tools that skip this dictionary.

**State inference:** scan the message's `parts` array for `tool-*` type parts (already emitted by the AI SDK bridge). Deduplicate by `toolCallId`. Order by first occurrence. Running tools render the verb with a small spinner next to the dot; errored tools render with a red dot.

**Reuse:** no change to `ToolCallDrawer`, `ToolCallChip`, or the existing chip placement logic. Summary is an ADDITIVE row above the chips — when expanded, both render (summary + chips). When collapsed, only the summary renders and the raw chips are hidden via CSS.

**Frontend tests:**
- Summary renders correct verbs for each mapped tool.
- `+N more` overflow kicks in at >5 distinct calls.
- Click toggles expansion; chip row becomes visible; existing drawer-open behavior unchanged.
- Running / errored state styling applied.
- `TOOL_VERB_MAP` coverage assertion — every tool in `names.ts` has a verb (regression lock).
- Message with zero tool calls renders no summary row at all.

**Acceptance:** a long agent turn reads as one sentence of "what I did" above the reply. Expand to audit. Click to drill in.

### F2 — Typographic attribution everywhere

**Scope:** extend the A1 `data-origin` grammar (grey-for-AI / black-for-human) to every surface that renders text, not just chat bubbles.

**Surfaces in scope** (each gets a parity audit):
- `write-ledger.tsx` rows — rationale text, operator-edit flag, entry title
- `plan-checklist.tsx` items — rationale sub-line, name
- `test-pipeline-result.tsx` — judge rationale, per-variant trigger/reply rendering
- `artifact-drawer.tsx` — `RationaleCard` body, preview diff text
- `compose-bubble.tsx` — agent-proposed replacement text
- `suggested-fix.tsx`, `audit-report.tsx` — any renderable text blocks

**Rules:**
- AI-generated prose: `STUDIO_COLORS.inkMuted` (≈`#52525B`) for body, `STUDIO_COLORS.ink` only for headings and structural labels.
- Operator-authored prose (rationale the operator typed in 055-A F3, ledger revert reasons, compose-bubble prompts the operator wrote): `STUDIO_COLORS.ink` (≈`#18181B`).
- Mixed-provenance text (rationale with `rationalePrefix === 'edited-by-operator'`): AI-grey for the prepended agent portion, human-black for the operator portion, separated by the existing `(edited by operator)` header.
- All rules expressed via a single helper `attributedStyle(origin: 'ai' | 'human' | 'mixed')` exported from `tokens.ts`. Every surface above imports and uses it — no hand-rolled colors.

**Migration strategy:** one commit per surface. Each commit is small (CSS / style prop change, no structural rewrite). If a surface doesn't know its origin, default to AI (most rationale text is AI). The component's own metadata decides — don't infer from props.

**Frontend tests:**
- Snapshot test on each migrated surface asserts the correct `color` computed style for AI vs human blocks.
- `attributedStyle('mixed')` helper renders both colors correctly on split content.
- Regression lock: add a lint-style test in `tokens.test.ts` that asserts every exported STUDIO_COLORS ink value is used via `attributedStyle()` somewhere (prevents future drift).

**Acceptance:** open a conversation with an operator-edited SOP. The ledger row's rationale shows the agent's original rationale in grey and the operator's appended rationale in black — at a glance, the manager sees who wrote what.

### F3 — Scroll discipline + queue-while-busy

**Scope:** two fixes that share a composer + scroller refactor.

**F3a — Jump-to-latest pill.** Replace the unconditional `scrollTo(scrollHeight)` on `[messages]` change with:

- Compute `isAtBottom` on every scroll event (threshold: 64px from bottom).
- If `isAtBottom === true` when a new message part arrives → auto-scroll as today.
- If `isAtBottom === false` → DO NOT scroll. Instead show a sticky "↓ N new" pill at the bottom-center of the scroll area. Click → smooth-scrolls to bottom and resets the counter.
- Counter increments on every new `message` added OR every new `text` part append on the last message while the manager is above the fold. Reset when the pill is clicked or the manager manually scrolls to bottom.

**F3b — Auto-queue while agent is working.** When `isStreaming || isSending` and the manager hits send:

- Instead of blocking, append the text to a `queuedMessages: string[]` in component state. Cap at 3. Clear the composer draft immediately (so the manager can keep typing).
- Render a small "Queued (2)" badge to the left of the send button. Click → expands a popover listing the queued texts with × to remove each.
- When `status` returns to `'ready'`, flush the queue one at a time: call `sendMessage({ text })` with the first queued item, wait for status to leave `'ready'` (i.e. the new turn started), then flush the next on the next `'ready'` transition. Implement as a `useEffect` watching `status`.
- If the agent reply errors or the manager closes the page, the queue persists ONLY in memory. No localStorage (per artifacts rule). Document this limitation in a code comment.

**Interaction with F3a:** when a queued message flushes and the new agent response starts streaming, auto-scroll to bottom (treat queue-flush as a manager-initiated send, not passive streaming). Resets the `isAtBottom` state.

**Frontend tests:**
- Scroll-pill appears when the operator scrolls up and a message arrives; counter increments on subsequent arrivals; pill click scrolls to bottom and clears.
- Scroll-pill does NOT appear when operator is at bottom (auto-scroll still fires).
- Queue accepts up to 3; 4th attempt shows a toast "Queue full — wait for the agent to finish"; removing one frees the slot.
- Queue flushes in order when status returns to `'ready'`. Test with a mocked `useChat`-like object.
- Queued-badge popover: click × removes that item; remaining items still flush correctly.
- Queue survives status flips during an error (does NOT drain on error — manager can manually dismiss).

**Acceptance:** during a long tool-loop turn, the manager scrolls up to re-read an earlier rationale. A new message arrives; a pill appears; the scroll stays put. The manager types "also update the early-check-in SOP" while the agent is still replying — the send button shows "Queued (1)" and the text flushes automatically when the current turn finishes.

---

## 4. Parallelization plan (REQUIRED — dispatch subagents)

Two streams. **Dispatch both in a single message** (two Task calls in parallel).

- **Stream A — F1 (tool-chain summary):** owns `tool-verbs.ts` dictionary, summary component, wiring in `studio-chat.tsx` MessageRow, `names.ts` coverage test.
- **Stream B — F2 + F3 (attribution + scroll/queue):** owns `attributedStyle` helper in `tokens.ts`, per-surface migration commits (one per surface, small), scroller refactor, queue state machine. All within the studio/build component dirs.

Overlap: both streams touch `studio-chat.tsx`. Stream A adds the summary row to MessageRow rendering; Stream B adjusts the scroller effect + composer. These edits are on different function bodies — merge conflicts should be localized. If a conflict happens, resolve by keeping both changes (they're additive).

Dispatch pattern:

```
Task(subagent_type: "general-purpose",
     description: "Stream A: tool-chain summary",
     prompt: [F1 scope + non-negotiables + tests + pre-flight SHAs, verbatim])

Task(subagent_type: "general-purpose",
     description: "Stream B: attribution + scroll/queue",
     prompt: [F2 + F3 scope + non-negotiables + tests + pre-flight SHAs, verbatim])
```

Each stream lands one or more commits on `feat/057-session-a`. Stream A is one commit. Stream B is two commits (F2 one, F3 one — they're easier to review separately). No serial merge gate.

---

## 5. Close-out checklist

- [ ] Three gates shipped; ≥3 commits on `feat/057-session-a`
- [ ] Frontend tests green; record delta in PROGRESS.md (expected +20 tests give or take)
- [ ] Backend: same 2 pre-existing failures, 0 new
- [ ] Manual smoke in BUILD: (a) trigger a multi-tool turn, see the collapsed summary, click to expand, drill into one tool-call drawer; (b) open a ledger with edited-by-operator rationale, verify grey-vs-black rendering; (c) during a streaming turn, scroll up → see the "↓ N new" pill; (d) during the same turn, type two follow-ups → see "Queued (2)" badge → wait for turn end → both flush automatically in order
- [ ] NEXT.md written for sprint-058 (candidate: editable plan mode OR session-diff summary)
- [ ] Archive spec to `NEXT.sprint-057-session-a.archive.md` at close

---

## 6. Risks + mitigations

- **Tool-verb dictionary drift.** New tools added without a verb entry will silently fall back to the raw name. Mitigation: the coverage test in F1 fails the build if `names.ts` has a tool without a verb entry.
- **Attribution migration creates visual noise** if grey-on-white contrast drops below AA. Mitigation: the `inkMuted` token is pre-tuned for AA on white; verify with a quick contrast-ratio check in one of the snapshot tests.
- **Queue flush race.** If the operator sends a manual message between `status: ready` and the queue flush effect firing, both might end up in-flight. Mitigation: guard the flush with a ref-based `isFlushing` flag; skip flush if a manual send happened in the interim (drop the queued item one position later).
- **Scroll-pill counter drift.** If `message` objects mutate in-place (AI SDK re-renders), counter could double-count. Mitigation: track seen message IDs in a `Set`; increment only on genuinely-new IDs.
- **Stream collision on `studio-chat.tsx`.** A + B both touch this file. Mitigation: each subagent is prompted to isolate its edits to different function bodies; manually merge if conflicts appear.

---

## 7. Explicit out-of-scope

- Re-running a tool call from the drawer (Bundle B/C per 050 A2 note — future sprint).
- Editing a tool call's args before re-running.
- Persistent queue across page reloads (requires localStorage, which artifacts rule forbids).
- Admin-tier TraceDrawer changes.
- BUILD agent prompt changes (this sprint is pure frontend).
- Session-diff summary (candidate for sprint-058).
- Editable plan mode (candidate for sprint-058).
