# Tasks: Smart Conversation Context Summarization

**Input**: Design documents from `/specs/024-smart-context-summary/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Not requested — no test tasks included.

**Organization**: Tasks grouped by user story. US1 is the MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

---

## Phase 1: Setup

**Purpose**: Branch verification and baseline

- [ ] T001 Verify on branch `024-smart-context-summary` and compile clean with `npx tsc --noEmit` in `backend/`
- [ ] T002 Verify existing schema fields `conversationSummary`, `summaryUpdatedAt`, `summaryMessageCount` on Conversation model in `backend/prisma/schema.prisma`

---

## Phase 2: User Story 1 — Intelligent Context Window with Summary (Priority: P1) 🎯 MVP

**Goal**: Reduce conversation history from 20 to 10 raw messages + inject stored summary. Create the summary service that generates/extends summaries asynchronously.

**Independent Test**: Send 15+ messages in a conversation. On message 16, the AI receives 10 raw messages + a summary. The AI demonstrates awareness of early context no longer in the raw window.

### Step 1: Create Summary Service

- [ ] T003 [US1] Create `backend/src/services/summary.service.ts` with `generateOrExtendSummary(conversationId, prisma)` function:
  - Query Conversation for existing `conversationSummary`, `summaryMessageCount`
  - Fetch all GUEST + AI messages (exclude AI_PRIVATE, MANAGER_PRIVATE)
  - If `summaryMessageCount` already covers all messages outside the 10-message window → skip
  - If no existing summary → generate from scratch using messages before the window
  - If existing summary → extend by feeding existing summary + newly scrolled-out messages to the model
  - Use `gpt-5.4-nano` (cheapest model) for summarization
  - Store result in `conversationSummary`, update `summaryUpdatedAt` and `summaryMessageCount`
  - Summarization prompt: extract only guest identity, special arrangements, preferences, dissatisfaction, key decisions. Exclude routine operational exchanges. Max 150 words.
  - Wrap entire function in try/catch — log errors, never throw

### Step 2: Modify AI Service History Logic

- [ ] T004 [US1] In `backend/src/services/ai.service.ts`, change `.slice(-20)` to `.slice(-10)` for `historyMsgs` (line ~1397)
- [ ] T005 [US1] In `backend/src/services/ai.service.ts`, after building `historyText`, query `conversationSummary` from the Conversation record and if present, add it as a `### CONTEXT SUMMARY ###` content block (appended to `userContent` array before the conversation history block)
- [ ] T006 [US1] In `backend/src/services/ai.service.ts`, after the AI response is sent (in the fire-and-forget section at the end), call `generateOrExtendSummary(conversationId, prisma)` — only if total GUEST+AI message count > 10. Catch errors silently.
- [ ] T007 [US1] Update `messageHistoryCount` from 20 to 10 in `backend/src/config/ai-config.json`

**Checkpoint**: Conversations with 15+ messages show summary in AI context. AI demonstrates awareness of early messages. Zero added latency.

---

## Phase 3: User Story 2 — Efficient Summary Generation (Priority: P2)

**Goal**: Ensure summaries fire efficiently — not on every message, only when messages scroll out of the window.

**Independent Test**: A 20-message conversation triggers summary generation no more than 2-3 times total.

- [ ] T008 [US2] In `backend/src/services/summary.service.ts`, add a check at the top of `generateOrExtendSummary`: count GUEST+AI messages, if count <= 10 return immediately (no summary needed)
- [ ] T009 [US2] In `backend/src/services/summary.service.ts`, add stale-check: if `summaryMessageCount >= (totalMessages - 10)` return immediately (existing summary is current, no new messages scrolled out)
- [ ] T010 [US2] Add console.log in summary service: `[Summary] [conversationId] Generated/extended summary (covered N messages, X words)` or `[Summary] [conversationId] Skipped — summary is current`

**Checkpoint**: Summary generation logs show efficient triggering — skips when current, generates only when messages scroll out.

---

## Phase 4: User Story 3 — Summary Quality and Content Rules (Priority: P3)

**Goal**: Ensure the summarization prompt produces high-quality summaries that include critical context and exclude operational noise.

**Independent Test**: Generate summaries for 5 conversation types. Review for inclusion of identity/preferences and exclusion of routine exchanges.

- [ ] T011 [US3] In `backend/src/services/summary.service.ts`, refine the summarization prompt to explicitly list inclusion and exclusion rules:
  - INCLUDE: guest identity (who they are, who they're booking for), nationality nuances, special arrangements, guest preferences (quiet room, pregnant wife, etc.), expressed dissatisfaction, key decisions
  - EXCLUDE: cleaning requests, WiFi issues, amenity deliveries, check-in/checkout logistics, resolved escalations, routine acknowledgments
  - Cap at 150 words
- [ ] T012 [US3] In `backend/src/services/summary.service.ts`, add word count enforcement: if summary exceeds 150 words, truncate to 150 words at the nearest sentence boundary

**Checkpoint**: Summaries are concise (<150 words), include identity/preference context, exclude routine exchanges.

---

## Phase 5: Update Sandbox Route

**Purpose**: Mirror history changes in the sandbox route for consistency.

- [ ] T013 [P] In `backend/src/routes/sandbox.ts`, change message history slice from 20 to 10
- [ ] T014 In `backend/src/routes/sandbox.ts`, inject `conversationSummary` as context block if available (sandbox may not have a real conversation — handle gracefully)

---

## Phase 6: Verification & Polish

**Purpose**: Compile check, deploy, test end-to-end.

- [ ] T015 Run `npx tsc --noEmit` in `backend/` — must compile clean
- [ ] T016 Run `npx prisma generate` in `backend/` — Prisma client regenerated (no schema changes needed)
- [ ] T017 Grep `backend/src/` for any remaining `.slice(-20)` on message history — confirm zero occurrences
- [ ] T018 Review `backend/src/services/ai.service.ts` to confirm summary block is injected BEFORE conversation history in the content blocks (so the AI reads summary first, then recent messages)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **US1 (Phase 2)**: Depends on Setup — this is the MVP
- **US2 (Phase 3)**: Depends on US1 (summary service must exist first)
- **US3 (Phase 4)**: Depends on US1 (refines the summarization prompt)
- **Sandbox (Phase 5)**: Depends on US1 (mirrors the same changes)
- **Verification (Phase 6)**: Depends on all phases

### Within User Story 1

- T003 (create service) → T004-T007 (modify AI service) — sequential
- T004, T005, T006 are in the same file — sequential
- T007 is independent (different file) but trivial

### Parallel Opportunities

- T013 can run in parallel with US2/US3 (different file)
- US2 (T008-T010) and US3 (T011-T012) can run in parallel (both modify summary.service.ts but different sections)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: User Story 1 (summary service + AI service changes)
3. **STOP and VALIDATE**: Deploy, test with 15+ message conversation
4. Commit the MVP

### Incremental Delivery

1. US1 → Summary service + 10-message window → Test → Commit (MVP)
2. US2 → Efficiency checks → Test trigger frequency → Commit
3. US3 → Quality refinement → Review summary outputs → Commit
4. Sandbox → Mirror changes → Commit
5. Verification → Final sweep → Commit

---

## Notes

- **No schema changes needed** — `conversationSummary`, `summaryUpdatedAt`, `summaryMessageCount` already exist on the Conversation model
- **Cheapest model**: Use `gpt-5.4-nano` for summarization (~$0.001 per call)
- **Fire-and-forget**: Summary generation NEVER blocks the AI response pipeline
- **Graceful fallback**: If summary is missing or generation fails, AI works fine with just the 10 raw messages
- Total tasks: 18
