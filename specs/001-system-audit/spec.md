# Feature Specification: Full System Audit

**Feature Branch**: `001-system-audit`
**Created**: 2026-03-19
**Status**: Draft
**Input**: User description: "Full system audit — identify security holes, technical debt, race conditions, and bugs across the entire GuestPilot platform"

## Clarifications

### Session 2026-03-19

- Q: Should Cohere provider switching (US5/FR-010) stay in this audit or be deferred to the AI-flow feature? → A: Keep in this audit — Cohere fixes stay in scope.
- Q: Should webhook auth strictly reject unauthenticated requests or use a grace period? → A: Grace period — warn-and-process if tenant hasn't configured auth, reject only on wrong credentials.
- Q: How should JWT token expiry be changed? → A: Reduce to 30 days, no refresh token system. Minimal disruption, 3x improvement over current 90-day expiry.
- Q: When JSON parsing fails, should the guest receive a fallback message? → A: Escalation to manager only — no fallback guest message sent (avoid sending potentially wrong content).
- Q: How should existing duplicate data be cleaned before applying new unique constraints? → A: Automated cleanup SQL in migration script — keep newer records, delete/deactivate older duplicates, log what was cleaned.

## User Scenarios & Testing

### User Story 1 - Fix Critical Security Vulnerabilities (Priority: P0)

A property manager relies on GuestPilot to handle sensitive guest data
(door codes, WiFi passwords, booking details) and process webhook events
from Hostaway. Critical security gaps MUST be closed to prevent
unauthorized access, data leakage, and message injection.

**Why this priority**: Unauthenticated webhook endpoints and weak JWT
defaults allow any attacker to inject fake messages into any tenant's
conversations, potentially sending malicious content to real guests.

**Independent Test**: After fixes, verify that (a) unauthenticated webhook
calls are rejected, (b) server refuses to start without a proper JWT
secret, (c) access credentials are not present in application logs.

**Acceptance Scenarios**:

1. **Given** a webhook request with wrong credentials, **When** it hits
   `POST /webhooks/hostaway/:tenantId`, **Then** the server rejects it
   with 401. If no credentials are provided and the tenant has auth
   configured, log a warning but still process (grace period).
2. **Given** `JWT_SECRET` is not set in environment, **When** the server
   starts, **Then** it exits with a clear error message instead of using
   a fallback default.
3. **Given** a confirmed guest conversation, **When** the AI generates a
   reply, **Then** door codes and WiFi passwords do NOT appear in any
   log output.
4. **Given** an AI response containing a `resolveTaskId`, **When** the
   system processes the escalation, **Then** the task's `tenantId` is
   verified to match the current tenant before any update.
5. **Given** a request to the API, **When** the response is sent,
   **Then** security headers (X-Frame-Options, X-Content-Type-Options,
   Strict-Transport-Security) are present.

---

### User Story 2 - Eliminate Race Conditions & Double-Fire Bugs (Priority: P0)

The debounce and AI reply pipeline has multiple race conditions that can
cause duplicate messages sent to guests — the most visible and damaging
class of bug in a guest communication platform.

**Why this priority**: Duplicate AI messages confuse guests, erode trust
in the automation, and force managers to intervene manually. The race
conditions are in critical-path code.

**Independent Test**: After fixes, simulate concurrent webhook arrivals
for the same conversation and verify only one AI reply is generated.

**Acceptance Scenarios**:

1. **Given** two webhook events arrive simultaneously for the same
   conversation, **When** both attempt to create PendingAiReply records,
   **Then** only one PendingAiReply exists (enforced at database level).
2. **Given** the poll job and BullMQ worker both attempt to process the
   same PendingAiReply, **When** one claims it, **Then** the other
   detects the claim and skips.
3. **Given** two identical `hostawayMessageId` values arrive
   simultaneously, **When** both attempt to insert, **Then** only one
   message is stored (enforced via database unique constraint).
4. **Given** the classifier is being reinitialized by the judge,
   **When** a concurrent classification request arrives, **Then** it
   either waits for reinitialization or uses the previous stable state
   — never a partially-updated state.

---

### User Story 3 - Plug Resource Leaks & Unbounded Growth (Priority: P1)

Multiple in-memory caches and connection registries grow without bounds,
causing gradual memory exhaustion on long-running servers.

**Why this priority**: Memory leaks don't crash immediately but degrade
performance over days/weeks, eventually causing OOM kills with no
obvious cause.

**Independent Test**: After fixes, run a load simulation for 24 hours
and verify that memory usage stabilizes rather than growing linearly.

**Acceptance Scenarios**:

1. **Given** an SSE client disconnects, **When** cleanup runs, **Then**
   the client is removed from the registry AND the tenant's entry is
   deleted from the Map if empty.
2. **Given** a Redis subscriber fails to connect, **When** the error is
   caught, **Then** both publisher AND subscriber connections are cleaned
   up properly.
3. **Given** topic state entries older than 30 minutes exist, **When**
   periodic cleanup runs (every 5 minutes), **Then** expired entries are
   removed automatically — not only when stats are queried.
4. **Given** the judge's per-tenant threshold/rate-limit caches, **When**
   entries expire, **Then** they are evicted — the Maps do not grow
   indefinitely with stale tenant IDs.

---

### User Story 4 - Harden Error Handling & Silent Failures (Priority: P1)

Several failure modes in the AI pipeline result in silent drops — a guest
sends a message, sees "AI is typing", but never receives a reply and no
escalation is created.

**Why this priority**: Silent failures are worse than visible errors.
A guest left waiting with no response and no human notified is the
worst outcome for the platform.

**Independent Test**: After fixes, trigger each failure mode and verify
either a fallback response or a manager escalation is created.

**Acceptance Scenarios**:

1. **Given** the Claude API returns a response that fails JSON parsing,
   **When** the pipeline catches the error, **Then** an immediate
   escalation is created and the manager is notified. No fallback
   message is sent to the guest (avoid sending potentially wrong
   content).
2. **Given** the Hostaway API is temporarily unreachable, **When** a
   message send fails, **Then** the system retries with exponential
   backoff (up to 3 attempts) before creating an escalation.
3. **Given** the SSE `res.write()` fails for a client, **When** the
   error is caught, **Then** it is logged (not swallowed silently) and
   the dead client is removed.
4. **Given** the Hostaway API call succeeds but the subsequent DB write
   crashes, **When** the system recovers, **Then** it does not re-send
   the same message (save to DB first, send second).

---

### User Story 5 - Resolve Data Integrity & Schema Gaps (Priority: P1)

Missing database constraints and schema gaps allow data corruption that
compounds over time — duplicate messages, duplicate training examples,
and missing vector columns for the Cohere embedding provider.

**Why this priority**: Data corruption in training examples degrades
classifier accuracy. Missing vector columns make provider switching
(OpenAI to Cohere) non-functional despite the UI toggle existing.

**Independent Test**: After fixes, switch embedding provider via the
settings UI and verify that classification and RAG retrieval work
correctly with both providers.

**Acceptance Scenarios**:

1. **Given** the Cohere embedding provider is selected, **When** a
   property knowledge chunk is embedded, **Then** the 1024-dimension
   vector is stored in the correct column and retrieval queries work.
2. **Given** the classifier store receives a duplicate `(tenantId, text)`
   pair, **When** `addExample()` is called, **Then** it upserts instead
   of creating a duplicate.
3. **Given** the Message model, **When** the schema is applied, **Then**
   a composite unique constraint on `(conversationId, hostawayMessageId)`
   prevents duplicate message inserts at the database level.
4. **Given** embeddings of dimension 1024 (Cohere), **When** cosine
   similarity is computed against stored vectors, **Then** the dimension
   matches the vector column used.

---

### User Story 6 - Add Rate Limiting & Auth Hardening (Priority: P2)

Auth endpoints lack rate limiting, JWT tokens have excessive lifetimes,
and no account lockout exists — leaving the system vulnerable to brute
force attacks.

**Why this priority**: Important for production hardening but
lower-impact than data-loss and guest-facing bugs since the platform
currently has a small, known user base.

**Independent Test**: After fixes, attempt rapid login with wrong
credentials and verify throttling kicks in.

**Acceptance Scenarios**:

1. **Given** more than 5 failed login attempts from the same IP within
   1 minute, **When** the 6th attempt arrives, **Then** it is rejected
   with 429 Too Many Requests.
2. **Given** more than 3 signup attempts from the same IP within
   1 minute, **When** the 4th attempt arrives, **Then** it is rejected
   with 429.
3. **Given** the JWT token configuration, **When** tokens are issued,
   **Then** access tokens expire after 30 days (reduced from 90 days).
   No refresh token mechanism in this audit.

---

### User Story 7 - Improve Observability & Configuration (Priority: P3)

Hardcoded values (model pricing, poll intervals), missing structured
logging, and stale-config issues in multi-instance deployments reduce
operational visibility and agility.

**Why this priority**: Quality-of-life improvements for operators.
Not blocking guest experience but important for long-term
maintainability.

**Independent Test**: After fixes, update tenant AI config via the
dashboard and verify the change takes effect within 60 seconds across
all server instances.

**Acceptance Scenarios**:

1. **Given** model pricing changes, **When** an operator updates the
   pricing config, **Then** cost calculations reflect the new prices
   without a code deployment.
2. **Given** a multi-instance deployment, **When** tenant config is
   updated on one instance, **Then** all instances reflect the change
   within 60 seconds.
3. **Given** the escalation enrichment service, **When** matching guest
   messages against trigger patterns, **Then** word-boundary matching
   is used to reduce false positives.

---

### Edge Cases

- What happens when a guest sends an image-only message (no text) and
  the AI fails to process the image? System MUST escalate rather than
  silently drop.
- What happens during a DST transition for tenants using working hours?
  The debounce scheduler MUST handle the time shift correctly.
- What happens when the classifier has 0 training examples (fresh
  tenant)? The system MUST fall through to Tier 2 or escalate — never
  crash.
- What happens when Redis dies mid-job? BullMQ workers MUST not corrupt
  PendingAiReply state.

## Requirements

### Functional Requirements

- **FR-001**: The webhook endpoint MUST authenticate incoming requests
  using Hostaway Basic Auth (per-tenant `webhookSecret`). On credential
  mismatch, reject with 401. On missing credentials with configured
  secret, log warning and process (grace period for migration).
- **FR-002**: The server MUST refuse to start if `JWT_SECRET` is not
  explicitly set in the environment.
- **FR-003**: Access credentials (door codes, WiFi passwords) MUST NOT
  appear in any application log output.
- **FR-004**: Task update/resolve operations MUST verify `tenantId`
  ownership before modifying records.
- **FR-005**: The Message model MUST have a database-level unique
  constraint on `(conversationId, hostawayMessageId)` to prevent
  duplicate inserts.
- **FR-006**: PendingAiReply creation/update MUST use atomic operations
  (upsert or unique constraint) to prevent multiple pending replies per
  conversation.
- **FR-007**: Classifier reinitialization MUST use a mutex/lock to
  prevent concurrent updates to the shared example and embedding arrays.
- **FR-008**: The AI pipeline MUST create an escalation when JSON
  parsing of the Claude response fails. No fallback message is sent to
  the guest — the manager handles follow-up manually.
- **FR-009**: Message delivery MUST follow a write-ahead pattern: save
  to local DB first, then send via Hostaway API, to prevent duplicate
  sends on crash recovery.
- **FR-010**: The `embedding_cohere vector(1024)` column MUST be added
  to PropertyKnowledgeChunk to support Cohere provider switching.
- **FR-011**: SSE client disconnect cleanup MUST remove the client from
  the registry and delete empty tenant entries from the Map.
- **FR-012**: Redis subscriber failures MUST clean up both publisher
  and subscriber connections.
- **FR-013**: Topic state cache MUST run periodic cleanup (every 5
  minutes) to evict expired entries.
- **FR-014**: Auth endpoints (`/auth/login`, `/auth/signup`) MUST be
  rate-limited (5 login attempts/min, 3 signups/min per IP).
- **FR-015**: HTTP responses MUST include security headers
  (X-Frame-Options, X-Content-Type-Options, HSTS, CSP).
- **FR-016**: Escalation title, note, and urgency fields from AI output
  MUST be validated (urgency against allowed enum values, title/note
  length-limited and sanitized).
- **FR-017**: Classifier example deduplication MUST prevent identical
  `(tenantId, text)` pairs from being inserted.
- **FR-018**: Hostaway API calls MUST implement retry with exponential
  backoff for transient errors (408, 429, 503).
- **FR-019**: Database migrations adding unique constraints MUST include
  automated cleanup SQL that removes existing duplicates (keep newest,
  delete/deactivate older) and logs what was cleaned for audit trail.

### Key Entities

- **PendingAiReply**: Add unique constraint on `conversationId` (only
  one pending reply per conversation at a time).
- **Message**: Add unique constraint on `(conversationId,
  hostawayMessageId)` with handling for empty-string default.
- **PropertyKnowledgeChunk**: Add `embedding_cohere vector(1024)` column
  with appropriate index.
- **ClassifierExample**: Add unique constraint on `(tenantId, text)` or
  implement application-level deduplication.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Zero duplicate AI messages sent to guests under concurrent
  webhook load (verified by load test: 50 concurrent webhooks for the
  same conversation).
- **SC-002**: Unauthenticated webhook requests are rejected 100% of the
  time.
- **SC-003**: Server memory usage stabilizes within 10% of baseline
  after 24 hours of continuous operation (no unbounded growth).
- **SC-004**: When JSON parsing fails, 100% of affected conversations
  receive either a fallback response or a manager escalation within
  60 seconds.
- **SC-005**: Embedding provider switching (OpenAI to Cohere) completes
  successfully without query errors (verified by switching and running
  10 test classifications + 10 RAG retrievals).
- **SC-006**: Tenant config changes take effect within 60 seconds across
  all server instances.
- **SC-007**: Login brute-force attempts are throttled after 5 failures
  per minute per IP.
- **SC-008**: No access credentials (door codes, WiFi) appear in any
  log output.

## Assumptions

- Hostaway uses HTTP Basic Auth for webhook authentication (confirmed
  via research). The existing per-tenant `webhookSecret` field serves
  as the password. Tenants must configure credentials in their Hostaway
  dashboard for full enforcement.
- The deployment supports multiple instances sharing a Redis cache for
  config invalidation.
- The current bcrypt cost factor of 12 is acceptable; increasing to 13+
  is a future enhancement, not a blocker.
- React's default JSX escaping provides adequate XSS protection for
  standard text content rendering; a dedicated sanitization library
  would only be needed for raw HTML injection scenarios.
- The existing `DRY_RUN` mechanism can be leveraged for testing
  concurrent webhook handling without affecting real guest conversations.
