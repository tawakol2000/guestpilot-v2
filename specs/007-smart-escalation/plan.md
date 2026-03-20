# Implementation Plan: Smart Escalation Logic

**Branch**: `007-smart-escalation` | **Date**: 2026-03-20 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/007-smart-escalation/spec.md`

## Summary

Add a lightweight Task Manager AI agent that fires only when Omar generates an escalation. It compares the new escalation against open tasks (with full notes) and decides: create new task, update existing task, resolve existing task, or skip as redundant. Also enhance Omar's prompt to show task notes for better context.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK (Haiku)
**Storage**: No schema changes — uses existing Task model
**Testing**: Manual end-to-end via pipeline visualization + task queue inspection
**Target Platform**: Railway (Docker)
**Project Type**: Web service — backend only
**Performance Goals**: Task Manager call < 500ms, < $0.0001/call
**Constraints**: Must not block guest-facing response. Graceful fallback on failure.
**Scale/Scope**: 1 new service file (~100 lines), modifications to ai.service.ts (~50 lines), system prompt update

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | ✅ PASS | Task Manager failure → fallback to create. Never loses escalation. |
| §II Multi-Tenant Isolation | ✅ PASS | Open tasks scoped by conversationId + tenantId. |
| §III Guest Safety | ✅ PASS | No access code changes. Escalation coverage preserved. |
| §IV Structured AI Output | ✅ PASS | Task Manager returns structured JSON. |
| §V Escalate When In Doubt | ✅ PASS | Fallback always creates. SKIP is conservative. |
| §VI Observability | ✅ PASS | Task Manager decisions logged. SKIP decisions tracked. |
| §VII Self-Improvement | ✅ PASS | No classifier changes. |
| Security | ✅ PASS | No new endpoints. Uses existing API key. |

## Project Structure

### Documentation

```text
specs/007-smart-escalation/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── task-manager-prompt.md
└── tasks.md
```

### Source Code

```text
backend/src/
├── services/
│   ├── task-manager.service.ts    # NEW — Task Manager AI agent
│   └── ai.service.ts             # MODIFIED — integrate Task Manager + show task notes
└── config/
    └── ai-config.json             # MODIFIED — escalation decision rules in system prompt
```

## Implementation Approach

### Change 1: Create Task Manager Service (NEW)

**File**: `backend/src/services/task-manager.service.ts`

- Lazy Anthropic client (same pattern as intent-extractor)
- `evaluateEscalation()` function:
  - Input: new escalation + open tasks (with notes) + guest message
  - If no open tasks → return `CREATE` immediately (no API call)
  - Otherwise → call Haiku with structured prompt from contracts/task-manager-prompt.md
  - Parse JSON response → return `{ action, taskId?, reason }`
  - On any error → return `CREATE` with reason `task-manager-error`
- Cost: ~$0.00005/call (200 tokens in, 30 out)
- Temperature: 0.0 (deterministic)
- max_tokens: 100

### Change 2: Integrate Task Manager into ai.service.ts

**In handleEscalation() (~line 986)**:

1. Fetch open tasks: `prisma.task.findMany({ where: { conversationId, status: 'open' }, take: 10 })`
2. Call `evaluateEscalation({ newEscalation, openTasks, guestMessage })`
3. Switch on result:
   - `CREATE` → existing `createTask()` path (no change)
   - `UPDATE {id}` → append note to existing task:
     ```
     [Original] Guest Mohamed, Unit 3. Wants cleaning. Time TBD.
     [Update 10:15 AM] Guest confirmed 10am. $20 accepted.
     ```
   - `RESOLVE {id}` → `prisma.task.update({ status: 'completed', completedAt: new Date() })`
   - `SKIP` → log `[TaskManager] Skipped: {reason}` and return without creating

**Note append** (not replace): preserves request history in one task.

### Change 3: Show Task Notes in Omar's Prompt

**In ai.service.ts (~line 1195)**:

Change open tasks format to include note preview:
```
[clm9abc123] cleaning-scheduled (scheduled)
  → Guest wants cleaning tomorrow, time TBD, $20 fee explained.
```

Note capped at 300 chars. Helps Omar write better escalation notes that reference existing context.

### Change 4: Update System Prompt Escalation Rules

**In ai-config.json guestCoordinator systemPrompt**:

Add task update decision rules after escalation urgency section:
```
## TASK UPDATES (check OPEN TASKS first)
Before creating a new escalation, check OPEN TASKS above:
- If an open task covers the same topic → use updateTaskId
- If the guest says issue is resolved → use resolveTaskId
- Only create new escalation when genuinely unrelated to open tasks
```

With examples for cleaning, maintenance, info_request scenarios.

## Deployment

Standard push. No schema migration. No new env vars. Task Manager uses existing `ANTHROPIC_API_KEY`. Runs during escalation handling (before task creation) — adds ~300-500ms to escalation processing but does NOT block the guest-facing response since escalation handling already runs after the response is sent via Hostaway.
