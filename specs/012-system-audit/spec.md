# Feature Specification: Full System Audit & Cleanup

**Feature Branch**: `012-system-audit`
**Created**: 2026-03-21
**Status**: Draft
**Input**: Full system audit — identify and fix dead code, broken references, security issues, missing error handling, UI inconsistencies, unused schema fields, debug code, and configuration problems across backend, frontend, and database.

## Audit Findings Summary

**Method**: 3 code audit agents + 2 live testing agents (API curl testing of 65 endpoints + Playwright browser testing of all 14 dashboard tabs).

**Totals**: 7 critical security issues, 8 high-priority fixes, 15+ medium issues, 10+ low-priority cleanup items.

## Live Testing Results (2026-03-21)

### API Testing (65 endpoints)
- **Pass rate**: 97% (63/65)
- **Bug**: `GET /auth/settings` always returns 401 — uses `req.user?.tenantId` but middleware sets `req.tenantId`
- **Slow**: `GET /api/ai-config` takes ~2.4s (10x slower than other endpoints)
- **Tenant isolation (reads)**: PASSES — fake tenant JWT gets empty results, not other tenants' data
- **Webhook auth**: Accepts requests without Basic Auth when secret is configured (grace period — design concern)

### Frontend Testing (14 tabs via Playwright)
- **All 14 tabs load and render correctly** — no blank screens, no broken layouts
- **Critical bug: SSE involuntary tab switching** — when the SSE connection drops and reconnects, the app switches away from the current tab (e.g., Sandbox → SOPs, Classifier → AI Logs). This is the most impactful UX bug.
- **Sandbox tools don't fire** — "do you have a pool" (INQUIRY) and "can I stay 2 more nights" (CONFIRMED) both escalated via SOP instead of calling tools. Tools work in production (3 invocations logged) but sandbox may not pass tool context correctly.
- **Classifier live test works** — "I need towels" → sop-amenity-request at 100% confidence
- **Console errors**: Only `ERR_HTTP2_PROTOCOL_ERROR` on SSE endpoint (likely root cause of tab switching)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix Tenant Isolation Vulnerabilities (Priority: P1)

Seven database write operations allow one tenant to modify another tenant's data by guessing record IDs. All are missing `tenantId` in the WHERE clause of update/delete operations.

**Why this priority**: Security vulnerability. A malicious user with a valid JWT could modify conversations, tasks, knowledge suggestions, and automated messages belonging to other tenants.

**Independent Test**: Attempt to update a conversation/task belonging to tenant B using tenant A's JWT. Verify the operation is rejected.

**Acceptance Scenarios**:

1. **Given** tenant A's JWT, **When** attempting to update conversation belonging to tenant B via `PATCH /api/conversations/:id`, **Then** the operation returns 404 or 403 — not success.
2. **Given** all 7 vulnerable endpoints are patched, **When** any update/delete is attempted, **Then** the WHERE clause includes `tenantId` from the authenticated request.

**Affected endpoints**:
- `conversations.controller.ts`: markRead (line 75), updateLastMessage (line 448), toggleStar (line 488), resolve (line 520)
- `task.controller.ts`: update (line 115)
- `knowledge.controller.ts`: approve suggestion (line 71), delete suggestion (line 102)
- `automated-messages.controller.ts`: update (line 48), toggle (line 72), delete (line 87)

---

### User Story 2 - Fix Debounce Double-Fire Bug (Priority: P1)

Already partially fixed in 011, but the BullMQ worker processes the same conversation multiple times when messages arrive close together. The debounce service resets `fired: false` while a worker is mid-processing, causing duplicate AI responses.

**Why this priority**: Live production bug — guests get duplicate AI responses with concatenated message history.

**Independent Test**: Send 3 messages 2 seconds apart. Verify only 1 AI response is generated (batching all 3 messages).

**Acceptance Scenarios**:

1. **Given** 3 messages arrive within the debounce window, **When** processed, **Then** exactly 1 AI response is sent containing all 3 messages.
2. **Given** a worker is mid-processing, **When** a new message arrives, **Then** it waits for the current response to complete before scheduling a new one.

---

### User Story 2b - Fix SSE Tab-Switching Bug (Priority: P1)

When the SSE connection to `/api/events` drops and reconnects (caused by `ERR_HTTP2_PROTOCOL_ERROR`), the frontend involuntarily switches the active tab. Observed during testing: Sandbox → SOPs, Classifier → AI Logs, Configure AI → AI Logs. This is the most disruptive UX bug — managers lose their place while working.

**Why this priority**: Live production UX bug. Managers using the dashboard will be interrupted every time SSE reconnects.

**Independent Test**: Open the Classifier tab. Wait 60 seconds. If SSE reconnects, verify the tab does NOT change.

**Acceptance Scenarios**:

1. **Given** the manager is on any tab, **When** the SSE connection drops and reconnects, **Then** the active tab remains unchanged.
2. **Given** an SSE event arrives (ai_typing, new_task, etc.), **When** processed by the frontend, **Then** it updates relevant data without switching tabs.

---

### User Story 2c - Fix auth/settings Endpoint (Priority: P2)

`GET /auth/settings` always returns 401 because it reads `req.user?.tenantId` but the auth middleware sets `req.tenantId`. One-line fix.

**Why this priority**: Broken endpoint, but may not be actively used by the frontend.

**Acceptance Scenarios**:

1. **Given** a valid JWT, **When** calling `GET /auth/settings`, **Then** returns 200 with tenant settings.

---

### User Story 2d - Fix Sandbox Tool Context (Priority: P2)

The sandbox chat doesn't pass tool context correctly — both `search_available_properties` and `check_extend_availability` tools don't fire in the sandbox, even though they work in production (3 invocations logged in the Tools tab).

**Why this priority**: Sandbox is the primary testing tool. If tools don't fire there, developers can't test tool behavior without creating real bookings — defeating the purpose.

**Acceptance Scenarios**:

1. **Given** sandbox set to INQUIRY, **When** sending "do you have a pool", **Then** the property search tool fires and returns alternatives.
2. **Given** sandbox set to CONFIRMED, **When** sending "can I stay 2 more nights", **Then** the extend-stay tool fires and returns availability + pricing.

---

### User Story 3 - Database Schema Cleanup (Priority: P2)

Multiple schema issues: unused fields, missing indexes, string fields that should be enums, unfinished TODO constraints, and an unused pgvector column.

**Why this priority**: Data integrity and query performance. Not a live bug but accumulates technical debt.

**Independent Test**: Run schema migration after cleanup. Verify all existing queries still work and performance improves on filtered queries.

**Acceptance Scenarios**:

1. **Given** the `embedding_cohere` field on PropertyKnowledgeChunk is never used, **When** removed, **Then** no code references break.
2. **Given** indexes are added on `Conversation(tenantId, status)` and `PropertyKnowledgeChunk(tenantId, category)`, **When** conversation list and RAG queries run, **Then** query time decreases.
3. **Given** unused schema fields are identified (screeningAnswers, triggerType, triggerOffset), **When** reviewed, **Then** they are either removed or documented as planned future features.
4. **Given** Task.urgency/type/status are free-form strings, **When** converted to enums, **Then** invalid values are rejected at the database level.

---

### User Story 4 - Remove Dead Code & Debug Logging (Priority: P2)

Deprecated functions, stale config files, and temporary debug logging left in production code.

**Why this priority**: Code hygiene — reduces confusion and maintenance burden.

**Independent Test**: Remove identified dead code. Verify TypeScript compiles clean and all existing functionality works.

**Acceptance Scenarios**:

1. **Given** `getLastClassifierResult()` in rag.service.ts is deprecated, **When** removed, **Then** no callers break (only `getAndClearLastClassifierResult` is used).
2. **Given** `ai-config.json` settings are overridden by database config, **When** documented as fallback-only template, **Then** developers understand it's not the source of truth.
3. **Given** debug logging for URL fields in import.service.ts, **When** removed, **Then** import logs are cleaner.
4. ~~Python removal~~ — CANCELLED. Python is needed in production for the Retrain Classifier button (`execFile('python3', [scriptPath])`). Keep in Dockerfile.

---

### User Story 5 - Frontend Error Handling & Consistency (Priority: P2)

10+ silent `.catch(() => {})` calls across frontend components, no error boundaries, missing loading states, and inconsistent styling patterns.

**Why this priority**: UX quality — users don't know when operations fail, and crashes kill the entire dashboard.

**Independent Test**: Disconnect the backend API. Verify frontend shows meaningful error messages instead of blank/broken pages.

**Acceptance Scenarios**:

1. **Given** an API call fails in settings-v5.tsx, **When** the user sees the result, **Then** a toast/error message appears instead of silent failure.
2. **Given** a component crashes (e.g., classifier-v5 throws), **When** the error boundary catches it, **Then** only that section shows an error — the rest of the dashboard works.
3. **Given** icon-only buttons in inbox-v5.tsx, **When** a screen reader reads them, **Then** each button has an `aria-label` describing its function.

---

### User Story 6 - Configuration & Infrastructure Hardening (Priority: P3)

Missing health check, hardcoded values that should be configurable, missing env var documentation, and CORS fallback risks.

**Why this priority**: Operational reliability — prevents production issues from configuration mistakes.

**Independent Test**: Remove all optional env vars. Verify the system starts with appropriate warnings/fallbacks.

**Acceptance Scenarios**:

1. **Given** `DATABASE_URL` is not set, **When** the server starts, **Then** it fails immediately with a clear error (not a late Prisma crash).
2. **Given** a `GET /health` endpoint exists, **When** Railway checks it, **Then** container health is accurately reported.
3. **Given** `COHERE_API_KEY` is documented in .env.example, **When** a new developer sets up, **Then** they know Cohere is optional and how to configure it.
4. **Given** CORS_ORIGINS is not set in production, **When** the server starts, **Then** it warns loudly instead of silently falling back to localhost.

---

### Edge Cases

- **Schema migration on live database**: Removing fields/adding indexes must not lock tables during peak hours.
- **Enum conversion for existing data**: Converting Task.urgency from string to enum requires migrating existing string values first.
- **Error boundary in SSR**: Next.js error boundaries must work in both client and server rendering.
- **Backwards compatibility**: Removing unused schema fields could break if any external system (Hostaway webhooks, Zapier) writes to them.

## Requirements *(mandatory)*

### Functional Requirements

**Security (P1)**

- **FR-001**: All database update/delete operations MUST include `tenantId` in the WHERE clause, preventing cross-tenant data access.
- **FR-002**: The debounce service MUST NOT reset a PendingAiReply to `fired: false` while a worker is actively processing the same conversation.
- **FR-002a**: Webhook endpoint MUST reject requests without valid Basic Auth when the tenant has a `webhookSecret` configured (return 401). The current grace period MUST be removed.

**Schema (P2)**

- **FR-003**: Unused schema fields (embedding_cohere, screeningAnswers, triggerType, triggerOffset) MUST be reviewed and either removed or documented.
- **FR-004**: Missing indexes MUST be added: `Conversation(tenantId, status)`, `PropertyKnowledgeChunk(tenantId, category)`, `Task(tenantId, status)`.
- **FR-005**: Task.urgency, Task.type, and Task.status — DEFERRED. Keep as strings for now, convert to enums in a future cleanup.

**Code Quality (P2)**

- **FR-006**: Deprecated `getLastClassifierResult()` function MUST be removed.
- **FR-007**: Debug logging (import URL field dump) MUST be removed from production code.
- **FR-008**: Python dependencies MUST stay in production Dockerfile — the Retrain Classifier button calls `python3 train_classifier.py` via `execFile` on the server. NOT dead weight.

**Bugs Found in Live Testing (P1-P2)**

- **FR-009**: SSE event handling MUST NOT switch the active tab when the connection reconnects or events arrive. Tab state must be preserved.
- **FR-010**: `GET /auth/settings` MUST use `req.tenantId` (not `req.user?.tenantId`) to match the auth middleware pattern.
- **FR-011**: Sandbox chat MUST pass tool definitions and handlers to `createMessage()` so tools fire in sandbox the same way they do in production.
- **FR-012**: `GET /api/ai-config` MUST respond in under 500ms (currently ~2.4s). Cache or lazy-load expensive operations.
- **FR-012a**: Analytics "AI Resolution Rate" MUST be capped at 100% or the calculation fixed (currently shows 600%).

**Frontend (P2)**

- **FR-013**: All silent `.catch(() => {})` calls MUST be replaced with user-visible error feedback.
- **FR-014**: A global error boundary MUST be added to prevent single-component crashes from killing the entire dashboard.
- **FR-015**: All icon-only buttons MUST have `aria-label` attributes.

**Infrastructure (P3)**

- **FR-016**: A `GET /health` endpoint MUST be added and configured in Railway.
- **FR-017**: `DATABASE_URL` and `JWT_SECRET` MUST be validated at startup with clear error messages.
- **FR-018**: `COHERE_API_KEY` MUST be documented in `.env.example`.
- **FR-019**: CORS fallback to localhost MUST warn in production (`NODE_ENV=production`).

## Out of Scope

- **System prompts** (OMAR_SYSTEM_PROMPT, OMAR_SCREENING_SYSTEM_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT) — another Claude Code session is handling prompt refinement. Do not modify prompt text.
- **Classifier training data** — managed separately via the judge/auto-fix pipeline.
- RAG/SOP content cleanup IS in scope if dead or orphaned chunks are found.

## Clarifications

### Session 2026-03-21

- Q: What's explicitly out of scope for this audit? → A: System prompts and classifier training data are excluded (another session handles those). RAG/SOP cleanup is in scope if dead chunks are found.
- Q: Should the webhook auth grace period be tightened? → A: Yes. If tenant has a webhookSecret configured, reject requests without valid Basic Auth (401). Remove grace period.
- Q: Should enum conversion (Task fields) and Python removal (Dockerfile) be done in this audit? → A: Skip both. Enum conversion deferred to future cleanup. Python MUST stay — the Retrain button runs `python3 train_classifier.py` on the server via `execFile`.

## Assumptions

- Schema changes can be applied with `prisma db push` during low-traffic periods.
- Converting string fields to enums requires a data migration step (update existing values to match enum names).
- Python MUST remain in Dockerfile — training runs on the server via the Retrain button (`execFile('python3', ...)`).
- Error boundaries are standard React patterns supported by Next.js 16.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero cross-tenant data access possible via any API endpoint (tenant isolation audit passes 100%).
- **SC-002**: No duplicate AI responses when messages arrive within the debounce window.
- **SC-003**: All database queries on frequently-filtered fields use appropriate indexes (verified via EXPLAIN ANALYZE).
- **SC-004**: TypeScript compiles with zero errors after all dead code removal.
- **SC-005**: Frontend shows user-visible error messages for 100% of failed API calls (no silent failures).
- **SC-006**: Dashboard remains functional when any single component crashes (error boundary catches it).
- ~~SC-007~~: CANCELLED — Python stays (needed for retrain).
- **SC-008**: SSE reconnection does NOT switch the active dashboard tab (verified via Playwright).
- **SC-009**: `GET /auth/settings` returns 200 with valid JWT (currently returns 401).
- **SC-010**: Sandbox chat fires tools (property search for INQUIRY, extend-stay for CONFIRMED) — verified in sandbox UI.
- **SC-011**: `GET /api/ai-config` responds in under 500ms.
