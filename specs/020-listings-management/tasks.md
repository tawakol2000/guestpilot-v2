# Tasks: Listings Management Page

**Input**: Design documents from `/specs/020-listings-management/`
**Prerequisites**: plan.md, spec.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: US1 — View and Edit Listing Details (P1)

**Goal**: New Listings page with property cards, editable fields, per-listing Hostaway resync, remove old Settings KB editor.

**Independent Test**: Open Listings page. See all properties. Edit a field. Save. Resync. Verify.

- [X] T001 [US1] Add API functions to `frontend/lib/api.ts`: `apiGetProperties()` (list all properties with customKnowledgeBase), `apiUpdatePropertyKB(id, kb)` (update knowledge base), `apiResyncProperty(id)` (trigger Hostaway resync), `apiSummarizeDescription(id)` (summarize one), `apiSummarizeAll()` (batch). Also add `ApiProperty` type with id, name, address, customKnowledgeBase, listingDescription.
- [X] T002 [US1] Create `frontend/components/listings-v5.tsx` — full Listings page. Load properties via `apiGetProperties()`. Display each as a card with: header (property name + address), editable fields (doorCode, wifiName, wifiPassword, checkInTime, checkOutTime, houseRules, specialInstruction, keyPickup, cleaningFee, squareMeters, bedTypes, personCapacity, roomType, airbnbListingUrl, vrboListingUrl, bookingEngineUrl), save button per card, "Resync from Hostaway" button with confirm dialog. Use card layout similar to SOP page (design tokens from T object). Fields grouped logically: Access (door code, WiFi), Timing (check-in/out), Details (capacity, beds, sqm, fee), URLs (airbnb, vrbo, engine), Rules (house rules, special instructions).
- [X] T003 [US1] Add "Listings" tab to the main navigation in `frontend/components/inbox-v5.tsx` — alongside existing tabs (Overview, Inbox, Analytics, etc.). Import and render `ListingsV5` component when the tab is active.
- [X] T004 [US1] Remove `PropertyInfoEditor` component and its usage from `frontend/components/settings-v5.tsx`. Remove the "Listing Knowledge Base" section that currently renders property knowledge editing in the Settings page.

**Checkpoint**: Listings page shows all properties. Fields editable and saveable. Resync works. Old Settings KB editor removed.

---

## Phase 2: US2 — Classify Amenities (P2)

**Goal**: Each amenity has a 3-way toggle (Default/Available/On Request). AI uses classified lists.

**Independent Test**: Classify "Extra towels" as On Request. Ask AI for extra towels → offers to schedule. Classify "Pool" as Available → AI confirms it exists.

- [X] T005 [US2] Add amenities section to each property card in `frontend/components/listings-v5.tsx`: parse the `amenities` string from customKnowledgeBase into individual items, render each as a pill with a 3-way segmented toggle (Default / Available / On Request). Read current classifications from `customKnowledgeBase.amenityClassifications` (object mapping amenity name → "default"|"available"|"on_request"). On toggle change, update classifications and save via `apiUpdatePropertyKB`. Color coding: Default=grey, Available=green, On Request=amber.
- [X] T006 [US2] Update `backend/src/services/ai.service.ts` `buildPropertyInfo()`: read `amenityClassifications` from `customKnowledgeBase`. Split amenities into two lists: "Available Amenities" (classified as "available" or "default"/unclassified) and "On Request Amenities" (classified as "on_request"). Inject "Available Amenities: pool, AC, ..." into the property info section. Pass the on-request list separately for SOP injection.
- [X] T007 [US2] Update `backend/src/services/sop.service.ts`: when replacing `{PROPERTY_AMENITIES}` in the amenity-request SOP content, use only "on request" amenities instead of the full list. If no classifications exist, fall back to the full amenities string (backward compatible). Pass the on-request amenities via a new parameter in `getSopContent()` or extract from the property data already available.

**Checkpoint**: Amenity toggles visible. AI correctly distinguishes available vs on-request amenities.

---

## Phase 3: US3 — Summarize Property Descriptions (P3)

**Goal**: AI-powered summarization of property descriptions. Per-listing and batch.

**Independent Test**: Click Summarize on a property. Verify concise summary generated. Verify AI uses summary.

- [X] T008 [US3] Add summarization endpoint to `backend/src/routes/properties.ts`: `POST /api/properties/:id/summarize` — reads `listingDescription`, calls GPT-5.4 Mini with prompt "Summarize this property listing into a concise, factual paragraph (~100 words) for an AI assistant. Keep: location, nearby landmarks, transport, key features, capacity. Remove: marketing language, superlatives, booking calls-to-action.", saves result to `customKnowledgeBase.summarizedDescription`, copies original to `customKnowledgeBase.originalDescription` (if not already there). Returns `{ summary }`.
- [X] T009 [P] [US3] Add batch summarization endpoint to `backend/src/routes/properties.ts`: `POST /api/properties/summarize-all` — loops through all tenant properties, summarizes each, returns `{ count, summaries: [...] }`.
- [X] T010 [US3] Update `backend/src/services/ai.service.ts` `buildPropertyInfo()`: when building property context, use `customKnowledgeBase.summarizedDescription` if it exists, otherwise fall back to `listingDescription`. This is the description the AI sees.
- [X] T011 [US3] Add description section to each property card in `frontend/components/listings-v5.tsx`: show the summarized description (if exists) with a badge "Summarized". Collapsible "Original" section to view the full Hostaway description. "Summarize" button per card. "Restore Original" button that clears the summary. At the top of the page: "Summarize All Descriptions" button with progress indicator.

**Checkpoint**: Descriptions summarizable. AI uses concise summaries. Originals preserved.

---

## Phase 4: Polish & Verify

- [X] T012 Verify TypeScript compilation: `cd backend && npx tsc --noEmit`
- [X] T013 Verify frontend build: `cd frontend && npx next build`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (US1 — View/Edit): No dependencies — start immediately
- **Phase 2** (US2 — Amenities): Depends on Phase 1 (needs Listings page with property cards)
- **Phase 3** (US3 — Summarize): Depends on Phase 1 (needs Listings page). Parallel with Phase 2.
- **Phase 4** (Polish): Depends on all previous

### Execution Order

T001 → T002 → T003 → T004 (sequential — types, page, nav, cleanup)
T005 → T006 → T007 (sequential — UI, AI context, SOP injection)
T008 → T010 → T011 (sequential — endpoint, AI usage, UI)
T009 (parallel with T008 — batch endpoint)
T012, T013 (parallel — after all)

### Parallel Opportunities

- Phase 2 and Phase 3 backend tasks (T006-T007 and T008-T010) can run in parallel — different files
- T009 (batch endpoint) parallel with T008 (single endpoint)
