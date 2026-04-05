# Data Model: Coordinator Prompt Rework with Reasoning

## Schema Changes

### TenantAiConfig (existing model — add field)

Add one boolean field:

- `showAiReasoning` — Boolean, default `false`. When true, the frontend displays AI reasoning alongside AI messages in the inbox chat view. Per-tenant setting.

No other schema changes. The reasoning field is part of the AI JSON output (runtime), not persisted separately — it's already captured in AiApiLog.responseText.

## Runtime Entities (not persisted)

### Coordinator Output Schema (updated)

```
{
  reasoning: string       // NEW — first field, chain-of-thought, under 80 words
  guest_message: string   // Existing — reply to guest
  escalation: {           // Existing — null when handled alone
    title: string
    note: string          // NOW follows structured format
    urgency: "immediate" | "scheduled" | "info_request"
  } | null
  resolveTaskId: string | null   // Existing
  updateTaskId: string | null    // Existing
}
```

### Reasoning Effort Level (runtime)

- Input: current message text, open task count
- Output: `"low"` or `"medium"`
- Not persisted — computed per-request
- Logged in AiApiLog.ragContext for debugging

### SSE Broadcast Payload (updated)

The existing `ai_response` SSE event payload adds:
- `reasoning: string` — the AI's internal reasoning, included alongside the existing message data
