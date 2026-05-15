# Prisma migrations — STATE: stale, do not use `prisma migrate deploy`

## TL;DR

This repo uses `prisma db push` (see [CLAUDE.md](../../../CLAUDE.md) §Build & Run).
The handful of files in this directory pre-date that decision and **do not
reflect the current schema**.

Running `prisma migrate deploy` against a fresh database will apply only the
three numbered migrations below — and silently miss the ~30 models added
since (TuningConversation, BuildToolCallLog, AutomatedReplyTemplate,
DocumentHandoffState, every Studio agent table, etc.).

## What to run, ever

| When | Command | Notes |
|---|---|---|
| Apply current schema to a DB | `npx prisma db push` | The supported path. |
| Inspect / verify schema | `npx prisma db pull` | |
| Browse DB | `npx prisma studio` | |
| Generate the Client | `npx prisma generate` | Runs at install + during `npm run build`. |

## What to **never** run

| Command | Why not |
|---|---|
| `npx prisma migrate deploy` | Will apply 3 stale migrations and leave the DB ~30 models behind reality. The `package.json` `db:migrate` script is here for historical reasons; do not rely on it. |
| `npx prisma migrate dev` | Same problem, plus will try to reset the DB. |
| `npx prisma migrate resolve` | Only useful if you intend to baseline; consult the team first. |

## Existing files

- `20240101000000_init/` — original schema at first deploy.
- `20260312000000_add_knowledge_chunks_summary_tenant_config/` — sprint 010 era.
- `20260313000000_fix_ailog_ragcontext_chunk_propertyid/` — sprint 010 fix.
- `add_audit_constraints.sql`, `add_pgvector.sql` — one-off SQL applied
  manually against prod / staging.
- `migration_lock.toml` — Prisma's lockfile; left intact so the migrations
  dir doesn't error on touch.

## Path forward (when there's a deploy window)

1. Take a clean DB snapshot of staging.
2. `npx prisma migrate dev --create-only --name baseline_$(date +%Y%m%d)` to
   produce a single migration from current schema.
3. `npx prisma migrate resolve --applied <new-baseline>` on staging + prod
   so they know the baseline is already applied.
4. Verify with `prisma migrate status`.
5. Switch the `db:migrate` script to the canonical path and update CLAUDE.md.

Until that's done, treat this directory as a museum.
