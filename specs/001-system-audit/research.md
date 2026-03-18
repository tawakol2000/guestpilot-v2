# Research: Full System Audit

**Date**: 2026-03-19
**Feature**: 001-system-audit

## R1: Hostaway Webhook Authentication

**Decision**: Use HTTP Basic Auth verification with per-tenant
`webhookSecret` as the password.

**Rationale**: Hostaway does not support HMAC signature verification.
Their webhook system supports optional Basic Auth credentials
(username + password) configured in the Hostaway dashboard. The
codebase already generates a 64-char hex `webhookSecret` per tenant
during signup (`auth.controller.ts` line 45) and stores it on the
Tenant model (`schema.prisma` line 16).

**Implementation**:
- Parse `Authorization: Basic <base64>` header from incoming webhooks
- Decode and extract password, compare against `tenant.webhookSecret`
- Graceful rollout: if no header present and tenant has a webhook
  secret, log a warning but still process (grace period for migration)
- If header present but secret mismatches, reject with 401

**Alternatives considered**:
- HMAC signature: Not supported by Hostaway
- IP allowlisting: Hostaway does not publish static IP ranges
- API key in query param: Less secure than Basic Auth header

---

## R2: Classifier Reinitialization Concurrency

**Decision**: Use the atomic swap / double-buffer pattern (no external
dependency).

**Rationale**: Node.js is single-threaded, so variable assignment is
atomic. The bug occurs because `_examples` and `_exampleEmbeddings` are
updated as two separate assignments with an `await` between them. Bundle
both into a single `ClassifierState` object and swap the reference in
one assignment after all async work completes.

**Pattern**:
```
interface ClassifierState { examples, embeddings }
let _state: ClassifierState | null = null;

// Reader: const state = _state; (snapshot — safe during swap)
// Writer: build new state fully, then _state = newState; (atomic)
```

**Deduplication**: Add `_reinitPromise` guard to coalesce concurrent
reinitialize calls.

**Alternatives considered**:
- `async-mutex` (npm): Well-maintained but penalizes the read path;
  all `classifyMessage()` calls would serialize through the lock
- `async-rwlock`: Right concept but unmaintained; unnecessary dependency
  for what's achievable in 10 lines

---

## R3: Rate Limiting & Security Headers

**Decision**: Use `express-rate-limit` v8.3.x + `rate-limit-redis`
v4.3.x for rate limiting, `helmet` v8.1.x for security headers.

**Rationale**: `express-rate-limit` is the standard Express middleware
(8.6M weekly downloads), native TypeScript, and supports per-route
application. `rate-limit-redis` provides cross-instance counters for
multi-instance Railway deployments. `helmet` sets 14 security headers
and is recommended in the official Express security guide.

**Packages**:
- `express-rate-limit@^8.3.1` — per-route rate limiting
- `rate-limit-redis@^4.3.1` — Redis-backed store (optional, graceful
  fallback to in-memory)
- `helmet@^8.1.0` — security headers

**Key configuration**:
- `app.set('trust proxy', 1)` required for Railway (reverse proxy)
- Helmet CSP disabled (API-only, no HTML served)
- Redis store optional: if `REDIS_URL` missing, falls back to in-memory
- `skipSuccessfulRequests: true` on login limiter (only count failures)
- `passOnStoreError: true` (if Redis dies, allow traffic through)

**Alternatives considered**:
- `rate-limiter-flexible`: More powerful but not Express middleware;
  requires custom wrapper code. Better for complex per-user tiered
  limits but overkill for simple per-IP auth limits

---

## R4: Write-Ahead Pattern for Message Delivery

**Decision**: Reverse the send order — save to DB first, then send via
Hostaway API.

**Rationale**: Current code sends via Hostaway first, then saves to DB.
If the server crashes after the Hostaway send but before the DB write,
the message is sent but not recorded. On recovery, the debounce job
retries and sends the same message again (duplicate).

**Pattern**:
1. Save AI message to local DB with a `delivered: false` flag
   (or `hostawayMessageId: ''` as the existing default)
2. Send via Hostaway API
3. Update local record with `hostawayMessageId` from Hostaway response
4. If step 2 fails, the message exists in DB but was never sent —
   can be retried or escalated. No duplicate.

**Risk**: If step 2 succeeds but step 3 fails, the local record
exists without a `hostawayMessageId`. This is acceptable — the message
was sent, and the DB record can be reconciled later. The critical
property (no duplicate sends) is preserved.

---

## R5: PendingAiReply Atomicity

**Decision**: Use Prisma `upsert` with a unique constraint on
`conversationId` + `fired: false` equivalent.

**Rationale**: The current check-then-create/update pattern has a race
window between `findFirst()` and `update()/create()`. A unique
constraint on `conversationId` (with the existing `fired` field as a
partial index condition) prevents duplicate pending replies at the DB
level. Combined with `upsert`, concurrent webhook calls for the same
conversation are serialized by the database.

**Approach**: Since Prisma doesn't support partial unique indexes
natively, add a `@@unique([conversationId])` constraint to
PendingAiReply. Before creating a new pending reply, delete any
existing `fired: true` records for the conversation, or use a cleanup
job. The constraint ensures only one record per conversation at a time.

**Alternative**: Use `updateMany` with a `where: { conversationId,
fired: false }` condition and check `count > 0` to detect races. This
is the pattern already used in `aiReply.worker.ts` (line 76) and works
well for the claim step.
