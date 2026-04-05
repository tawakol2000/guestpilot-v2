# Contract: Coordinator Output Schema (with Reasoning)

## JSON Schema

```json
{
  "name": "omar_coordinator_response",
  "strict": true,
  "schema": {
    "type": "object",
    "properties": {
      "reasoning": {
        "type": "string",
        "description": "Internal reasoning: what the guest is asking, which SOP applies, what context you have, what the right response is. Under 80 words. Not shown to guest."
      },
      "guest_message": {
        "type": "string",
        "description": "Reply sent to the guest. Empty string for conversation-ending messages."
      },
      "escalation": {
        "type": ["object", "null"],
        "properties": {
          "title": {
            "type": "string",
            "description": "kebab-case slug, max 6 words"
          },
          "note": {
            "type": "string",
            "description": "Structured handoff: Guest: [name, unit] / Situation: [1 sentence] / Guest wants: [verbatim] / Context: [2-3 facts] / Suggested action: [recommendation] / Urgency reason: [why this level]"
          },
          "urgency": {
            "type": "string",
            "enum": ["immediate", "scheduled", "info_request"]
          }
        },
        "required": ["title", "note", "urgency"],
        "additionalProperties": false
      },
      "resolveTaskId": {
        "type": ["string", "null"],
        "description": "Task ID from open tasks when guest confirms existing issue is resolved"
      },
      "updateTaskId": {
        "type": ["string", "null"],
        "description": "Task ID from open tasks when adding details to existing escalation instead of duplicating"
      }
    },
    "required": ["reasoning", "guest_message", "escalation", "resolveTaskId", "updateTaskId"],
    "additionalProperties": false
  }
}
```

## Key Differences from Current Schema

| Field | Before | After |
|-------|--------|-------|
| `reasoning` | Not present | First field, required string, chain-of-thought |
| `escalation.note` | Free-form text | Structured format (Guest/Situation/Guest wants/Context/Suggested action/Urgency reason) |
| Everything else | Unchanged | Unchanged |

## SSE Broadcast Payload

When the AI response is broadcast via SSE, the payload includes:

```json
{
  "conversationId": "...",
  "message": {
    "role": "AI",
    "content": "WiFi is BoutiqueR_5G, password guest2024.",
    "reasoning": "WiFi credentials in reservation details, no tool needed. One-sentence answer.",
    "sentAt": "2026-04-05T19:30:00Z",
    "channel": "AIRBNB"
  }
}
```

The `reasoning` field is included in the SSE payload. The frontend decides whether to display it based on the tenant's `showAiReasoning` setting.

## Hostaway Message (reasoning stripped)

The message sent to Hostaway contains ONLY `guest_message`. The `reasoning` field is never included:

```
WiFi is BoutiqueR_5G, password guest2024.
```
