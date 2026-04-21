# Sprint 050 — kickoff

> Sprint 049 closed clean at Session A's commit `3f419c3` — the
> legacy-Copilot `approveSuggestion` P0 pair (Hostaway-failure orphan
> + Path B diagnostic fire) fixed, tuning nav 404s removed, inbox
> checklist + approve-pill now toast failures, and a structured
> `[TUNING_DIAGNOSTIC_FAILURE]` log tag landed at all four tuning
> fire-and-forget sites. tsc+test-green both sides. Archived kickoff
> at [`NEXT.sprint-049-session-a.archive.md`](./NEXT.sprint-049-session-a.archive.md).
>
> Sprint 050's candidate scope is the remaining sprint-049 deferrals:
> explore-report P1s that didn't fit Session A, discovery-report F1/D1,
> plus the DB-backed half of the observability badge (P1-3) now that
> the log-tag half is shipping signal. Pick a coherent bundle from §1
> and §2.
>
> Read sections in order: §1 sprint-050 Session A candidates, §2
> still-deferred, §3 context pointers.

---

## 1. Sprint 050 — Session A candidates

Six candidates ranked roughly by operator impact. Owner picks a
coherent bundle (2–3 items) for the first session; the rest stay on
deck for Session B or slip to 051.

### 1.1 Explore P1-5 — PREVIEW_LOCKED 409 from `/send` doesn't refresh client state

**Files.** [`shadow-preview.service.ts:22–53`](backend/src/services/shadow-preview.service.ts),
[`inbox-v5.tsx`](frontend/components/inbox-v5.tsx) (socket listener
for `shadow_preview_locked`).

**Symptom.** `lockOlderPreviews` fires on a new inbound message and
emits `shadow_preview_locked`. If the socket event drops (flaky wifi)
or lands after the user clicks Send, `/send` returns 409 but the UI
keeps the preview actionable. Manager sees a dead Send button. No
retry, no toast.

**Fix sketch.** On 409 from `/send`, re-fetch the message (or trust a
follow-up `message_state_changed` broadcast) and patch local state. A
sonner toast "this draft was superseded" covers the observability
half in one line. Matches the A6 pattern shipped in sprint-049.

**Effort.** 2–3 hours (frontend + a regression test mirroring A3's
controller-level shape).

**Operator impact.** High — the failure mode is silent and recurs on
every socket reconnect race. Operator workaround today is a page
refresh; the fix eliminates the need.

### 1.2 Explore P1-2 — Judge API failure returns `score: 0` with `failureCategory: 'judge-error'`

**Files.** [`test-judge.ts:167–175`](backend/src/services/build-tune-agent/preview/test-judge.ts).

**Symptom.** Manager runs `test_pipeline`. Anthropic 401s or times
out. Tool returns a well-formed `TestJudgeResult` with `score: 0.0`
and rationale "Judge call failed: …". The BUILD agent has no way to
tell infra failure from genuinely bad output and iterates on the
reply trying to improve something that was never graded. Manager
sees score 0 and assumes BUILD is broken.

**Fix sketch.** On Anthropic API failure, return an `asError(...)`
tool error rather than a score-shaped stub. The agent sees a tool
error it can recover from, not a fake grade.

**Effort.** 1–2 hours + a unit spec on the stub path.

**Operator impact.** Medium — rare trigger (needs a judge-API blip),
but when it fires the manager's BUILD trust is poisoned for the rest
of that session.

### 1.3 Explore P1-4 — Diagnostic + suggestion-writer + evidence-bundle not transactional

**Files.** [`diagnostic.service.ts:483–492`](backend/src/services/tuning/diagnostic.service.ts),
[`suggestion-writer.service.ts:168–198`](backend/src/services/tuning/suggestion-writer.service.ts).

**Symptom.** `runDiagnostic` persists an `EvidenceBundle`, returns.
`writeSuggestionFromDiagnostic` writes a `TuningSuggestion`, then
`logSampleToAiApiLog` is `.catch(() => {})`. Mid-sequence failure →
evidence without suggestion, suggestions pointing at a missing
`AiApiLog`. Post-hoc replay + the trace drawer break silently.

**Fix sketch.** Wrap the write sequence in a `prisma.$transaction`.
Alternative: a post-write sanity-check reconciler (cheaper, less
safe). Pair with sprint-049 A7's observability so orphan rows at
least get an audit tag.

**Effort.** 2 hours + one integration case per branch outcome.

**Operator impact.** Low-frequency today (haven't seen it in
production) but the blast radius on a bad deploy would be
significant. Belongs on the same sprint as any schema work since
the fix is transactional, not columnar.

### 1.4 Explore P1-6 — Atomic-claim revert race on tuning-suggestion accept

**Files.** [`tuning-suggestion.controller.ts:180–196, 801–812`](backend/src/controllers/tuning-suggestion.controller.ts).

**Symptom.** The `updateMany WHERE status IN ('PENDING',
'AUTO_SUPPRESSED')` atomic claim protects against double-apply. But
when the artifact write fails (e.g. SopVariant update) and the
handler reverts status back to PENDING, another request may have
claimed the reverted row between the failure and the revert. Two
concurrent handlers both think they own the apply; two writes to
`SopVariant` / `FaqEntry` / `TenantAiConfig`. Rare (~10ms race
window).

**Fix sketch.** Introduce an intermediate `APPLYING` status (or an
`appliedVersion` optimistic counter) so the revert path is not
reclaimable. Alternative: do the revert and the artifact write
inside a single `$transaction`.

**Effort.** 3–4 hours + a concurrent-apply integration test using
two parallel handler invocations.

**Operator impact.** Rare in single-operator tenants but non-zero
when managers rapidly hit Apply on stacked-up suggestions. Outcome
is duplicate clauses / overwritten edits — painful to diagnose
after the fact.

### 1.5 Discovery F1 — Dead `POST /api/tuning/complaints`

**Files.** [`backend/src/routes/tuning-complaint.ts:20`](backend/src/routes/tuning-complaint.ts),
plus `docs/ios-handoff.md` (pre-work read).

**Symptom.** Route exposed behind JWT auth, zero frontend callers.
Companion `GET /category-stats` also unused by frontend. Feature 041
sprint 02 wired the route; UI never followed.

**Fix sketch.** Either ship a Complaint affordance on one of the
`/tuning` sub-pages OR delete the router + controller + its
`app.ts` mount. Product call. Read `docs/ios-handoff.md` first to
confirm no iOS handoff call uses the POST — if it does, the
deletion is blocked and this becomes a "delete from web, keep for
ios" scope.

**Effort.** 30 min if deleting; 1 day if shipping the UI.

**Operator impact.** Zero today (nothing calls it). Cleanup yields
a smaller auth surface and one less mystery route for the next
code reader.

### 1.6 DB-backed `TUNING_DIAGNOSTIC_FAILURE` badge (DB half of explore P1-3)

**Files.** [`prisma/schema.prisma`](backend/prisma/schema.prisma) (new
`DiagnosticFailure` model), [`diagnostic-failure-log.ts`](backend/src/services/tuning/diagnostic-failure-log.ts)
(teach helper to also insert), new admin-only query endpoint,
tuning nav badge.

**Symptom.** Sprint-049 A7 shipped the log-tag half — Railway
grep now surfaces silent failures. But the manager has no product-
side signal. A 30-minute OpenAI outage still leaves zero /tuning
badge, no retry queue, no observable count.

**Fix sketch.** Persist a `DiagnosticFailure` row on each
fire-and-forget catch (tenantId, phase, path, triggerType,
messageId, reason, createdAt). Retention: 30d rolling purge.
Surface a count badge on `/tuning/sessions` nav when >0 in the
last 24h. Admin-only `/api/admin/diagnostic-failures` endpoint for
triage.

**Effort.** 0.5–1 day. Schema change + helper delta + nav badge +
admin endpoint + a retention job hooking into the existing
scheduled-job runner.

**Operator impact.** High once calibrated — turns silent tuning-
pipeline outages into a visible product signal. Pre-requisite: at
least a week of production log signal from sprint-049 A7 to pick
sensible thresholds for the badge (e.g. "show when ≥N failures in
24h, where N is the p95 of normal weeks").

---

## 2. Still-deferred

### 2.1 Deferred from sprint 049

- **Discovery D1** — webhook drop-through on auto-create-failed.
  Touches `webhooks.controller.ts` on the guest-message intake
  path; CLAUDE.md rule #1 says never break it without a dedicated
  sprint. Standalone work, not a bundle item.
- **Full Path A ⇔ Path B semantic parity audit.** Sprint-049 A2
  fixed the diagnostic fire divergence. `Message.role`
  (`HOST` vs `AI`), `deliveryStatus` capture, audit-field set are
  still different on the two paths. Sprint-050 bundle candidate
  only if a new bug surfaces in the seam.
- **Explore P2s (×10).** Polish queue — see
  [`sprint-049-explore-report.md`](./sprint-049-explore-report.md) §2
  P2-1 through P2-10. Pick individually as padding when a session
  bundle has slack.

### 2.2 Carried forward unchanged (from sprint-049 NEXT §2.3)

- **R1 persist-time truncation (Path B).** Langfuse-data-dependent.
- **Dashboards merge into main Analytics tab.** Depends on operator
  feedback on the standalone Studio panel.
- **R2 enforcement observability dashboard.** Langfuse work, out of
  the code-session pattern.
- **Oscillation advisory on BUILD writes.** Needs a confidence
  signal on BUILD creators that doesn't exist today.
- **Per-user admin distinctions.** `Tenant.isAdmin` conflates
  tenant-owner and platform-admin. Migrate to a `User` model only if
  product surfaces a need.
- **Raw-prompt editor edit path.** Still deferred from prior
  sessions — no operator pressure has made this the hot item yet.
- **RejectionMemory retention sweep + cleared-rejections UI.**
- **Free-text rationale on reject card.**

### 2.3 Non-negotiables carried forward

- `ai.service.ts` untouched. Guest messaging flow out of scope.
- Prisma changes via `prisma db push`, not migrations.
- Admin-only surfaces stay admin-only (triple-gated: env flag +
  `tenant.isAdmin` + server-side route gate).
- Graceful degradation on every new DB lookup (CLAUDE.md rule #2).
- Legacy copilot `fromDraft` gate stays explicit opt-in — the
  sprint-10 false-positive lockdown is load-bearing; sprint 048-A
  A4 case 3 + sprint 049-A A3 case (b) both regression-test it.

---

## 3. Context pointers

- [`sprint-049-session-a.md`](./sprint-049-session-a.md) — archived
  session-a brief (nine gates, all closed).
- [`sprint-049-discovery-report.md`](./sprint-049-discovery-report.md)
  — discovery audit; F1 + D1 deferrals live here with line refs.
- [`sprint-049-explore-report.md`](./sprint-049-explore-report.md) —
  16-finding explore pass; sprint-050 candidates 1.1–1.4 come from §2
  P1-2/4/5/6. §3 "Also-considered" is the coverage map so 050
  doesn't re-walk clean surfaces.
- [`PROGRESS.md`](./PROGRESS.md) — "Sprint 049 — Session A"
  subsection is the close-out log for this sprint's work, including
  the A6 terminology caveat and the A7 SC-5 extraction rationale.
- [`NEXT.sprint-049-session-a.archive.md`](./NEXT.sprint-049-session-a.archive.md)
  — archived sprint-049 kickoff brief.
- [`NEXT.sprint-049-kickoff-candidate-list.archive.md`](./NEXT.sprint-049-kickoff-candidate-list.archive.md)
  — superseded pre-discovery candidate list.

End of kickoff.
