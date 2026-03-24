# Tasks: Prompt Template Variables

**Input**: Design documents from `/specs/021-prompt-template-variables/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup

**Purpose**: Create the variable registry and resolution service — the foundation everything builds on.

- [X] T001 Create `backend/src/services/template-variable.service.ts` — define the TEMPLATE_VARIABLES registry (8 variables, each with name, description, essential flag, agentScope, propertyBound). Export `resolveVariables(promptText, dataMap)` that: (1) scans prompt for `{VARIABLE_NAME}` patterns via `/\{([A-Z_]+)\}/g`, (2) builds ordered content blocks based on variable positions in prompt, (3) auto-appends essential variables (CURRENT_MESSAGES, PROPERTY_GUEST_INFO, CONVERSATION_HISTORY) if missing, (4) handles empty values with sensible defaults (e.g., "No open tasks."), (5) leaves unrecognized `{SOME_TEXT}` as-is. Also export `getAvailableVariables(agentType)` for the frontend editor. Note: if a variable appears multiple times in the prompt, each occurrence generates a separate content block (operator responsibility). Variables with empty data should use the empty-state defaults from data-model.md (some omit the block entirely, others render a placeholder like "No open tasks.").

**Checkpoint**: Variable registry exists and resolveVariables can be unit-tested in isolation.

---

## Phase 2: US1+US2 — Variable Injection Engine + Clean Static Prompt (Priority: P1)

**Goal**: Replace all hardcoded dynamic content with variable resolution. System prompt becomes static + cacheable, dynamic data becomes content blocks.

**Independent Test**: Send a guest message. Check AI Logs — system prompt should be static (no property data inline), dynamic data should appear as separate content blocks.

- [X] T002 [US2] Strip the `SEED_COORDINATOR_PROMPT` in `backend/src/services/ai.service.ts` of ALL dynamic content references. Keep only static behavioral instructions. Add `{VARIABLE}` references where the prompt currently describes data sections. Specific sections to strip: (1) the numbered list describing "1. CONVERSATION HISTORY", "2. PROPERTY & GUEST INFO", etc. (~lines 633-645), (2) the "Data rule:" and "History rule:" paragraphs that reference dynamic sections by name, (3) any paragraph saying "the following sections will be provided", (4) the inline scheduling logic references to CURRENT LOCAL TIME, (5) the DOCUMENT CHECKLIST instructions section (~lines 758-760). Replace each stripped section with a single variable reference block: "You will receive the following data as separate content blocks: {CONVERSATION_HISTORY}, {PROPERTY_GUEST_INFO}, {OPEN_TASKS}, {CURRENT_MESSAGES}, {CURRENT_LOCAL_TIME}, {DOCUMENT_CHECKLIST}, {AVAILABLE_AMENITIES}."
- [X] T003 [P] [US2] Strip the `SEED_SCREENING_PROMPT` in `backend/src/services/ai.service.ts` of ALL dynamic content references. Same approach as T002 but for screening agent. Exclude `{DOCUMENT_CHECKLIST}` and `{OPEN_TASKS}` (coordinator-only).
- [X] T004 [US1] Refactor the main AI pipeline in `backend/src/services/ai.service.ts` — replace the hardcoded `userMessage` assembly (lines ~1841-1848 that concatenate `### CONVERSATION HISTORY ###`, `### PROPERTY & GUEST INFO ###`, etc.) with a call to `resolveVariables()`. Pass the system prompt text + a data map built from existing variables (historyText, propertyInfo, openTasksText, currentMsgsText, localTime, documentChecklistText). The returned content blocks become the user message parts.
- [X] T005 [US1] Refactor `buildContentBlocks()` in `backend/src/services/ai.service.ts` (lines ~1320-1342) to use the new `resolveVariables()` from template-variable.service.ts instead of the current `{{variable}}` interpolation + `### ` splitting logic.
- [X] T006 [US1] Update the screening agent path in `backend/src/services/ai.service.ts` to also use `resolveVariables()` — the screening prompt assembly currently has its own hardcoded content block construction. Unify both agents through the same variable resolution path.
- [X] T007 [US1] Split `{AVAILABLE_AMENITIES}` and `{ON_REQUEST_AMENITIES}` — in `backend/src/services/ai.service.ts`, the `classifyAmenities()` output currently gets merged into `buildPropertyInfo()`. Extract the two lists as separate data map entries for the variable resolver. `{PROPERTY_GUEST_INFO}` should no longer contain amenity lists — those are now separate variables.
- [X] T008 [US1] Extract `{DOCUMENT_CHECKLIST}` — currently appended inline to `propertyInfo` (line ~1792). Move to its own data map entry so it resolves as a separate content block via the variable system.
- [X] T009 [US2] Add migration logic in `backend/src/services/tenant-config.service.ts` — in `getTenantAiConfig()`, after loading config, check if `systemPromptCoordinator` contains ≥3 distinct recognized variable names (e.g., `{CONVERSATION_HISTORY}`, `{CURRENT_MESSAGES}`, `{PROPERTY_GUEST_INFO}`). If fewer than 3 found, treat as legacy prompt and append the default variable reference block at the end. Bump `systemPromptVersion`. Must be idempotent — if the appended block is already present (check for a sentinel comment like `<!-- VARIABLES -->` at the end), skip.
- [X] T010 [US1] Update `backend/src/services/sop.service.ts` — rename `{PROPERTY_AMENITIES}` to `{ON_REQUEST_AMENITIES}` in the `applyTemplates()` function. Support both names as aliases (check for either pattern). Update the seed SOP content for `sop-amenity-request` to use `{ON_REQUEST_AMENITIES}`.

**Checkpoint**: Guest messaging works end-to-end with variable resolution. AI Logs show static system prompt + separate dynamic content blocks. No duplication.

---

## Phase 3: US3 — Prompt Editor Variable Awareness (Priority: P2)

**Goal**: The system prompt editor shows available variables, supports click-to-insert, and warns on missing essentials.

**Independent Test**: Open Configure AI, edit the system prompt. See variable reference panel. Remove `{CURRENT_MESSAGES}`, see warning on save.

- [ ] T011 [US3] Add API endpoint `GET /api/ai-config/template-variables` in `backend/src/routes/` (or existing ai-config route file) — returns the variable registry filtered by agent type (query param `?agent=coordinator|screening`). Each entry: `{ name, description, essential, propertyBound }`. Response should be <100ms (simple in-memory registry, no DB query).
- [ ] T012 [US3] Add variable reference panel to `frontend/components/configure-ai-v5.tsx` — next to each system prompt textarea, show a collapsible panel listing available variables with descriptions. Click a variable name to insert `{VARIABLE_NAME}` at the cursor position in the textarea.
- [ ] T013 [US3] Add missing-variable warning in `frontend/components/configure-ai-v5.tsx` — on save, scan the prompt text for essential variables (CURRENT_MESSAGES, PROPERTY_GUEST_INFO, CONVERSATION_HISTORY). If any are missing, show an amber warning: "Essential variable {X} is missing. The system will auto-append it." Allow save anyway (not blocking).
- [ ] T014 [P] [US3] Add `apiGetTemplateVariables(agentType)` function to `frontend/lib/api.ts` — calls the new endpoint from T011.

**Checkpoint**: Configure AI page shows variable panel, click-to-insert works, warnings appear for missing essentials.

---

## Phase 4: US4 — Per-Listing Variable Preview & Editor (Priority: P2)

**Goal**: Operators can view and customize property-bound variable output per listing.

**Independent Test**: Open Listings page, expand variable preview for a property. Add a custom title. Send a guest message for that property — verify custom title appears in AI context.

- [ ] T015 [US4] Add variable preview endpoint `GET /api/properties/:id/variable-preview` in `backend/src/routes/properties.ts` — returns resolved output for each property-bound variable (PROPERTY_GUEST_INFO, AVAILABLE_AMENITIES, ON_REQUEST_AMENITIES, DOCUMENT_CHECKLIST) using mock reservation data. Shows what the AI would see.
- [ ] T016 [US4] Update variable resolution in `backend/src/services/template-variable.service.ts` — add `applyPropertyOverrides(variableName, content, overrides)` that merges `customKnowledgeBase.variableOverrides` into the resolved output. If `customTitle` exists, prepend as a header. If `notes` exists, append after the auto-generated content.
- [ ] T017 [US4] Update `buildPropertyInfo()` in `backend/src/services/ai.service.ts` to read `customKnowledgeBase.variableOverrides.PROPERTY_GUEST_INFO` and apply overrides (custom title, notes) to the output.
- [ ] T018 [US4] Add `variableOverrides` to `USER_MANAGED_KEYS` in both `backend/src/services/import.service.ts` and `backend/src/routes/properties.ts` (resync endpoint) so per-listing customizations survive Hostaway resyncs.
- [ ] T019 [US4] Add variable preview section to `frontend/components/listings-v5.tsx` — new collapsible `Section` titled "Variable Preview" on each property card. Shows read-only preview of each property-bound variable's resolved output. Editable fields for `customTitle` and `notes` per variable. Save updates `customKnowledgeBase.variableOverrides` via existing `apiUpdateKnowledgeBase`.
- [ ] T020 [P] [US4] Add `apiGetVariablePreview(propertyId)` function to `frontend/lib/api.ts` — calls the new endpoint from T015.

**Checkpoint**: Listings page shows variable preview per property. Custom titles/notes appear in AI context for that property.

---

## Phase 5: Polish & Verify

- [ ] T021 Verify TypeScript compilation: `cd backend && npx tsc --noEmit`
- [ ] T022 Verify frontend build: `cd frontend && npx next build`
- [ ] T023 End-to-end test via Sandbox: send a guest message, verify AI Logs show clean variable-resolved prompt with no duplication. Also verify: (1) system prompt text is identical across multiple messages to the same tenant (confirms prompt caching preserved — no dynamic data inline), (2) edge case: temporarily set system prompt to just "You are Omar." (no variables) — verify CURRENT_MESSAGES, PROPERTY_GUEST_INFO, and CONVERSATION_HISTORY are auto-appended as content blocks

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (Setup): No dependencies — start immediately
- **Phase 2** (US1+US2): Depends on Phase 1 (needs template-variable.service.ts)
- **Phase 3** (US3): Depends on Phase 2 (needs working variable system + API endpoint)
- **Phase 4** (US4): Depends on Phase 2 (needs working variable resolution for previews)
- **Phase 5** (Polish): Depends on all previous

### Execution Order

T001 → T002 + T003 (parallel) → T004 → T005 → T006 → T007 → T008 → T009 → T010
T011 → T012 → T013 (T014 parallel with T011)
T015 → T016 → T017 → T018 → T019 (T020 parallel with T015)
T021, T022, T023 (sequential — after all)

### Parallel Opportunities

- T002 + T003 (different prompts, same file but independent sections)
- T011 + T014 (backend endpoint + frontend API wrapper)
- T015 + T020 (backend endpoint + frontend API wrapper)
- Phase 3 and Phase 4 can run in parallel after Phase 2 (different files)

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. Complete T001 (variable service)
2. Complete T002-T010 (injection engine + clean prompts + migration)
3. **STOP and VALIDATE**: Send messages via Sandbox, check AI Logs
4. This is fully functional — operators edit prompts manually with `{VARIABLES}`

### Incremental Delivery

1. Phase 1+2 → Variable system works, prompts clean → Deploy
2. Phase 3 → Editor UX with variable panel → Deploy
3. Phase 4 → Per-listing customization → Deploy
4. Each phase adds value without breaking previous
