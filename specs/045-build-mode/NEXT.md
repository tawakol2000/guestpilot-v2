# Sprint 049 — Session A kickoff

> Sprint 048 closed clean at Session A's commit `c206db0` (both
> operator-facing bugs fixed, tsc+test-green). Sprint 049 picks up
> from two parallel audit passes:
>
> - [`sprint-049-discovery-report.md`](./sprint-049-discovery-report.md)
>   — pre-compaction triple-check; surfaced two P0s in one controller
>   plus two UX bugs and a stale endpoint.
> - [`sprint-049-explore-report.md`](./sprint-049-explore-report.md)
>   — 16-finding explore pass over copilot / BUILD / RejectionMemory /
>   tuning-handoff surfaces. 6 P1 + 10 P2.
>
> Session A scope is fixed. Read sections in order: §1 session pointer,
> §2 still-deferred, §3 context pointers.

---

## 1. Sprint 049 — Session A scope (fixed)

**Read [`sprint-049-session-a.md`](./sprint-049-session-a.md) for the
full brief.** Nine gates (A1-A9):

- **A1 + A2** — `approveSuggestion` controller repair. Reorder so
  Hostaway fires before DB writes (fixes P0 orphan on Hostaway failure),
  then wire the tuning diagnostic fire + `cancelPendingAiReply` (fixes
  the Path A/B divergence from sprint 048).
- **A3** — Backend integration tests for A1+A2 (4 cases).
- **A4** — Remove dead `/tuning` + `/tuning/agent` route references
  from top-nav + playground. Two nav entries currently 404 on every
  tuning page.
- **A5** — `sonner` toasts on document-checklist write failures (two
  silent-swallow sites).
- **A6** — Stale API endpoint cleanup (discovery-report F2).
- **A7** — `[TUNING_DIAGNOSTIC_FAILURE]` structured log tag on every
  diagnostic / suggestion-writer / compaction fire-and-forget (four
  sites after A2). Closes the log-greppable half of the observability
  hole; DB-backed badge defers to sprint-050.
- **A8** — Suites green + tsc clean.
- **A9** — PROGRESS.md + NEXT.md rewrite for sprint-050.

**Pre-flight** (from sprint-049-session-a.md §0.1):

- Confirm both audit reports (discovery + explore) are committed on
  `feat/048-session-a` before cutting `feat/049-session-a`.
- No schema changes. No `prisma db push`.
- No new API routes.

**Admin flags on production** (still pending from sprint 047 close-out,
operator-side only):

```
ENABLE_BUILD_MODE=true
ENABLE_BUILD_TRACE_VIEW=true
ENABLE_RAW_PROMPT_EDITOR=true
```

Set on Railway when ready. Not part of this session's code scope.

---

## 2. Still-deferred (updated)

### 2.1 Deferred from explore report to sprint-050 candidate list

- **P1-4** — Transactional diagnostic + suggestion + evidence writes.
- **P1-6** — Atomic-claim revert race on tuning-suggestion accept.
- **P1-2** — Judge infra failure returning `score: 0` (real BUILD
  correctness bug; agent iterates on infra failures).
- **P1-5** — `PREVIEW_LOCKED` 409 from `/send` doesn't refresh client
  state; manager sees dead button.
- **P1-1** — Legacy `approveSuggestion` `editedText` diagnostic fire.
  Being shipped by A2 in this session; the NEXT.md §2.4 framing from
  the prior kickoff is subsumed. **Mark closed at end of session.**
- **DB-backed observability badge for `TUNING_DIAGNOSTIC_FAILURE`**
  (the DB half of P1-3). Log-tag half ships in A7; table + badge need
  a week of production log signal to calibrate thresholds.
- All ten P2s from the explore report — polish queue.

### 2.2 Deferred from discovery report to Session B (or sprint 050)

- **F1** — Dead `POST /api/tuning/complaints`. Needs `docs/ios-handoff.md`
  read to confirm no mobile client still calls it.
- **D1** — Webhook drop-through on auto-create-failed. Touches guest-
  message intake; CLAUDE.md rule #1 says never break it without a
  dedicated sprint.

### 2.3 Carried forward unchanged

- **R1 persist-time truncation (Path B).** Langfuse-data-dependent.
- **Dashboards merge into main Analytics tab.** Depends on operator
  feedback on the standalone Studio panel.
- **R2 enforcement observability dashboard.** Langfuse work, out of
  the code-session pattern.
- **Oscillation advisory on BUILD writes.** Needs a confidence signal
  on BUILD creators that doesn't exist today.
- **Per-user admin distinctions.** `Tenant.isAdmin` conflates tenant-
  owner and platform-admin. Migrate to a User model only if product
  surfaces a need for per-operator gating.
- **Raw-prompt editor edit path** (prior NEXT.md §2.1 / Plan §6.5).
- **RejectionMemory retention sweep + cleared-rejections UI** (prior
  §2.2).
- **Free-text rationale on reject card** (prior §2.3).

### 2.4 Non-negotiables carried forward

- `ai.service.ts` untouched. Guest messaging flow out of scope.
- Prisma changes via `prisma db push`, not migrations. (No schema
  changes this session regardless.)
- Admin-only surfaces stay admin-only.
- Graceful degradation on every new DB lookup.
- Legacy copilot `fromDraft` gate stays explicit opt-in — the
  sprint-10 false-positive lockdown is load-bearing; sprint 048
  Session A's A4 case 3 regression test guards it.

---

## 3. Context pointers

- [`sprint-049-session-a.md`](./sprint-049-session-a.md) — this
  session's full brief. Nine gates, six sub-items, three acceptance
  criteria each.
- [`sprint-049-discovery-report.md`](./sprint-049-discovery-report.md)
  — audit that surfaced A1+A2+A4+A5+A6.
- [`sprint-049-explore-report.md`](./sprint-049-explore-report.md) —
  explore pass that surfaced A7 (the log-tag half of P1-3) and the
  sprint-050 candidate list.
- [`sprint-046-plan.md`](./sprint-046-plan.md) §8 — legacy-Copilot
  contract + sprint-10 `fromDraft` lockdown. A2 inherits by design.
- [`sprint-048-session-a.md`](./sprint-048-session-a.md) §1.1 — Path A
  half of the legacy-Copilot diagnostic fix. A2 lands Path B half.
- [`cross-session-rejection-memory.md`](./cross-session-rejection-memory.md)
  — sprint-047 Session C design doc (context for explore report bucket 3).
- [`PROGRESS.md`](./PROGRESS.md) — decisions + verification log;
  "Sprint 048 — Session A" subsection is the extract-to-helper
  testing pattern A7's tests should reuse.
- [`NEXT.sprint-048-session-a.archive.md`](./NEXT.sprint-048-session-a.archive.md)
  — archived sprint-048 kickoff brief.
- [`NEXT.sprint-049-kickoff-candidate-list.archive.md`](./NEXT.sprint-049-kickoff-candidate-list.archive.md)
  — superseded pre-discovery-report four-candidate list.

End of kickoff.
