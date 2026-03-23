# Tasks: Tools Management Page

**Input**: Design documents from `/specs/018-tools-management/`
**Prerequisites**: plan.md, spec.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Foundational — Schema + Service + Routes

**Purpose**: New ToolDefinition model, CRUD service with caching, REST endpoints, seed system tools.

- [X] T001 Add `ToolDefinition` model to `backend/prisma/schema.prisma` with fields: id, tenantId, name (unique per tenant), displayName, description (Text), defaultDescription (Text), parameters (Json), agentScope (String: screening/coordinator/both), type (String: system/custom), enabled (Boolean default true), webhookUrl (String?), webhookTimeout (Int default 10000), createdAt, updatedAt. Add relation to Tenant. Run `npx prisma db push`.
- [X] T002 Create `backend/src/services/tool-definition.service.ts` with: `getToolDefinitions(tenantId, prisma)` (cached 5min, returns enabled+disabled), `seedToolDefinitions(tenantId, prisma)` (upsert system tools with update:{} — never overwrite), `updateToolDefinition(id, updates, prisma)` (validate description min 10 chars, invalidate cache), `createCustomTool(tenantId, data, prisma)` (validate unique name, type='custom'), `deleteCustomTool(id, prisma)` (reject type='system'), `resetDescription(id, prisma)` (copy defaultDescription to description).
- [X] T003 [P] Create `backend/src/services/webhook-tool.service.ts` with: `callWebhook(url, input, timeoutMs)` — POST JSON to URL with axios, timeout handling, return response body as string. Graceful error: return JSON `{error: "webhook failed", details: "..."}` on timeout/network error.
- [X] T004 Create `backend/src/routes/tool-definitions.ts` with endpoints: `GET /api/tools` (list all for tenant), `PUT /api/tools/:id` (update description/enabled/webhookUrl), `POST /api/tools` (create custom tool), `DELETE /api/tools/:id` (delete custom only), `POST /api/tools/:id/reset` (reset description). All tenant-scoped via auth middleware.
- [X] T005 Register the tool-definitions router in `backend/src/app.ts`
- [X] T006 Define seed data for 5 system tools in `tool-definition.service.ts`: get_sop (both, description from current SOP tool), search_available_properties (screening), create_document_checklist (screening), check_extend_availability (coordinator), mark_document_received (coordinator). Include defaultDescription = description for each. Parameters from current hardcoded schemas.

**Checkpoint**: CRUD works via REST. System tools seeded on first access. Can create/edit/delete custom tools.

---

## Phase 2: US1 — View All Tools (P1)

**Goal**: Tools page shows all tools from DB with full details.

**Independent Test**: Open Tools page. See all 5 system tools with descriptions, agent scope, parameters.

- [X] T007 [US1] Add `ApiToolDefinition` type and API functions to `frontend/lib/api.ts`: `apiGetTools()`, `apiUpdateTool(id, data)`, `apiCreateTool(data)`, `apiDeleteTool(id)`, `apiResetToolDescription(id)`.
- [X] T008 [US1] Rewrite `frontend/components/tools-v5.tsx` — replace hardcoded AVAILABLE_TOOLS with `apiGetTools()` fetch on mount. Render tool cards in a grid: each card shows name, displayName, type badge (system/custom), agentScope badge, enabled toggle, description text, expandable parameter schema (formatted JSON). No edit functionality yet (read-only this phase).

**Checkpoint**: All system tools visible with real data from DB. Custom tools (if any) also appear.

---

## Phase 3: US2 — Edit Tool Descriptions (P2)

**Goal**: Inline-edit descriptions, save to DB, reset to default.

**Independent Test**: Edit a tool description. Refresh. Verify change persisted. Reset to default. Verify restored.

- [X] T009 [US2] Add inline editing to tool cards in `frontend/components/tools-v5.tsx`: clicking description makes it a textarea, save button calls `apiUpdateTool`, cancel reverts. Show "modified" indicator when description differs from defaultDescription. Add "Reset to Default" link that calls `apiResetToolDescription`.

**Checkpoint**: Descriptions editable and persisted. Reset works.

---

## Phase 4: US3 — Enable/Disable Tools (P3)

**Goal**: Toggle tools on/off with immediate effect on AI.

**Independent Test**: Disable `check_extend_availability`. In sandbox, ask about extending stay. AI should NOT call the tool.

- [X] T010 [US3] Wire enable/disable toggle in tool cards in `frontend/components/tools-v5.tsx` to call `apiUpdateTool(id, { enabled: !current })`. Show warning modal when toggling `get_sop` (core classification tool).
- [X] T011 [US3] Replace hardcoded tool arrays in `backend/src/services/ai.service.ts` — load tool definitions from `getToolDefinitions()`, filter by enabled + agentScope. Build the `toolsForCall` array dynamically from DB definitions instead of hardcoded `screeningTools`/`coordinatorTools`. Keep existing handler Map but match by name. Add fallback: if tool not found in handlers and has webhookUrl, call `callWebhook()`.
- [X] T012 [US3] Update `backend/src/routes/sandbox.ts` — same as T011, replace hardcoded tool arrays with `getToolDefinitions()` + dynamic building. Match handlers by name, webhook fallback for custom tools.

**Checkpoint**: Disabled tools not available to AI. Enabled tools work as before. Sandbox mirrors production.

---

## Phase 5: US4 — Add Custom Tools (P4)

**Goal**: Create custom tools with webhook URLs via the UI.

**Independent Test**: Create a custom tool with a webhook URL. In sandbox, trigger it. Verify webhook receives the call.

- [X] T013 [US4] Add "Add Custom Tool" button and modal to `frontend/components/tools-v5.tsx`: fields for name (slug format), displayName, description (textarea), agentScope (dropdown), webhookUrl (text input), parameters (monospace JSON editor textarea with JSON.parse validation on save). Save calls `apiCreateTool`. Show validation errors inline.
- [X] T014 [US4] Add delete button on custom tool cards in `frontend/components/tools-v5.tsx` with confirmation. Calls `apiDeleteTool`. System tools show no delete button.

**Checkpoint**: Custom tools creatable, appear in grid, callable by AI via webhook, deletable.

---

## Phase 6: US5 — Tool Invocation Logs (P5)

**Goal**: Show recent tool invocations for all tools.

**Independent Test**: After AI calls tools, see invocations in the log section.

- [X] T015 [US5] Keep existing invocation log in `frontend/components/tools-v5.tsx` but ensure it shows ALL tool invocations (not just property search). The existing `apiGetToolInvocations()` endpoint already returns all tools from ragContext — verify and fix if needed.

**Checkpoint**: All tool calls visible in the log section.

---

## Phase 7: Polish & Verify

- [X] T016 Verify TypeScript compilation: `cd backend && npx tsc --noEmit`
- [X] T017 Verify frontend build: `cd frontend && npx next build`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (Foundational): No dependencies — start immediately
- **Phase 2** (US1 — View): Depends on Phase 1 (needs service + API types)
- **Phase 3** (US2 — Edit): Depends on Phase 2 (needs tool cards)
- **Phase 4** (US3 — Toggle): Depends on Phase 1 (needs service) + Phase 2 (needs UI)
- **Phase 5** (US4 — Custom): Depends on Phase 4 (needs DB-driven tools in AI pipeline)
- **Phase 6** (US5 — Logs): Independent of US2-4, depends on Phase 2 (needs page)
- **Phase 7** (Polish): Depends on all previous

### Execution Order

T001 → T002 → T006 (sequential — schema, service, seed data)
T003 (parallel with T002 — different file)
T004 → T005 (sequential — routes, registration)
T007 → T008 (sequential — types then UI)
T009 (after T008)
T010 (after T008)
T011, T012 (parallel — different files, after T002)
T013 → T014 (sequential — create then delete)
T015 (after T008)
T016, T017 (parallel — after all)
