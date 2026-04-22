# Deferred Bugs — 2026-04-22 → 2026-04-23

> Bugs found during the autonomous run that need user input before
> fixing safely (schema change, scope decision, behaviour ambiguity, or
> external dependency).

## Format

```
### [Severity] Title
**File:line(s):** path
**Symptom:** what goes wrong
**Why deferred:** specific question for the user
**Fix sketch:** what I'd do once unblocked
```

## Items

### [HIGH] Schema follow-up: partial unique index on TuningSuggestion previewId
- **File:** `backend/prisma/schema.prisma` (TuningSuggestion model) + `backend/src/build-tune-agent/tools/suggestion-action.ts:1027`
- **Symptom:** `applyArtifactChangeFromUi` race window cannot be fully closed cross-instance via app code alone. The 2026-04-22 fix added a process-level single-flight Map + create-time previewId stamp, narrowing the window dramatically — but two concurrent calls landing on different backend instances within the round-trip of one Prisma `create` can still both succeed.
- **Why deferred:** The proper fix is a partial unique index on `(tenantId, (appliedPayload->>'previewId')) WHERE appliedPayload IS NOT NULL`. Prisma 5 supports `@@unique` for plain columns but not yet first-class partial expression indexes — needs a `prisma db execute` raw SQL step. User should confirm: (a) acceptable to apply an expression index via raw SQL outside the migration system; (b) what to do when the constraint fires (currently the code would throw P2002, which we can map to `alreadyApplied:true`).
- **Fix sketch:** `CREATE UNIQUE INDEX CONCURRENTLY tuning_suggestion_preview_idempotency ON "TuningSuggestion" ("tenantId", (("appliedPayload"->>'previewId'))) WHERE "appliedPayload" IS NOT NULL;` + catch P2002 in `applyArtifactChangeFromUi` and re-run the findFirst.

---
