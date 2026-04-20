# Sprint 046 — Session D: Cleanup + cooldown removal + rejection memory

> Session 4 of 4 for sprint 046. Implements Phase D of
> [`sprint-046-plan.md`](./sprint-046-plan.md) §8.
>
> Owner: Abdelrahman. Branch: `feat/046-studio-unification` (continue
> on the branch Sessions A/B/C built on; do NOT branch off again).
>
> Session D is the closing session. Pure cleanup + two narrowly-scoped
> enforcement flips. If it grows, split into a sprint-047 cleanup —
> don't let it bloat.

---

## 0. Starting state (handed off by Session C)

All eight Session-C gates are green; see
[`PROGRESS.md`](./PROGRESS.md) "Sprint 046 — Session C" for the full
table. Highlights relevant to Session D:

- `/studio` ships as a hash-state tab inside `inbox-v5.tsx`
  (`navTab === 'studio'`). The old `/build`, `/tuning`, and
  `/tuning/agent` routes serve thin 302 redirect stubs. A Studio
  conversation list (left rail) + centre chat + right-rail state
  snapshot + accept/reject suggested-fix endpoints are all wired.
- `propose_suggestion` emits BOTH `data-suggestion-preview` (legacy)
  AND `data-suggested-fix` (new Studio shape). The StandalonePart
  renderer in `studio-chat.tsx` ignores `data-suggestion-preview` so
  Studio doesn't double-render.
- Accept/reject proxy endpoints are thin: they return
  `appliedVia: 'no-op-stub'` for ephemeral `preview:*` ids and
  `appliedVia: 'suggestion_action'` + a placeholder message when a
  `TuningSuggestion` row matches. Real writes land in this session.
- Output linter (`build-tune-agent/output-linter.ts`) runs post-turn
  and logs findings to `BuildToolCallLog` as synthetic `__lint__`
  rows. Log-only — no user-visible enforcement yet.
- 48h cooldown (`COOLDOWN_WINDOW_MS` in `hooks/shared.ts` +
  enforcement in `hooks/pre-tool-use.ts`) is still active.
- Back-compat shim `backend/src/tuning-agent/index.ts` still exports
  the old entry point. Every production caller has migrated.
- Legacy frontend token shim `frontend/components/tuning/tokens.ts`
  is still imported by tuning-era components that aren't part of
  Studio (queue, detail-panel, top-nav, etc.). Studio imports the
  Studio tokens directly.
- `frontend/components/build/build-chat.tsx` is orphaned — no
  importer after the `/build` redirect stub.
- `frontend/app/tuning/agent/page.tsx` is a redirect stub; the old
  732-line raw-prompt editor body is gone (not archived).

Decisions locked in Session C that affect Session D:

- Studio is the single conversational surface. Session D does not
  introduce any new surface; every change is backend enforcement,
  memory plumbing, or dead-code deletion.
- Category pastels retained on artifact-type pills (plan §3.3
  decision #3). Do not touch the pastel palette.
- Cache baselines have not drifted in sprint 046. Any change that
  touches the system prompt or tool-array description must re-run
  `prompt-cache-stability.test.ts` and refresh the baseline row in
  PROGRESS.md before calling a gate green.

---

## 1. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — constitution + critical rules.
2. [`sprint-046-plan.md`](./sprint-046-plan.md) — §§4.4 (rejection
   memory), 5.2 (cooldown removal), 5.5 (output linter), 8 Phase D
   end-to-end.
3. [`sprint-046-session-a.md`](./sprint-046-session-a.md) and
   [`NEXT.sprint-046-session-b.archive.md`](./NEXT.sprint-046-session-b.archive.md)
   + [`NEXT.sprint-046-session-c.archive.md`](./NEXT.sprint-046-session-c.archive.md)
   for context on what shipped.
4. [`PROGRESS.md`](./PROGRESS.md) Sprint 046 Sessions A + B + C
   sections.

Then read the code you'll touch:

- `backend/src/build-tune-agent/hooks/pre-tool-use.ts` — cooldown
  block lives here. Delete the block, keep rollback-compliance +
  oscillation-logging intact (they become observability inputs).
- `backend/src/build-tune-agent/hooks/shared.ts` — home of
  `COOLDOWN_WINDOW_MS`. Constant deletion only.
- `backend/src/build-tune-agent/output-linter.ts` — flip R1/R2 from
  log-only to drop-not-log. R3 stays log-only (too noisy for
  enforcement this session per plan §5.5 risk).
- `backend/src/build-tune-agent/runtime.ts` — the place the linter
  hands off findings. If R2 enforces (dropping extra
  `data-suggested-fix` parts), the drop happens here by rewriting the
  response-message parts before persist.
- `backend/src/build-tune-agent/tools/propose-suggestion.ts` — stop
  emitting `data-suggestion-preview`. Keep the `data-suggested-fix`
  emission.
- `backend/src/build-tune-agent/memory/*` (or the equivalent helper
  module — check where `listMemoryByPrefix` lives) — add
  `writeMemory('session/{conv}/rejected/{fixHash}', …)` helpers.
  Keep the rejection hash as SHA-1 of
  `(artifactId, target.sectionId||target.slotKey||'', semanticIntent)`
  per plan §4.4.
- `backend/src/controllers/build-controller.ts` — accept/reject
  handlers become real writes (not stubs). Accept proxies into
  `suggestion_action({action:'apply'})` when a row exists. Reject
  writes a rejection-memory row.
- `backend/src/tuning-agent/index.ts` — delete the shim. Verify no
  consumer outside `backend/src/build-tune-agent/**` imports it.
- `frontend/components/tuning/tokens.ts` — delete. Migrate the
  remaining tuning-era importers (queue, detail-panel, top-nav,
  category-pill, conversation-list) to `components/studio/tokens.ts`.
  Some will need TUNE-era tokens (accentMuted) that Studio doesn't
  have — inline them at the callsite or define a small re-export
  layer if there's truly no Studio equivalent.
- `frontend/components/build/build-chat.tsx` — delete. No importer
  after Session C.
- `frontend/components/build/` in general — audit for orphaned files
  (test-pipeline-result, propagation-banner, page-skeleton,
  build-disabled) and delete anything that's not imported by either
  `studio-surface.tsx`, `studio-chat.tsx`, or `plan-checklist.tsx`.

---

## 2. Scope — in this session

Each item is a gate. Order matters: the rejection-memory wiring (D3)
depends on a helper that D4 may also touch; the cleanup gates (D5–D8)
depend on nothing else landing first.

### 2.1 (D1) Delete the 48h cooldown

- Remove the `COOLDOWN_WINDOW_MS` block from `hooks/pre-tool-use.ts`.
  The hook should still be called — just no longer emit the cooldown
  deny. Oscillation detection stays, but flips from `deny` to
  `emitDataPart({type:'data-advisory', kind:'oscillation', …})` so
  the Studio card renderer can show the muted warning chip.
- Delete `COOLDOWN_WINDOW_MS` + any helper it pulled from
  `hooks/shared.ts`. Keep rollback-compliance helpers.
- Update/remove the cooldown unit tests in
  `build-tune-agent/__tests__/pre-tool-use-hook.test.ts` (mark
  cooldown tests deleted with a comment referencing this session).
  Add a new test asserting oscillation now emits a `data-advisory`
  rather than denying.
- Add a new test asserting an immediate second apply of the same
  artifact is ALLOWED (no cooldown) so we lock the behaviour
  deletion.

### 2.2 (D2) `data-advisory` recent-edit emitter

- When a suggested_fix or plan_build_changes item targets an
  artifact that was edited within the last 48h (reuse the existing
  recent-edit query from `hooks/shared.ts#recentEditAt` or the
  equivalent), the pre-tool-use hook emits a `data-advisory` with
  `kind: 'recent-edit'` and `context: { lastEditedAt }`.
- The Studio frontend already renders `data-advisory` as a muted
  warning chip (see `studio-chat.tsx#StandalonePart` — no changes
  needed there). Session D only wires the emitter.
- Unit test in `pre-tool-use-hook.test.ts` covers: (a) emits on
  edit-within-48h, (b) does NOT emit on edit-older-than-48h,
  (c) does NOT deny — the hook still allows the tool call.

### 2.3 (D3) Session-scoped rejection memory

- New helpers in the existing memory module — wherever
  `listMemoryByPrefix` lives today, add `writeRejectionMemory(conv,
  fixHash, ts)` and `listRejectionHashes(conv)`. Stored under
  `session/{conversationId}/rejected/{fixHash}` as per plan §4.4.
- `fixHash = sha1(artifactId + '|' + (target.sectionId ||
  target.slotKey || '') + '|' + semanticIntent)` — store enough
  context that the agent can check for a match before emitting a new
  suggested_fix.
- `propose_suggestion` tool hook: before emitting a
  `data-suggested-fix`, compute the hash and query rejection memory
  for the current conversation. If a match exists, skip the emit
  and return `{hint: 'Fix was previously rejected in this session;
  rephrase or propose a different target.'}` so the agent can
  re-reason.
- `rejectSuggestedFix` controller handler (Session C stub) becomes
  a real write: compute the hash from the payload, persist, return
  `appliedVia: 'rejection-memory'` in the response.
- Unit tests: (a) write + list round-trip, (b) propose_suggestion
  skips on hash-match, (c) controller endpoint persists a row
  readable by the same session's next propose_suggestion call.

### 2.4 (D4) Output-linter enforcement flip (R1 + R2 only)

- `output-linter.ts` R1 (0 structured parts + >120 words prose):
  on fire, truncate the prose parts to the first sentence and
  append a `data-advisory` with
  `kind: 'linter-drop', message: '(card omitted — agent prose too
  long without structured card; please rephrase)'`. R1 must NOT
  drop the whole response; the trailing advisory signals the lint
  hit.
- R2 (>1 `data-suggested-fix`): keep the first, drop subsequent
  `data-suggested-fix` parts, emit a `data-advisory` with
  `kind: 'linter-drop', message: 'Dropped N additional suggested
  fixes — surface the top one first.'`.
- R3 (markdown lists) stays log-only. Too noisy for enforcement;
  revisit in sprint 047 after a week of trace data.
- Runtime integration: the enforcement step runs in the turn's
  `onFinish` before persistence, so the persisted parts reflect the
  linted output. The synthetic `__lint__` row still writes to
  `BuildToolCallLog`.
- Unit tests: add R1-drop case + R2-drop case to
  `output-linter.test.ts`, keep all existing log-only cases.

### 2.5 (D5) Retire legacy `data-suggestion-preview`

- `propose_suggestion` stops emitting the legacy part. Keep the
  `data-suggested-fix` emission.
- Remove the frontend no-op branch in `studio-chat.tsx#StandalonePart`
  (currently `if (type === 'data-suggestion-preview') return null`).
- Delete any TUNE-era consumer of the legacy part outside
  `/build|/tuning` (both routes are now redirect stubs so the
  consumers don't render anyway — a `grep -r 'data-suggestion-preview'`
  sweep confirms before delete).
- Update the part in `DATA_PART_TYPES` registry in `data-parts.ts` —
  keep the key for stream-bridge backward-compat (a small risk
  layer) but mark it deprecated in the JSDoc.
- Test: the propose_suggestion "emits both" test from Session B
  flips to "emits only data-suggested-fix". Keep the derivation
  tests (they're the public contract now).

### 2.6 (D6) Delete `tuning-agent/index.ts` back-compat shim

- `grep -r "from '@/tuning-agent'" backend/src/` and
  `grep -r "require('./tuning-agent')"` must both be empty after the
  delete. If any importer survived migration (very likely not —
  sprint 045 Gate 1 already moved them), migrate first, then delete.
- Nothing to test — the shim had no behaviour, it re-exported.

### 2.7 (D7) Delete `frontend/components/tuning/tokens.ts`

- Inventory the remaining importers (grep shows `queue`,
  `detail-panel`, `top-nav`, `category-pill`, `conversation-list`,
  `diff-viewer`, `evidence-pane`, `accept-controls`, `chat-parts`,
  `chat-panel`, `dashboards`, `quickstart`, `toaster`).
- Swap each import for `components/studio/tokens.ts`. If the file
  references an accent-muted token that Studio doesn't expose,
  inline a muted-grey fallback at the callsite (these files are
  all reachable only from the redirect-stub routes — they render
  only on the 302 flash, so perfect fidelity isn't required).
- Delete `components/tuning/tokens.ts`.
- Frontend `tsc --noEmit` error count must not grow past the
  Session C baseline (32 lines).

### 2.8 (D8) Orphaned-code sweep

- Delete `frontend/components/build/build-chat.tsx` (no importer
  after Session C; PlanChecklist stayed, moved under the Studio
  umbrella via re-palette).
- Delete anything else under `frontend/components/build/` that's
  not imported by `studio-surface.tsx`, `studio-chat.tsx`, or
  `plan-checklist.tsx`. Candidates: `test-pipeline-result.tsx`
  (used by studio-chat — keep), `propagation-banner.tsx` (used by
  studio-surface — keep), `page-skeleton.tsx` (may be orphaned now
  — verify), `build-disabled.tsx` (used by studio-surface — keep),
  `build-toaster.tsx` (check).
- For each deletion: `grep` first, delete, re-run frontend
  `tsc --noEmit` to confirm zero new errors.

### 2.9 (D9) `BuildToolCallLog` admin-only trace view

- New page/route or in-Studio admin drawer (plan §4.5 — admin-only
  hidden toggle). Read-only table: tenantId, conversationId, turn,
  tool, durationMs, success, errorMessage, createdAt.
- Gated by a new env flag `ENABLE_BUILD_TRACE_VIEW` or reuse the
  existing `ENABLE_BUILD_MODE` — recommend a new flag so tenant
  admins can't accidentally see raw tool calls.
- Backend: new `GET /api/build/traces?limit=&cursor=&tool=` under
  the same router guard.
- Frontend: new component, mounted as a drawer from Studio's right
  rail under a gear/… menu (admin-only — reuse existing
  role-check helpers). Read-only table, sort by createdAt desc.
- Tests: controller integration test for the list endpoint; the
  drawer itself is presentation-only.

---

## 3. Out of scope

- Cross-session rejection memory — stays deferred to sprint 047
  (plan §9).
- 30-day retention sweep on `BuildToolCallLog` — sprint 047.
- Dashboards merge into main Analytics — sprint 047 (plan §9).
- Raw-prompt editor drawer — sprint 047 (plan §6.5).
- Deleting the three redirect stubs — sprint 047 (the stubs are a
  one-sprint courtesy).
- Any new tool. Session D is enforcement + cleanup; no new
  agent-facing functionality.

---

## 4. Gate sheet

Tick off as each lands. Prisma changes unlikely this session; if any
land apply via `prisma db push`, never migrations (CLAUDE.md).

| Gate | Item | Status |
|------|------|--------|
| D1   | 48h cooldown removal + oscillation-as-advisory | ☐ |
| D2   | `data-advisory` recent-edit emitter | ☐ |
| D3   | Session-scoped rejection memory + propose_suggestion guard | ☐ |
| D4   | Output-linter R1 + R2 drop-not-log enforcement | ☐ |
| D5   | Retire legacy `data-suggestion-preview` | ☐ |
| D6   | Delete `backend/src/tuning-agent/index.ts` shim | ☐ |
| D7   | Delete `frontend/components/tuning/tokens.ts` re-export | ☐ |
| D8   | Orphaned `components/build/*` sweep | ☐ |
| D9   | `BuildToolCallLog` admin trace view | ☐ |
| D10  | Full suite green + `tsc --noEmit` clean + staging smoke | ☐ |
| D11  | PROGRESS.md final sprint-046 wrap + MASTER_PLAN entry | ☐ |

---

## 5. Success criteria (this session)

Session D is done when all of these are true:

- S-1. No call path through `pre-tool-use.ts` denies on cooldown.
  Oscillation emits a `data-advisory`; recent-edit emits a
  `data-advisory`; neither blocks.
- S-2. A `propose_suggestion` call whose hash matches a prior
  rejection in the SAME conversation returns the
  "was previously rejected" hint and does not emit a card. A
  fresh-hash call still emits.
- S-3. A turn that emits two `data-suggested-fix` parts lands in
  the persisted parts with only the first retained plus a
  `data-advisory` documenting the drop. A turn with 120+ words of
  prose and zero structured parts lands with truncated prose plus
  a `data-advisory`.
- S-4. `grep -r data-suggestion-preview backend/src` returns only
  the deprecated-JSDoc entry in `data-parts.ts`.
- S-5. `grep -r "from.*tuning-agent['\"]" backend/src` returns
  empty. The shim file is deleted.
- S-6. `grep -r "components/tuning/tokens" frontend/` returns
  empty. The shim file is deleted.
- S-7. `grep -r "components/build/build-chat" frontend/` returns
  empty. The file is deleted.
- S-8. Frontend `tsc --noEmit` line count is ≤ 32 (Session C
  baseline). Backend `tsc --noEmit` clean.
- S-9. Full build-tune-agent test suite green (expect +5..+10 net
  from D1/D2/D3/D4/D5 test additions minus cooldown deletions).
  Integration + E2E plumbing suites stay 9/9 + 3/3.
- S-10. `BuildToolCallLog` admin trace view renders in staging
  behind the env flag; reads the last 50 rows; cannot write.

---

## 6. Non-negotiables

- Never break the main guest messaging flow (`ai.service.ts` is
  untouched — same as Sessions B + C).
- `BuildToolCallLog` insertion failures remain fire-and-forget.
- Output-linter R1/R2 drops happen BEFORE persistence, so a rerun
  of the conversation reads the linted state. Don't double-count
  the linter — it runs once per turn at the end.
- No violet anywhere. Category pastels retained on artifact-type
  pills only (plan §3.3 decision #3).
- Cooldown removal is final for this codebase. If Langfuse shows
  abuse patterns after the flip, handle with rate-limiting on the
  controller, not by re-adding the hook block.
- Session D is the last session of sprint 046. If a gate is
  blocking and cannot land cleanly, defer it to sprint 047 rather
  than landing a half-finished cleanup. Cleanup sessions that
  sprawl are worse than explicit deferrals.

---

## 7. Exit handoff

At session end, do all three:

### 7.1 Commit + push

Single commit per gate is fine. Push to
`feat/046-studio-unification`. After Session D closes, the branch is
ready for production flip (per sprint-045 convention: direct branch
deploy, no PR unless the user changes the rule).

### 7.2 Archive this NEXT.md

Move this file to `NEXT.sprint-046-session-d.archive.md`. Write a
fresh sprint-047 `NEXT.md` at project close — or leave `NEXT.md`
missing so a new sprint's kickoff creates it. The "sprint 047
shopping list" section of this doc (embedded above as deferrals)
should be copied into that new `NEXT.md` as the starting scope.

### 7.3 Update PROGRESS.md + MASTER_PLAN.md

PROGRESS.md — append a "Sprint 046 — Session D" section mirroring
A/B/C's shape: gate table, decisions, deferrals, blockers. Cache
baselines — if D2/D3/D4 touched the system prompt or tool array,
refresh the baseline row; otherwise note "no drift".

MASTER_PLAN.md — append a short "Sprint 046 — shipped" section
naming the four sessions and the net surface change (unified
Studio tab + grounding-aware agent + enforcement linter + cleanup).
Pointer into PROGRESS.md for detail.

End of Session D brief.
