# Contract: `studio_get_context`

**Tool name:** `studio_get_context` (existing, extended)
**Owner:** [`backend/src/build-tune-agent/tools/get-context.ts`](../../../backend/src/build-tune-agent/tools/get-context.ts)
**Version:** v2 (this feature) — additive `verbosity` parameter

## Input schema

```ts
{
  // NEW in this feature
  verbosity: z.enum(['concise', 'detailed']).optional()  // default 'concise'
}
```

No other parameters today; `studio_get_context` is parameter-less in v1.

## Description (operator-readable, written into tool description)

> Return the conversation context for this Studio session: anchor message text, last few inbox messages, and last-edit summary. Default `verbosity:'concise'` returns ≤2K tokens (anchor + last 3 inbox + last edit). Use `verbosity:'detailed'` (current 7.8K-token shape) only when you need the full conversation history, full anchor message metadata, retrieval context, and other heavy fields. Most turns only need concise.

## Output schemas

### `concise` (new default)

```json
{
  "conversation": {
    "id": "<cuid>",
    "title": "<string>",
    "anchorMessageId": "<cuid | null>",
    "anchorMessage": {
      "id": "<cuid>",
      "role": "AI" | "MANAGER" | "GUEST",
      "content": "<string>",
      "createdAt": "<ISO8601>"
    }
  },
  "lastInbox": [
    { "id": "<cuid>", "role": "...", "content": "<string>", "createdAt": "<ISO8601>" }
  ],
  "lastEditSummary": "<string | null>",
  "verbosity": "concise"
}
```

Target ≤2,000 tokens. `lastInbox` capped at 3 entries; if the conversation has fewer, returns however many exist.

### `detailed` (existing shape, preserved byte-for-byte)

Existing v1 shape — full conversation, anchor message + reactions, retrieval context, classifier decision, system prompt version, agent name, mode, and metadata. Approximately 7.8K tokens for a typical conversation. Used when the agent needs full context (rare).

## Validation & error cases

| Case | Response |
|---|---|
| `verbosity:'concise'` | Returns slim shape, target ≤2K tokens |
| `verbosity:'detailed'` | Returns existing v1 shape byte-for-byte |
| No params (default) | Treated as `verbosity:'concise'` |
| Conversation not found | `asError("studio_get_context: conversation not found")` (existing behavior) |

## Span observability

`build-tune-agent.studio_get_context` span ends with metadata:

```ts
{
  detailed: boolean,           // verbosity === 'detailed'
  returnCharLength: number,    // size of what we returned
  hasAnchor: boolean,
  inboxCount: number           // entries in lastInbox
}
```

## Constitution compliance

- **I. Graceful Degradation**: existing fallback to "no anchor" preserved.
- **II. Multi-Tenant Isolation**: existing tenant-scoped query unchanged.
- **VI. Observability**: span metadata captures the new fields.
