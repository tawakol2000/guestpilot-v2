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

### [LOW] broadcastCritical timeout-then-retry produces duplicates under multi-tab
- **File:** `backend/src/services/socket.service.ts:154-165` + every `socket.on('message', ...)` handler in `frontend/components/inbox-v5.tsx`
- **Symptom:** `io.to(room).timeout(5000).emit(...)` waits for ACK from EVERY socket in the tenant room. One slow tab's timeout makes the helper retry-emit to the entire room — fast tabs receive the same event twice. Frontends that don't dedupe by message id render double toasts / inbox entries.
- **Why deferred:** The proper fix is multi-step and architectural: switch to per-socket targeting (`io.in(room).fetchSockets()` + per-socket emit+timeout) AND add a server-side message-id stamp + client-side seen-id Set so the frontend dedupes regardless of broadcast retry. The retry behaviour is currently load-bearing for slow networks — pulling it without per-socket targeting would regress reliability. Needs user input on whether to take the architectural change or accept the duplicate-event class.
- **Fix sketch:**
  - Server: replace `io.to(room).timeout().emit()` with iteration over fetchSockets, individual timeout-emit per socket.
  - Client: every `socket.on('message', ...)` handler maintains a `seenMessageIds: Set<string>` and short-circuits if `data.message.id` is already seen (with a TTL eviction so the set doesn't grow forever).

### [LOW] JWT_SECRET rotation breaks at-rest encrypted tokens
- **File:** `backend/src/lib/encryption.ts` + `backend/src/services/hostaway-dashboard.service.ts` (consumer)
- **Symptom:** The encryption key is derived from JWT_SECRET via PBKDF2. If JWT_SECRET is ever rotated, every existing encrypted dashboard JWT in the DB becomes undecryptable. The alteration-accept / login-assist code paths would fail silently (decrypt throws, caught and surfaced as 403/500).
- **Why deferred:** The fix is a rotation runbook + a migration helper script that decrypts with the OLD secret and re-encrypts with the NEW. Both require user input on the rotation cadence and the operational policy.
- **Fix sketch:** New script `backend/scripts/rotate-encryption-secret.ts` accepting OLD_JWT_SECRET + NEW_JWT_SECRET env vars, iterates `Tenant` rows with non-null `hostawayDashboardJwtEncrypted`, decrypts with OLD, encrypts with NEW. Document in CLAUDE.md.

### [LOW] WebhookLog table has no retention sweep
- **File:** `backend/src/controllers/webhooks.controller.ts:203-226` + a new job under `backend/src/jobs/webhookLogRetention.job.ts`
- **Symptom:** Every Hostaway webhook persists a row with the full payload to `WebhookLog`. No retention job, no size cap. High-volume tenants (hundreds of webhooks/day from reservation polling + message updates) accumulate indefinitely.
- **Why deferred:** Picking the right retention window requires user input. Defaults vary across the existing retention jobs: `BuildToolCallLog` is 30 days, `TuningSuggestion` is configurable, `AiApiLog` has its own policy. Need user to confirm: keep 30 days? 7 days? Smaller for high-volume tenants?
- **Fix sketch:** Create `backend/src/jobs/webhookLogRetention.job.ts` mirroring `buildToolCallLogRetention.job.ts`. Run daily. `prisma.webhookLog.deleteMany({ where: { createdAt: { lt: thirtyDaysAgo } } })`.

### [LOW] translateAndSend bypasses copilot edit-diagnostic capture
- **File:** `backend/src/controllers/messages.controller.ts:355-394` (translate-and-send branch) vs `:100-220` (regular send branch)
- **Symptom:** Managers who use the in-app translator to translate-and-send a reply skip the entire diagnostic-capture pipeline (pendingDraft lookup → recentAiApiLog → REJECT_TRIGGERED diagnostic emit). Their corrected outputs never feed the tuning corpus, so we lose tuning signal for multilingual managers.
- **Why deferred:** Non-trivial port — the diagnostic capture has side effects (Tuning suggestion writes, similarity scoring, critical-failure flag emission) that need careful translation from "compare manager-typed text against AI draft" to "compare translated-output against AI draft." User should confirm: (a) does the diagnostic semantics make sense when the manager's intent is in source language but the sent text is the translated output? (b) which text should the diagnostic compare against the draft — the source-lang input or the en-translated output?
- **Fix sketch:** Mirror lines 111-220's pendingDraft + recentAiApiLog + diagnostic-emit block inside the translate branch, comparing the translated output against the AI draft (treating the manager's translation as their corrected reply).

### [MEDIUM] create_tool_definition.availableStatuses silently dropped
- **File:** `backend/src/build-tune-agent/tools/create-tool-definition.ts:87` + `prisma/schema.prisma` ToolDefinition + `backend/src/services/ai.service.ts` (sacred)
- **Symptom:** Agent declares a custom tool restricted to e.g. `[CONFIRMED]` only. The Zod schema accepts it; the dryRun preview surfaces it; BuildArtifactHistory metadata captures it; but it is never persisted to the ToolDefinition row (no column) and never honoured by main-AI status gating. Manager believes the tool is restricted; main AI calls it in every status.
- **Why deferred:** The proper fix needs (a) a schema column on `ToolDefinition` (`availableStatuses Json?` — nullable to avoid backfill lock; `prisma db push` per constitution); AND (b) `ai.service.ts` updated to filter custom tools by reservation status — but `ai.service.ts` is sacred (untouchable). Need user sign-off on whether to schedule an `ai.service` edit just for this gate, or alternatively to drop the Zod param entirely (and update the agent system prompt so it stops claiming the gate exists).
- **Fix sketch:**
  - Option A: add `availableStatuses Json?` to `ToolDefinition`, persist in `create_tool_definition` and the admin apply path, run `prisma db push`. Then add a status filter in `ai.service.ts` when assembling the per-turn tool list.
  - Option B: remove `availableStatuses` from the Zod schema + tool description; drop the field from dryRun preview + history metadata; agent stops claiming the capability.

### [HIGH] Schema follow-up: partial unique index on TuningSuggestion previewId
- **File:** `backend/prisma/schema.prisma` (TuningSuggestion model) + `backend/src/build-tune-agent/tools/suggestion-action.ts:1027`
- **Symptom:** `applyArtifactChangeFromUi` race window cannot be fully closed cross-instance via app code alone. The 2026-04-22 fix added a process-level single-flight Map + create-time previewId stamp, narrowing the window dramatically — but two concurrent calls landing on different backend instances within the round-trip of one Prisma `create` can still both succeed.
- **Why deferred:** The proper fix is a partial unique index on `(tenantId, (appliedPayload->>'previewId')) WHERE appliedPayload IS NOT NULL`. Prisma 5 supports `@@unique` for plain columns but not yet first-class partial expression indexes — needs a `prisma db execute` raw SQL step. User should confirm: (a) acceptable to apply an expression index via raw SQL outside the migration system; (b) what to do when the constraint fires (currently the code would throw P2002, which we can map to `alreadyApplied:true`).
- **Fix sketch:** `CREATE UNIQUE INDEX CONCURRENTLY tuning_suggestion_preview_idempotency ON "TuningSuggestion" ("tenantId", (("appliedPayload"->>'previewId'))) WHERE "appliedPayload" IS NOT NULL;` + catch P2002 in `applyArtifactChangeFromUi` and re-run the findFirst.

---
