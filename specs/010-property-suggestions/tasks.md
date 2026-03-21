# Tasks: Cross-Sell Property Suggestions (Tool Use)

**Input**: Design documents from `/specs/010-property-suggestions/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Listing URL import + types — prerequisite data that all stories need

- [x] T001 [P] Add `airbnbListingUrl`, `vrboListingUrl`, `bookingEngineUrls` fields to `HostawayListing` interface in `backend/src/types/index.ts`
- [x] T002 [P] Create amenity synonym map config file at `backend/src/config/amenity-synonyms.json` with entries for pool, wifi, parking, gym, balcony, kitchen, washer, ac, sea_view, bbq (per data-model.md)
- [x] T003 Update `import.service.ts` to capture listing URLs during Hostaway import: `listing.airbnbListingUrl` → `kb.airbnbListingUrl`, `listing.vrboListingUrl` → `kb.vrboListingUrl`, `listing.bookingEngineUrls[0]` → `kb.bookingEngineUrl` in `backend/src/services/import.service.ts`
- [x] T004 Update the resync endpoint in `backend/src/routes/properties.ts` to also capture listing URLs (same logic as T003 — the resync path has its own KB building code)
- [x] T005 Copy `amenity-synonyms.json` to dist in build script — add to `cp -r src/config dist/` in `backend/package.json` (already copies config, verify the new file is included)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Tool use infrastructure in `createMessage()` — MUST be complete before any user story

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Extend `createMessage()` options interface in `backend/src/services/ai.service.ts` to accept optional `tools` (Anthropic Tool array), `toolChoice` (ToolChoice), and `toolHandlers` (Map of tool name → async handler function)
- [x] T007 Add tool use response loop in `createMessage()` in `backend/src/services/ai.service.ts`: after `anthropic.messages.create()`, check `response.stop_reason === 'tool_use'` → extract `tool_use` content blocks → execute matching handler from `toolHandlers` map → build `tool_result` message → call Claude again. Cap at 1 loop iteration. On handler error, return error `tool_result` to Claude (never crash)
- [x] T008 Add tool use metadata to `ragContext` logging in `createMessage()` in `backend/src/services/ai.service.ts`: set `toolUsed` (boolean), `toolName` (string), `toolInput` (object), `toolResults` (array), `toolDurationMs` (number) on the ragContext object passed to AiApiLog

**Checkpoint**: Tool use infrastructure ready — `createMessage()` can now accept tools and handle the tool_use → tool_result loop. All existing callers unaffected (tools param is optional).

---

## Phase 3: User Story 1 — Inquiry Guest Asks for Unavailable Amenity (Priority: P1) MVP

**Goal**: When an inquiry guest asks about an amenity the property doesn't have, the screening AI searches the portfolio and suggests alternatives with booking links.

**Independent Test**: Send a message on an INQUIRY conversation asking "Is there a pool?" for a property without a pool. Verify the AI responds with 1-3 alternative properties including names, highlights, and channel-appropriate booking links.

### Implementation for User Story 1

- [x] T009 [P] [US1] Add `listAvailableListings(accountId, apiKey, startDate, endDate)` function to `backend/src/services/hostaway.service.ts` — calls `GET /v1/listings?availabilityDateStart=YYYY-MM-DD&availabilityDateEnd=YYYY-MM-DD`, returns array of available listing objects. Use existing `retryWithBackoff()` and `getClient()` patterns
- [x] T010 [P] [US1] Create `backend/src/services/property-search.service.ts` with `searchAvailableProperties(input, context)` function: (1) load all tenant properties from DB, (2) parse city from current property address, (3) filter to same-city properties, (4) match amenities using synonym map (case-insensitive substring match against `customKnowledgeBase.amenities`), (5) exclude current property, (6) filter by `min_capacity` if specified, (7) call `listAvailableListings()` from hostaway.service and intersect with amenity matches, (8) select channel-appropriate booking link per R5 (AIRBNB→airbnbListingUrl, BOOKING→vrboListingUrl, DIRECT/WHATSAPP/OTHER→bookingEngineUrl, fallback chain), (9) return top 3 results formatted per data-model.md tool result schema
- [x] T011 [US1] Define the `search_available_properties` tool schema in `backend/src/services/ai.service.ts` (per contracts/tool-definition.md). Register the tool handler mapping: `"search_available_properties"` → `searchAvailableProperties()` from property-search.service. Pass reservation context (checkIn, checkOut, channel, currentPropertyId, tenantId, hostawayAccountId, hostawayApiKey) to the handler
- [x] T012 [US1] Update `generateAndSendAiReply()` in `backend/src/services/ai.service.ts` to pass `tools` array and `toolHandlers` map to `createMessage()` ONLY when `reservationStatus === 'INQUIRY'` (screening agent). CONFIRMED/CHECKED_IN calls get no tools — same as today
- [x] T013 [US1] Add tool use instruction to the screening system prompt (`OMAR_SCREENING_SYSTEM_PROMPT`) in `backend/src/services/ai.service.ts`: brief paragraph telling the AI about the `search_available_properties` tool — when to use it (guest asks about missing amenity/feature, wants alternatives), when NOT to use it (guest asking about current property's existing amenities), and to never quote prices (direct to booking link)
- [x] T014 [US1] Ensure multi-tenant isolation in property-search.service: all DB queries filter by `tenantId`, Hostaway API called with per-tenant credentials. Ensure tool results NEVER include access codes (doorCode, wifiPassword) — only name, highlights, link, capacity

**Checkpoint**: US1 complete. Inquiry guests asking about missing amenities get alternative property suggestions with booking links. Confirmed guests are unaffected.

---

## Phase 4: User Story 2 — Conversational Follow-Ups (Priority: P1)

**Goal**: After suggesting properties, the AI handles follow-up questions naturally — refining searches, answering about specific properties, redirecting pricing to links.

**Independent Test**: After getting property suggestions, send "Do any of those have parking too?" — verify the AI refines the search. Then send "How much is the Beach Villa?" — verify it directs to the booking link, not quoting a price.

### Implementation for User Story 2

- [x] T015 [US2] Verify the tool use loop in `createMessage()` correctly passes conversation history (including prior tool_use + tool_result turns) so Claude has context of previous suggestions. If the 6-message history window in `backend/src/services/ai.service.ts` doesn't include tool turns, adjust to include them
- [x] T016 [US2] Update screening system prompt in `backend/src/services/ai.service.ts` to instruct the AI: (1) when refining a search, call the tool again with updated criteria, (2) never quote specific prices — always direct to the booking link, (3) if the guest switches topics ("what's the check-in time?"), answer normally without forcing cross-sell

**Checkpoint**: US2 complete. Follow-up conversations about suggested properties work naturally.

---

## Phase 5: User Story 3 — Guest Interested in a Suggested Property (Priority: P1)

**Goal**: When an inquiry guest expresses interest in a suggested property, the AI provides the booking link and creates an escalation task for manager follow-up.

**Independent Test**: After receiving suggestions, say "I'd like to book the Beach Villa." Verify the AI provides the booking link and a Task is created with title `property-switch-request`, urgency `scheduled`, and note containing target property + dates + reason.

### Implementation for User Story 3

- [x] T017 [US3] Update screening system prompt in `backend/src/services/ai.service.ts` to instruct the AI: when a guest expresses interest in a suggested property, (1) provide the booking link, (2) create an escalation with `title: "property-switch-request"`, `urgency: "scheduled"`, and a `note` containing: target property name, guest's requested dates, the amenity/reason that triggered the suggestion, and guest's booking channel
- [x] T018 [US3] Verify the existing `handleEscalation()` flow in `backend/src/services/ai.service.ts` correctly handles the `property-switch-request` escalation title — no code changes needed if it passes through to Task creation as-is. Verify task-manager deduplication doesn't suppress repeated property interest signals

**Checkpoint**: US3 complete. Guest interest generates a manager task with all booking details.

---

## Phase 6: User Story 4 — Subtle / Indirect Requests (Priority: P2)

**Goal**: The AI recognizes indirect requests ("I wish this place had a view", "too small for our group") and searches for alternatives without being pushy.

**Independent Test**: Send "The apartment feels a bit small for 6 people" — verify the AI searches for higher-capacity properties. Send "Nice place, shame there's no balcony though" — verify the AI acknowledges but doesn't aggressively push alternatives.

### Implementation for User Story 4

- [x] T019 [US4] Update screening system prompt in `backend/src/services/ai.service.ts` with guidance on indirect requests: (1) capacity complaints → search with `min_capacity`, (2) wish/desire expressions → search with the mentioned amenity, (3) casual comments ("shame there's no X") → acknowledge naturally, optionally mention alternatives exist without full search unless guest asks, (4) never be aggressive or salesy

**Checkpoint**: US4 complete. Subtle requests are handled with tact.

---

## Phase 7: User Story 5 — Manager Dashboard Visibility (Priority: P3)

**Goal**: Pipeline/AI log view shows tool usage details when a tool was invoked during a response.

**Independent Test**: Trigger a property suggestion, then check the pipeline view in the dashboard. Verify tool name, search criteria, properties returned, and duration are visible.

### Implementation for User Story 5

- [x] T020 [P] [US5] Update `PipelineFeedEntry` interface in `frontend/components/ai-pipeline-v5.tsx` to include tool use fields: `toolUsed` (boolean), `toolName` (string), `toolInput` (object), `toolResults` (array), `toolDurationMs` (number)
- [x] T021 [US5] Add tool usage section in the expanded pipeline entry in `frontend/components/ai-pipeline-v5.tsx`: render when `entry.toolUsed === true` — show tool name badge, search criteria (amenities, min_capacity), results list (property names + links), and duration in ms. Style consistent with existing pipeline sections (Tier 1, Similarity Boost, etc.)

**Checkpoint**: US5 complete. Managers see tool usage in pipeline logs.

---

## Phase 8: User Story 6 — Frontend Tools Management (Priority: P2)

**Goal**: Dashboard includes a Tools section showing available tools, their status, and recent invocations.

**Independent Test**: Navigate to the Tools section. Verify the property search tool is listed with description and status. Verify recent invocations show timestamp, search criteria, and results count.

### Implementation for User Story 6

- [x] T022 [US6] Create `frontend/components/tools-v5.tsx` — Tools management section with: (1) tools list showing tool name, description, status (enabled), agent scope ("Screening only"), (2) recent invocations table pulled from AI logs where `toolUsed === true`, showing: timestamp, conversation link, search criteria, results count, duration. Use existing theme/design patterns from classifier-v5.tsx
- [x] T023 [P] [US6] Add API function `apiGetToolInvocations()` in `frontend/lib/api.ts` — calls `GET /api/ai-logs` (or similar existing endpoint) with filter for entries where `ragContext.toolUsed === true`, returns recent invocations sorted by timestamp
- [x] T024 [US6] Add backend endpoint for tool invocations in `backend/src/routes/knowledge.ts` (or appropriate route file): `GET /api/knowledge/tool-invocations` — queries `AiApiLog` where `ragContext` contains `toolUsed: true`, returns last 50 entries with tool metadata, tenant-scoped
- [x] T025 [US6] Add "Tools" navigation tab in the dashboard header/nav in the appropriate frontend layout component — link to the tools section

**Checkpoint**: US6 complete. Managers can view and monitor AI tools from the dashboard.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, cleanup, and validation

- [ ] T026 Re-import properties on staging/production to capture listing URLs (run `POST /api/import { listingsOnly: true }`) and verify `airbnbListingUrl`, `bookingEngineUrl` appear in `customKnowledgeBase`
- [ ] T027 Validate edge case: tenant with only 1 property — send an amenity question, verify AI says "no alternatives available" and offers to escalate
- [ ] T028 Validate edge case: Hostaway API failure during tool execution — verify AI responds helpfully ("Let me check with the team") and escalates to manager
- [ ] T029 Validate edge case: property with no listing URL — verify AI suggests property by name but says "contact the team for booking"
- [ ] T030 Validate FR-010: send same amenity question on a CONFIRMED reservation — verify NO tool use, normal guest coordinator response
- [ ] T031 Run quickstart.md full validation workflow

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — core MVP
- **US2 (Phase 4)**: Depends on US1 (needs tool to be wired)
- **US3 (Phase 5)**: Depends on US1 (needs tool + escalation)
- **US4 (Phase 6)**: Depends on US1 (prompt refinement only)
- **US5 (Phase 7)**: Depends on Foundational T008 (ragContext logging) — can run parallel to US1-US4
- **US6 (Phase 8)**: Depends on US5 (needs pipeline view first) + T024 (backend endpoint)
- **Polish (Phase 9)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: BLOCKS US2, US3, US4. Must complete first — it wires the tool.
- **US2 (P1)**: Depends on US1. Follow-up handling needs the tool to be working.
- **US3 (P1)**: Depends on US1. Escalation flow needs tool results in conversation.
- **US4 (P2)**: Depends on US1. Prompt refinement only — no new code.
- **US5 (P3)**: Can start after Foundational. Independent — only reads ragContext.
- **US6 (P2)**: Depends on T024 (backend endpoint). Frontend-only after that.

### Within Each User Story

- Hostaway service changes before property-search service (T009 before T010)
- Property search service before AI service wiring (T010 before T011-T012)
- Tool wiring before prompt changes (T012 before T013)

### Parallel Opportunities

```
Phase 1: T001 ‖ T002 (different files)
Phase 2: T006 → T007 → T008 (sequential, same file)
Phase 3: T009 ‖ T010 (different services), then T011 → T012 → T013 → T014
Phase 7: T020 ‖ T023 (different files), parallel to backend work
Phase 8: T022 + T023 ‖ T024 (frontend ‖ backend)
```

---

## Parallel Example: User Story 1

```bash
# Launch in parallel (different files):
Task: T009 "Add listAvailableListings() to backend/src/services/hostaway.service.ts"
Task: T010 "Create backend/src/services/property-search.service.ts"

# Then sequential (same file, dependencies):
Task: T011 "Define tool schema + register handler in backend/src/services/ai.service.ts"
Task: T012 "Pass tools to createMessage() for INQUIRY only in backend/src/services/ai.service.ts"
Task: T013 "Add tool use instruction to screening system prompt in backend/src/services/ai.service.ts"
Task: T014 "Verify tenant isolation + no access code exposure in property-search.service.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T005) — listing URLs + amenity synonyms
2. Complete Phase 2: Foundational (T006-T008) — tool use loop in createMessage()
3. Complete Phase 3: User Story 1 (T009-T014) — property search tool wired to screening agent
4. **STOP and VALIDATE**: Test with an INQUIRY conversation asking about a missing amenity
5. Deploy if working — this alone delivers the core value

### Incremental Delivery

1. Setup + Foundational → Tool use infrastructure ready
2. US1 → Inquiry guests get property suggestions (MVP!)
3. US2 → Follow-up questions work naturally
4. US3 → Guest interest creates manager tasks
5. US4 → Subtle requests handled with tact
6. US5 → Pipeline view shows tool usage
7. US6 → Tools management section in dashboard
8. Polish → Edge case validation + re-import

---

## Notes

- No schema migration needed — all data fits in existing JSON fields
- Total: 31 tasks across 9 phases
- US1 is the MVP (14 tasks including setup + foundational)
- US2-US4 are mostly prompt refinements (1-2 tasks each)
- US5-US6 are frontend (6 tasks)
- Cost impact: ~$0.003 extra per INQUIRY message when tool fires, zero on CONFIRMED/CHECKED_IN
