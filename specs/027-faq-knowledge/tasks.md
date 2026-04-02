# Tasks: FAQ Knowledge System

**Input**: Design documents from `/specs/027-faq-knowledge/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/faq-api.md, contracts/faq-tool.md, quickstart.md

**Organization**: Tasks grouped by user story. US1 (AI answers from FAQ) is the MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Schema & Constants)

**Purpose**: Database model and shared constants required before any feature work

- [x] T001 Add FaqEntry model to backend/prisma/schema.prisma — fields: id (cuid), tenantId, propertyId (optional), question (String), answer (Text), category (String), scope (FaqScope enum: GLOBAL/PROPERTY), status (FaqStatus enum: SUGGESTED/ACTIVE/STALE/ARCHIVED), source (FaqSource enum: MANUAL/AUTO_SUGGESTED), usageCount (Int default 0), lastUsedAt (DateTime optional), sourceConversationId (String optional), createdAt, updatedAt. Relations: Tenant (cascade delete), Property (optional). Indexes: `[tenantId, propertyId, status]`, `[tenantId, scope, status]`, `[tenantId, category, status]`. Unique constraint: `@@unique([tenantId, propertyId, question])` to prevent exact duplicate questions per property. Add enums FaqScope, FaqStatus, FaqSource.
- [x] T002 Run `npx prisma generate` and `npx prisma db push` to apply schema changes
- [x] T003 Create FAQ_CATEGORIES constant array in backend/src/config/faq-categories.ts — export the 15 fixed category IDs and a display label map: `{ id: 'check-in-access', label: 'Check-in & Access' }` for all 15 categories (check-in-access, check-out-departure, wifi-technology, kitchen-cooking, appliances-equipment, house-rules, parking-transportation, local-recommendations, attractions-activities, cleaning-housekeeping, safety-emergencies, booking-reservation, payment-billing, amenities-supplies, property-neighborhood)

---

## Phase 2: Foundational (FAQ Service + Routes)

**Purpose**: Core FAQ CRUD service and API routes that ALL user stories depend on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 Create backend/src/services/faq.service.ts — export functions: `getFaqEntries(prisma, tenantId, filters?)` returns entries with optional filtering by propertyId/scope/status/category. `createFaqEntry(prisma, data)` creates an entry with validation (category must be in FAQ_CATEGORIES, question/answer required). `updateFaqEntry(prisma, id, tenantId, data)` updates fields (status, scope, question, answer, propertyId). `deleteFaqEntry(prisma, id, tenantId)` hard-deletes. `getFaqForProperty(prisma, tenantId, propertyId, category)` retrieves ACTIVE entries for get_faq tool — property-specific first, then global. Override logic: a global entry is excluded if a property entry exists with the same first 50 characters of the question (lowercased, trimmed). Returns Markdown-formatted Q&A string. Increments usageCount and updates lastUsedAt on each entry returned. `getCategoryStats(prisma, tenantId)` returns category counts.
- [x] T005 Create backend/src/controllers/faq.controller.ts — makeFaqController(prisma) factory returning handlers: list (GET /), create (POST /), update (PATCH /:id), remove (DELETE /:id), categories (GET /categories). All scoped by tenantId from JWT. Validate category against FAQ_CATEGORIES. Return 404 if entry not found or wrong tenant.
- [x] T006 Create backend/src/routes/faq.ts — faqRouter(prisma) factory. Mount authMiddleware. Register all 5 routes from faq.controller. Follow existing route patterns (AuthenticatedRequest cast).
- [x] T007 Mount FAQ router in backend/src/app.ts — add `app.use('/api/faq', faqRouter(prisma))` alongside existing route mounts. Add import for faqRouter.
- [x] T008 [P] Add FAQ API functions to frontend/lib/api.ts — `apiGetFaqEntries(filters?)`, `apiCreateFaqEntry(data)`, `apiUpdateFaqEntry(id, data)`, `apiDeleteFaqEntry(id)`, `apiGetFaqCategories()`. Follow existing apiFetch pattern.

**Checkpoint**: FAQ CRUD works end-to-end. Can create, list, update, delete entries via API.

---

## Phase 3: User Story 1 — AI Answers From FAQ (Priority: P1) MVP

**Goal**: The AI calls `get_faq` before escalating `info_request`. If a matching FAQ entry exists, the AI answers directly without escalating.

**Independent Test**: Create an FAQ entry, send a matching guest question, verify AI answers from FAQ without escalating.

### Implementation

- [x] T009 [US1] Add `get_faq` tool definition to the tools array in backend/src/services/ai.service.ts — tool name: `get_faq`, description: "Retrieve FAQ entries for the current property. Call this BEFORE escalating an info_request when a guest asks a factual question about the property, local area, amenities, or policies. If the FAQ has an answer, use it directly instead of escalating." Parameters: `category` (string, enum of 15 categories, required). Add alongside existing tool definitions (get_sop, check_extend_availability, etc.).
- [x] T010 [US1] Add `get_faq` tool handler in backend/src/services/ai.service.ts — in the toolHandlers Map, add handler for `get_faq`: extracts `category` from input, calls `getFaqForProperty(prisma, tenantId, propertyId, category)` from faq.service, returns the Markdown-formatted Q&A string. If no entries found, returns "No FAQ entries for this category. Escalate to the manager if the guest needs this information."
- [x] T011 [US1] Switch `get_sop` tool output from JSON to Markdown format in backend/src/services/ai.service.ts — find the get_sop handler that returns `JSON.stringify({ categories, content })`. Change to return Markdown: `## SOP: ${categoryLabel}\n\n${sopContent}`. Keep the same content, just change the wrapper format from JSON to Markdown with headers.

**Checkpoint**: US1 complete — AI checks FAQ before escalating, uses Markdown output for both SOP and FAQ tools.

---

## Phase 4: User Story 4 — Markdown Tool Output (Priority: P2)

**Goal**: All text-heavy tool outputs use Markdown format for better AI comprehension and fewer tokens.

**Independent Test**: Trigger a get_sop call, verify output is Markdown. Trigger get_faq, verify output is Markdown.

### Implementation

- [x] T012 [US4] Verify all data-oriented tools still use JSON output in backend/src/services/ai.service.ts — check that `check_extend_availability`, `search_available_properties`, `create_document_checklist`, `mark_document_received`, and webhook tools still return `JSON.stringify(...)`. No changes needed if they already do — just verify and document.

**Checkpoint**: US4 complete — text tools use Markdown, data tools use JSON.

---

## Phase 5: User Story 2 — Auto-Suggest From Manager Replies (Priority: P2)

**Goal**: When a manager replies to an `info_request` escalation, the system classifies the reply as reusable, extracts a Q&A pair, and creates a suggested FAQ entry.

**Independent Test**: Reply to an info_request as a manager. Verify a suggested FAQ entry is created and an inline prompt appears in the chat.

### Implementation

- [x] T013 [US2] Create backend/src/services/faq-suggest.service.ts — export `processFaqSuggestion(prisma, tenantId, conversationId, propertyId, guestMessage, managerReply)`. Uses GPT-5 Nano (`gpt-5-nano`) via OpenAI Responses API. Two-step process: (1) Classify reply as REUSABLE/BOOKING_SPECIFIC using structured JSON output `{ reusable: boolean, reason: string }`. Signals: guest names, dates, pricing → booking-specific; amenities, hours, directions, policies → reusable. (2) If reusable: extract clean Q&A pair `{ question: string, answer: string, category: string }` — strip greetings, personal details, booking references. Deduplicate: check existing ACTIVE entries with similar question (first 100 chars). If duplicate, skip. Create FaqEntry with status SUGGESTED, source AUTO_SUGGESTED, sourceConversationId. Return the suggestion or null. Fire-and-forget — never block the manager's reply.
- [x] T014 [US2] Trigger auto-suggest when manager replies to info_request in backend/src/controllers/messages.controller.ts — in the `send()` method (manager sends message), after saving the message, check if the conversation has an open task with urgency `info_request` ONLY (NOT `inquiry_decision` or `modification_request` — those are booking decisions, not reusable knowledge). If so, call `processFaqSuggestion()` fire-and-forget. Pass the last guest message content and the manager's reply.
- [x] T015 [US2] Broadcast `faq_suggestion` Socket.IO event in backend/src/services/faq-suggest.service.ts — after creating a SUGGESTED entry, call `broadcastToTenant(tenantId, 'faq_suggestion', { conversationId, suggestion: { id, question, answer, category, propertyId, propertyName } })`. The frontend uses this to show the inline "Save as FAQ?" prompt.
- [x] T016 [US2] Add inline "Save as FAQ?" prompt in frontend/components/inbox-v5.tsx — listen for `faq_suggestion` Socket.IO event. When received for the selected conversation, show a card below the manager's message: extracted Q/A, Approve/Edit/Reject buttons, Global/Property scope toggle (default: Property). On Approve: call `apiUpdateFaqEntry(id, { status: 'ACTIVE', scope })`. On Reject: call `apiUpdateFaqEntry(id, { status: 'ARCHIVED' })`. On Edit: expand inline editor for question/answer, then approve. Auto-dismiss after 60 seconds if no action (suggestion stays on FAQs page).

**Checkpoint**: US2 complete — manager replies auto-generate FAQ suggestions with inline approval.

---

## Phase 6: User Story 3 — FAQ Management Page (Priority: P3)

**Goal**: Dedicated FAQs page for viewing, creating, editing, and organizing all FAQ entries.

**Independent Test**: Open FAQs page, see all entries organized by category. Create, edit, archive entries.

### Implementation

- [x] T017 [P] [US3] Create frontend/components/faq-v5.tsx — dedicated FAQs page component. Layout: top bar with "Add FAQ" button + filter controls (property dropdown, scope toggle, status filter, category filter). Main area: entries grouped by category with collapsible sections. Each entry shows: question (bold), answer, property name or "Global", status badge (suggested=yellow, active=green, stale=orange, archived=gray), usage count, last used date. Actions per entry: edit, archive, toggle scope, delete. Suggested entries section at the top with approve/reject buttons. Empty state: "No FAQ entries yet. Create your first FAQ or reply to guest questions to auto-generate suggestions."
- [x] T018 [P] [US3] Add FAQ page route — add "FAQs" tab to the main navigation in the app layout (alongside Overview, Inbox, Analytics, etc.). Route to the faq-v5 component. Use the same layout/nav pattern as other pages.
- [x] T019 [US3] Add create/edit FAQ modal in frontend/components/faq-v5.tsx — modal with fields: question (textarea), answer (textarea), category (dropdown of 15 categories), scope (Global/Property radio), property selector (dropdown, shown when scope=Property). Validate: question and answer required, category required, property required when scope=Property. On save: call apiCreateFaqEntry or apiUpdateFaqEntry.

**Checkpoint**: US3 complete — full FAQ management UI.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Staleness detection, suggestion expiry, cleanup

- [x] T020 Add staleness detection to backend/src/services/faq.service.ts — export `markStaleFaqEntries(prisma, tenantId)` that updates ACTIVE entries with lastUsedAt < 90 days ago (or createdAt < 90 days ago if never used) to status STALE. Call this from the existing debounce job or a new lightweight scheduled check (once per day is sufficient).
- [x] T021 Add suggestion expiry to backend/src/services/faq.service.ts — export `expireStaleSuggestions(prisma, tenantId)` that deletes SUGGESTED entries with createdAt < 28 days ago. Call alongside staleness detection.
- [x] T022 Register staleness + expiry check in backend/src/jobs/ — either add to an existing daily job or create a lightweight `faqMaintenance.job.ts` that runs once per day via setInterval(24h). Queries all tenants and runs markStaleFaqEntries + expireStaleSuggestions for each.
- [x] T023 Run all 9 quickstart.md test scenarios manually and verify each passes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — schema first
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 (needs FAQ service + get_faq tool)
- **US4 (Phase 4)**: Depends on Phase 3 (Markdown output change is in the same file)
- **US2 (Phase 5)**: Depends on Phase 2 — can run in parallel with US1
- **US3 (Phase 6)**: Depends on Phase 2 — can run in parallel with US1 and US2
- **Polish (Phase 7)**: Depends on all stories being complete

### User Story Dependencies

- **US1 (P1)**: Depends only on Foundational
- **US4 (P2)**: Depends on US1 (T011 is in US1, T012 is verification)
- **US2 (P2)**: Depends only on Foundational — can parallel with US1
- **US3 (P3)**: Depends only on Foundational — can parallel with US1 and US2

### Parallel Opportunities

- T003 and T008 are parallel (different files)
- T005 and T006 are parallel with T008 (backend vs frontend)
- T013 (auto-suggest service) is parallel with T009-T011 (get_faq tool)
- T017-T018 (FAQ page) are parallel with T013-T016 (auto-suggest)
- US1, US2, US3 can all start in parallel after Phase 2

---

## Parallel Example: After Phase 2

```bash
Agent 1: "US1 — T009-T011: get_faq tool + Markdown SOP output"
Agent 2: "US2 — T013-T016: Auto-suggest pipeline + inline prompt"
Agent 3: "US3 — T017-T019: FAQ management page + nav integration"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Schema + categories (T001-T003)
2. Complete Phase 2: FAQ service + routes + frontend API (T004-T008)
3. Complete Phase 3: get_faq tool + Markdown output (T009-T011)
4. **STOP and VALIDATE**: Manually create FAQ entries, send guest questions, verify AI answers from FAQ
5. Deploy — this alone reduces info_request escalations

### Incremental Delivery

1. Setup + Foundational → FAQ CRUD works
2. US1 → AI answers from FAQ → Deploy (MVP!)
3. US4 → Markdown tool output verified → Deploy
4. US2 → Auto-suggest pipeline → Deploy (knowledge base grows organically)
5. US3 → Full FAQ management page → Deploy
6. Polish → Staleness, expiry → Deploy

---

## Notes

- GPT-5 Nano (`gpt-5-nano`) for auto-suggest classification — ~$0.0001 per call
- 15 fixed categories as constants, not DB records
- Markdown output only for text-heavy tools (SOP, FAQ). Data tools stay JSON.
- Auto-suggest is fire-and-forget — never blocks manager reply
- Suggestions never auto-publish — always require manager approval
- FAQ entries are short (1-3 sentences per answer)
