# Tasks: Status-Aware SOP Variants

**Input**: Design documents from `/specs/015-sop-variants/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: US1 (status-aware content) and US4 (persistence) are tightly coupled — both P1, done together. US2 (management page) depends on the CRUD endpoints. US3 (property overrides) is P2.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Schema & Seed (Foundational)

**Purpose**: Add database models and seed existing SOP content into the DB.

- [X] T001 Add SopDefinition, SopVariant, and SopPropertyOverride models to `backend/prisma/schema.prisma` — SopDefinition has tenantId+category (unique), toolDescription, enabled. SopVariant has sopDefinitionId+status (unique), content, enabled. SopPropertyOverride has sopDefinitionId+propertyId+status (unique), content, enabled. Add relations to Tenant and Property. Add @@index on tenantId.

- [X] T002 Run `npx prisma db push` to apply the schema changes to the database.

- [X] T003 Create seed function in `backend/src/services/sop.service.ts` — add `seedSopDefinitions(tenantId, prisma)` that: (1) checks if SopDefinition records exist for the tenant, (2) if not, creates 22 SopDefinition records from the current hardcoded SOP_CATEGORIES + tool descriptions, (3) creates DEFAULT SopVariant for each with current SOP_CONTENT, (4) creates status-specific variants for the 8 SOPs that need them (sop-amenity-request, sop-early-checkin, sop-late-checkout, sop-cleaning, sop-wifi-doorcode, sop-visitor-policy, sop-booking-modification, pre-arrival-logistics) with differentiated content per INQUIRY/CONFIRMED/CHECKED_IN.

- [X] T004 Write the 8 status-variant content texts — for each of the 8 SOPs needing variants, write the actual INQUIRY, CONFIRMED, and CHECKED_IN procedure text. Base on the current DEFAULT content but adjust for the booking status context. Key differences per SOP documented in plan.md §SOPs Needing Variants table.

**Checkpoint**: Schema applied, seed function creates all SOPs with variants for a tenant.

---

## Phase 2: User Story 1+4 — Status-Aware SOP Retrieval + Persistence (Priority: P1) MVP

**Goal**: getSopContent() loads from DB with status-aware resolution. Tool schema built dynamically from DB.

**Independent Test**: Send "is there a baby crib?" as INQUIRY vs CHECKED_IN guest → different responses.

- [X] T005 [US1] Rewrite `getSopContent()` in `backend/src/services/sop.service.ts` — change from synchronous hardcoded map lookup to async DB query with resolution order: (1) property override for category+status, (2) property override for category+DEFAULT, (3) tenant variant for category+status, (4) tenant variant for category+DEFAULT, (5) empty string. Add 5-minute cache per tenant to avoid DB hit on every message. Keep the `{PROPERTY_AMENITIES}` template replacement. Export as `async function getSopContent(tenantId, category, reservationStatus, propertyId?, propertyAmenities?, prisma?)`.

- [X] T006 [US1] Rewrite `buildToolDefinition()` in `backend/src/services/sop.service.ts` — replace the hardcoded `SOP_TOOL_DEFINITION` constant with a dynamic function that loads enabled SopDefinitions from DB, builds the enum + description string from their categories and toolDescriptions. Cache per tenant (5-minute TTL). Export as `async function buildToolDefinition(tenantId, prisma)`. Invalidate cache when descriptions are edited.

- [X] T007 [US1] Update `classifyMessageSop()` in `backend/src/services/ai.service.ts` — replace `SOP_TOOL_DEFINITION` constant with `await buildToolDefinition(tenantId, prisma)`. Pass prisma instance through.

- [X] T008 [US1] Update `generateAndSendAiReply()` in `backend/src/services/ai.service.ts` — change `getSopContent(category, propertyAmenities)` call to `await getSopContent(tenantId, category, context.reservationStatus, context.propertyId, propertyAmenities, prisma)`. Pass the booking status so the correct variant is selected.

- [X] T009 [US1] Update `backend/src/routes/sandbox.ts` — change getSopContent calls to pass tenantId, reservationStatus (from sandbox config), and propertyId. Change SOP_TOOL_DEFINITION reference to `await buildToolDefinition(tenantId, prisma)`.

- [X] T010 [US4] Auto-seed on first access — in `getSopContent()` and `buildToolDefinition()`, if no SopDefinition records found for tenant, call `seedSopDefinitions(tenantId, prisma)` before proceeding. This ensures existing tenants get seeded transparently.

- [X] T011 [US1] Log variant used in ragContext — add `sopVariantStatus: string` field to ragContext in `ai.service.ts` showing which variant was actually selected (e.g., 'INQUIRY', 'DEFAULT', etc.).

**Checkpoint**: Sandbox shows different responses for INQUIRY vs CHECKED_IN for amenity requests. SOPs loaded from DB.

---

## Phase 3: User Story 2 — Interactive SOP Management Page (Priority: P1)

**Goal**: Operators can view, edit, enable/disable SOPs and variants from the frontend.

**Independent Test**: Edit an SOP variant's content → send a guest message → AI uses updated content.

### Backend CRUD

- [X] T012 [P] [US2] Add `GET /api/knowledge/sop-definitions` endpoint in `backend/src/routes/knowledge.ts` — return all SopDefinitions for tenant with their variants (include relation). Also return property list for dropdown. Trigger auto-seed if no definitions found.

- [X] T013 [P] [US2] Add `PUT /api/knowledge/sop-definitions/:id` endpoint — update toolDescription and/or enabled state. Invalidate the tenant's tool schema cache on save.

- [X] T014 [P] [US2] Add SopVariant CRUD endpoints in `backend/src/routes/knowledge.ts` — `PUT /sop-variants/:id` (update content/enabled), `POST /sop-variants` (create new variant for a status), `DELETE /sop-variants/:id` (delete variant). Invalidate SOP content cache on save.

- [X] T015 [P] [US2] Add cache invalidation helper in `backend/src/services/sop.service.ts` — export `invalidateSopCache(tenantId)` that clears both the content cache and tool schema cache for a tenant. Call from CRUD endpoints after writes.

### Frontend

- [X] T016 [P] [US2] Add SOP CRUD API functions to `frontend/lib/api.ts` — `apiGetSopDefinitions()`, `apiUpdateSopDefinition(id, data)`, `apiUpdateSopVariant(id, data)`, `apiCreateSopVariant(data)`, `apiDeleteSopVariant(id)`. Add TypeScript interfaces: `SopDefinitionResponse`, `SopVariantData`.

- [X] T017 [US2] Rewrite `frontend/components/sop-editor-v5.tsx` as full SOP management page — complete redesign with:
  (1) **Property dropdown** at top: "Global SOPs" (default) + tenant properties
  (2) **SOP table** with rows per category. Each row has:
    - SOP name as colored badge + enable/disable toggle
    - Tool description: inline editable text field with save button
    - Content area: status tabs (DEFAULT | INQUIRY | CONFIRMED | CHECKED_IN). Each tab shows the variant content in an editable textarea. Tab is grayed out if no variant exists for that status. "Add Variant" button to create one. Enable/disable toggle per variant.
  (3) **Visual indicators**: badge showing "3 variants" or "default only" per SOP
  (4) **Save feedback**: inline success/error messages on save
  (5) **Search/filter**: search box to filter SOPs by name or category
  Keep existing design tokens (T.bg, T.text, T.font, T.radius, T.shadow).

**Checkpoint**: SOP page shows all SOPs with variant tabs, inline editing works, changes take effect on next message.

---

## Phase 4: User Story 3 — Property-Specific Overrides (Priority: P2)

**Goal**: Operators can override SOP content per property.

**Independent Test**: Override cleaning SOP for Property A → Property A guest gets custom procedure, Property B guest gets global default.

- [X] T018 [P] [US3] Add property override CRUD endpoints in `backend/src/routes/knowledge.ts` — `GET /sop-property-overrides?propertyId=xxx` (list overrides for property), `POST /sop-property-overrides` (create override), `PUT /sop-property-overrides/:id` (update), `DELETE /sop-property-overrides/:id` (delete). Invalidate SOP cache on writes.

- [X] T019 [P] [US3] Add property override API functions to `frontend/lib/api.ts` — `apiGetSopPropertyOverrides(propertyId)`, `apiCreateSopPropertyOverride(data)`, `apiUpdateSopPropertyOverride(id, data)`, `apiDeleteSopPropertyOverride(id)`.

- [X] T020 [US3] Update SOP management page for property overrides in `frontend/components/sop-editor-v5.tsx` — when a property is selected from the dropdown, show property-specific overrides instead of global variants. Each SOP row shows: "(Global)" badge if using global, or editable override content if property override exists. "Add Override" button per SOP to create a property-specific version. "Remove Override" to revert to global.

**Checkpoint**: Property dropdown switches between global and property-specific SOPs. Overrides work correctly.

---

## Phase 5: Polish & Verification

- [X] T021 Run `npx prisma db push` to verify schema is clean
- [X] T022 Run `npx tsc --noEmit` in `backend/` — verify zero TypeScript errors
- [X] T023 Run frontend build — verify zero compilation errors
- [X] T024 Test via sandbox — send messages as INQUIRY, CONFIRMED, CHECKED_IN for amenity requests, verify different responses
- [X] T025 Commit all changes and push to `015-sop-variants` branch

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Schema)**: No dependencies — start immediately
- **Phase 2 (US1+US4)**: Depends on Phase 1 (schema must exist)
- **Phase 3 (US2)**: Depends on Phase 2 (needs working getSopContent + CRUD endpoints)
- **Phase 4 (US3)**: Depends on Phase 2 (needs resolution logic) + Phase 3 (needs UI foundation)
- **Phase 5 (Polish)**: Depends on ALL phases

### Parallel Opportunities

```
Phase 1: T001 → T002 → T003 → T004 (sequential — schema then seed)
Phase 2: T005 → T006 → T007 → T008 (sequential — same files, builds on each other)
          T009 (parallel with T007 — different file)
          T010 (after T005 — same file)
          T011 (after T008 — same file)
Phase 3: T012 ‖ T013 ‖ T014 ‖ T015 (all parallel — backend CRUD)
          T016 (after CRUD endpoints done — needs API shape)
          T017 (after T016 — uses API functions)
Phase 4: T018 ‖ T019 (parallel — backend + frontend API)
          T020 (after T018+T019 — uses both)
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. T001-T004: Schema + seed data with status variants
2. T005-T011: Status-aware retrieval + dynamic tool schema
3. **STOP and VALIDATE**: Sandbox shows different responses by booking status

### Management UI (Phase 3)

4. T012-T017: CRUD endpoints + full SOP management page
5. **STOP and VALIDATE**: Edit SOP content → changes reflected in AI responses

### Property Overrides (Phase 4)

6. T018-T020: Property override CRUD + UI
7. **STOP and VALIDATE**: Property-specific SOPs work

### Ship

8. T021-T025: Final checks + push

---

## Notes

- Total: 25 tasks across 5 phases
- MVP: 11 tasks (Phase 1 + Phase 2 — status-aware retrieval working)
- Main bottleneck: sop.service.ts rewrite (T005-T006, sequential — core logic)
- Biggest parallel win: Phase 3 backend CRUD (4 parallel endpoints)
- Schema migration: `prisma db push` (non-destructive — new tables only)
- getSopContent becomes async — all callers need await
- Tool schema cache: 5-minute TTL per tenant, invalidated on description edit
- SOP content cache: 5-minute TTL per tenant, invalidated on content edit
