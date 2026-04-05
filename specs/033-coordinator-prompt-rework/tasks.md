# Tasks: Coordinator Prompt Rework with Reasoning

**Input**: Design documents from `/specs/033-coordinator-prompt-rework/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Schema change needed before frontend work

- [X] T001 Add showAiReasoning Boolean field (default false) to TenantAiConfig model in backend/prisma/schema.prisma
- [X] T002 Run prisma db push to apply the schema change

**Checkpoint**: Database schema ready for the settings toggle.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Update the coordinator JSON schema — all user stories depend on the reasoning field being in the schema.

- [X] T003 Update the coordinator JSON schema in backend/src/services/ai.service.ts — add `reasoning` as the first property (required string, description: "Internal reasoning under 80 words. Not shown to guest."). Update the schema constant used by json_schema enforcement. Keep all existing fields (guest_message, escalation, resolveTaskId, updateTaskId) unchanged.

- [X] T004 Update the sandbox coordinator schema in backend/src/routes/sandbox.ts to match the new schema with the reasoning field.

**Checkpoint**: Both main pipeline and sandbox enforce the new schema with reasoning field. AI responses now include reasoning.

---

## Phase 3: User Story 1 — Chain-of-Thought Reasoning (Priority: P1)

**Goal**: AI produces reasoning before every response. Reasoning is stripped before Hostaway send, included in SSE broadcast, logged in AI Logs.

**Independent Test**: Send a message via sandbox. Verify reasoning in AI Logs, NOT in Hostaway message.

- [X] T005 [US1] Rewrite SEED_COORDINATOR_PROMPT in backend/src/services/ai.service.ts — incorporate the new prompt structure from the expert recommendations. Include: output contract description with reasoning field, tool routing table (SOP-first pattern preserved), escalation decision ladder (9 levels per FR-002), structured escalation note format (FR-003), conversation repair section (FR-004), tone calibration with good/bad examples (FR-005), worked examples showing reasoning in different scenarios (FR-007). Keep the existing content blocks section (CONTENT_BLOCKS with RESERVATION_DETAILS, OPEN_TASKS, CONVERSATION_HISTORY, CURRENT_MESSAGES, CURRENT_LOCAL_TIME, DOCUMENT_CHECKLIST) and reminder block exactly as they are. Update search_available_properties references to match nano scoring behavior.

- [X] T006 [US1] Strip reasoning from the AI response before sending guest_message to Hostaway in backend/src/services/ai.service.ts — after parsing the JSON response, extract the reasoning field, log it in ragContext, then send only guest_message to Hostaway. Do NOT include reasoning in the message content sent via the Hostaway API.

- [X] T007 [US1] Include reasoning in the SSE broadcast payload in backend/src/services/ai.service.ts — when broadcasting the AI response via broadcastCritical/broadcastToTenant, add the reasoning field to the message object so the frontend receives it.

- [X] T008 [US1] Log reasoning effort level in ragContext in backend/src/services/ai.service.ts — add a `reasoningEffort` field to the ragContext object that gets persisted to AiApiLog, so AI Logs show what effort level was used.

**Checkpoint**: Reasoning field populated in AI Logs, stripped from Hostaway messages, included in SSE broadcasts.

---

## Phase 4: User Story 2 — Improved Escalation Quality (Priority: P1)

**Goal**: Escalation ladder and structured notes are enforced via the system prompt.

**Independent Test**: Send safety/complaint/unknown messages. Verify escalation notes follow structured format and urgency matches the ladder.

- [X] T009 [US2] Verify the escalation decision ladder is correctly encoded in the new SEED_COORDINATOR_PROMPT (done in T005). No additional code change — this is a prompt-level feature. Validate by sending test messages via sandbox: (1) safety message → immediate, no tools, (2) angry complaint → immediate, emotion outranks refund, (3) unknown question after SOP+FAQ fail → info_request.

**Checkpoint**: Escalation ladder and structured notes working as designed in the prompt.

---

## Phase 5: User Story 3 — Enhanced Tone and Conversation Repair (Priority: P2)

**Goal**: Tone calibration and conversation repair are enforced via the system prompt.

**Independent Test**: Send complaint, then "that's not what I meant" follow-up. Verify tone and repair behavior.

- [X] T010 [US3] Verify tone calibration and conversation repair sections are correctly encoded in the new SEED_COORDINATOR_PROMPT (done in T005). No additional code change — this is a prompt-level feature. Validate by sending test messages via sandbox: (1) complaint → empathetic tone, (2) correction → brief acknowledgment.

**Checkpoint**: Tone and conversation repair working as designed in the prompt.

---

## Phase 6: User Story 4 — Tool Reasoning and Richer Descriptions (Priority: P2)

**Goal**: Every tool call includes reasoning. Tool descriptions have CALL/DO NOT CALL boundaries.

**Independent Test**: Send a message requiring a tool call. Verify reasoning appears in AI Logs tool call details.

- [X] T011 [P] [US4] Add reasoning parameter to get_faq tool definition in backend/src/services/ai.service.ts (inline tool definition around line 1673) — add reasoning as first property, required string, description: "Why this is a factual question rather than procedural, and why this category."

- [X] T012 [P] [US4] Add reasoning parameter to check_extend_availability tool definition in backend/src/services/tool-definition.service.ts — add reasoning as first property, required string, description: "Why this change type and these dates."

- [X] T013 [P] [US4] Add reasoning parameter to mark_document_received tool definition in backend/src/services/tool-definition.service.ts — add reasoning as first property, required string, description: "Why you believe this image is this document type."

- [X] T014 [P] [US4] Add reasoning parameter to search_available_properties tool definition in backend/src/services/tool-definition.service.ts — add reasoning as first property, required string, description: "Why calling search and what requirements to match."

- [X] T015 [US4] Enrich all tool descriptions with CALL/DO NOT CALL boundaries in backend/src/services/tool-definition.service.ts — for each system tool (get_sop already defined inline), add explicit "CALL for:" and "DO NOT call for:" lists with redirection to the correct tool. Update the get_sop description in backend/src/services/ai.service.ts similarly (the inline SOP tool definition).

**Checkpoint**: All tool calls include reasoning. Tool descriptions have clear boundaries.

---

## Phase 7: User Story 5 — Dynamic Reasoning Effort (Priority: P3)

**Goal**: System picks low/medium reasoning effort based on message complexity signals.

**Independent Test**: Send simple vs complex messages. Verify AI Logs show correct effort level.

- [X] T016 [US5] Implement pickReasoningEffort function in backend/src/services/ai.service.ts — takes current message text (string) and open task count (number), returns "low" or "medium". Logic: check distress keywords (English + Arabic list), ALL CAPS over 20 chars, open tasks >= 2, message length > 300 chars. Default "low". Wrap in try/catch — return "low" on error.

- [X] T017 [US5] Wire pickReasoningEffort into the main AI pipeline in backend/src/services/ai.service.ts — call before createMessage, pass the result as the reasoning.effort parameter to the OpenAI Responses API call. If the model doesn't support the parameter, catch and retry without it.

- [X] T018 [US5] Wire pickReasoningEffort into the sandbox pipeline in backend/src/routes/sandbox.ts — same logic as main pipeline for consistent behavior during testing.

**Checkpoint**: Reasoning effort selector working. AI Logs show effort level per message.

---

## Phase 8: Frontend — Settings Toggle and Reasoning Display (Priority: P2)

**Goal**: Tenant can toggle reasoning visibility in chat. When on, reasoning shows alongside AI messages.

**Independent Test**: Toggle setting on/off. Verify reasoning appears/disappears in inbox chat.

- [X] T019 [P] [US1] Add showAiReasoning toggle to the AI settings page in frontend/components/configure-ai-v5.tsx — add a toggle in the AI Mode section (or a new "Debug" section) that reads/writes the showAiReasoning field via the existing tenant config API. Label: "Show AI Reasoning". Description: "Display the AI's internal reasoning alongside messages in the inbox. Useful for debugging."

- [X] T020 [US1] Display reasoning in inbox chat when toggle is on in frontend/components/inbox-v5.tsx — when an AI message includes a reasoning field in the SSE payload AND the tenant's showAiReasoning is true, display the reasoning above or below the AI message bubble. Style it as a collapsible, muted/secondary element (e.g., small italic text with a "Reasoning" label, or a subtle expandable section). When toggle is off, hide it completely.

**Checkpoint**: Settings toggle works. Reasoning visible in chat when enabled, hidden when disabled.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T021 Verify TypeScript compilation passes with no errors in backend/ (tsc --noEmit)
- [X] T022 Run prisma db push on Railway production to apply showAiReasoning field
- [X] T023 Run quickstart.md scenarios 1-7 via sandbox to validate all prompt behaviors
- [X] T024 Run quickstart.md scenario 8 to validate settings toggle and reasoning display
- [X] T025 Verify AI Logs show reasoning field, tool reasoning, and effort level for a real production conversation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — schema change
- **Phase 2 (Foundational)**: Depends on Phase 1 — schema needed for reasoning field
- **Phase 3 (US1)**: Depends on Phase 2 — needs schema with reasoning field
- **Phase 4 (US2)**: Depends on Phase 3 — escalation ladder is in the prompt written in T005
- **Phase 5 (US3)**: Depends on Phase 3 — tone/repair are in the prompt written in T005
- **Phase 6 (US4)**: Can run in parallel with Phases 4-5 (different files — tool-definition.service.ts)
- **Phase 7 (US5)**: Depends on Phase 3 — needs pipeline changes from T005-T008
- **Phase 8 (Frontend)**: Depends on Phase 1 (schema) + Phase 3 (SSE broadcast). Can run in parallel with Phases 4-7.
- **Phase 9 (Polish)**: Depends on all prior phases

### Parallel Opportunities

- T011, T012, T013, T014 can all run in parallel (different tool definitions in different locations)
- T019 (settings toggle) can run in parallel with T020 (inbox display) — different components
- Phase 6 (tool definitions) can run in parallel with Phase 8 (frontend)
- Phase 4 and Phase 5 are validation-only (prompt is written in Phase 3)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Schema change (T001-T002)
2. Phase 2: Schema update in code (T003-T004)
3. Phase 3: Prompt rewrite + reasoning stripping + SSE broadcast (T005-T008)
4. **STOP and VALIDATE**: Send test messages via sandbox. Verify reasoning in logs, not in Hostaway.

### Incremental Delivery

1. Phases 1-3 → Reasoning working, prompt rewritten → MVP
2. Phase 4 → Validate escalation ladder (prompt-only, no code)
3. Phase 5 → Validate tone/repair (prompt-only, no code)
4. Phase 6 → Tool reasoning + boundaries → Better debugging
5. Phase 7 → Reasoning effort selector → Cost optimization
6. Phase 8 → Frontend toggle → User-facing feature
7. Phase 9 → Full validation

---

## Notes

- Total tasks: 25
- US1 (Reasoning): 6 tasks (T005-T008, T019-T020)
- US2 (Escalation): 1 task (T009 — validation only, prompt in T005)
- US3 (Tone/Repair): 1 task (T010 — validation only, prompt in T005)
- US4 (Tool Reasoning): 5 tasks (T011-T015)
- US5 (Reasoning Effort): 3 tasks (T016-T018)
- Foundational: 4 tasks (T001-T004)
- Polish: 5 tasks (T021-T025)
- The heavy lift is T005 (prompt rewrite) — everything else is incremental
