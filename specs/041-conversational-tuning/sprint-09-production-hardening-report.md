# Sprint 09 — Production Hardening — Report

## 1. Goal recap

Fix every critical bug, fill the system-prompt context gaps, and resolve
the worst performance issues identified in the full-system audit. Purely
corrective — no new features, no schema changes beyond indexes.

All work is on `feat/041-conversational-tuning`, committed in seven
logical phases on top of the prior sprint-08 branch. No merge, no push.

## 2. The 18 briefed fixes

### Phase 1 — Data integrity (fixes 2, 7, 8, 9, 10)

Commit `814e229 feat(041): sprint 09 phase 1 — data integrity fixes`.

- **Fix 2** — `TOOL_CONFIG` apply no longer silently falls back to
  `allTools[0]` when the beforeText lookup misses. Returns an error so
  the agent asks the manager for clarification instead of corrupting a
  random tool's description.
  (`backend/src/tuning-agent/tools/suggestion-action.ts`)
- **Fix 7** — Diagnostic service model fallback is now TTL-based
  (5 min) instead of a permanent global. After the window expires the
  primary model is retried; on success the fallback state clears and
  both events are logged.
  (`backend/src/services/tuning/diagnostic.service.ts`)
- **Fix 8** — Accept + reject endpoints use an atomic status CAS
  (`updateMany` with `status: { in: ['PENDING', 'AUTO_SUPPRESSED'] }`
  → `data: { status: 'ACCEPTED' }`). Postgres's row lock on `UPDATE`
  serialises two concurrent callers; the loser observes 0 rows
  affected and returns 409. On artifact-write failure the status is
  reverted to PENDING so retries still work.
  (`backend/src/controllers/tuning-suggestion.controller.ts`)
- **Fix 9** — AUTO_SUPPRESSED suggestions (sprint 08 §5 gating output)
  can now be accepted or rejected. Previously they were permanently
  stuck with no resolution path.
  (`backend/src/controllers/tuning-suggestion.controller.ts`)
- **Fix 10** — `checkCooldown` threads `sopStatus` through the where
  clause. Back-compat: the filter is omitted when `sopStatus` is null.
  Because the diagnostic pipeline doesn't currently emit `sopStatus`
  in `artifactTarget`, the narrowing is wired but inert until that
  field is populated — flagged in §5.
  (`backend/src/services/tuning/suggestion-writer.service.ts`)

### Phase 2 — Agent correctness (fixes 1, 3, 4, 5, 6, 11, 12, 16)

Commit `3e24b36 feat(041): sprint 09 phase 2 — agent correctness fixes`.

- **Fix 1** — Pending count no longer lies. System prompt and
  `get_context` tool emit the true queue total from a separate
  `count()` call; the `take: 10` / `take: 8` detail array is unchanged.
  (`runtime.ts`, `tools/get-context.ts`, `system-prompt.ts`)
- **Fix 3** — `artifactTargetWhere` has a `TOOL_CONFIG` case scoped by
  `(diagnosticCategory = 'TOOL_CONFIG', diagnosticSubLabel = toolHint)`.
  TOOL_CONFIG applies now participate in cooldown + oscillation
  protection.
- **Fix 4** — Null-confidence oscillation false positive eliminated.
  The oscillation check now requires BOTH sides to have numeric
  confidence before firing; `0 <= 0 * 1.25` can no longer block.
- **Fix 5** — Rollback requires an explicit manager sanction. Added
  `detectRollbackSanction()` with rollback-specific intent phrases
  ("roll back", "revert it", "undo the change") and a parallel
  `compliance.lastUserSanctionedRollback` flag.
- **Fix 6** — Compliance regex tightened. Bare `/\bapply\b/` and
  `/\bconfirm\b/` replaced with intent phrases:
  `apply it/this/that/now/the change`, `confirm the change/rollback`,
  `yes[,] apply/go/do`, etc. "Can you confirm what the SOP says?" and
  "I need to apply for a visa" no longer trigger. Negative test cases
  added.
- **Fix 11** — Stream bridge emits fresh `text-start` with unique ids
  for the second text block after a `tool_use`. Previously the second
  block was silently dropped because `textBlockId` was cleared but
  subsequent aggregated text reused the same closed stream id. A
  monotonic `textBlockCounter` now stamps unique ids per block.
  (`stream-bridge.ts`)
- **Fix 12** — `truncateForLog` returns a truncated string instead of
  throwing on the invalid mid-JSON slice. Previously every payload
  over 4,000 chars dropped to `{ note: 'unserializable' }`.
- **Fix 16** — `persistedDataParts` is cleared on session-not-found
  retry so data parts from the failed first attempt are not
  double-persisted.

### Phase 3 — System-prompt enrichment (fix 15)

Commit `2c3b85e feat(041): sprint 09 phase 3 — enrich agent system prompt`.

Added a `<platform_context>` section to the static prefix (inside the
cached region) covering:

- SOP status lifecycle (DEFAULT / INQUIRY / PENDING / CONFIRMED /
  CHECKED_IN / CHECKED_OUT) and variant resolution order (property
  override → status variant → DEFAULT).
- Per-status tool availability for the main AI.
- Hard security rule: never expose access codes to INQUIRY guests.
- Escalation signal detection (keyword-based).
- Channel differences (Airbnb / Booking / WhatsApp / Direct).
- Hold-firm-on-NO_FIX directive with evidence-contingent reversal.

### Phase 4 — Frontend + performance (fixes 13, 14, 17, 18)

Commit `b4aee00 feat(041): sprint 09 phase 4 — frontend + performance fixes`.

- **Fix 13** — KnowledgeCard hrefs point to `/?tab=sops`,
  `/?tab=faqs`, `/?tab=tools` (and `/?tab=configure` for AI config).
  InboxV5's initial `navTab` state now reads the `?tab=` query param
  first, falling back to sessionStorage.
- **Fix 14** — DiffViewer shows a TUNING_COLORS warn banner when
  either input exceeds 1,600 tokens: "Diff truncated to first 1,600
  tokens for performance. Full text available in the editor."
- **Fix 17** — Three new indexes added:
  - `TuningSuggestion` `(tenantId, status, appliedAt desc)` —
    serves the cooldown query.
  - `TuningSuggestion` `(tenantId, criticalFailure, createdAt desc)`
    — serves sprint 08 graduation metrics critical-failure count.
  - `Message` `(tenantId, role, sentAt desc)` — serves dashboard
    coverage and graduation metrics queries.
  `npx prisma db push` applied in 3.7 s, no destructive changes
  reported.
- **Fix 18** — Dashboard endpoints rewritten to use aggregates:
  - Coverage: four `count()` queries instead of two `findMany()`s.
  - Graduation metrics: counts for total/edited, narrow `findMany`
    only over edited rows for magnitude averaging, and
    `conversation.count({ messages: { some: ... } })` for the
    distinct-conversations-with-AI denominator.

## 3. Additional fixes surfaced during the triple-check audit

The user asked for a triple-check before declaring done. Two full
audit passes surfaced real additional bugs; the highest-impact ones
were fixed in three follow-up phases.

### Phase 5 (audit round 1, high/medium findings)

Commit `bc88802 feat(041): sprint 09 phase 5 — follow-up bugs from full audit`.

- **Rollback SYSTEM_PROMPT variant detection** (round 1 #2, high) —
  The old `target.coordinator ? 'coordinator' : 'screening'` silently
  defaulted to `screening` when the coordinator key was missing,
  risking a blank write to the wrong variant. Explicit
  `hasCoord`/`hasScreen` checks refuse ambiguous or empty history
  rows.
  (`tools/version-history.ts`)
- **Agent-path atomic CAS in `suggestion_action`** (round 1 #10, high)
  — Sprint 09 fix 8 hardened only the HTTP endpoint. The agent tool
  had the same race. Apply + reject now use the same `updateMany`
  CAS pattern. `edit_then_apply` additionally requires a non-empty
  `editedText` so the preference-pair capture stays truthful.
  (`tools/suggestion-action.ts`)
- **TOOL_CONFIG beforeText match normalisation** (round 1 #20) — CRLF
  vs LF drift + trailing-whitespace no longer breaks the lookup; both
  sides are trimmed and newline-normalised.
- **SOP/Tool cache invalidation** (round 1 #12) — Both the agent path
  and the HTTP accept path now call `invalidateSopCache(tenantId)`
  and `invalidateToolCache(tenantId)` after writes so the main AI
  picks up changes immediately instead of waiting out the 5-minute
  TTL.
- **fetch_evidence_bundle transient** (round 1 #27) — The data part is
  emitted with `transient: true` so multi-KB evidence payloads don't
  get persisted on every mid-turn evidence peek.
- **Dashboard `escalationRate` denominator mismatch** (round 1 #16) —
  Escalations are now narrowed to escalations whose conversation also
  saw an AI reply in the window. The `Math.min(1, …)` clamp hiding
  the mismatch is gone.
- **`retentionSummary` aggregation** (round 1 #26) — Replaced the
  `findMany` with four `count()` queries keyed on the tri-state
  retention flag.

### Phase 6 (audit round 2, high findings)

Commit `5ac69f0 feat(041): sprint 09 phase 6 — round-2 audit fixes`.

- **`suggestion_action` CAS revert on throw** (round 2 high) — If
  `applyArtifactWrite` threw (not just returned `{ok:false}`), the
  CAS claim was left in place with no artifact written. A new
  `acceptedClaimForId` tracker in the outer scope lets the catch
  handler revert the status, `appliedAt`, and `appliedByUserId`.
- **Evidence-bundle tenant filters** (round 2 high) — Property,
  Reservation, Guest, and AiApiLog lookups switched from
  `findUnique({ where: { id } })` to
  `findFirst({ where: { id, tenantId } })`. Defense in depth: a
  corrupt FK to another tenant's row cannot leak PII into the
  bundle.
- **Tuning-chat user-message persist failure handling** (round 2
  medium) — Previously `console.warn`'d and let the assistant turn
  persist with no matching user turn, breaking the transcript
  invariant. Now returns 500 and aborts. Also added a
  `req.on('close', …)` log line so client disconnects during
  streaming are observable in deployment logs.
- **TuningCategoryStats EMA atomic update** (round 2 medium) — The
  read-compute-write sequence is wrapped in an interactive transaction
  so two concurrent accepts for the same (tenant, category) can't
  both read the same `oldEma` and both write identical `newEma`
  values. `acceptCount` and `rejectCount` use Prisma's atomic
  `increment` so those were already safe.

### Phase 7 (audit round 2, medium finding)

Commit `02f130e feat(041): sprint 09 phase 7 — tuning-conversation search tenant scope`.

- **TuningMessage substring search** — The `$queryRawUnsafe` scan of
  the entire TuningMessage table now INNER JOINs TuningConversation
  and filters by `tenantId`. The outer `where.id = { in: ids }` was
  already filtering results to tenant-scoped conversation ids, but
  the raw query itself should not cross tenants.

## 4. Files changed

Backend:

- `backend/src/tuning-agent/runtime.ts`
- `backend/src/tuning-agent/system-prompt.ts`
- `backend/src/tuning-agent/stream-bridge.ts`
- `backend/src/tuning-agent/hooks/shared.ts`
- `backend/src/tuning-agent/hooks/pre-tool-use.ts`
- `backend/src/tuning-agent/hooks/post-tool-use.ts`
- `backend/src/tuning-agent/tools/suggestion-action.ts`
- `backend/src/tuning-agent/tools/get-context.ts`
- `backend/src/tuning-agent/tools/fetch-evidence-bundle.ts`
- `backend/src/tuning-agent/tools/version-history.ts`
- `backend/src/tuning-agent/__tests__/pre-tool-use-hook.test.ts`
- `backend/src/services/tuning/diagnostic.service.ts`
- `backend/src/services/tuning/suggestion-writer.service.ts`
- `backend/src/services/tuning/category-stats.service.ts`
- `backend/src/services/evidence-bundle.service.ts`
- `backend/src/controllers/tuning-suggestion.controller.ts`
- `backend/src/controllers/tuning-dashboards.controller.ts`
- `backend/src/controllers/tuning-chat.controller.ts`
- `backend/src/controllers/tuning-conversation.controller.ts`
- `backend/prisma/schema.prisma`

Frontend:

- `frontend/app/tuning/agent/page.tsx`
- `frontend/components/inbox-v5.tsx`
- `frontend/components/tuning/diff-viewer.tsx`

Seven commits, ~25 files, ~840 insertions / ~230 deletions net.

## 5. Known limitations after sprint 09

- **Fix 10 is wired but inert until diagnostic emits `sopStatus`.** The
  `checkCooldown` call site passes `sopStatus: null` because the
  diagnostic `DiagnosticResult.artifactTarget` doesn't carry status;
  it's left wired so the moment the diagnostic starts emitting
  sopStatus, the narrowing takes effect without further refactor.
  Tracked as C30.
- **`TuningSuggestion` `appliedAt` is set during CAS, before artifact
  write succeeds.** On a failed apply the revert path clears it, but
  during the narrow window between CAS and revert, a concurrent
  cooldown query could observe a false-ACCEPTED row and apply cooldown
  to a sibling proposal. Very narrow; tradeoff accepted. Tracked as
  C31.
- **`systemPromptHistory` lost-update** — two concurrent prompt
  applies each read the history array, each push a snapshot, one
  overwrite wins. The surviving prompt is correct; the losing
  snapshot is gone. Very rare (two concurrent prompt applies are
  unusual) and not functionally breaking. Tracked as C32.
- **`retention job` window-math drift** — the job's `{gte: now-8d,
  lte: now-7d}` boundaries can miss rows that applied between the
  upper bound of run N and the lower bound of run N+1 if run
  intervals drift. Low impact; tracked as C33.
- **`ui-ux-pro-max` skill** — Frontend changes kept minimal per brief.
  No new styling; existing TUNING_COLORS used.

## 6. Verification

- `npx tsc --noEmit` on `backend/` — clean.
- `npx tsx --test src/tuning-agent/__tests__/pre-tool-use-hook.test.ts`
  — 11/11 pass, including new negative cases for "apply for a visa",
  "confirm what the SOP says", and the rollback-sanction track.
- `npx prisma db push` — applied three new indexes in 3.7 s, no
  destructive changes. Generated Prisma Client regenerated.
- `git status` — only sprint-09 commits on the branch; no
  unintentional files.

## 7. Commit discipline

Seven commits, one per logical unit:

```
02f130e feat(041): sprint 09 phase 7 — tuning-conversation search tenant scope
5ac69f0 feat(041): sprint 09 phase 6 — round-2 audit fixes
bc88802 feat(041): sprint 09 phase 5 — follow-up bugs from full audit
b4aee00 feat(041): sprint 09 phase 4 — frontend + performance fixes
2c3b85e feat(041): sprint 09 phase 3 — enrich agent system prompt (fix 15)
3e24b36 feat(041): sprint 09 phase 2 — agent correctness fixes
814e229 feat(041): sprint 09 phase 1 — data integrity fixes
```

All with `Co-Authored-By: Claude <noreply@anthropic.com>`. Branch not
pushed; no merge to `main`.

## 8. Next-sprint follow-ups

- Have the diagnostic emit `sopStatus` in `artifactTarget.id` so fix
  10's narrowing activates.
- Consider bumping `appliedAt` timing so it's only set after the
  artifact write succeeds — requires an extra DB round-trip but
  closes the narrow false-cooldown window.
- Wire an AbortSignal from the Express `req.on('close', ...)` handler
  through `runTuningAgentTurn` into the Agent SDK `query()` so a
  client disconnect actually terminates the in-flight agent turn.
- Atomic push into `systemPromptHistory` via raw SQL
  (`UPDATE ... SET "systemPromptHistory" = "systemPromptHistory" || $1::jsonb`)
  to close the lost-update window on concurrent prompt applies.
