---
description: "Task list for Autopilot Shadow Mode — dependency-ordered, grouped by user story"
---

# Tasks: Autopilot Shadow Mode for AI Tuning

**Input**: Design documents from `/specs/040-autopilot-shadow-mode/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: Not requested. No test tasks generated. Manual verification via quickstart.md.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and shipped independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks in the same phase)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths are specified in every task

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the feature branch is ready. No new dependencies needed — every library this feature uses (Prisma, OpenAI SDK, Socket.IO, shadcn/ui) is already installed in the existing monorepo.

- [X] T001 Verify branch `040-autopilot-shadow-mode` is checked out and clean-based on main, and that `cd backend && npm run dev` + `cd frontend && npm run dev` both start cleanly against the current schema before any edits

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Apply the Prisma schema changes that every user story depends on. Both tasks modify the same file or depend strictly on each other and MUST run sequentially.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Apply data model changes to `backend/prisma/schema.prisma` per `specs/040-autopilot-shadow-mode/data-model.md`: add `PreviewState`, `TuningActionType`, `TuningSuggestionStatus` enums; extend `Message` model with 4 nullable columns (`previewState PreviewState?`, `originalAiText String? @db.Text`, `editedByUserId String?`, `aiApiLogId String?`) and add `@@index([conversationId, previewState])`; extend `TenantAiConfig` with `shadowModeEnabled Boolean @default(false)`; add new `TuningSuggestion` model with all fields, indexes, and relations from data-model.md §3 (cascade delete to Tenant and Message)
- [X] T003 Run `cd backend && npx prisma db push && npx prisma generate` to apply schema changes to the dev database and regenerate the Prisma client; verify the generated client exposes the new enums and the `tuningSuggestion` model

**Checkpoint**: Schema is live. All four user stories can begin.

---

## Phase 3: User Story 1 — See copilot replies as previews inside the inbox (Priority: P1) 🎯 MVP

**Goal**: Toggle in settings turns on Shadow Mode. Copilot AI replies get rendered as in-chat preview bubbles instead of the legacy suggestion-card UI. Autopilot is completely untouched. No preview-related actions yet — this story is read-only observation.

**Independent Test**: Enable the Shadow Mode toggle on a test tenant, send a guest message on a **copilot** reservation, confirm the AI's reply appears as a yellow-outlined "Not sent to guest" bubble in the inbox within the normal debounce window. Confirm that autopilot reservations on the same tenant are unaffected (still send directly to guests).

### Implementation for User Story 1

- [X] T004 [P] [US1] Extend `backend/src/controllers/tenant-config.controller.ts` update handler to accept and persist the new `shadowModeEnabled` boolean field in the PATCH body; invalidate the tenant-config cache on change (reuses existing cache-invalidation pattern in the same controller)
- [X] T005 [P] [US1] Create `backend/src/services/shadow-preview.service.ts` exporting `lockOlderPreviews(prisma, tenantId, conversationId): Promise<string[]>` that runs a single Prisma `updateMany` setting `previewState = 'PREVIEW_LOCKED'` WHERE `tenantId`, `conversationId`, and `previewState = 'PREVIEW_PENDING'`, then returns the ids of the rows it just locked (use a preceding `findMany` + update by id list, since `updateMany` does not return updated rows in Prisma)
- [X] T006 [US1] Modify **the existing copilot branch** in `backend/src/services/ai.service.ts` at ~line 2099-2108 (currently: `if (context.aiMode === 'copilot') { ...PendingAiReply.update + ai_suggestion broadcast... return; }`). Restructure so: (a) at the top of the copilot branch, check `if (tenantConfig.shadowModeEnabled)`; (b) if true, run the NEW preview flow — call `lockOlderPreviews` from T005 and capture the returned locked ids, create the Message row via `prisma.message.create` with `previewState: 'PREVIEW_PENDING'`, `originalAiText: guestMessage`, `aiApiLogId` populated from the in-scope AiApiLog id (add a plumbing change to capture that id into a local variable if it's not already in scope), broadcast `'shadow_preview_locked'` via `broadcastCritical(tenantId, 'shadow_preview_locked', { conversationId, lockedMessageIds })`, broadcast the preview via the existing `'message'` event with the extended payload from T007, then `return`; (c) if `shadowModeEnabled` is false, **fall through to the existing legacy logic unchanged** — `PendingAiReply.update` + `ai_suggestion` broadcast + return. **Do NOT touch autopilot at all**: the outer `if (context.aiMode === 'copilot')` guard is preserved. Autopilot continues to send replies directly to guests via the existing code path below the copilot branch. Do NOT touch any code downstream of the copilot branch.
- [X] T007 [US1] Extend the existing `broadcastCritical(tenantId, 'message', ...)` call in `backend/src/services/ai.service.ts` (the one currently at ~line 2137-2142) so the nested `message` object always includes `id: savedMessage.id`, and conditionally includes `previewState`, `originalAiText`, `editedByUserId` when the Message row carries them. This is used by both the normal send path and the new shadow-mode branch from T006
- [X] T008 [P] [US1] Extend `apiUpdateTenantAiConfig` in `frontend/lib/api.ts` to include `shadowModeEnabled?: boolean` in the PATCH payload shape; extend `apiGetTenantAiConfig` response type to include the same field
- [X] T009 [P] [US1] Add a Shadow Mode toggle row to `frontend/components/configure-ai-v5.tsx` bound to `tenantConfig.shadowModeEnabled`. Place it near the bottom under a new "Tuning" subsection heading. Toggle onChange calls `apiUpdateTenantAiConfig` with the new value and optimistically updates local state. Include a short helper text: "Render **copilot** AI replies as in-chat preview bubbles (instead of the legacy suggestion-card UI) and fire the tuning analyzer on edited sends. Does not affect autopilot. For tuning sessions only."
- [X] T010 [P] [US1] Extend the `Message` TypeScript interface in `frontend/components/inbox-v5.tsx` (currently defined around lines 147-156 per prior research — verify first) to add `id: string` and optional `previewState?: 'PREVIEW_PENDING' | 'PREVIEW_LOCKED' | 'PREVIEW_SENDING'`, `originalAiText?: string`, `editedByUserId?: string` fields. Update the socket `'message'` event handler to read and store these new fields when they're present on incoming payloads
- [X] T011 [US1] Add preview-bubble rendering to the message map in `frontend/components/inbox-v5.tsx`: when `message.previewState === 'PREVIEW_PENDING'` or `'PREVIEW_LOCKED'`, render the bubble with reduced opacity + a yellow "Not sent to guest" pill label in the header row. Use the same bubble shape as a normal AI message so the layout is stable. Do NOT add Send/Edit buttons yet — those land in US2
- [X] T012 [US1] Add a `'shadow_preview_locked'` socket handler in `frontend/components/inbox-v5.tsx` (or the shared `frontend/lib/socket.ts` if that's where handlers are registered in the existing pattern). On receipt, for each id in `lockedMessageIds`, update the local messages state to set `previewState: 'PREVIEW_LOCKED'`. In-progress edit discard lives in US2

**Checkpoint**: Toggle the Shadow Mode setting on, send a guest message to a **copilot** reservation, and watch a preview bubble land in the inbox (instead of the legacy suggestion card). Confirm autopilot reservations are unchanged. US1 is independently shippable here — inert observation only.

---

## Phase 4: User Story 2 — Send or edit the most recent preview (Priority: P1)

**Goal**: The most recent preview in each conversation gets Send and Edit buttons. Send delivers the current text to the guest via the existing Hostaway pipeline and transitions the preview into a normal sent AI message. Older previews stay visible but inert. In-progress edits discard automatically when a newer preview supersedes them.

**Independent Test**: Generate two previews in sequence on the same conversation, confirm only the latest preview has Send/Edit buttons; edit the latest, click Send, confirm the guest receives the edited text and the bubble becomes a normal sent AI message; separately, start editing a preview and trigger a new guest message to confirm the in-progress edit is discarded with a toast.

### Implementation for User Story 2

- [X] T013 [P] [US2] Create `backend/src/controllers/shadow-preview.controller.ts` with a `sendShadowPreview` handler per `specs/040-autopilot-shadow-mode/contracts/rest-api.md §2`. Behavior: load Message by `:messageId`, verify `tenantId` matches the JWT claim, run a Prisma conditional UPDATE (`updateMany` with `where: { id, previewState: 'PREVIEW_PENDING' }`, set `previewState: 'PREVIEW_SENDING'`, and if `req.body.editedText` is provided also set `content: editedText` and `editedByUserId: req.userId`); if `count === 0` return 409 with `PREVIEW_NOT_PENDING`; otherwise call `hostawayService.sendMessageToConversation` with the final content; on success update the row to set `previewState: null`, `hostawayMessageId: <hostaway id>`, `sentAt: now()` and broadcast the `'message'` event with the final state; on Hostaway failure update the row back to `previewState: 'PREVIEW_PENDING'` and return 502 `HOSTAWAY_DELIVERY_FAILED`. Return the 200 payload shape from the contract with `analyzerQueued: (content !== originalAiText)`. **Do not call the tuning analyzer yet — that wiring lands in T021 during US3.**
- [X] T014 [P] [US2] Create `backend/src/routes/shadow-preview.routes.ts` mounting `POST /api/shadow-previews/:messageId/send` → `sendShadowPreview` handler with the existing JWT auth middleware
- [X] T015 [US2] Register the new `shadow-preview.routes` in the main Express app wiring (locate the existing `app.use('/api/...', ...)` block in `backend/src/index.ts` or `backend/src/app.ts` and add the new router mount)
- [X] T016 [P] [US2] Add `apiSendShadowPreview(messageId: string, editedText?: string): Promise<SendResult>` to `frontend/lib/api.ts` calling `POST /api/shadow-previews/:messageId/send`. Return type matches the contract's 200 payload
- [X] T017 [US2] Add Send and Edit buttons to the preview bubble renderer in `frontend/components/inbox-v5.tsx`. Compute "latest preview per conversation" client-side by iterating the current messages array and tracking the last message with `previewState === 'PREVIEW_PENDING'`. Render Send + Edit ONLY on that message — all other previews (including `PREVIEW_LOCKED`) stay inert. Edit opens an inline textarea pre-filled with `message.content`. Send button calls `apiSendShadowPreview(messageId, editedText)`: on 200 success, optimistically clear `previewState` on the local message; on 409 show a toast "This preview has already been superseded" and leave state as-is; on 502 show a toast "Send failed — guest channel rejected the message" and leave the bubble actionable for retry
- [X] T018 [US2] Handle in-progress edit discard on the `'shadow_preview_locked'` socket event (extend the handler from T012 in `frontend/components/inbox-v5.tsx`): if the user has an open edit buffer on any id in `lockedMessageIds`, clear the edit buffer and show a toast notification: "A newer preview replaced the one you were editing."

**Checkpoint**: User Story 1 + User Story 2 together form a complete manual-approval shadow-mode loop: observe, optionally edit, send. Zero analyzer involvement yet. Shippable as-is if you want to ship tuning-manual without automated suggestions.

---

## Phase 5: User Story 3 — AI suggests tuning changes based on operator edits (Priority: P2)

**Goal**: When a preview is sent with edits, a fire-and-forget analyzer diagnoses the root cause(s) of the edit and produces concrete tuning suggestions across system prompts, SOPs, SOP routing, and FAQs — as EDIT or CREATE actions. Suggestions surface in a new Tuning tab in AI settings where the admin can accept, edit-then-accept, or reject each one.

**Independent Test**: Edit a preview meaningfully (changing semantic content), click Send, open the new Tuning tab, verify at least one suggestion appears within 30 seconds showing an action type, rationale, before/proposed diff, and working Accept / Edit-and-Accept / Reject buttons. Accept one and verify the referenced artifact (system prompt, SOP, or FAQ) reflects the change on the next AI generation.

### Implementation for User Story 3

- [X] T019 [P] [US3] Create `backend/src/services/tuning-analyzer.service.ts` exporting `analyzePreview(messageId: string): Promise<void>`. Implementation: (1) load the Message row with its linked `AiApiLog` (via `message.aiApiLogId`); (2) extract analyzer context — conversation history (last 40 messages), `originalAiText`, final `content`, the `systemPrompt` and `userContent` fields from `AiApiLog`, the `ragContext.sopClassification` showing which SOPs were consulted and at what resolution level, the `ragContext.tools` tool-call trace, and the full FAQ list reachable for the conversation's property; (3) build a single prompt instructing the model to diagnose root cause(s) then propose zero or more tuning suggestions; (4) call OpenAI Responses API using **`gpt-5.4-mini-2026-03-17` with `reasoning: "high"`** (matching the pattern used for `TenantAiConfig.reasoningCoordinator` in the main pipeline) and `strict: true` json_schema from T020; (5) validate each returned suggestion against the required-field matrix from data-model.md §3; (6) insert all valid `TuningSuggestion` rows in a single Prisma transaction; (7) broadcast `'tuning_suggestion_created'` with the new suggestion ids and `sourceMessageId` + `conversationId`. **Entire function wrapped in a single try/catch that logs errors via `console.warn` and returns silently — fire-and-forget per constitution §I.**
- [X] T020 [P] [US3] Define the analyzer's strict json_schema as a const `TUNING_ANALYZER_SCHEMA` in `backend/src/services/tuning-analyzer.service.ts` matching the discriminated-union over `actionType` from data-model.md §3. Schema shape: `{ type: "array", items: oneOf([SystemPromptEditSchema, SopContentEditSchema, SopRoutingEditSchema, FaqEditSchema, SopCreateSchema, FaqCreateSchema]) }` where each sub-schema has a `const` discriminator on `actionType` and the required fields listed in the required-field matrix
- [X] T021 [US3] Wire the analyzer trigger into the `sendShadowPreview` handler from T013 in `backend/src/controllers/shadow-preview.controller.ts`: after the successful Hostaway delivery block, if `finalContent !== originalAiText`, call `tuningAnalyzerService.analyzePreview(messageId).catch(err => console.warn('[tuning-analyzer] failed:', err.message))` as a fire-and-forget promise. The HTTP response MUST NOT wait for the analyzer
- [X] T022 [P] [US3] Create `backend/src/controllers/tuning-suggestion.controller.ts` with three handlers per contracts/rest-api.md §3-§5: (a) `listTuningSuggestions` — GET with optional `status`, `limit`, `cursor` query params, filters by `tenantId` from JWT, joins the source Message to resolve `sourceConversationId`, returns `{ suggestions, nextCursor }`; (b) `acceptTuningSuggestion` — POST /accept, accepts optional action-type-specific edit fields in body (`editedText` for EDIT_* actions, `editedContent` + `editedToolDescription` for CREATE_SOP, `editedQuestion` + `editedAnswer` for CREATE_FAQ), normalizes them into an `appliedPayload` JSON per action type per contracts/rest-api.md §4, dispatches to the per-action-type apply function from T023, marks status ACCEPTED, sets `appliedAt` / `appliedPayload` / `appliedByUserId`, broadcasts `'tuning_suggestion_updated'`, returns `{ ok, suggestion, targetUpdated }`; (c) `rejectTuningSuggestion` — POST /reject, marks status REJECTED, broadcasts `'tuning_suggestion_updated'`. All three scope by `tenantId` and return 404 on cross-tenant access attempts
- [X] T023 [US3] Implement the per-action-type Accept dispatcher inside `acceptTuningSuggestion` in `backend/src/controllers/tuning-suggestion.controller.ts`, normalizing the request body into an `appliedPayload` JSON per action type and storing it on the suggestion row: (a) `EDIT_SYSTEM_PROMPT` → write final text to `TenantAiConfig.systemPromptCoordinator` or `systemPromptScreening` based on `systemPromptVariant`; append an entry to `systemPromptHistory` JSON; bump `systemPromptVersion`; `appliedPayload = { text }`; (b) `EDIT_SOP_CONTENT` → resolve target tier (if `sopPropertyId` set → update `SopPropertyOverride`, else update `SopVariant` by category+status) and write the new content; `appliedPayload = { text }`; (c) `EDIT_SOP_ROUTING` → update `SopDefinition.toolDescription` by category; `appliedPayload = { text }`; (d) `EDIT_FAQ` → update `FaqEntry` by id, writing the applied text into the answer field by default; `appliedPayload = { text, field: 'answer' }`; (e) `CREATE_SOP` → upsert `SopDefinition` by category, create `SopVariant` for the specified status with the proposed content, optionally create `SopPropertyOverride` if `sopPropertyId` is set; `appliedPayload = { content, toolDescription }`; (f) **`CREATE_FAQ` → create `FaqEntry` with `status: 'ACTIVE'` and `source: 'MANUAL'`** (NOT `AUTO_SUGGESTED` — the admin has explicitly approved via the Tuning tab, so the entry is not auto-suggested in the Constitution §VIII sense), scope/category/question/answer from the suggestion payload (with any admin edits); `appliedPayload = { question, answer }`. Reuse existing service functions (`faqService.createEntry`, SOP update helpers, etc.) rather than raw Prisma writes wherever possible. On any failure throw — the caller returns 500 and the suggestion stays PENDING
- [X] T024 [P] [US3] Create `backend/src/routes/tuning-suggestion.routes.ts` mounting `GET /api/tuning-suggestions`, `POST /api/tuning-suggestions/:id/accept`, `POST /api/tuning-suggestions/:id/reject` with the existing JWT auth middleware
- [X] T025 [US3] Register the new `tuning-suggestion.routes` in the main Express app wiring (same file as T015)
- [X] T026 [P] [US3] Add `apiListTuningSuggestions(status?, limit?, cursor?)`, `apiAcceptTuningSuggestion(id, body?)`, `apiRejectTuningSuggestion(id)` to `frontend/lib/api.ts`, matching the REST contract response shapes
- [X] T027 [P] [US3] Create `frontend/components/tuning-review-v5.tsx`: on mount, fetch pending suggestions via `apiListTuningSuggestions({ status: 'PENDING' })` and group by `sourceMessageId` for display. Each suggestion card shows: action-type badge, rationale paragraph, before/proposed diff (EDIT actions) or proposed new-artifact fields form (CREATE actions), target reference label ("Coordinator prompt" / "SOP sop-checkin @ CONFIRMED / property 1234" / "FAQ entry #abc"), and three buttons: Accept, Edit & Accept (inline textarea, then POST), Reject. Accept/Reject calls use the API functions from T026 and update local state on 200. Component subscribes to `'tuning_suggestion_created'` (prepends new suggestions) and `'tuning_suggestion_updated'` (syncs status changes) socket events
- [X] T028 [US3] Register the new Tuning tab in the AI settings tab wrapper component (locate the component that currently renders the Configure AI / SOPs / FAQs / AI Logs tabs — likely in `frontend/app/settings/` or `frontend/components/ai-settings-*.tsx`) and add a new "Tuning" entry that mounts `tuning-review-v5.tsx`. Tab MUST remain visible regardless of the `shadowModeEnabled` toggle state (per FR-027)

**Checkpoint**: Edit a preview, send it, and within 30 seconds see a tuning suggestion appear in the Tuning tab. Accept it and verify the target artifact updated. US3 is independently shippable on top of US1+US2.

---

## Phase 6: User Story 4 — Turn Shadow Mode off when tuning is done (Priority: P3)

**Goal**: Disabling the toggle restores the legacy copilot suggestion-card flow for subsequent copilot replies while preserving historical previews and all captured tuning suggestions for retrospective review. Autopilot is unchanged in either toggle state.

**Independent Test**: Disable Shadow Mode, trigger a new copilot reply, confirm it flows through the legacy `ai_suggestion` event / suggestion-card UI instead of the preview bubble; revisit an old conversation that has preview bubbles from when Shadow Mode was on, confirm they're still rendered and the Tuning tab still lists previously captured suggestions.

Most of US4's functionality falls out of US1-US3 naturally: flipping `shadowModeEnabled` to `false` bypasses the interception branch from T006, and the Tuning tab from T028 is already toggle-agnostic. This phase is verification + one small guardrail.

### Implementation for User Story 4

- [X] T029 [US4] In `frontend/components/tuning-review-v5.tsx` from T027, display a small banner at the top when `tenantConfig.shadowModeEnabled === false`: "Shadow Mode is currently off. Historical suggestions remain actionable below." — this confirms to the admin that the tab is functioning as expected in disabled state. Pull `shadowModeEnabled` from the same tenant-config hook used by configure-ai-v5
- [ ] T030 [US4] Manually verify per quickstart.md §6: flip Shadow Mode off; trigger a new AI reply on a **copilot** reservation; confirm it flows through the legacy suggestion-card path (PendingAiReply.suggestion + `ai_suggestion` event) and does NOT appear as a preview bubble. Separately confirm an autopilot reservation still delivers directly to the guest (unchanged behavior)
- [ ] T031 [US4] Manually verify per quickstart.md §6: historical preview bubbles from the Shadow Mode ON period continue to render inside conversations as inert (locked or latest-still-pending) bubbles with no visual regression, and the Tuning tab lists previously captured suggestions with working Accept / Reject / Edit-and-Accept actions

**Checkpoint**: All four user stories independently functional. Shadow Mode can be safely flipped on and off repeatedly without data loss or UI breakage.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T032 [P] Update `CLAUDE.md` "Key Services" table to add two rows: `shadow-preview.service.ts` (preview lifecycle + lock-older helper) and `tuning-analyzer.service.ts` (fire-and-forget analyzer for edited previews)
- [ ] T033 [P] Run the full verification checklist at the bottom of `specs/040-autopilot-shadow-mode/quickstart.md` against a live test tenant with Shadow Mode enabled and tick each box
- [ ] T034 [P] Verify constitution gates post-merge: (§I) analyzer failures caught and logged without blocking Send; (§II) all 4 new endpoints scope by `tenantId` from JWT and reject cross-tenant access; (§VI) preview generation still writes an `AiApiLog` entry identical to normal sends, and the analyzer itself writes its own AiApiLog entry via the OpenAI call wrapper; (§VIII) FAQ auto-suggest path in `messages.controller.ts` is completely untouched and does not run on shadow-preview sends; **(§VIII continued) CREATE_FAQ accept path writes `source='MANUAL'` (not `'AUTO_SUGGESTED'`) in the committed code, so tuning-accepted FAQ entries fall outside Principle VIII's "auto-suggested entries MUST have status=SUGGESTED" rule**
- [X] T035 Run `cd backend && npm run build && cd ../frontend && npm run build` to catch any TypeScript errors across the full feature surface before merge

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: T001 — no dependencies.
- **Phase 2 (Foundational)**: T002 → T003. Both block every user story.
- **Phase 3 (US1)**: depends on Phase 2. Independently shippable as "observe-only" MVP.
- **Phase 4 (US2)**: depends on Phase 2 and on T006 from US1 (needs previews to exist before adding Send/Edit). Independently shippable on top of US1.
- **Phase 5 (US3)**: depends on Phase 2 and on T013 from US2 (analyzer wiring lives inside the Send handler). Independently shippable on top of US1+US2.
- **Phase 6 (US4)**: depends on Phase 2 (cross-cuts all preceding stories). Largely verification.
- **Phase 7 (Polish)**: depends on whichever stories you intend to ship.

### User Story Dependencies

- **US1 (P1)** is fully independent given Phase 2. Viable MVP shipping just T001–T012.
- **US2 (P1)** requires US1's interception branch (T006) because there must be `PREVIEW_PENDING` Messages for Send/Edit to operate on. Can be built in parallel with US1 as long as T006 lands first.
- **US3 (P2)** requires T013 from US2 (the Send handler is where the analyzer trigger lives). Apart from that one hook, T019–T028 can be built entirely in parallel with US1+US2.
- **US4 (P3)** is purely verification + one UI banner. Can start as soon as Phase 2 ends, but the manual verification tasks (T030, T031) only yield a meaningful result after US1+US3 land.

### Within Each User Story

- Models / schema → services → controllers → routes → frontend types → frontend components → frontend wiring.
- Backend + frontend tasks for the same story can run in parallel if they're marked [P].
- Tasks in the same file are sequential (e.g. T006 + T007 both touch `ai.service.ts`; T010 + T011 + T012 + T017 + T018 all touch `inbox-v5.tsx`).

### Parallel Opportunities

- Phase 2 is strictly sequential (same file + prisma db push ordering).
- Phase 3 (US1): T004, T005, T008, T009, T010 can run in parallel (distinct files). T006 depends on T005. T007 must wait for T006 (same file). T011 depends on T010 (same file). T012 can run with T011.
- Phase 4 (US2): T013, T014, T016 can run in parallel. T015 depends on T014 (app wiring must know the router exists). T017 + T018 are sequential in the same frontend file.
- Phase 5 (US3): T019 + T020 are in the same file — do T020 first (schema) then T019 (implementation). T021 depends on T013 from US2. T022, T024, T026, T027 are parallel. T023 is inside T022's file. T025 depends on T024. T028 depends on T027.
- Phase 6 (US4): T029 is a quick UI change. T030 and T031 are manual verifications — run after US1+US3 are in place.
- Phase 7: T032, T033, T034 are independent. T035 should run last.

---

## Parallel Example: User Story 1 (MVP)

```bash
# After Phase 2 completes, kick off US1 backend + frontend work in parallel:

# Backend track (parallel at start, then sequential as files collide):
Task T004 — Extend tenant-config update controller          (backend/src/controllers/tenant-config.controller.ts)
Task T005 — Create shadow-preview.service.ts helper          (backend/src/services/shadow-preview.service.ts)
  ↓ (T006 waits for T005)
Task T006 — Add shadow-mode branch to ai.service.ts          (backend/src/services/ai.service.ts)
  ↓ (T007 same file as T006, sequential)
Task T007 — Extend 'message' broadcast to include messageId  (backend/src/services/ai.service.ts)

# Frontend track (all parallel, different files or different sections):
Task T008 — apiUpdateTenantAiConfig payload extension         (frontend/lib/api.ts)
Task T009 — Shadow Mode toggle row                            (frontend/components/configure-ai-v5.tsx)
Task T010 — Extend Message TS interface                       (frontend/components/inbox-v5.tsx)
  ↓ (T011 same file as T010, sequential)
Task T011 — Preview bubble renderer
Task T012 — 'shadow_preview_locked' socket handler            (frontend/components/inbox-v5.tsx or lib/socket.ts)
```

---

## Implementation Strategy

### MVP First (just US1)

1. Run Phase 1 (T001).
2. Run Phase 2 (T002, T003). Schema live.
3. Run Phase 3 (T004–T012). Preview-rendering works.
4. **STOP and validate**: flip toggle on, trigger a message, confirm the preview lands in the inbox and nothing reaches the guest.
5. Optional: stop here if you just want observation and will manually approve via Hostaway direct.

### Incremental delivery

1. Phase 1 + Phase 2 → foundation ready.
2. Phase 3 (US1) → observe-only MVP ready.
3. Phase 4 (US2) → full manual approval loop ready.
4. Phase 5 (US3) → automated tuning suggestions ready (the "full" feature).
5. Phase 6 (US4) → graceful disable verified.
6. Phase 7 → polish + docs + full verification.

### Parallel team strategy

- After Phase 2, a backend dev can take T005 → T006 → T007 → T013 → T014 → T015 → T019 → T020 → T021 → T022 → T023 → T024 → T025 while a frontend dev takes T008 → T009 → T010 → T011 → T012 → T016 → T017 → T018 → T026 → T027 → T028 → T029 in parallel. Only the wire-up tasks (T015, T025) and the handler-chaining (T021 depends on T013) create cross-dev sync points.

---

## Notes

- No test tasks included — spec did not request TDD. Manual verification uses `quickstart.md`.
- Every new Message column is nullable; every new model carries a cascade to Tenant. Retirement is a clean drop per research.md.
- Shadow Mode is explicitly a short-lived diagnostic tool; prioritize shipping US1+US2 first and treat US3 as the valuable-but-optional upgrade.
- Constitution compliance is assertive at the task level (T034 is an explicit gate-check task before merge).
- All file paths are absolute from the repo root or relative to `backend/` / `frontend/` to match the existing monorepo layout.
