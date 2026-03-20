# Data Model: Smart Escalation Logic

**Branch**: `007-smart-escalation`
**Date**: 2026-03-20

---

## No Schema Changes

The Task model already has all needed fields (title, note, urgency, status, conversationId). No new tables or columns needed.

---

## Interface Changes

### Open Tasks Format (shown to Omar in prompt)

**Before** (ai.service.ts line ~1195):
```
[clm9abc123] cleaning-scheduled (scheduled)
```

**After**:
```
[clm9abc123] cleaning-scheduled (scheduled)
  → Guest wants cleaning tomorrow, time TBD, $20 fee explained.
```

Note capped at 300 characters. If longer, truncated with `...`.

### Task Note Append Format

**Before** (on update, note is REPLACED):
```
Guest Mohamed confirmed cleaning at 10am.
```

**After** (on update, note is APPENDED):
```
[Original] Guest Mohamed, Unit 3. Wants cleaning. Time TBD. $20 fee explained.
[Update 10:15 AM] Guest confirmed 10am. $20 accepted.
```

Total note capped at 2000 chars.

### New Service: Task Manager Agent

**File**: `backend/src/services/task-manager.service.ts` (new)

**Function signature**:
```typescript
export async function evaluateEscalation(input: {
  tenantId: string;
  conversationId: string;
  newEscalation: { title: string; note: string; urgency: string };
  openTasks: Array<{ id: string; title: string; note: string | null; urgency: string; createdAt: Date }>;
  guestMessage: string;
}): Promise<{
  action: 'create' | 'update' | 'resolve' | 'skip';
  taskId?: string;
  reason: string;
}>
```

**Behavior**:
- If `openTasks` is empty → always return `{ action: 'create' }`
- If `openTasks` has entries → call Haiku with structured prompt
- On Haiku failure → return `{ action: 'create', reason: 'task-manager-fallback' }`

### Modified: handleEscalation in ai.service.ts

**Before**: Always creates a new task via `createTask()`.

**After**:
1. Fetch open tasks for this conversation
2. Call `evaluateEscalation()` with new escalation + open tasks + guest message
3. Based on result:
   - `CREATE` → create new task (existing behavior)
   - `UPDATE {id}` → append note to existing task
   - `RESOLVE {id}` → close existing task
   - `SKIP` → log and do nothing
