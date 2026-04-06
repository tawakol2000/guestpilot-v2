# AI Output Schema Contracts

## Coordinator Response Schema

```json
{
  "type": "json_schema",
  "name": "coordinator_response",
  "strict": true,
  "schema": {
    "type": "object",
    "properties": {
      "guest_message": {
        "type": "string",
        "description": "Reply to the guest. Empty string if no reply needed."
      },
      "escalation": {
        "type": ["object", "null"],
        "description": "null when no escalation needed. Object when escalating.",
        "properties": {
          "title": { "type": "string", "description": "kebab-case escalation label" },
          "note": { "type": "string", "description": "Details for manager: situation, what the guest wants (quote their words when charged), and suggested action." },
          "urgency": { "type": "string", "enum": ["immediate", "scheduled", "info_request"] }
        },
        "required": ["title", "note", "urgency"],
        "additionalProperties": false
      },
      "resolveTaskId": { "type": ["string", "null"], "description": "Task ID from open tasks when guest confirms issue resolved" },
      "updateTaskId": { "type": ["string", "null"], "description": "Task ID from open tasks when adding new details to existing escalation" }
    },
    "required": ["guest_message", "escalation", "resolveTaskId", "updateTaskId"],
    "additionalProperties": false
  }
}
```

**Changes from old**: `escalation.note` description updated to include format guidance.
**Changes from v4**: Removed `reasoning`, `action`, `sop_step` fields.

## Screening Response Schema

```json
{
  "type": "json_schema",
  "name": "screening_response",
  "strict": true,
  "schema": {
    "type": "object",
    "properties": {
      "guest_message": {
        "type": "string",
        "description": "Reply to the guest. Empty string if no reply needed."
      },
      "manager": {
        "type": "object",
        "description": "Manager escalation. needed=false when still gathering info.",
        "properties": {
          "needed": { "type": "boolean", "description": "true when manager action needed (booking decision, rejection). false when still gathering info." },
          "title": { "type": "string", "description": "kebab-case category from escalation vocabulary. Empty string when not needed." },
          "note": { "type": "string", "description": "Details for manager: nationality, party composition, screening recommendation. Empty string when not needed." }
        },
        "required": ["needed", "title", "note"],
        "additionalProperties": false
      }
    },
    "required": ["guest_message", "manager"],
    "additionalProperties": false
  }
}
```

**Changes from old**: Field renamed from `'guest message'` (space) to `guest_message` (underscore). `manager.note` description updated.
**Changes from v4**: Removed `reasoning`, `nationality_known`, `composition_known`, `action`, `sop_step` fields.

## Derived Fields (computed by code, stored in ragContext)

| Field | Source | Logic |
|-------|--------|-------|
| action | Response structure | escalation != null → "escalate"; guest_message == "" → "none"; manager.needed + title starts with "eligible-" → "screen_eligible"; manager.needed + title starts with "violation-" → "screen_violation"; else → "reply" |
| sopStep | Tool call log | Categories from get_sop tool call arguments |
| screeningPhase | screening-state.service | GATHER / DECIDE / POST_DECISION |
| reasoningEffort | pickReasoningEffort | "low" or "medium" |

## SSE Message Broadcast

```json
{
  "conversationId": "string",
  "message": {
    "role": "AI",
    "content": "guest_message value",
    "reasoning": "Derived summary: [action]: [detail]",
    "sentAt": "ISO datetime"
  }
}
```

The `reasoning` field is derived from ragContext, not from model output. Format examples:
- "Answered from SOP: sop-cleaning"
- "Escalated: ac-not-working (immediate)"
- "Screening: eligible-arab-family-pending-docs"
- "Asked: awaiting nationality"
- "No action: conversation-ending"
