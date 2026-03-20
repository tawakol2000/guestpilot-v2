# Research: Smart Escalation Logic

**Branch**: `007-smart-escalation`
**Date**: 2026-03-20

---

## Finding 1: Task Manager Agent Design

**Decision**: Lightweight Haiku post-processor that fires only when Omar generates an escalation.

**Rationale**:
- Code-level deduplication fails for nuanced topics (pharmacy vs mall — both `info_request`)
- Adding all task context to Omar's main prompt bloats it unnecessarily (~300 chars × 10 tasks = 3000 chars on every message)
- A separate agent focuses exclusively on the create/update/resolve/skip decision
- Fires only on escalations (~30% of messages) — 70% of messages have zero extra cost

**Alternatives considered**:
- Prompt-only (Option A): Relies on Claude's judgment with incomplete info. Tested informally — Claude still creates duplicates even with task notes visible.
- Deterministic code (Option C): String matching on titles. Works for cleaning/maintenance but fails for info_request topics where titles are generic.

---

## Finding 2: Task Manager Prompt Design

**Decision**: Minimal prompt with structured input/output.

**Input format**:
```
OPEN TASKS FOR THIS CONVERSATION:
[task-id-1] cleaning-scheduled (scheduled)
  Note: Guest Mohamed, Unit 3. Wants cleaning. Time TBD. $20 fee explained.
  Created: 2 minutes ago

[task-id-2] info-pharmacy (info_request)
  Note: Guest asked about nearest pharmacy.
  Created: 5 minutes ago

NEW ESCALATION FROM OMAR:
Title: cleaning-time-confirmed
Note: Guest Mohamed confirmed cleaning at 10am. $20 fee accepted.
Urgency: scheduled

GUEST MESSAGE: "10am works for me"

DECIDE: Should this escalation CREATE a new task, UPDATE an existing task, RESOLVE an existing task, or be SKIPPED as redundant?
Return JSON: {"action":"create|update|resolve|skip","taskId":"<id if update/resolve>","reason":"<brief>"}
```

**Output**: Single JSON line — action + taskId + reason.

**Rationale**: Haiku excels at structured classification with clear options. The prompt is ~200 tokens input, ~30 tokens output. At $0.25/M input + $1.25/M output for Haiku, cost is ~$0.00005 per call.

---

## Finding 3: Note Appending Strategy

**Decision**: Append new note to existing note with timestamp separator, don't replace.

**Format**:
```
[Original] Guest Mohamed, Unit 3. Wants cleaning. Time TBD. $20 fee explained.
[Update 10:15 AM] Guest confirmed 10am. $20 accepted.
[Update 10:22 AM] Guest changed time to 11am.
```

**Rationale**: Preserves the full history of a request in one task. The manager sees the evolution without needing to check multiple tasks.

**Cap**: Total note length capped at 2000 chars. Oldest update entries trimmed if exceeded.

---

## Finding 4: Open Tasks in Omar's Prompt

**Decision**: Include task notes (capped at 300 chars) in the open tasks section shown to Omar.

**Before**:
```
### OPEN TASKS ###
[clm9abc123] cleaning-scheduled (scheduled)
```

**After**:
```
### OPEN TASKS ###
[clm9abc123] cleaning-scheduled (scheduled)
  → Guest wants cleaning tomorrow, time TBD, $20 fee explained.
```

**Rationale**: Even with the Task Manager as a safety net, giving Omar context helps it write better escalation notes that reference the existing request. Reduces Task Manager workload.

---

## Finding 5: Graceful Degradation

**Decision**: If Task Manager call fails → create task as Omar requested. Never lose an escalation.

**Rationale**: Constitution §I (Graceful Degradation) requires all optional features to fail silently. The Task Manager is optional — the system worked (poorly) without it before. A failed Task Manager call just means one potential duplicate, which is acceptable.

**Implementation**: try/catch around the Haiku call. On any error, log warning and proceed with task creation.
