# Contract: `logAgentGeneration` per-round Langfuse emit

**Function:** `logAgentGeneration` in [`backend/src/services/observability.service.ts`](../../../backend/src/services/observability.service.ts)
**Version:** v3 (this feature) — extends v2 (added 2026-05-04 in commit `0ffb6db`)
**Caller paths:** [`sdk-runner.ts`](../../../backend/src/build-tune-agent/sdk-runner.ts) (SDK transport, default), [`runtime-direct.ts`](../../../backend/src/build-tune-agent/runtime-direct.ts) (direct transport, opt-in via `BUILD_AGENT_DIRECT_TRANSPORT=true`)

## Function signature (v3)

```ts
export function logAgentGeneration(params: {
  name: string;                    // e.g. 'tuning-agent.query'
  model: string;                   // e.g. 'claude-sonnet-4-6'

  inputTokens: number;             // fresh input only (input_tokens from API)
  outputTokens: number;
  cacheReadTokens?: number;        // cache_read_input_tokens
  cacheCreationTokens?: number;    // cache_creation_input_tokens

  metadata?: {
    // NEW in v3 — required for per-round capture
    roundIndex: number;            // 1-based, monotonic within a parent query
    parentSpanId?: string;         // optional: explicit parent for span tree

    // Existing context
    tenantId?: string;
    conversationId?: string;
    toolCallsInRound?: string[];   // tool names invoked in this round
  };
}): void;
```

## Behavior

### Emit cadence (LIVE)

The function MUST be called inside the `for await` loop of the agent runtime, **at the moment** each `assistant` SDK message arrives with `usage`. NOT batched at end-of-query. Each generation carries its own `startTime` / `endTime` matching the actual round window.

```ts
// SDK transport (sdk-runner.ts) — illustrative
for await (const message of q) {
  if (message.type === 'assistant' && message.message?.usage) {
    const u = message.message.usage;
    logAgentGeneration({
      name: 'tuning-agent.query',
      model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      metadata: {
        roundIndex: ++cumulativeUsage.rounds,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        toolCallsInRound: extractToolNamesFromMessage(message),
      },
    });
  }
  bridgeSDKMessage(message, state, filteredWrite);
}
```

### Langfuse generation body

The function calls `trace.generation(...)` on the current root trace with:

```ts
trace.generation({
  name: params.name,
  model: params.model,
  usageDetails: {
    input: params.inputTokens,
    output: params.outputTokens,
    cache_read_input_tokens: params.cacheReadTokens ?? 0,
    cache_creation_input_tokens: params.cacheCreationTokens ?? 0
  },
  metadata: { ...(params.metadata ?? {}) }
});
```

Cost is auto-computed by Langfuse's model-pricing layer using the `usageDetails` keys.

### Graceful degradation

- If `getCurrentTrace()` returns null (no root trace active), function is a silent no-op.
- If Langfuse env vars are missing, the underlying `trace` is null and the function is a silent no-op.
- Any thrown error inside the `trace.generation(...)` call is caught and logged at `console.warn` level (existing behavior). Agent execution continues unaffected.

## Two-transport requirement

Both transports MUST emit per-round generations with byte-equivalent shape:

| Transport | Where the loop lives | Emit point |
|---|---|---|
| SDK (default) | `sdk-runner.ts` `for await (const message of q)` | When `message.type === 'assistant'` and `message.message.usage` is present |
| Direct (opt-in) | `runtime-direct.ts` `for await (const event of streamingResponse)` | On `message_delta` events that carry `usage` deltas, finalized on `message_stop` |

The direct-transport bridge needs additional plumbing because the streaming API surfaces usage incrementally (per `message_delta`) rather than as a complete object. The bridge accumulates the deltas and emits one `logAgentGeneration` call per `message_stop` event.

## Validation & test cases

| Test | Assertion |
|---|---|
| 5-round turn under SDK transport | 5 generations emitted with `roundIndex` 1..5 monotonic |
| 4-round turn under direct transport | 4 generations emitted with same shape as SDK transport |
| Trivial 1-round turn | 1 generation emitted (no special-casing for single rounds) |
| Langfuse disabled | All `logAgentGeneration` calls are no-ops; agent runs to completion |
| Mid-turn process crash after round 3 | Rounds 1-3 already in Langfuse via live emit |
| Sum of per-round inputs across one turn | Within 5% of the Anthropic console's reported total for that turn |

Tests live in `backend/src/build-tune-agent/__tests__/sdk-runner.test.ts` (extended) and `backend/src/build-tune-agent/__tests__/runtime-direct.test.ts` (extended).

## Audit-script integration

`backend/scripts/langfuse-cost-audit.ts` extension reads `metadata.roundIndex` from each observation and groups by `(traceId, roundIndex)`. Output table gains a "rounds" column showing the per-trace round count.

`backend/scripts/langfuse-trace-detail.ts` extension renders the per-round generations as a chronological tree under their parent `tuning-agent.query` span, with each round showing input/output/cache_read/cache_write breakdown.

## Constitution compliance

- **I. Graceful Degradation**: explicit no-op path when Langfuse is disabled or `getCurrentTrace()` returns null.
- **VI. Observability**: this contract IS the observability improvement. Strengthens existing principle.
