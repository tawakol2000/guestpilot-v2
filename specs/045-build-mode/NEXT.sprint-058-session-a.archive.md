# Sprint 058 — Session A — archive

Archived 2026-04-22 at sprint close. For the full contract, see `sprint-058-session-a.md`. For per-gate status, commits, and verdicts, see `PROGRESS.md` → "Sprint 058 — consolidated close-out".

## One-paragraph recap

Opus 4.7 / 1M-context overnight run. Three parallel streams dispatched in one message via worktree isolation: Stream A backend (F1 + F4 + F8 + F9d-backend), Stream B frontend-heavy (F2 + F3 + F4 + F5 + F6 + F7 + F8-frontend + F9d-frontend), Stream C 057-A regression sweep (F9a through F9f). Stream A shipped 4/4. Stream B stopped cleanly at 3/8 per overnight-run discipline; re-dispatched as B2 which hit a mid-stream infra API error after committing the F3/F6 backend endpoints and creating the 845-line `versions-tab.tsx` scaffold. B3 picked up from the committed WIP and shipped the remaining 4 frontend wiring gates plus mount wiring for F4/F5. Stream C shipped 5/5. All nine sprint gates landed; two operator-owned items deferred (F1 runtime transport swap, F9a root cause).

## Final numbers

- **Frontend:** 260 → 347 tests (+87), 30 → 45 test files (+15)
- **Backend:** ~408 → 423 tests (+15), one pre-existing env-var failure carried through unchanged
- **Backend typecheck:** clean
- **Commits on `feat/058-session-a`:** 21 (17 feat/fix/chore + 4 docs close-outs from streams A/C/B3 + consolidated)
- **Screenshot regressions:** 5 of 6 fully fixed; 1 (React #310) shipped with a safety-net error boundary, root cause deferred
- **F1 cache fraction verification:** deferred to operator per spec §6 MCP-risk ship strategy

## Operator-owned deferrals

1. F1 runtime transport swap (`runtime-direct.ts` header tracks the remaining work items).
2. F9a React #310 root-cause pass — error boundary ships; staging repro needed.
3. F6 write-ledger tag chip — trivial add when ledger is next touched.

## Lessons for sprint-059

- **Worktree isolation created off-stale-HEAD twice** — both Stream A and the first Stream B2 dispatch landed in worktrees branched from an ancient commit (`cd4aa8a`), not from the current `feat/058-session-a` tip. Stream A reset manually and proceeded; B2 stopped per discipline. Mitigation going forward: either (a) explicitly reset worktree HEAD to the target branch in the dispatch prompt as Stream A did, OR (b) skip worktree isolation when only one stream is running (as B3 did successfully).
- **Stream B's "stop at 3/8" was the right call under discipline** — followed spec §4.1 literally. Cost one extra dispatch round. Benefit: no silent-bleed through compound UI gates that would have been hard to untangle.
- **Backend test framework claim was subtly wrong** — spec §2.2 referenced "2 pre-existing backend failures" assuming a formal test framework; actual state is `node:test + tsx` with one env-var-dependent failure (`tenant-config-bypass.test.ts`). Stream A's decision to just use the existing pattern was correct.
- **F2/F6 schema changes applied cleanly via `prisma db push`** — no migration risk realized.
