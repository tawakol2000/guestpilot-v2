# Next — after sprint-052 Session A close-out

> Sprint 052-A closed at `bf2aa36` on `feat/052-session-a`, stacked on
> `feat/051-session-a` (tip `41b339c`) stacked on `feat/050-session-a`
> (tip `d103c14`). All three branches stay off `main` until the owner
> runs a combined 050-A + 051-A + 052-A staging walkthrough. The B
> bundle is now complete — every artifact type the drawer renders has a
> "view" and, where a history table exists, a diff. The only
> forward-compatible seam is `ToolDefinitionHistory` (renderer shipped,
> backend prev-schema not lit up yet).

This kickoff surfaces two candidates for sprint-053 Session A. Either
is a reasonable next sprint; the owner chooses.

---

## Candidate 1 — Bundle C primary (tiered permissions + Try-it + dry-run)

Closes the "operator trust" half of the roadmap. Operators need to be
able to (a) experiment with a planned change before it lands, (b) feel
in control of what each tier of user can do, and (c) understand the
blast radius of a system-prompt write before approving it. This bundle
bundles the three together because they share plumbing (the write
ledger, the permission tier check, the preview pipeline) — splitting
them into three sprints would touch the same files repeatedly.

### Gate sheet

| Gate | Title | Why |
|------|-------|-----|
| C1 | Write-ledger unification + suggested-fix rollback "reverted" state | sprint-050-A caveat #3. The permissions work in C2 needs a single ledger to reason about, and the rollback → "reverted" UI is already half-modelled in `session-artifacts.tsx` (the `reverted` action exists; the backend flow doesn't emit it on suggested-fix rollbacks). Backend-leaning. Estimated 6–10h. |
| C2 | Tiered permissions — operator / admin / owner | Capability-tier gate on `create_*` + `write_system_prompt` + `rollback` tools. Operator can read + propose; admin can approve in-session; owner can unlock dry-run-disabled paths. Reuses `BuildCapabilities` — no new wire format. Estimated 8–12h. |
| C3 | Try-it composer in the drawer | Inline "compose a draft reply using this artifact" chip that calls `test_pipeline` with the artifact's current body bound. Read-only; viewer-only. Operator gets a preview of the AI's behaviour under the proposed content without committing. Estimated 10–14h. |
| C4 | Dry-run-before-write for `system_prompt` only | Pre-flight `test_pipeline` against 2–3 canned incidents before any `write_system_prompt` approval. Surface the judge's score + the judge's rationale in the approval card. If the judge score drops vs baseline, make the "Approve" button a two-click confirmation. `system_prompt` only — SOP/FAQ writes are cheap enough to revert; a blown prompt is not. Estimated 6–10h. |
| C5 | Verification | tsc + suites + manual walkthrough. Fold in the 050/051/052 combined walkthrough as the merge gate. Estimated 3h. |

Total: **33–49 hours**. Medium-large sprint. C1 is the load-bearing
prerequisite — do it first.

### Why this is the primary pick

- Operators have been asking for "can I see what this would do"
  since 048. Try-it + dry-run directly answer that.
- Permissions are the unlock for letting non-admins inside Studio.
  The 050-A + 051-A sanitiser work was the security floor for this
  sprint; C2 is the ceiling.
- Write-ledger unification unblocks session-artifacts' "reverted"
  state, which is the last grammar gap in the A1 origin rules.

### Non-goals (protect the scope)

- No batch / golden-set / adversarial eval — `test_pipeline` stays
  single-message.
- No inline edit in the drawer. Still viewer-only.
- No markdown-AST diff.
- No `ToolDefinitionHistory` model (would bloat the sprint).

---

## Candidate 2 — Correctness carry-over bundle

Clears the sprint-049 tail + absorbs the 050-A / 051-A / 052-A caveats
that haven't been handled. Not glamorous; also not load-bearing for
any single operator flow. Interleave candidate if Bundle C feels too
heavy to start this session.

### Gate sheet

| Gate | Title | Why / carryover |
|------|-------|-----------------|
| K1 | sprint-049 P1-5 — `PREVIEW_LOCKED` 409 refresh | Cheapest single item at ~2–3h. Ships the refresh-on-preview-lock UX. |
| K2 | sprint-049 P1-2 — judge API stub | Test harness cleanliness; the test_pipeline judge call is currently hand-mocked per test. Saves 20m per new test. |
| K3 | sprint-049 P1-4 — diagnostic transaction | Unwinds the multi-write path in `diagnostic.service.ts` into a single transaction. No user-facing change; one less race condition. |
| K4 | sprint-049 P1-6 — atomic-claim revert race | Rare race when two managers hit "accept" on the same queued suggestion. Reproducible; low frequency. |
| K5 | sprint-049 F1 — dead `POST /api/tuning/complaints` | Route is referenced nowhere in the frontend; safe to delete after a final grep. |
| K6 | sprint-049 P1-3 DB half — backend persistence for diagnostic-failure badge | Completes the DB-backed badge flag; the frontend half shipped in 049. |
| K7 | sprint-050-A caveat #3 (if not in C1) — write-ledger unification | Overlap with Bundle C; skip this gate if C1 is already scheduled. |
| K8 | 051-A citation unknown-id UX polish | Currently an unknown id renders as a muted chip; polish to an inline "stale citation" tooltip. Low priority. |
| K9 | 052-A `ToolDefinitionHistory` model (optional) | Unlocks the tool JSON diff end-to-end. Medium cost (schema change + write-path patches in every tool-touching service). Defer if Bundle C is planned. |
| K10 | Verification | tsc + suites + PROGRESS.md. |

Total: **14–22 hours**. Smaller than Bundle C, and each gate is
independent — the sprint can drop any one if it runs long.

### Why this is the alternate pick

- The tail is small but real. P1-6 is a latent race; P1-3's DB half
  would quiet a long-standing "why does this badge sometimes
  disappear" thread.
- Useful cold-start for a session where Bundle C feels too heavy.
- Pairs well with P1-5 as "operator refresh polish" + the other K
  items as "infra polish".

### Non-goals

- No new surfaces. This is a tail-sweep sprint.
- No schema churn except K9 (optional).
- No brand-new tests beyond the carry-overs' own suites.

---

## Owner notes

- All three branches (050/051/052) stay off `main` until the combined
  walkthrough. If the owner can run it before 053-A kicks off,
  053-A merges straight to `main` along with the three predecessors.
- The slug-rule contract (`frontend/lib/slug.ts` ↔ backend
  `<citation_grammar>` block ↔ `backend/src/build-tune-agent/lib/
  slug.ts`) is the specific new surface worth eyeballing. A mismatch
  would silently break `#section-*` citations across every future
  session; the regression test locks the contract but a human read
  is still worth it.
- 051-A's "SystemPromptView already accepts showDiff" claim was
  slightly off — the prop landed in 052-A along with the prevBody
  path. Correction noted in 052-A's PROGRESS block.

### Decision gate

Pick one of:

1. **Bundle C primary** (C1–C5 above).
2. **Correctness carry-over bundle** (K1–K10 above).

If undecided: Bundle C. It's the load-bearing one; the K items keep
interleaving well into sprint 055+.
