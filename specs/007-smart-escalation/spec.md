# Feature Specification: Smart Escalation Logic

**Feature Branch**: `007-smart-escalation`
**Created**: 2026-03-20
**Status**: Draft
**Input**: Smart escalation with a lightweight Task Manager AI agent that decides whether to create, update, resolve, or skip escalations — preventing duplicate tasks while handling nuanced topic differentiation.

## Problem Statement

The AI creates a new escalation task for every interaction in a multi-turn service request, even when an open task already exists for the same issue. This floods the manager's task queue with duplicates and makes it harder to track actual issues.

**Example of the current problem:**
1. Guest: "Can we get cleaning done?" → AI creates task `cleaning-scheduled` (**correct**)
2. Guest: "10am please" → AI creates ANOTHER task `cleaning-time-confirmed` (**wrong — should update**)
3. Guest: "Actually, make it 11am" → AI creates a THIRD task (**wrong — should update again**)
4. Manager sees 3 tasks for what is actually 1 cleaning request

**Why simple code can't fix this:**
- Title matching works for obvious cases (`cleaning-scheduled` → `cleaning-time-confirmed`)
- But fails for `info_request` escalations: "nearest pharmacy" vs "closest mall" vs "good restaurant" all create `info_request` tasks with different topics. Code-level string matching can't tell if "which pharmacy is open 24 hours?" is a follow-up to "nearest pharmacy" or a new request.

**Solution:** A lightweight Task Manager AI that fires ONLY when Omar generates an escalation. It sees the full context (open tasks with notes + new escalation + guest message) and makes a single decision: create, update, resolve, or skip.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Task Manager Prevents Duplicate Escalations (Priority: P1)

When Omar generates an escalation for a topic that already has an open task, the Task Manager detects the duplicate and converts the "create" into an "update" on the existing task.

**Why this priority**: This is the core fix. Every multi-turn service request currently generates 2-3 duplicate tasks. The Task Manager eliminates this at the source.

**Independent Test**: Ask for cleaning → task created. Say "10am please" → Omar generates another escalation → Task Manager detects it matches the existing cleaning task → existing task updated with confirmed time, no new task created.

**Acceptance Scenarios**:

1. **Given** an open task `cleaning-scheduled` with note "Guest wants cleaning, time TBD", **When** Omar escalates again with "Guest confirmed 10am for cleaning", **Then** the Task Manager returns `UPDATE {existing-task-id}` and the existing task note is updated with the confirmed time.
2. **Given** an open task `info_request` with note "Guest asked about nearest pharmacy", **When** Omar escalates with "Guest asking about closest mall", **Then** the Task Manager returns `CREATE` because this is a genuinely different topic.
3. **Given** an open task `info_request` with note "Guest asked about nearest pharmacy", **When** Omar escalates with "Guest wants to know which pharmacy is open 24 hours", **Then** the Task Manager returns `UPDATE` because this is a follow-up about the same pharmacy question.

---

### User Story 2 — Task Manager Resolves Completed Requests (Priority: P2)

When a guest indicates that a previously escalated issue is resolved, the Task Manager closes the existing task instead of creating a new escalation.

**Why this priority**: Without this, resolved issues stay open in the queue forever. The manager has to manually close tasks that the guest already confirmed are fixed.

**Independent Test**: Report a maintenance issue → task created. Say "it's fixed now" → Omar might escalate or not → Task Manager detects the open maintenance task and resolves it.

**Acceptance Scenarios**:

1. **Given** an open task `maintenance-no-hot-water`, **When** the guest says "the hot water is working now", **Then** the Task Manager returns `RESOLVE {existing-task-id}` and the task is closed.
2. **Given** an open task `cleaning-scheduled`, **When** the guest says "never mind, we don't need cleaning anymore", **Then** the Task Manager returns `RESOLVE` and the task is closed.

---

### User Story 3 — Task Manager Skips Redundant Escalations (Priority: P3)

When Omar generates an escalation that adds no new information to an existing open task, the Task Manager skips it entirely — no create, no update.

**Why this priority**: Some follow-up messages ("ok thanks", "sounds good") trigger Omar to re-escalate with the same information. These add noise to the queue without new context.

**Independent Test**: After a cleaning escalation, guest says "ok sounds good" → Omar might escalate with the same cleaning info → Task Manager detects no new information → returns `SKIP`.

**Acceptance Scenarios**:

1. **Given** an open task `cleaning-scheduled` with note "Guest Mohamed, Unit 3, cleaning at 10am, $20 fee confirmed", **When** Omar escalates with essentially the same note, **Then** the Task Manager returns `SKIP` — no duplicate, no update.
2. **Given** an open task with all relevant details already captured, **When** the guest sends a generic acknowledgment, **Then** no task action is taken.

---

### User Story 4 — Task Manager Works Across All Escalation Types (Priority: P4)

The Task Manager correctly handles the create/update/resolve/skip decision for all common escalation scenarios — not just cleaning.

**Why this priority**: The multi-turn pattern applies to every service request type. The Task Manager must generalize.

**Independent Test**: Run through each escalation type with a multi-turn conversation and verify exactly 1 task is created per distinct request.

**Acceptance Scenarios**:

1. **Cleaning**: request → create → confirm time → update → change time → update → cancel → resolve
2. **Maintenance**: report → create → add details → update → confirm fixed → resolve
3. **Early check-in**: ask → create → provide arrival time → update
4. **Amenity request**: ask for towels → create → change quantity → update
5. **Visitor policy**: request visit → create → send passport → update
6. **Complaint**: report noise → create → noise stopped → resolve
7. **Info request (pharmacy)**: ask pharmacy → create → ask pharmacy hours → update
8. **Info request (mall)**: ask mall → create (separate from pharmacy task)

---

### User Story 5 — AI Sees Full Task Context (Priority: P5)

Omar receives open task notes in the prompt (not just titles), so Omar's own escalation decisions are better informed even before the Task Manager runs.

**Why this priority**: Showing task notes helps Omar generate better escalation notes (referencing existing context) and makes Omar more likely to use `updateTaskId` natively — reducing the Task Manager's workload.

**Independent Test**: Check the prompt sent to Omar — open tasks section should include note content.

**Acceptance Scenarios**:

1. **Given** an open task with a detailed note, **When** the prompt is built, **Then** Omar sees the note (capped at 300 chars) alongside the title and urgency.
2. **Given** Omar sees an open task about cleaning, **When** the guest provides a time, **Then** Omar's escalation note references the existing task context ("updated cleaning time to 10am" rather than starting from scratch).

---

### Edge Cases

- What if the Task Manager AI call fails (API timeout, rate limit)? Fall back to creating the task as Omar requested — never lose an escalation silently.
- What if there are 10+ open tasks? The Task Manager should still identify the most relevant one. Include all open tasks (capped at 10) sorted by recency.
- What if Omar returns BOTH a `resolveTaskId` AND a new escalation? The Task Manager should handle the resolve first, then evaluate the new escalation.
- What if the guest changes topics mid-sentence ("the cleaning at 10am is fine, but also the WiFi isn't working")? Omar should produce two escalation actions, and the Task Manager should handle each independently.
- What if the Task Manager says SKIP but the manager actually needed to see the update? Track skip decisions in logs for auditing. Better to over-update than under-update.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A lightweight Task Manager AI MUST run as a post-processing step whenever Omar generates an escalation.
- **FR-002**: The Task Manager MUST receive: Omar's escalation (title, note, urgency), all open tasks for this conversation (with full notes), and the guest's current message.
- **FR-003**: The Task Manager MUST return exactly one decision: `CREATE`, `UPDATE {taskId}`, `RESOLVE {taskId}`, or `SKIP`.
- **FR-004**: When the Task Manager returns `UPDATE`, the existing task's note MUST be appended with the new information (not replaced), preserving the history of the request.
- **FR-005**: When the Task Manager returns `RESOLVE`, the existing task MUST be closed with status "completed" and a `completedAt` timestamp.
- **FR-006**: When the Task Manager returns `SKIP`, no task action is taken and the decision is logged for auditing.
- **FR-007**: If the Task Manager AI call fails for any reason, the system MUST fall back to creating the task as Omar requested — escalations are never lost silently.
- **FR-008**: Open tasks shown to Omar in the prompt MUST include the task note (capped at 300 characters) alongside the title and urgency.
- **FR-009**: The Task Manager MUST fire only when Omar generates an escalation — not on every message. This limits extra cost to ~30% of messages.
- **FR-010**: The Task Manager AI call MUST use the cheapest available model and complete in under 500ms.

### Key Entities

- **Task Manager Agent**: A lightweight AI post-processor that evaluates escalation decisions. Input: new escalation + open tasks + guest message. Output: CREATE / UPDATE / RESOLVE / SKIP.
- **Task**: An escalation record. Enhanced with note history (appended on updates). Open tasks are injected into Omar's prompt with note content.
- **Task Decision Log**: A record of the Task Manager's decision for each escalation, stored for auditing and tuning.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Duplicate escalation rate drops by at least 70% — measured by counting conversations where 2+ tasks are created for the same underlying request.
- **SC-002**: Manager task queue contains 30-50% fewer open tasks at any given time.
- **SC-003**: Zero regression in escalation coverage — every request that genuinely needs manager attention still generates at least one task.
- **SC-004**: At least 90% of multi-turn service requests result in exactly 1 task, not 2+.
- **SC-005**: Task Manager AI cost stays under $0.0001 per escalation (average).
- **SC-006**: Task Manager adds less than 500ms latency to escalation processing.

## Assumptions

- The existing Task model, `updateTaskId`, and `resolveTaskId` code paths work correctly — verified by audit.
- Haiku is fast enough (<500ms) and cheap enough (~$0.00005) for this use case.
- The Task Manager runs AFTER Omar has already sent the guest response — it doesn't block the guest-facing reply.
- Note appending (not replacing) preserves the request history in a single task.
- The guestCoordinator is the only agent that generates escalations. The screeningAI uses a different model (manager.needed) that doesn't produce Task records in the same way.

## Out of Scope

- Changes to the manager's task dashboard UI (tasks are already displayed — this just reduces duplicates).
- Automatic task assignment or routing to specific team members.
- Task priority/ordering logic beyond the existing urgency levels.
- Changes to the screening AI's escalation model.
- Historical deduplication of existing duplicate tasks (only prevents new ones).
