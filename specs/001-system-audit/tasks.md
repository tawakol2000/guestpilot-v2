# Tasks: Full System Audit

**Input**: Design documents from `/specs/001-system-audit/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: No test framework in project. Verification via quickstart.md.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Install new dependencies and configure Express for production

- [x] T001 Install `helmet@^8.1.0`, `express-rate-limit@^8.3.1`, `rate-limit-redis@^4.3.1` in `backend/package.json`
- [x] T002 Add `app.set('trust proxy', 1)` near top of `createApp()` in `backend/src/app.ts`

---

## Phase 2: Foundational (Schema Migrations)

**Purpose**: Database constraint changes that MUST be complete before service-level fixes. All user stories depend on these.

- [x] T003 Write automated duplicate cleanup SQL for PendingAiReply (keep newest unfired per conversationId, delete older) and execute — log results to console
- [x] T004 Write automated duplicate cleanup SQL for Message (keep newest per conversationId + hostawayMessageId where hostawayMessageId != '', delete older) and execute — log results to console
- [x] T005 Write automated duplicate cleanup SQL for ClassifierExample (keep newest per tenantId + text where active=true, deactivate older) and execute — log results to console
- [x] T006 Update `backend/prisma/schema.prisma`: change PendingAiReply `@@index([conversationId])` to `@@unique([conversationId])`, keeping `@@index([fired, scheduledAt])`
- [x] T007 Create raw SQL migration `backend/prisma/migrations/add_audit_constraints.sql`: add partial unique index `Message_conv_hostaway_msg_unique` on `("conversationId", "hostawayMessageId") WHERE "hostawayMessageId" != ''`
- [x] T008 Add to the same migration file: `ALTER TABLE "PropertyKnowledgeChunk" ADD COLUMN "embedding_cohere" vector(1024)` plus HNSW index `PropertyKnowledgeChunk_cohere_hnsw`
- [x] T009 Update `backend/prisma/schema.prisma`: add `@@unique([tenantId, text])` to ClassifierExample model
- [x] T010 Apply schema changes with `npx prisma db push` and run raw SQL migration, verify all constraints applied

**Checkpoint**: Database constraints in place — service-level fixes can now begin

---

## Phase 3: User Story 1 — Fix Critical Security Vulnerabilities (Priority: P0)

**Goal**: Close webhook auth, JWT secret, credential logging, tenant isolation, and security header gaps.

**Independent Test**: Verify webhook auth rejects wrong creds, server refuses to start without JWT_SECRET, no credentials in logs, security headers present on all responses.

### Implementation for User Story 1

- [x] T011 [P] [US1] Create `backend/src/middleware/webhook-auth.ts`: parse Basic Auth header, compare password against `tenant.webhookSecret`, reject 401 on mismatch, log warning on missing credentials with grace period per contracts/middleware.md
- [x] T012 [P] [US1] Add `helmet` middleware to `backend/src/app.ts` with CSP and COEP disabled per contracts/middleware.md (FR-015)
- [x] T013 [P] [US1] Remove `|| 'changeme'` fallback from `backend/src/middleware/auth.ts` line 5 — add startup validation in `backend/src/app.ts` that exits with clear error if `JWT_SECRET` env var is missing (FR-002)
- [x] T014 [P] [US1] Remove duplicate `|| 'changeme'` fallback in `backend/src/app.ts` SSE token verification (~line 199) — import JWT_SECRET from auth.ts instead (FR-002)
- [x] T015 [US1] Wire webhook auth middleware into `backend/src/routes/webhooks.ts` before the controller handler (FR-001)
- [x] T016 [US1] Remove the disabled-auth TODO block in `backend/src/controllers/webhooks.controller.ts` lines 96-100 — auth is now handled by middleware (FR-001)
- [x] T017 [US1] Scrub `[CLAUDE-RAW]` log in `backend/src/services/ai.service.ts` (~line 161): either remove entirely or redact system prompt / user content containing credentials (FR-003)
- [x] T018 [US1] Add tenantId verification in `backend/src/services/ai.service.ts` `handleEscalation()` (~line 1005-1018): before `prisma.task.update()` for resolveTaskId/updateTaskId, verify `task.tenantId === tenantId` (FR-004)
- [x] T019 [US1] Add validation of AI output escalation fields in `backend/src/services/ai.service.ts` (~line 1477-1503): validate `urgency` is one of `['immediate', 'scheduled', 'info_request']`, cap title to 200 chars, cap note to 2000 chars (FR-016)

**Checkpoint**: All critical security vulnerabilities closed. Webhook auth, JWT enforcement, log scrubbing, tenant isolation, security headers all active.

---

## Phase 4: User Story 2 — Eliminate Race Conditions & Double-Fire Bugs (Priority: P0)

**Goal**: Prevent duplicate AI messages via atomic DB operations and classifier state safety.

**Independent Test**: Send 50 concurrent webhooks for the same conversation — verify exactly one AI reply generated.

### Implementation for User Story 2

- [x] T020 [US2] Refactor `scheduleAiReply()` in `backend/src/services/debounce.service.ts` (~lines 122-138): replace `findFirst` + `create/update` with Prisma `upsert` on the new unique `conversationId` constraint. Delete `fired: true` records for the conversation before upserting (FR-006)
- [x] T021 [US2] Update `backend/src/controllers/webhooks.controller.ts` message insert (~lines 370-382): wrap in try/catch for unique constraint violation on `Message_conv_hostaway_msg_unique` — if duplicate, log and skip instead of crashing (FR-005)
- [x] T022 [US2] Refactor `backend/src/services/classifier.service.ts`: bundle `_examples` + `_exampleEmbeddings` into a single `ClassifierState` interface/object. Update `classifyMessage()` to capture `const state = _state` snapshot at entry and use `state.examples` / `state.embeddings` throughout. Update `reinitializeClassifier()` to build complete new state object, then swap `_state = newState` in one assignment (FR-007, per research.md R2)
- [x] T023 [US2] Add `_reinitPromise` deduplication guard to `reinitializeClassifier()` in `backend/src/services/classifier.service.ts`: if reinit already in progress, return existing promise instead of starting a second (FR-007)
- [x] T024 [US2] Update `backend/src/services/queue.service.ts` `addAiReplyJob()` (~lines 44-60): use BullMQ `jobId` option with `conversationId` as key (already done) and add `removeOnComplete: true` to prevent stale job accumulation

**Checkpoint**: No duplicate AI messages under concurrent load. Classifier state always consistent.

---

## Phase 5: User Story 3 — Plug Resource Leaks & Unbounded Growth (Priority: P1)

**Goal**: Ensure all in-memory caches and connection registries are bounded and cleaned up.

**Independent Test**: Monitor memory usage over 24h under load — should stabilize, not grow linearly.

### Implementation for User Story 3

- [x] T025 [P] [US3] Fix SSE client registry in `backend/src/services/sse.service.ts`: in the `res.on('close')` handler (~line 83), after deleting the client from the Set, check `if (clients.get(tenantId)?.size === 0) clients.delete(tenantId)` (FR-011)
- [x] T026 [P] [US3] Fix SSE Redis subscriber cleanup in `backend/src/services/sse.service.ts` `initRedis()` (~line 28-62): when `psubscribe` fails, also null and disconnect `subscriber` (not just `publisher`). Add `process.on('beforeExit')` hook to disconnect both connections (FR-012)
- [x] T027 [P] [US3] Add periodic cleanup to `backend/src/services/topic-state.service.ts`: add `setInterval(() => { cleanupExpired() }, 5 * 60 * 1000)` that iterates `_cache` and deletes entries where `now - updatedAt > decayMs`. Export a `stopTopicStateCleanup()` for graceful shutdown (FR-013)
- [x] T028 [P] [US3] Add periodic cleanup to `backend/src/services/judge.service.ts`: add `setInterval` (every 5 min) that iterates `_thresholdCache` and `_fixCounts` Maps and deletes entries where `now > expiresAt` / `now > resetAt`
- [x] T029 [US3] Add SSE write error logging in `backend/src/services/sse.service.ts` `deliverToLocalClients()` and `broadcastInMemory()` (~lines 66-73, 110-113): change empty `catch {}` to `catch (err) { console.warn('[SSE] Write failed, removing client:', err.message); tenantClients.delete(res); }`

**Checkpoint**: All in-memory caches bounded. SSE connections properly cleaned up. No more silent error swallowing.

---

## Phase 6: User Story 4 — Harden Error Handling & Silent Failures (Priority: P1)

**Goal**: Ensure no guest message goes unanswered silently — every failure creates a manager escalation.

**Independent Test**: Force a JSON parse failure and Hostaway API timeout — verify escalation task created in both cases.

### Implementation for User Story 4

- [x] T030 [US4] Add escalation on JSON parse failure in `backend/src/services/ai.service.ts` (~lines 1513-1516): in the `catch` block after `JSON.parse`, call `handleEscalation()` with urgency `immediate`, title `ai-parse-failure`, note containing the raw response snippet. Clear `ai_typing` via SSE (FR-008)
- [x] T031 [US4] Implement write-ahead delivery in `backend/src/services/ai.service.ts` (~lines 1625-1660): move `prisma.message.create()` BEFORE the `hostawayService.sendMessageToConversation()` call. After Hostaway send succeeds, update the message record with `hostawayMessageId`. If Hostaway fails, the message exists in DB but was never sent — create escalation (FR-009)
- [x] T032 [US4] Add retry with exponential backoff to `backend/src/services/hostaway.service.ts`: create a `retryWithBackoff()` helper (3 attempts, 2s/4s/8s delays) for transient HTTP errors (408, 429, 503, network errors). Apply to `sendMessageToConversation()`, `getAccessToken()`, and `getReservation()` (FR-018)
- [x] T033 [US4] Add escalation on Hostaway send failure in `backend/src/services/ai.service.ts`: after retry exhaustion in the send step, call `handleEscalation()` with urgency `immediate`, title `message-delivery-failure`, note with error details

**Checkpoint**: Every AI pipeline failure creates a manager escalation. No more silent drops.

---

## Phase 7: User Story 5 — Resolve Data Integrity & Schema Gaps (Priority: P1)

**Goal**: Make Cohere embedding provider switching functional and prevent training data corruption.

**Independent Test**: Switch embedding provider to Cohere via settings UI, run test classification and RAG retrieval — both should work.

### Implementation for User Story 5

- [x] T034 [P] [US5] Update `backend/src/services/rag.service.ts`: in all `queryRawUnsafe` / `executeRawUnsafe` calls that reference `${embCol()}`, ensure the Cohere column name `embedding_cohere` maps to the actual new column. Verify dimension matches (1024 for Cohere, 1536 for OpenAI) in vector insert and query operations (FR-010)
- [x] T035 [P] [US5] Update `backend/src/services/classifier-store.service.ts` `addExample()` (~line 17): replace `prisma.classifierExample.create()` with `prisma.classifierExample.upsert()` using `where: { tenantId_text: { tenantId, text } }`, `create: { tenantId, text, labels, source }`, `update: { labels, source, active: true, updatedAt: new Date() }` (FR-017)
- [x] T036 [US5] Update `backend/src/services/embeddings.service.ts`: verify that `setEmbeddingProvider()` correctly clears the embedding cache and that `embedText()` / `embedBatch()` return the correct dimension for the active provider. Add a dimension assertion after embedding calls
- [x] T037 [US5] Verify `backend/src/services/rag.service.ts` `seedTenantSops()` and `upsertChunk()` functions correctly write to the `embedding_cohere` column when Cohere is the active provider

**Checkpoint**: Cohere provider switching works end-to-end. No duplicate training examples.

---

## Phase 8: User Story 6 — Add Rate Limiting & Auth Hardening (Priority: P2)

**Goal**: Protect auth endpoints from brute force and reduce JWT exposure window.

**Independent Test**: Hit login endpoint 6 times in 1 minute with wrong password — 6th should return 429.

### Implementation for User Story 6

- [x] T038 [P] [US6] Create `backend/src/middleware/rate-limit.ts`: implement `loginLimiter` (5/min, skipSuccessfulRequests), `signupLimiter` (3/min), `webhookLimiter` (100/min per tenantId) per contracts/middleware.md. Use Redis store if `REDIS_URL` available, fallback to in-memory. Set `passOnStoreError: true` (FR-014)
- [x] T039 [P] [US6] Reduce JWT expiry from `90d` to `30d` in `backend/src/middleware/auth.ts` `signToken()` function (~line 30)
- [x] T040 [US6] Wire rate limiters into routes: apply `loginLimiter` to `POST /auth/login` and `signupLimiter` to `POST /auth/signup` in `backend/src/routes/auth.ts`. Apply `webhookLimiter` to `POST /webhooks/hostaway/:tenantId` in `backend/src/routes/webhooks.ts`

**Checkpoint**: Auth endpoints rate-limited. JWT tokens expire in 30 days.

---

## Phase 9: User Story 7 — Improve Observability & Configuration (Priority: P3)

**Goal**: Make operational config changeable without deployments and reduce false positive escalations.

**Independent Test**: Update tenant config in dashboard — verify change takes effect within 60 seconds.

### Implementation for User Story 7

- [x] T041 [P] [US7] Extract `MODEL_PRICING` from `backend/src/services/ai.service.ts` (~lines 28-34) into a separate config file `backend/src/config/model-pricing.json` — import it in ai.service.ts. This allows pricing updates via config change instead of code deployment
- [x] T042 [P] [US7] Reduce tenant config cache TTL from 5 minutes to 60 seconds in `backend/src/services/tenant-config.service.ts` (~line 15): change `CACHE_TTL_MS` from `5 * 60 * 1000` to `60 * 1000`
- [x] T043 [US7] Update escalation keyword matching in `backend/src/services/escalation-enrichment.service.ts` (~line 40): replace `textLower.includes(pattern)` with word-boundary regex `new RegExp('\\b' + escapeRegex(pattern) + '\\b', 'i')` to reduce false positives (e.g., "phone code" no longer triggers "code doesn't work")

**Checkpoint**: Config changes take effect in 60 seconds. Escalation false positives reduced.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and cleanup across all stories

- [x] T044 Verify all `console.log('[CLAUDE-RAW]'` and similar debug logs in `backend/src/services/ai.service.ts` do not contain credentials by searching for doorCode, wifiPassword, doorSecurityCode patterns
- [x] T045 Run through all 8 quickstart.md verification steps to validate fixes end-to-end
- [ ] T046 Verify graceful degradation: start server without `REDIS_URL` — confirm rate limiting falls back to in-memory, SSE falls back to in-memory broadcast, queue falls back to polling

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — can run in PARALLEL with US2
- **US2 (Phase 4)**: Depends on Phase 2 — can run in PARALLEL with US1
- **US3 (Phase 5)**: Depends on Phase 2 — can run in PARALLEL with US1/US2
- **US4 (Phase 6)**: Depends on Phase 2 — can run in PARALLEL with US1/US2/US3
- **US5 (Phase 7)**: Depends on Phase 2 (needs Cohere column from T008)
- **US6 (Phase 8)**: Depends on Phase 1 (needs npm packages from T001)
- **US7 (Phase 9)**: No dependencies on other user stories
- **Polish (Phase 10)**: Depends on ALL user stories completing

### User Story Dependencies

- **US1 (P0)**: Independent after Phase 2
- **US2 (P0)**: Independent after Phase 2
- **US3 (P1)**: Independent after Phase 2
- **US4 (P1)**: Independent after Phase 2
- **US5 (P1)**: Depends on T008 (Cohere column migration)
- **US6 (P2)**: Depends on T001 (npm install)
- **US7 (P3)**: Fully independent

### Within Each User Story

- Tasks marked [P] can run in parallel
- Remaining tasks are sequential (top to bottom)
- Complete story before moving to next priority

### Parallel Opportunities

```bash
# After Phase 2, launch P0 stories in parallel:
Phase 3 (US1): T011, T012, T013, T014 — all [P], then T015-T019 sequential
Phase 4 (US2): T020-T024 sequential (same-file dependencies)

# P1 stories can also run in parallel with P0:
Phase 5 (US3): T025, T026, T027, T028 — all [P], then T029
Phase 6 (US4): T030-T033 sequential
Phase 7 (US5): T034, T035 — [P], then T036-T037
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T010)
3. Complete Phase 3: US1 — Security (T011-T019)
4. Complete Phase 4: US2 — Race Conditions (T020-T024)
5. **STOP and VALIDATE**: Run quickstart.md steps 1-5
6. Deploy — critical security and data integrity issues resolved

### Incremental Delivery

1. Setup + Foundational → constraints in place
2. US1 + US2 → P0 security + race conditions fixed (MVP!)
3. US3 + US4 → P1 memory leaks + error handling
4. US5 → P1 Cohere provider switching
5. US6 → P2 rate limiting + auth hardening
6. US7 → P3 observability improvements
7. Polish → final verification

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- No test framework in project — verification via quickstart.md
- All service modifications must preserve graceful degradation (Constitution Principle I)
- Commit after each completed user story phase
