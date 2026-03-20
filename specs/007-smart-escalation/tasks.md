# Tasks: Smart Escalation Logic

**Input**: Design documents from `/specs/007-smart-escalation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/task-manager-prompt.md

**Tests**: Not requested.

**Organization**: Tasks grouped by user story. Foundational phase creates the new service. US1-US5 integrate and tune it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)

---

## Phase 1: Foundational — Create Task Manager Service

**Purpose**: Build the new Task Manager AI agent. MUST complete before user story integration.

- [x] T001 Create `backend/src/services/task-manager.service.ts` — implement `evaluateEscalation()` function with:
  - Lazy Anthropic client initialization (same pattern as intent-extractor.service.ts)
  - System prompt from `specs/007-smart-escalation/contracts/task-manager-prompt.md`
  - Input: `{ tenantId, conversationId, newEscalation: { title, note, urgency }, openTasks: Array<{ id, title, note, urgency, createdAt }>, guestMessage }`
  - If `openTasks.length === 0` → return `{ action: 'create', reason: 'no-open-tasks' }` immediately (no API call)
  - Otherwise → build user message with formatted open tasks + new escalation + guest message, call Haiku (`claude-haiku-4-5-20251001`, temperature 0.0, max_tokens 100)
  - Parse JSON response → return `{ action: 'create' | 'update' | 'resolve' | 'skip', taskId?: string, reason: string }`
  - On ANY error → `console.warn('[TaskManager] Failed (non-fatal):', err)` and return `{ action: 'create', reason: 'task-manager-error' }`
  - Format open tasks as: `[{id}] {title} ({urgency})\n  Note: {note?.substring(0, 300) || 'No details'}\n  Created: {relativeTime}`

- [x] T002 Add `evaluateEscalation` stats tracking in `backend/src/services/task-manager.service.ts` — track call count, create/update/resolve/skip counts, error count, average duration. Export `getTaskManagerStats()` for observability.

**Checkpoint**: Task Manager service exists, compiles, handles all edge cases.

---

## Phase 2: User Story 1 — Prevent Duplicate Escalations (Priority: P1) 🎯 MVP

**Goal**: When Omar escalates and an open task already exists for the same topic, update the existing task instead of creating a duplicate.

**Independent Test**: Ask for cleaning → task created. Say "10am" → existing task updated, not a new one.

### Implementation

- [x] T003 [US1] Integrate Task Manager into `handleEscalation()` in `backend/src/services/ai.service.ts` — before calling `createTask()` (~line 1031):
  1. Fetch open tasks: `await prisma.task.findMany({ where: { conversationId, status: 'open' }, orderBy: { createdAt: 'desc' }, take: 10 })`
  2. Call `evaluateEscalation({ tenantId, conversationId, newEscalation: { title, note, urgency }, openTasks, guestMessage })`
  3. Switch on `result.action`:
     - `'create'` → proceed with existing `createTask()` (no change)
     - `'update'` → find task by `result.taskId`, append note with timestamp (use property timezone Africa/Cairo), update urgency. Format: `existingNote + '\n[Update ' + time + '] ' + newNote`. Cap total note at 2000 chars — if exceeded, trim oldest `[Update]` entries. Broadcast `task_updated` SSE.
     - `'resolve'` → find task by `result.taskId`, set `status: 'completed'`, `completedAt: new Date()`. Broadcast `task_updated` SSE.
     - `'skip'` → log `[AI] Task Manager: skipped escalation (reason: ${result.reason})` and return without creating.
  4. Log the decision: `[AI] Task Manager: ${result.action} ${result.taskId || ''} (${result.reason})`

- [x] T004 [US1] Pass `guestMessage` (ragQuery) to `handleEscalation()` in `backend/src/services/ai.service.ts` — currently `handleEscalation` doesn't receive the guest message. Add it as a parameter and pass `ragQuery` from the caller at lines ~1550 and ~1663.

**Checkpoint**: Cleaning request → 1 task. Follow-up "10am" → same task updated. No duplicates.

---

## Phase 3: User Story 2 — Resolve Completed Requests (Priority: P2)

**Goal**: When a guest says an issue is fixed, the Task Manager closes the open task.

**Independent Test**: Report maintenance issue → task created. Say "it's fixed" → task resolved.

### Implementation

- [x] T005 [US2] Verify `RESOLVE` action handling in `handleEscalation()` in `backend/src/services/ai.service.ts` — confirm the resolve path from T003 works correctly:
  - Validates task exists and belongs to tenant
  - Sets `status: 'completed'` and `completedAt`
  - Broadcasts `task_updated` SSE event
  - Does NOT create a new task

**Checkpoint**: "It's fixed" → existing task closed, no new task.

---

## Phase 4: User Story 3 — Skip Redundant Escalations (Priority: P3)

**Goal**: When an escalation adds no new information, skip it entirely.

**Independent Test**: After cleaning task with all details confirmed, guest says "ok sounds good" → no task action.

### Implementation

- [x] T006 [US3] Add skip logging and metrics in `backend/src/services/ai.service.ts` — when Task Manager returns `SKIP`:
  - Log: `[AI] Task Manager: skipped redundant escalation for conv ${conversationId} (reason: ${result.reason})`
  - Store skip decision in ragContext for pipeline display: `ragContext.taskManagerDecision = { action: 'skip', reason }`

**Checkpoint**: Redundant follow-ups don't create or update tasks.

---

## Phase 5: User Story 5 — Show Task Notes in Omar's Prompt (Priority: P5)

**Goal**: Omar sees task notes in the prompt for better context.

**Independent Test**: Check prompt — open tasks section includes note preview.

### Implementation

- [x] T007 [P] [US5] Update open tasks formatting in `backend/src/services/ai.service.ts` (~line 1195) — change from:
  ```
  openTasks.map(t => `[${t.id}] ${t.title} (${t.urgency})`).join('\n')
  ```
  To:
  ```
  openTasks.map(t => {
    const notePreview = t.note ? `\n  → ${t.note.substring(0, 300)}` : '';
    return `[${t.id}] ${t.title} (${t.urgency})${notePreview}`;
  }).join('\n')
  ```

- [x] T008 [P] [US5] Add task update decision rules to system prompt in `backend/src/config/ai-config.json` — add after the escalation urgency section in the guestCoordinator systemPrompt:
  ```
  ## TASK UPDATES (check OPEN TASKS first)
  Before creating a new escalation, check OPEN TASKS above:
  - If an open task covers the same topic the guest is asking about, use updateTaskId to add new details instead of creating a duplicate.
  - If the guest says an issue is resolved, use resolveTaskId to close the task.
  - Only create a new escalation when the request is genuinely NEW and unrelated to any open task.
  ```

**Checkpoint**: Omar sees full task context. System prompt has decision rules.

---

## Phase 6: Polish & Verification

**Purpose**: Final checks and documentation.

- [x] T009 Run `npx tsc --noEmit` in `backend/` to verify zero TypeScript errors.

- [ ] T010 Add Task Manager decision data to pipeline feed in `backend/src/routes/ai-pipeline.ts` — include `taskManagerDecision: ragCtx?.taskManagerDecision || null` in the pipeline response so the frontend can display create/update/resolve/skip decisions.

- [ ] T011 Update `AI_SYSTEM_FLOW-v7.md` — add a section after Stage 4f (Response Handling) documenting the Task Manager agent: when it fires, what it checks, the 4 possible outcomes, cost, and fallback behavior.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately
- **Phase 2 (US1)**: Depends on T001 (Task Manager service)
- **Phase 3 (US2)**: Depends on T003 (integration)
- **Phase 4 (US3)**: Depends on T003 (integration)
- **Phase 5 (US5)**: Independent — can run in parallel with Phase 2-4
- **Phase 6 (Polish)**: Depends on all prior phases

### Parallel Opportunities

```
Phase 1: T001 → T002 (sequential — service then stats)
Phase 2: T003 → T004 (sequential — integrate then pass guestMessage)
Phase 3: T005 (depends on T003)
Phase 4: T006 (depends on T003)
Phase 5: T007 ‖ T008 (parallel — different files)
Phase 6: T009 → T010 ‖ T011 (build check, then parallel)
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. T001-T002: Create Task Manager service
2. T003-T004: Integrate into ai.service.ts
3. **STOP and VALIDATE**: Test cleaning duplicate scenario
4. Deploy — immediate reduction in duplicate tasks

### Incremental Delivery

1. Phase 1+2 → deploy (duplicate prevention — main value)
2. Phase 3+4 → deploy (resolve + skip)
3. Phase 5 → deploy (Omar sees notes — better escalation quality)
4. Phase 6 → deploy (observability + docs)

---

## Notes

- Total: 11 tasks across 6 phases
- 1 new file: `task-manager.service.ts`
- 2 modified files: `ai.service.ts`, `ai-config.json`
- 1 modified route: `ai-pipeline.ts`
- No schema changes, no frontend changes, no new env vars
- Cost: ~$0.00005 per escalation (~$0.000015/message average)
