# Tasks: Perfect AI Mix

**Input**: Design documents from `/specs/037-perfect-ai-mix/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Database schema and new file scaffolding

- [x] T001 Add `showAiReasoning Boolean @default(false)` to TenantAiConfig in `backend/prisma/schema.prisma` and run `npx prisma db push`
- [ ] T002 [P] Create `backend/src/services/screening-state.service.ts` with `computeScreeningState()` function — scan guest messages with nationality/composition regex patterns, check open tasks for screening titles, compute GATHER/DECIDE/POST_DECISION phase, return hint string

---

## Phase 2: Foundational (Backend Pipeline Infrastructure)

**Purpose**: Port v4 infrastructure improvements into main branch code. MUST complete before prompt/schema changes.

**WARNING**: These tasks modify `backend/src/services/ai.service.ts` — execute sequentially, not in parallel.

- [ ] T003 Port `computeContextVariables()` and `renderPreComputedContext()` functions from v4 branch into `backend/src/services/ai.service.ts` — compute temporal variables (is_business_hours, days_until_checkin/out, back-to-back flags, screening context) and render as bullet-list content block
- [ ] T004 Port `pickReasoningEffort()` function from v4 branch into `backend/src/services/ai.service.ts` — distress signal detection (English + Arabic keywords), ALL CAPS check, open task count, message length. Returns 'low' or 'medium'. Wire into main pipeline where `auto` maps to this function instead of hardcoded `'low'`
- [ ] T005 Register `PRE_COMPUTED_CONTEXT` and `SCREENING_STATE` in `backend/src/services/template-variable.service.ts` — PRE_COMPUTED_CONTEXT: essential=true, agentScope=['coordinator','screening']. SCREENING_STATE: essential=false, agentScope=['screening']
- [ ] T006 Add `PRE_COMPUTED_CONTEXT` and `SCREENING_STATE` to `variableDataMap` in the main pipeline function in `backend/src/services/ai.service.ts` — compute context variables for all calls, compute screening state for INQUIRY calls only
- [ ] T007 Port deferred tool schema enforcement from v4 into `backend/src/services/ai.service.ts` — during tool follow-up rounds: pass `tools` + `tool_choice: 'auto'` but do NOT pass `text: { format: outputSchema }`. After tool loop exits, validate response JSON and make final schema-enforced call if invalid
- [ ] T008 Port `get_sop` handler changes from v4 into `backend/src/services/ai.service.ts` — return Markdown format (`## SOP: category\n\ncontent`) instead of JSON. Remove auto-escalation for 'escalate' category. Do NOT port auto-enrich (model can chain tools now)
- [ ] T009 Port `get_faq` inline tool definition and handler from v4 into `backend/src/services/ai.service.ts` — add tool with category enum (15 categories), reasoning parameter (optional). Handler calls `getFaqForProperty()`. Import `getFaqForProperty` from faq.service
- [ ] T010 Port pre-response Hostaway sync from v4 into `backend/src/services/ai.service.ts` — call `syncConversationMessages` before generating response. Cancel AI reply if manager already responded. Re-sync reservation status for INQUIRY→CONFIRMED detection
- [ ] T011 Port conversation summary injection from v4 into `backend/src/services/ai.service.ts` — load `conversationSummary` from conversation record, inject as first content block if non-empty
- [ ] T012 Port fire-and-forget summary generation from v4 into `backend/src/services/ai.service.ts` — after sending reply, if allMsgs.length > 10, call `generateOrExtendSummary(conversationId, prisma).catch(() => {})`
- [ ] T013 Change history window from `slice(-20)` to `slice(-10)` and add `take: 100` to message query in `backend/src/services/ai.service.ts`
- [ ] T014 Port `stripCodeFences` improvements from v4 into `backend/src/services/ai.service.ts` — handle concatenated JSON objects (`}{` splitting, extract last valid object with non-empty guest_message)
- [ ] T015 Port response parsing fallbacks from v4 into `backend/src/services/ai.service.ts` — `reason→note` recovery, `missing-title-${urgency}` sentinel, `guest_message || 'guest message'` backward compat for screening
- [ ] T016 Port `buildPropertyInfo` improvements from v4 into `backend/src/services/ai.service.ts` — extract structured property details (capacity, bedrooms, bathrooms, square meters, check-in/out times) from customKnowledgeBase

**Checkpoint**: All v4 infrastructure ported. Pipeline is enhanced but prompts/schemas unchanged yet.

---

## Phase 3: User Story 1 — Guest Response Quality (Priority: P1) MVP

**Goal**: Restore old schema simplicity and prompt structure so the model focuses on writing excellent guest messages.

**Independent Test**: Send 10 messages through sandbox (WiFi, cleaning, complaint, Arabic, acknowledgment) and rate response quality.

- [ ] T017 [US1] Update COORDINATOR_SCHEMA in `backend/src/services/ai.service.ts` — keep exactly 4 fields (guest_message, escalation, resolveTaskId, updateTaskId). Update `escalation.note` description to include format guidance: "Details for manager: situation, what the guest wants (quote their words when charged), and suggested action."
- [ ] T018 [US1] Update SCREENING_SCHEMA in `backend/src/services/ai.service.ts` — rename `'guest message'` to `guest_message`. Keep exactly 2 fields (guest_message, manager). Update `manager.note` description to: "Details for manager: nationality, party composition, screening recommendation."
- [ ] T019 [US1] Write new SEED_COORDINATOR_PROMPT in `backend/src/services/ai.service.ts` — use old XML structure (`<critical_rule>`, `<language>`, `<tools>`, `<escalation>`, `<task_management>`, `<documents>`, `<rules>`, `<examples>`, `<reminder>`). Critical rule: "retrieve SOP before responding." Language: one line "Match the guest's language. Default Egyptian Arabic if Arabic. Notes in English." Escalation: 3 triggers (safety→immediate, SOP says→SOP urgency, can't answer→info_request) + 4-field note format. Tools: priority chain get_sop→get_faq→escalate + direct triggers. Add `{PRE_COMPUTED_CONTEXT}` content block. 3 examples (SOP question, escalation with note, acknowledgment). 4-line reminder. Add "Never respond cheerfully to a complaint" to rules.
- [ ] T020 [US1] Update coordinator response parsing in `backend/src/services/ai.service.ts` — derive action from response: escalation!=null→"escalate", guest_message==""→"none", else→"reply". Derive sopStep from tool call categories. Store both in ragContext. Keep validation function (observe-only).
- [ ] T021 [US1] Update SSE broadcast in `backend/src/services/ai.service.ts` — include derived `reasoning` string in message broadcast: format as "[action]: [detail from tool/escalation]". E.g., "Escalated: ac-not-working (immediate)" or "Answered from SOP: sop-cleaning"

**Checkpoint**: Coordinator agent restored with old simplicity + v4 infrastructure. Test via sandbox with CONFIRMED/CHECKED_IN status.

---

## Phase 4: User Story 2 — Screening Agent (Priority: P1)

**Goal**: Screening agent correctly screens guests with code-tracked state, no re-asking, no premature search.

**Independent Test**: 4-turn screening conversation — verify correct screening decision, no re-asking, no property search.

- [ ] T022 [US2] Write new SEED_SCREENING_PROMPT in `backend/src/services/ai.service.ts` — use old XML structure. Critical rule: "Screening gates everything. Nationality and party composition must be known before any booking decision." Add `{SCREENING_STATE}` content block in prominent position. Keep old screening rules with Lebanese/Emirati exception prominent. Simplified workflow (GATHER/DECIDE/POST_DECISION phases mapped to prompt instructions). Add `{PRE_COMPUTED_CONTEXT}` content block. Remove search_available_properties from tools section. 3 examples (eligible couple, missing info, post-decision follow-up). 4-line reminder.
- [ ] T023 [US2] Wire screening state service into main pipeline in `backend/src/services/ai.service.ts` — import `computeScreeningState`, call it for INQUIRY/PENDING conversations, add result to variableDataMap as SCREENING_STATE, log phase to console and ragContext
- [ ] T024 [US2] Update screening response parsing in `backend/src/services/ai.service.ts` — parse `guest_message` (underscore) with `'guest message'` (space) fallback. Derive action from manager fields: needed+title starts with "eligible-"→"screen_eligible", "violation-"→"screen_violation", needed+other→"escalate", !needed+empty message→"awaiting_manager", else→"reply". Derive urgency from title: eligible-*/violation-*/awaiting-manager-review→"inquiry_decision", else→"info_request"
- [ ] T025 [US2] Port duplicate screening prevention from v4 into `backend/src/services/ai.service.ts` — when derived action is "awaiting_manager" and open tasks contain a screening title, skip handleEscalation
- [ ] T026 [US2] Update `search_available_properties` tool scope — change agentScope from 'INQUIRY,PENDING' to 'CONFIRMED,CHECKED_IN' in tool-definition seed in `backend/src/services/tool-definition.service.ts`. Also write a migration snippet to update existing DB records

**Checkpoint**: Screening agent restored with code-tracked state. Test via sandbox with INQUIRY status — verify GATHER→DECIDE→POST_DECISION flow.

---

## Phase 5: User Story 3 — Escalation Notes (Priority: P2)

**Goal**: Manager receives consistent, actionable escalation notes without rigid 6-field template.

**Independent Test**: Trigger 5 escalation types and verify notes contain situation, guest request, and suggested action.

- [x] T027 [US3] Verify escalation note format guidance is in schema descriptions (done in T017/T018) and in coordinator prompt escalation section (done in T019). No additional code changes needed — this story is satisfied by the prompt and schema work in Phase 3/4.

**Checkpoint**: Escalation notes should now be consistently structured but natural. Verify in sandbox.

---

## Phase 6: User Story 4 — Code-Tracked Screening State (Priority: P2)

**Goal**: Application code determines screening phase deterministically.

**Independent Test**: Multi-turn conversation where nationality is mentioned in turn 1 and composition in turn 3.

- [x] T028 [US4] Verify screening-state.service.ts (created in T002) has comprehensive nationality regex patterns — countries, demonyms, "from [country]" patterns, Arabic nationality words
- [x] T029 [US4] Verify screening-state.service.ts has comprehensive composition regex patterns — family words (wife, husband, children, kids), group words (couple, solo, friends), gender words (male, female), count patterns ("just me", "two of us")
- [x] T030 [US4] Verify screening state integration (done in T023) correctly produces GATHER/DECIDE/POST_DECISION phases and the hint text is clear and actionable

**Checkpoint**: Screening state service produces correct phases. Verify via AI logs showing screeningPhase in ragContext.

---

## Phase 7: User Story 5 — Pre-Computed Context (Priority: P2)

**Goal**: Model receives temporal facts without doing date arithmetic.

**Independent Test**: Reservation with check-in tomorrow, verify is_within_2_days_of_checkin=true in content block.

- [x] T031 [US5] Verify computeContextVariables (ported in T003) correctly computes all fields — test with various dates, times, and statuses. Verify Cairo timezone handling.

**Checkpoint**: Pre-computed context injected correctly. Verify in AI logs.

---

## Phase 8: User Story 6 — Tool Chaining (Priority: P3)

**Goal**: AI can call multiple tools per response without schema blocking.

**Independent Test**: Send message requiring SOP + FAQ lookups, verify both tools called.

- [x] T032 [US6] Verify deferred schema enforcement (ported in T007) works correctly — test with a message that triggers get_sop then get_faq. Verify both tools called and final response is valid JSON.

**Checkpoint**: Tool chaining works. Verify in AI logs showing multiple tool calls per response.

---

## Phase 9: User Story 7 — Reasoning Visibility (Priority: P3)

**Goal**: Manager can toggle AI reasoning display in inbox.

**Independent Test**: Enable toggle, send message, verify reasoning appears.

- [ ] T033 [P] [US7] Add `showAiReasoning` to `TenantAiConfig` interface and `apiGetTenantAiConfig` response in `frontend/lib/api.ts`
- [ ] T034 [P] [US7] Add reasoning toggle row to Configure AI features section in `frontend/components/configure-ai-v5.tsx`. Add `PRE_COMPUTED_CONTEXT` and `SCREENING_STATE` to BLOCK_VARIABLES array.
- [ ] T035 [US7] Add reasoning display to inbox in `frontend/components/inbox-v5.tsx` — fetch showAiReasoning from config, capture reasoning from SSE broadcast, display as collapsible muted element below AI messages when enabled

**Checkpoint**: Reasoning toggle works. Reasoning derived from ragContext appears in inbox.

---

## Phase 10: SOP Content Updates

**Purpose**: Fix SOP content gaps without changing the variant architecture.

- [ ] T036 [P] Add WiFi troubleshooting content to CHECKED_IN variant of `sop-wifi-doorcode` in `backend/src/services/sop.service.ts` — "If guest reports WiFi issues, share credentials again. If still not working, escalate immediately."
- [ ] T037 [P] Improve maintenance SOP DEFAULT content in `backend/src/services/sop.service.ts` — add safety triage: "AC/water/electricity failures → urgency immediate. Cosmetic issues → urgency scheduled."
- [ ] T038 Write SOP migration script at `backend/scripts/migrate-sops.ts` — scan existing SOP variants for v4 multi-path markers (`<paths>`, `<sop>`, `Path A:`). For each match: compare against known v4 seed content. If content matches v4 seed exactly → update to new prose content. If content has been customized → skip and log. Run via `railway run npx ts-node scripts/migrate-sops.ts`

---

## Phase 11: Sandbox Parity

**Purpose**: Sandbox endpoint mirrors production pipeline changes.

- [ ] T039 Update sandbox response parsing in `backend/src/routes/sandbox.ts` — parse `guest_message` with `'guest message'` fallback, derive action and reasoning from response structure, return in response JSON
- [ ] T040 Port sandbox OPEN_TASKS tracking from v4 into `backend/src/routes/sandbox.ts` — build from previous AI response meta (manager/escalation data from frontend)
- [ ] T041 Port sandbox PRE_COMPUTED_CONTEXT from v4 into `backend/src/routes/sandbox.ts` — compute context variables including screening-specific fields
- [ ] T042 Port sandbox SCREENING_STATE into `backend/src/routes/sandbox.ts` — compute screening state from message history meta
- [ ] T043 Port pickReasoningEffort into sandbox in `backend/src/routes/sandbox.ts`
- [ ] T044 [P] Update sandbox-chat-v5.tsx to send meta (action, manager, escalation) alongside messages in `frontend/components/sandbox-chat-v5.tsx`
- [ ] T045 [P] Update SandboxChatRequest type in `frontend/lib/api.ts` to include optional meta on messages

**Checkpoint**: Sandbox produces identical behavior to production pipeline. Test all scenarios from quickstart.md.

---

## Phase 12: Polish & Cross-Cutting Concerns

- [ ] T046 Run TypeScript compilation check (`npx tsc --noEmit`) for both backend and frontend
- [ ] T047 Run SOP migration script on Railway (`railway run npx ts-node scripts/migrate-sops.ts`)
- [ ] T048 Deploy to Railway and Vercel
- [ ] T049 Restore both system prompts to defaults in Configure AI
- [ ] T050 Run battle test — 2 agents (screening + coordinator) via battle-test/turn.ts
- [ ] T051 Verify AI logs show: derived action, sopStep, screeningPhase, pre-computed context
- [ ] T052 Run quickstart.md verification checklist (7 items)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user stories
- **Phase 3 (US1 Coordinator)**: Depends on Phase 2
- **Phase 4 (US2 Screening)**: Depends on Phase 2 + T002 (screening state service)
- **Phase 5-8 (US3-6)**: Verification phases — depend on Phase 3/4
- **Phase 9 (US7 Reasoning UI)**: Can run in parallel with Phase 3/4 (frontend only)
- **Phase 10 (SOP Content)**: Independent — can run in parallel with Phase 3/4
- **Phase 11 (Sandbox)**: Depends on Phase 3/4 (must mirror production changes)
- **Phase 12 (Polish)**: Depends on all previous phases

### Parallel Opportunities

- T001 + T002 can run in parallel (different files)
- T033 + T034 can run in parallel (different frontend files)
- T036 + T037 can run in parallel (different SOP categories)
- T044 + T045 can run in parallel (different frontend files)
- Phase 9 (frontend reasoning UI) can run in parallel with Phase 3/4 (backend prompts)
- Phase 10 (SOP content) can run in parallel with Phase 3/4 (backend prompts)

---

## Implementation Strategy

### MVP First (Phase 1-4)

1. Setup (T001-T002) — schema + screening state service
2. Foundational (T003-T016) — port all v4 infrastructure
3. Coordinator prompt + schema (T017-T021) — restore old simplicity
4. Screening prompt + state integration (T022-T026) — code-tracked screening
5. **STOP AND VALIDATE**: Battle test both agents

### Incremental Delivery

1. MVP → validate coordinator + screening quality
2. Add frontend reasoning UI (Phase 9) → demo to user
3. SOP content fixes (Phase 10) → deploy
4. Sandbox parity (Phase 11) → enable sandbox testing
5. Polish + full verification (Phase 12) → production ready

---

## Notes

- [P] tasks = different files, no dependencies
- Phase 2 tasks modify ai.service.ts sequentially — do NOT parallelize
- Phases 5-8 are verification-only (no new code) — can be quick passes
- SOP migration (T038) must run AFTER new seed content is deployed
- Battle test (T050) requires Railway deployment and valid JWT
