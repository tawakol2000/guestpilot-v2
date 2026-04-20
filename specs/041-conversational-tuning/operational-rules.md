# Conversational Tuning Agent — Operational Rules

> **Read this before making any changes.** These rules are non-negotiable and apply to every sprint in feature 041.

## Branch

- All V1 work lives on branch `feat/041-conversational-tuning`.
- Do NOT create new branches per sprint. All sprint commits go onto the same branch.
- Do NOT merge to `main` until V1 is fully done and explicitly approved.

## Database coexistence (most important rule)

The `main` branch is running live on Railway and shares the same Postgres database as the `feat/041-conversational-tuning` branch. Schema changes MUST be safe for both code bases to run against the same DB simultaneously.

### Schema change rules

1. **Additive only.** New tables, new columns, new indexes, new enum values. No renames. No drops. No type changes. No default changes that break old writes.
2. **New columns on existing tables MUST be nullable with a sensible default** (or have a runtime-computable default so old code's inserts don't fail Prisma validation).
3. **No `NOT NULL` constraints added to existing columns** that old code might not populate.
4. **No indexes with blocking migrations on large tables.** Use `CREATE INDEX CONCURRENTLY` patterns when possible.
5. **Enum additions are additive** — new enum values are safe for the new branch to produce. The old branch will never produce them. Be aware: if old-branch code ever *reads* a row written by the new branch containing a new enum value, Prisma will throw. Solution: old branch should never read rows filtered for the new values. Keep new-branch data in new tables or clearly segregated rows.
6. **Old `TuningSuggestion` records from the current live analyzer must keep working unchanged.** The new branch extends this table with nullable columns (`applyMode`, `conversationId`, `confidence`, `appliedAndRetained7d`, `editEmbedding`). Old records will have NULL for all these; that's fine and expected.
7. **Migrations use `npx prisma db push`** per existing project constitution. Do NOT generate named migration files for V1; the project has been using `db push`.

### Code isolation rules

8. **New-branch code must not break old-branch code at runtime.** The two codebases run side-by-side on the shared DB. If new-branch code writes a row that old-branch code then queries, the old-branch Prisma client must be able to deserialize it. This is why all extensions to existing tables are nullable.
9. **New features live in NEW tables** whenever possible — the old branch never queries them, so we have full freedom there.
10. **Tear-out of old code (the existing `tuning-review-v5.tsx`, the existing two-step analyzer in `tuning-analyzer.service.ts`) happens ONLY ON THE NEW BRANCH.** The old branch keeps these files intact and running. Do not delete migration files, data rows, or anything shared.

### Railway preview deploys

11. **It is OK to deploy `feat/041-conversational-tuning` to a Railway preview environment for testing.** Your fallback plan is revert-the-code, not revert-the-database, so the DB-safety rules above MUST hold at every commit that might get deployed.
12. Assume the Railway preview shares the same DATABASE_URL as live production. Plan accordingly.

## Per-sprint workflow

Each sprint has three possible artifacts:

1. **(Optional) Discovery prompt** — a read-only briefing that asks Claude Code to explore specific areas of the codebase and report back findings. Output gets pasted back to the planning chat, not acted on directly. Use when the sprint's acceptance criteria depend on facts we don't already know.
2. **Sprint prompt (`sprint-NN-<name>.md`)** — a self-contained brief. States the goal, references the spec docs, lists files to read first, gives exact acceptance criteria, specifies what to report back. The Claude Code session has zero context beyond what this file points at.
3. **Sprint report (`sprint-NN-<name>-report.md`)** — the session writes its own report at the end: what was built, what deviated from the plan, what's broken, what's deferred, recommended next actions.

### Fresh-session rule

Every sprint runs in a fresh Claude Code session with no memory of prior sprints, no knowledge of the planning chat, and no assumptions not written into the sprint prompt or the spec docs. The sprint prompt must be written as if briefing a capable stranger.

### What every sprint prompt must include

- **Read-first list:** the four spec docs (`vision.md`, `roadmap.md`, `deferred.md`, `glossary.md`) + this `operational-rules.md` + specific codebase files relevant to the sprint
- **Goal statement:** one paragraph
- **Non-goals:** explicit list of what not to do
- **Acceptance criteria:** checkable list
- **Database changes:** explicit list with the rule audit (additive, nullable, etc.)
- **What to report back:** structured report format

## When to ask

Sprint sessions should ask via AskUserQuestion (or stop and report) when:
- A decision isn't in the spec docs and would lock in architecture
- A file contradicts the spec docs (investigate, don't guess)
- The database-safety rules would be violated by the obvious implementation
- Acceptance criteria cannot be met without scope expansion

Sprint sessions should NOT ask when:
- The decision is clearly specified in the spec docs (just implement)
- The question is stylistic or cosmetic (just pick something reasonable)

## Commits

- Commit frequently within a sprint (per logical unit of work).
- Commit messages follow the existing project convention (imperative, short subject, co-author line).
- Do NOT squash at the end of a sprint. Keep the sprint's history intact.
- Do NOT push unless explicitly asked. The planning chat will request pushes at sprint boundaries.
