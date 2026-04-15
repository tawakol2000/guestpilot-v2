# Integration tests — Feature 041 sprint 05 §7

Closes concerns C3 + C21 — the evidence-bundle assembler, the
`/api/evidence-bundles/:id` endpoint, the diagnostic single-shot pipeline,
and the sprint-04 `suggestion_action(apply)` path now have automated
assertions that exercise real DB writes.

## How they're organized

Each spec runs in `node:test` against a real Prisma client pointed at
`DATABASE_URL`. There is no `pg-mem` layer: `pgvector` is required for the
existing schema (see sprint-01 report §2) and `pg-mem` doesn't carry it. We
follow the sprint brief's documented fallback: **isolate test data by writing
into a sentinel TEST tenant on the live DB, and clean the sentinel rows
between runs.** The harness creates a `TEST_<random>` tenant on setup,
populates the minimum entity graph (tenant + property + reservation +
conversation + AI message), runs the spec, then cascades-deletes the tenant
and every dependent row.

## Running locally

Requires `DATABASE_URL` and (for the diagnostic test) a stub OPENAI module.
The diagnostic spec mocks the OpenAI client at module-load time so no
network call happens — safe to run in CI.

```
cd backend
DATABASE_URL=$DATABASE_URL npx tsx --test \
  src/__tests__/integration/evidence-bundle.integration.test.ts \
  src/__tests__/integration/diagnostic.integration.test.ts \
  src/__tests__/integration/suggestion-action.integration.test.ts
```

## Running on Railway preview

```
railway run --service guestpilot-v2 --environment <preview> npx tsx --test \
  src/__tests__/integration/*.integration.test.ts
```

## NOT wired into CI yet

These specs are intentionally outside the default `tsc --noEmit + unit` CI
job. They write to a real DB; CI doesn't have a Postgres yet. Future sprint
can wire them into a CI job once a CI Postgres (Railway-managed or otherwise)
is provisioned. Tracked as a follow-up concern.
