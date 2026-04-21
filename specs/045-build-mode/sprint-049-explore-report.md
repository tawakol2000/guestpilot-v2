# Sprint 049 — explore report

Research-only audit across four buckets (copilot e2e, BUILD surfaces,
RejectionMemory round-trip, Studio→tuning handoff). Sources: four
parallel Explore agents + cross-check against
[NEXT.md §2](./NEXT.md) tracked candidates.

No code was changed. Dates: 2026-04-21. Branch: `feat/048-session-a`.

---

## §1 Summary

- **Legacy-copilot edit signal loss (NEXT.md §2.4) should move from
  last-priority to top-priority for sprint 049.** The shadow-mode and
  legacy paths have drifted apart: shadow mode fires the diagnostic on
  edit; the legacy `conversations.controller#approveSuggestion` does
  not, even though it accepts an `editedText` param and is still
  shipped. Every finding in bucket 1 that looked like a new bug
  collapses into this one gap once you trace it.
- **The tuning handoff is the single biggest silent-failure surface.**
  Three independent fire-and-forget paths (diagnostic, suggestion-writer,
  compaction) swallow errors into `console.error` with no metric, no
  badge, no row — if any one crashes, the operator sees nothing missing
  and the queue quietly loses data. This is the category most likely to
  cause "I edited three times and nothing showed up in /tuning."
- **BUILD mode has one concrete correctness bug and one observability
  hole, both P1.** Judge-API failures currently masquerade as a real
  `score: 0` ("judge-error") and will cause the agent to iterate on
  infrastructure failures as if they were quality feedback. Tenant-state
  fetch failures silently drop the GREENFIELD/BROWNFIELD posture signal
  with no operator surfacing.
- **RejectionMemory is mostly correct.** Retention is tracked (§2.2),
  read-time expiry filter works, tenant scoping is fine. A handful of
  small P2s (history loss on upsert, no agent-facing prompt guidance)
  but no P0/P1 untracked gaps.
- **Preview lifecycle has one user-visible race.** PREVIEW_LOCKED 409
  responses from /send do not refresh the client's local preview state,
  so the Send button stays active after a rejection. Rare, but when it
  fires the manager sees a dead button.

---

## §2 Punch list

Ranked P0 / P1 / P2. No untracked P0 found — see §1 bullet 1.

### P1 — visible gap in shipped feature

#### P1-1 — Legacy copilot `approveSuggestion` does not fire the tuning diagnostic on editedText (TRACKED — NEXT.md §2.4, recommend upgrade)
- **Bucket** 1
- **File(s)** [conversations.controller.ts:517–592](backend/src/controllers/conversations.controller.ts)
- **Symptom** Manager edits a legacy-copilot suggestion (non-shadow-mode)
  and approves via the arrow button. Text goes out fine; no
  `TuningSuggestion` row ever lands, no `/tuning` signal, no rationale
  captured. Silent tuning-loop break for legacy-path tenants.
- **Why elevate** Sprint-048 Session A fixed the shadow-mode half of
  this exact bug. The legacy half is tracked as §2.4 but ranked last
  of four candidates at "0.5 day." Three bucket-1 findings (no
  `aiApiLogId`, no EDIT/REJECT similarity classification, no dedup fire)
  all fold into this single change. It is the most load-bearing item
  on the list. Bump to sprint-049 top pick.
- **Fix sketch** Mirror the `shadow-preview.controller.ts:148–187` edit
  path: capture `originalAiText` + `editedByUserId` on the Message row,
  stamp `aiApiLogId` via the most-recent-AiApiLog lookup used in
  `messages.controller.ts:124–131`, compute similarity, classify
  EDIT vs REJECT (<0.3), apply trigger-dedup, fire diagnostic
  fire-and-forget.
- **Effort** 0.5 day (NEXT.md estimate holds)

#### P1-2 — Judge API failure returned as `score: 0` with `failureCategory: 'judge-error'`
- **Bucket** 2
- **File(s)** [test-judge.ts:167–175](backend/src/services/build-tune-agent/preview/test-judge.ts)
- **Symptom** Manager runs `test_pipeline`. Anthropic API times out or
  401s. Tool returns a well-formed `TestJudgeResult` with `score: 0.0`
  and rationale "Judge call failed: …". The agent has no way to tell
  this is infrastructure failure vs genuinely bad output and will
  iterate on the reply trying to improve something that was never
  graded. Manager sees a score of zero and assumes the BUILD work is
  broken.
- **Fix sketch** Return a real tool error (`asError(...)` style) from
  `runTestJudge` on API failure, not a score-shaped stub. The agent
  should see a tool-error it can recover from, not a fake grade.
- **Effort** 1–2 hours

#### P1-3 — Tuning diagnostic / suggestion-writer errors fully invisible
- **Bucket** 4
- **File(s)** [messages.controller.ts:182–201](backend/src/controllers/messages.controller.ts),
  [shadow-preview.controller.ts:164–183](backend/src/controllers/shadow-preview.controller.ts)
- **Symptom** Any failure inside `runDiagnostic()` or
  `writeSuggestionFromDiagnostic()` (OpenAI timeout, Prisma error, JSON
  parse failure) is caught and logged to `console.error`. There is no
  metric, no badge on `/tuning`, no row. If the diagnostic service is
  down for an afternoon, the queue silently has a hole. This is the
  single most likely root cause of "I thought that edit would surface
  and it didn't."
- **Fix sketch** Write a `DiagnosticFailure` row on exception (tenantId,
  triggerType, messageId, reason, timestamp) and surface a count badge
  on `/tuning` when non-zero in the last 24h. Alternative: structured
  log tag `[TUNING_DIAGNOSTIC_FAILURE]` so Railway log search finds
  them, plus a Langfuse span.
- **Effort** 0.5 day

#### P1-4 — Diagnostic + suggestion-writer + evidence-bundle not transactional; orphan audit rows possible
- **Bucket** 4
- **File(s)** [diagnostic.service.ts:483–492](backend/src/services/tuning/diagnostic.service.ts),
  [suggestion-writer.service.ts:168–198](backend/src/services/tuning/suggestion-writer.service.ts)
- **Symptom** `runDiagnostic` persists an `EvidenceBundle`, then returns.
  `writeSuggestionFromDiagnostic` writes a `TuningSuggestion`, then
  `logSampleToAiApiLog` is called with `.catch(() => {})` (line 679).
  If either step fails mid-sequence: evidence bundles without a
  suggestion, suggestions pointing at a missing `AiApiLog`. Post-hoc
  replay and the trace drawer break.
- **Fix sketch** Wrap the write sequence in a `prisma.$transaction`.
  Alternative: a post-write sanity check that reconciles orphans (cheaper
  but less safe).
- **Effort** 2 hours

#### P1-5 — PREVIEW_LOCKED 409 from /send does not refresh client state
- **Bucket** 1
- **File(s)** [shadow-preview.service.ts:22–53](backend/src/services/shadow-preview.service.ts),
  [inbox-v5.tsx](frontend/components/inbox-v5.tsx) (socket listener)
- **Symptom** `lockOlderPreviews` fires on a new inbound message and
  emits `shadow_preview_locked`. If the socket event is dropped (flaky
  wifi) or arrives after the user clicks Send, the /send endpoint
  returns 409 but the UI keeps the preview in its previous actionable
  state. User sees a Send button that does nothing. No retry, no
  refresh, no toast.
- **Fix sketch** On 409 from `/send`, re-fetch the message (or trust a
  `message_state_changed` broadcast) and update local state. A sonner
  toast "this draft was superseded" on 409 would cover the observability
  half in one line.
- **Effort** 2–3 hours (frontend + a regression test)

#### P1-6 — Approve/reject status-claim revert not atomic → concurrent apply race
- **Bucket** 4
- **File(s)** [tuning-suggestion.controller.ts:180–196, 801–812](backend/src/controllers/tuning-suggestion.controller.ts)
- **Symptom** The `updateMany WHERE status IN ('PENDING','AUTO_SUPPRESSED')`
  atomic claim protects against double-apply. But when the artifact write
  fails (e.g., SopVariant update) and the handler reverts status back to
  PENDING, another request may already have claimed the reverted row
  between the failure and the revert. Result: two concurrent handlers
  both think they own the apply and both write to `SopVariant` /
  `FaqEntry` / `TenantAiConfig`. Rare (requires a failure + a concurrent
  click inside ~10ms), but the outcome is duplicate clauses / overwritten
  edits.
- **Fix sketch** Use an intermediate `APPLYING` status (or an
  `appliedVersion` optimistic counter) so the revert path is not
  reclaimable. Alternatively, do the revert and the artifact write
  inside a single `$transaction` so neither partial state is visible.
- **Effort** 3–4 hours

### P2 — polish / observability / minor UX

#### P2-1 — Tenant-state fetch failure silently drops GREENFIELD/BROWNFIELD posture from prompt
- **Bucket** 2
- **File(s)** [build-controller.ts:412–423, 430–445](backend/src/controllers/build-controller.ts);
  [system-prompt.ts:732–733](backend/src/services/build-tune-agent/system-prompt.ts)
- **Symptom** `getTenantStateSummary(...).catch(() => null)` → agent gets
  no `<tenant_state>` block → BUILD opens with the wrong frame on a
  brownfield tenant during a transient DB blip.
- **Fix sketch** Log a warn; retry once; surface a frontend advisory
  ("running without posture") so the manager knows why the agent is
  confused.
- **Effort** 20–30 min

#### P2-2 — Cross-session rejection write failure swallowed after session-scoped write succeeds
- **Bucket** 2
- **File(s)** [build-controller.ts:843–870](backend/src/controllers/build-controller.ts)
- **Symptom** Reject endpoint writes session-scoped memory first
  (required), then cross-session (best-effort with `catch → warn`). If
  the cross-session write fails, current session is fine, next session
  re-proposes the same fix. Manager sees no error; thinks rejection is
  permanent.
- **Fix sketch** Either return a non-fatal advisory to the UI when
  cross-session fails, or retry once before giving up.
- **Effort** 20 min

#### P2-3 — Shadow-preview compaction is fire-and-forget with no observability
- **Bucket** 1
- **File(s)** [shadow-preview.controller.ts:121–123](backend/src/controllers/shadow-preview.controller.ts)
- **Symptom** Compaction after a preview send is unawaited; errors land
  in logs only. Future AI turns quietly use stale / missing
  `compactedContent`.
- **Fix sketch** Add a structured metric on failure; pair with the P1-3
  failure surfacing so all three fire-and-forget swallowers share one
  observability path.
- **Effort** 1 hour (rolls into P1-3 work)

#### P2-4 — Tuning dedup key `${triggerType}:${messageId}` conflates distinct EDIT→REJECT flips
- **Bucket** 4
- **File(s)** [trigger-dedup.service.ts:8–33](backend/src/services/tuning/trigger-dedup.service.ts)
- **Symptom** Manager edits a draft (EDIT_TRIGGERED fires), then 30s
  later wholesale-replaces it (REJECT_TRIGGERED fires). Both fire
  because the triggerType differs — so this is actually correct
  behaviour today. The concern goes the other way: two distinct EDITs
  on the same message within 60s collapse into one diagnostic, losing
  the stronger signal if the second edit crosses the <0.3 similarity
  threshold.
- **Fix sketch** Dedup on
  `${triggerType}:${messageId}:${Math.floor(similarity*10)}` so a
  similarity-bucket flip defeats the dedup.
- **Effort** 1–2 hours

#### P2-5 — AUTO_SUPPRESSED tuning suggestions hidden with no operator-visible count
- **Bucket** 4
- **File(s)** [tuning-suggestion.controller.ts:94–99](backend/src/controllers/tuning-suggestion.controller.ts)
- **Symptom** `status=ALL` silently excludes AUTO_SUPPRESSED. Managers
  without the (optional) "Show suppressed" toggle never know a queue of
  low-confidence suggestions exists.
- **Fix sketch** Add a count badge on the `/tuning` nav for suppressed
  rows in the last 7d. Cheap; high confidence fix.
- **Effort** 1–2 hours

#### P2-6 — TOOL_CONFIG cooldown falls through to category-only key and over-suppresses
- **Bucket** 4
- **File(s)** [suggestion-writer.service.ts:221–247](backend/src/services/tuning/suggestion-writer.service.ts)
- **Symptom** Two distinct tool fixes (e.g. `check_availability` and
  `check_extend_availability`) within 48h collide on the category-only
  cooldown key; the second is suppressed. Silent false negative in the
  suggestion queue.
- **Fix sketch** Use `diagnosticSubLabel` (already holds the tool name)
  as a secondary cooldown key for TOOL_CONFIG.
- **Effort** 1–2 hours

#### P2-7 — Tuning list pagination: cursor to deleted id throws; non-deterministic order on tied `createdAt`
- **Bucket** 4
- **File(s)** [tuning-suggestion.controller.ts:101–112](backend/src/controllers/tuning-suggestion.controller.ts)
- **Symptom** A cursor pointing at a row since deleted → Prisma 500s
  and the `/tuning` list errors out for the user. Ties on `createdAt`
  can produce cross-page duplicates/gaps.
- **Fix sketch** Wrap findMany in try/catch → empty page + null cursor
  on invalid cursor. Composite `orderBy: [{createdAt: 'desc'}, {id: 'desc'}]`.
- **Effort** 1 hour

#### P2-8 — Category-acceptance gating lookup failure defaults to PENDING (gate silently opens)
- **Bucket** 4
- **File(s)** [suggestion-writer.service.ts:147–166](backend/src/services/tuning/suggestion-writer.service.ts)
- **Symptom** If `getCategoryAcceptance30d()` throws (transient DB), the
  gate opens — low-confidence suggestions that should have been
  AUTO_SUPPRESSED show up as PENDING. Self-heals when DB recovers, but
  the manager sees a noisier queue for the window.
- **Fix sketch** On error, default to `AUTO_SUPPRESSED`; log warn;
  emit a metric. Fails safer than fails loud.
- **Effort** 1 hour

#### P2-9 — RejectionMemory upsert overwrites prior `rationale`/`rejectedAt`; no audit history
- **Bucket** 3
- **File(s)** [prisma/schema.prisma:1057](backend/prisma/schema.prisma),
  [memory/service.ts:239–280](backend/src/services/build-tune-agent/memory/service.ts)
- **Symptom** Reject the same fix in two different conversations — the
  second upsert overwrites the first. Lose first-rejection timestamp
  and prior rationale. If operator later asks "when / why did we first
  reject this?" the answer is gone.
- **Fix sketch** Minimal: add a `firstRejectedAt` column kept across
  upserts. Full fix: a `RejectionMemoryHistory` audit table (mirrors
  `SopVariantHistory`). Out of scope for a single sprint-049 item but
  worth tracking.
- **Effort** 2 hours (minimal) to 1 day (audit table)

#### P2-10 — System prompt has no guidance on interpreting SKIPPED_PRIOR_REJECTION
- **Bucket** 3
- **File(s)** [system-prompt.ts](backend/src/services/build-tune-agent/system-prompt.ts)
- **Symptom** The tool returns a status + human hint, but the addendum
  never instructs the agent how to adapt (rephrase? retarget? ask?).
  Agent behaviour is currently emergent. Low probability of misbehaviour
  with current model, but the instruction is cheap and makes behaviour
  auditable.
- **Fix sketch** Short `<rejection_memory_guide>` block in the BUILD
  addendum explaining the three adaptation paths (rephrase / retarget
  / ask) and that rejection should be respected unless new evidence
  exists.
- **Effort** 30 min

---

## §3 Also-considered (clean)

Coverage map so sprint 050 doesn't re-walk these:

- `lockOlderPreviews` race between findMany + updateMany — updateMany
  correctly re-applies the `previewState: PREVIEW_PENDING` precondition.
- Frontend `shouldSendAsFromDraft` gate (sprint-048 fix) — still
  correct; `seededFromDraft !== null && sentText !== seededFromDraft`.
- BUILD transaction state machine (PLANNED → EXECUTING → {COMPLETED |
  PARTIAL} → ROLLED_BACK) with `validateBuildTransaction` — solid, has
  tests.
- `test-judge` JSON parsing with tiered fallbacks (strip markdown →
  regex → JSON.parse → field coercion) — robust.
- Admin-only gating on raw-prompt drawer — triple-layered (env flag +
  `tenant.isAdmin` + server-side route gate).
- `judgePromptVersion` stamping + surfacing to frontend — future
  re-scoring will work.
- RejectionMemory read-time expiry filter in `memory/service.ts:302` —
  correct.
- RejectionMemory tenant scoping (unique constraint + all queries) —
  correct, no cross-tenant leak risk.
- `approveSuggestion` clears `suggestion` after sending (prevents
  re-fire).
- Tuning dedup sweep when registry > 200 — lazy GC is appropriate.
- Diagnostic null-return on missing `OPENAI_API_KEY` — graceful
  degradation.
- `messages.controller.ts` fromDraft gate (sprint-048 fix) — explicit
  opt-in, not regressed.
- Cooldown uses `appliedAt` wall-clock, not `createdAt` — correct.

---

## §4 Open questions

1. Is `approveSuggestion`'s `editedText` parameter actually live from any
   caller today? The frontend `apiApproveSuggestion(...)` call at
   `inbox-v5.tsx:5095` omits it. If the param is dead,
   `P1-1` / NEXT §2.4 becomes "plumb the frontend to send editedText"
   not just "fire the diagnostic." Changes the effort estimate.
2. Intended BUILD tool-use loop depth — is there a hard cap, or is
   convergence assumed? `test_pipeline` has a once-per-turn guard but
   the broader `create_sop → test_pipeline → iterate` loop has no
   documented bound.
3. Calibration of the 60s tuning dedup window — is it SLA-based (webhook
   retry window) or a conservative guess?
4. Should session-scoped rejections in AgentMemory
   (`session/{conversationId}/rejected/*`) be swept too, or are they
   expected to decay with the TuningConversation lifecycle? Currently
   no cleanup.
5. Is `normaliseStatus` idempotent across the `test_pipeline` default
   ('CONFIRMED') and the hot-path `sop.service.ts` normaliser? If not,
   test runs may pick a different SOP variant than production. Need to
   read `normaliseStatus`.
6. Transactional boundary preference on tuning-suggestion accept: atomic
   claim + async artifact writes (current) vs full `$transaction` —
   product choice, ties into P1-6 fix shape.

End of report.
