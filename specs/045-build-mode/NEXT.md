# Sprint 049 — kickoff

> Sprint 048 closed at Session A's commit `944b08f` with both
> operator-facing bugs fixed: copilot-mode edits now fire the tuning
> diagnostic via a new pill-side Edit affordance + gated `fromDraft`
> signal, and "Discuss in tuning" now surfaces errors via sonner
> toast with a visible busy state. Both ship at tsc+test-green.
>
> The three candidates previously queued in sprint-048's NEXT.md §2.1
> remain unstarted and carry forward as the sprint-049 candidate
> scope. The archived session brief is at
> [`NEXT.sprint-048-session-a.archive.md`](./NEXT.sprint-048-session-a.archive.md).
>
> Read sections in order: §1 close-out still owed, §2 sprint-049
> candidates (pick one), §3 still-deferred, §4 context pointers.

---

## 1. Sprints 047 + 048 — pending close-out

### 1.1 End-of-stack merge to `advanced-ai-v7`

Unchanged from sprint-047 Session C's exit, with one more segment
now in the chain (`feat/048-session-a`). Still deferred per
Abdelrahman's posture of merging once at the end so staging
wet-tests run against a single merged commit.

**Do the merge via `git merge -X theirs feat/048-session-a` onto
`advanced-ai-v7`.** Rationale unchanged: 045 → 046 → 047-A/B/C →
048-A all touch overlapping files (system-prompt.ts,
build-controller.ts, studio-chat.tsx, schema.prisma, frontend
api.ts types, inbox-v5.tsx). The head of the chain contains the
authoritative view of every touched file; `-X theirs` sidesteps
dozens of ancient conflicts that were hand-resolved along the way.

```bash
git fetch origin
git checkout advanced-ai-v7
git pull --ff-only origin advanced-ai-v7
git merge -X theirs feat/048-session-a --no-ff \
  -m "merge 045→048-A: BUILD mode + Studio merge + cross-session rejection memory + copilot edit signal"
```

**Pre-merge sanity:** diff the merge result against main and
confirm zero changes land in `ai.service.ts` (CLAUDE.md critical
rule #1). The chain is designed to stay clear of the main guest
pipeline.

**After the merge:** Railway auto-deploys backend, Vercel
auto-deploys frontend. Run:

1. [`validation/sprint-047-session-a-staging-smoke.md`](./validation/sprint-047-session-a-staging-smoke.md)
   C-1 / C-2 / C-4 / C-5 checks (still open from sprint-047).
2. [`validation/sprint-048-discuss-in-tuning-smoke.md`](./validation/sprint-048-discuss-in-tuning-smoke.md)
   curl + fill in the Run log stanza.
3. Ad-hoc: send a copilot-mode reply via the new pill Edit button
   with real edits → confirm a `TuningSuggestion` row lands in
   `/tuning` within 5s (SC-1a).

If any fails, the failing check is sprint-049's first unit of work
(same §1.5 contingency pattern used in Session C).

### 1.2 Admin flags on production

Unchanged from sprint-047 Session C NEXT.md. For the raw-prompt
drawer + trace drawer to render for Abdelrahman after deploy:

```sql
UPDATE "Tenant" SET "isAdmin" = true WHERE email = 'ab.tawakol@gmail.com';
```

Railway env:

```
ENABLE_BUILD_MODE=true
ENABLE_BUILD_TRACE_VIEW=true
ENABLE_RAW_PROMPT_EDITOR=true
```

Spec-intended; not automated.

---

## 2. Sprint 049 — candidate scope

Three candidates carry forward from sprint-048's §3 list. Pick the
one with the most operator pressure; the others defer to sprint 050.

### 2.1 Raw-prompt editor edit path (finishing C3)

[Plan §6.5](./sprint-046-plan.md) + sprint-047 Session C §7. The
read-through drawer is live behind two flags; the composer needs an
override-merge layer so region-scoped edits write a
`TenantAiConfig` override with `origin: 'raw-editor'` without
rewriting the full assembled prompt. Estimate: 1.5–2 days.

Load-bearing decision: does the override live per-region (coordinator
vs screening vs shared prefix) or per-byte-range? Per-region is
cleaner but requires the composer to track region boundaries; the
current `assembleSystemPromptRegions` helper is shape-only. A
per-region override table feels right; lock in at kickoff.

### 2.2 RejectionMemory retention sweep + cleared-rejections UI

The 90d TTL is stamped per-row; a retention job to delete
`WHERE expiresAt < now()` would mirror
`build-tool-call-log-retention.job.ts` (daily 03:00 UTC, batched
10k). Pair with a small admin-only "Cleared rejections" list that
lets a manager manually unblock a rejection ahead of 90d ("that
was the old SOP, propose again"). Requires operator feedback on
whether the UI is worth the surface area. Estimate: 0.5–1 day for
the job, +1 day for the UI.

### 2.3 Free-text rationale on the reject card

Backend already captures and round-trips `RejectionMemory.rationale`;
the Studio reject UI currently sends null. A small optional text
field on the reject button would dramatically enrich the
`SKIPPED_PRIOR_REJECTION` hints the agent sees. Product question:
is the extra click worth the agent-behaviour upside? Estimate:
0.5 day.

### 2.4 Path A/B unification for legacy copilot edits

New in sprint-049: `conversations.controller.ts#approveSuggestion`
still doesn't fire the diagnostic when `editedText !== suggestion`.
Not load-bearing today (the frontend only sends unchanged text down
that path), but worth harmonising so a future UX addition — e.g.
an edit-then-approve option on the arrow button — gets the fire
for free. Estimate: 0.5 day (add the same EDIT/REJECT split as
`messages.controller.ts#send`).

---

## 3. Still-deferred (unchanged from sprint 048)

- **R1 persist-time truncation (Path B).** Langfuse-data-dependent;
  re-evaluate when a week of production telemetry is in.
- **Dashboards merge into main Analytics tab.** Depends on
  operator feedback on the standalone Studio panel.
- **R2 enforcement observability dashboard.** Langfuse work, out
  of the code-session pattern.
- **Oscillation advisory on BUILD writes.** Needs a confidence
  signal on BUILD creators that doesn't exist today.
- **Per-user admin distinctions.** `Tenant.isAdmin` conflates
  tenant-owner and platform-admin. Migrate to a User model only if
  product surfaces a need for per-operator gating.

### 3.1 Non-negotiables carried forward

- `ai.service.ts` untouched. Guest messaging flow is out of scope
  for any /build / /tuning / /copilot work.
- Prisma changes via `prisma db push`, not migrations.
- Admin-only surfaces stay admin-only.
- Graceful degradation on every new DB lookup: missing memory ≠
  silencing a suggestion.
- Legacy copilot `fromDraft` gate stays explicit opt-in — the
  sprint-10 false-positive lockdown is load-bearing and sprint 048
  Session A adds a new regression test (A4 case 3) guarding it.

---

## 4. Context pointers

- [sprint-046-plan.md](./sprint-046-plan.md) — the unified plan
  Sessions 045 / 046 / 047 all implement against. §6.5 (raw-prompt
  editor) and §4.4 (rejection memory) are still the authoritative
  contract specs.
- [cross-session-rejection-memory.md](./cross-session-rejection-memory.md)
  — sprint-047 Session C design doc.
- [sprint-048-session-a.md](./sprint-048-session-a.md) — sprint-048
  Session A scope sheet (kept for audit; session closed).
- [PROGRESS.md](./PROGRESS.md) "Sprint 048 — Session A" —
  decisions + verification log.
- [NEXT.sprint-048-session-a.archive.md](./NEXT.sprint-048-session-a.archive.md)
  — archived sprint-048 kickoff brief.

End of handoff.
