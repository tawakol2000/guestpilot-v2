# Sprint 047 close + sprint 048 kickoff

> Sprint 047 is code-complete at Session C close. Five of the six
> gate items on the sprint-047 scope sheet landed across Sessions A,
> B, and C; the only remaining non-code action is the end-of-stack
> merge to production + its staging wet-test.
>
> This file is both the sprint-047 exit handoff and the sprint-048
> kickoff. Read section 1 to confirm what's still pending on 047,
> then section 2 for where sprint 048 begins.

---

## 1. Sprint 047 — pending close-out

### 1.1 End-of-stack merge to `advanced-ai-v7`

The full 045 → 046 → 047-A → 047-B → 047-C chain is unmerged.
Abdelrahman's explicit direction across Sessions B and C was to
defer the merge until the end of the stack so all staging wet-tests
run once against a single merged commit, not N times against
intermediate merges.

**Do the merge via `git merge -X theirs feat/047-session-c` onto
`advanced-ai-v7`.** The `-X theirs` strategy is deliberate:

- 045, 046, 047-A, 047-B, 047-C each touched overlapping files
  (system-prompt.ts, build-controller.ts, studio-chat.tsx,
  schema.prisma, frontend api.ts types).
- Every conflict across the stack has been resolved inside the
  chain — `feat/047-session-c` contains the authoritative view of
  every touched file.
- A 3-way merge would surface dozens of ancient conflicts that
  have already been hand-resolved along the way. `-X theirs` takes
  the merge-head version wherever they disagree with main.

**Before the merge**, verify:

```bash
git fetch origin
git checkout advanced-ai-v7
git pull --ff-only origin advanced-ai-v7
git merge -X theirs feat/047-session-c --no-ff -m "merge 045→047-C: BUILD mode + Studio merge + cross-session rejection memory"
```

`--no-ff` preserves the stack history. `--no-commit` is NOT
specified — audit the merge result before pushing.

**After the merge**, Railway auto-deploys backend from main; Vercel
auto-deploys frontend from main. Both are "git push is a prod
deploy" environments (per CLAUDE.md critical rule #1 — never break
the main guest messaging flow, so verify no `ai.service.ts` changes
are in the diff before push).

### 1.2 Staging wet-test

The four C-1 / C-2 / C-4 / C-5 checks in
[validation/sprint-047-session-a-staging-smoke.md](./validation/sprint-047-session-a-staging-smoke.md)
remain open. After the end-of-stack merge deploys, run them
against staging before the production flip. If any fails, the
failing check is sprint-048's first unit of work (same §1.5
contingency pattern used in Session C).

Pre-flight nullable-FK grep already done in Session C — no
non-null-assertion callsites in the repo; the one type gap
(`TuningSuggestion.sourceMessageId`) was patched at commit
`282753a`. The grep can be skipped at deploy time; the patch is
already on the branch.

### 1.3 Admin flags on production

After the deploy, for the raw-prompt drawer and trace drawer to
render for Abdelrahman, flip these manually:

```sql
UPDATE "Tenant" SET "isAdmin" = true WHERE email = 'ab.tawakol@gmail.com';
```

And on Railway environment:

```
ENABLE_BUILD_MODE=true
ENABLE_BUILD_TRACE_VIEW=true
ENABLE_RAW_PROMPT_EDITOR=true
```

None of these are automated — spec-intended per Session B and
Session C decisions. Leave them off on other tenants' environments
if any are shared.

---

## 2. Sprint 048 — kickoff

### 2.1 Candidate scope

Three lines of work are ripe, all carried forward from sprint-047
deferrals. Pick the one with the most operator pressure; the others
can defer to sprint 049.

- **Raw-prompt editor edit path (finishing C3).**
  [Plan §6.5](./sprint-046-plan.md) + sprint-047 Session C §7:
  flesh out the edit path so admins can write a `TenantAiConfig`
  override from the drawer with `origin: 'raw-editor'`. The reads
  exist; the composer needs to grow an override-merge layer so
  region-scoped edits don't require rewriting the whole assembled
  prompt. Estimate: 1.5–2 days.

- **RejectionMemory retention sweep + cleared-rejections UI.**
  The 90d TTL is stamped per-row; a retention job to delete
  `WHERE expiresAt < now()` would mirror
  `build-tool-call-log-retention.job.ts` (daily 03:00 UTC, batched
  10k). Pair with a small admin-only "Cleared rejections" list that
  lets a manager manually unblock a rejection that's stale ahead of
  90d (e.g. "that was the old SOP, propose again"). Requires
  operator feedback on whether the UI is worth the surface area.
  Estimate: 0.5–1 day for the job, +1 day for the UI.

- **Free-text rationale on the reject card.** The backend already
  captures and round-trips `RejectionMemory.rationale`; the Studio
  reject UI currently sends null. A small optional text field on
  the reject button would dramatically enrich the
  `SKIPPED_PRIOR_REJECTION` hints the agent sees. Product question:
  is the extra click worth the agent-behaviour upside? Estimate:
  0.5 day.

### 2.2 Still-deferred from sprint 047

Unchanged from sprint-047 Session C close:

- **R1 persist-time truncation (Path B).** Langfuse-data-dependent;
  re-evaluate when a week of production telemetry is in.
- **Dashboards merge into main Analytics tab.** Plan §9; depends
  on operator feedback on the standalone Studio panel.
- **R2 enforcement observability dashboard.** Langfuse work, out
  of the code-session pattern.
- **Oscillation advisory on BUILD writes.** Still needs a
  confidence signal on BUILD creators that doesn't exist today.
- **Per-user admin distinctions.** `Tenant.isAdmin` conflates
  tenant-owner and platform-admin. Migrate to a User model only if
  product surfaces a need for per-operator gating.

### 2.3 Non-negotiables carried forward

- `ai.service.ts` untouched. Guest messaging flow is out of scope
  for any /build / /tuning work.
- Prisma changes via `prisma db push`, not migrations.
- Admin-only surfaces stay admin-only. No weakening for
  convenience.
- Graceful degradation on every new DB lookup: missing memory ≠
  silencing a suggestion.

---

## 3. Context pointers

- [sprint-046-plan.md](./sprint-046-plan.md) — the unified plan
  Sessions 045 / 046 / 047 all implement against. §6.5 (raw-prompt
  editor) and §4.4 (rejection memory) are still the authoritative
  contract specs.
- [cross-session-rejection-memory.md](./cross-session-rejection-memory.md)
  — sprint-047 Session C design doc. Start here before touching
  RejectionMemory.
- [PROGRESS.md](./PROGRESS.md) "Sprint 047 — Session C" —
  decisions + verification log.
- [NEXT.sprint-047-session-c.archive.md](./NEXT.sprint-047-session-c.archive.md)
  — archived Session C scope sheet. Kept for audit trail.

End of handoff.
