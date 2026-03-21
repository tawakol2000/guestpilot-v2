# Data Model: OpenAI GPT-5.4 Mini Migration

## No Schema Migration Required

The Prisma schema is NOT modified. Changes are limited to:
1. JSON field shape changes in AiApiLog.ragContext
2. New fields in TenantAiConfig (model tier selection — can use existing `model` field)

## AiApiLog.ragContext — Enhanced Fields

New fields added to the ragContext JSON for OpenAI-specific metadata:

```typescript
{
  // SOP Tool Classification (unchanged from 013)
  sopToolUsed: boolean;
  sopCategories: string[];
  sopConfidence: 'high' | 'medium' | 'low';
  sopReasoning: string;

  // OpenAI-specific (NEW in 014)
  modelUsed: string;                    // e.g., "gpt-5.4-mini-2026-03-17"
  reasoningEffort: 'none' | 'low';      // reasoning.effort used for response call
  reasoningTokens: number;              // reasoning tokens consumed (0 when effort=none)
  cachedInputTokens: number;            // tokens served from cache
  totalInputTokens: number;             // total input tokens (cached + uncached)
  cacheHitRate: number;                 // cachedInputTokens / totalInputTokens
  promptCacheKey: string;               // e.g., "tenant-abc-screening"

  // Property Knowledge RAG (unchanged)
  chunks: Array<{ content, category, similarity, sourceKey, isGlobal }>;
  totalRetrieved: number;
  durationMs: number;
  topSimilarity: number;

  // Escalation (unchanged)
  escalationSignals: string[];

  // Tool Usage (unchanged)
  toolUsed?: boolean;
  toolName?: string;
  toolInput?: any;
  toolResults?: any;
  toolDurationMs?: number;
}
```

## AiApiLog — Cost Calculation Changes

Cost calculation formula changes from Anthropic to OpenAI pricing:

**Before** (Anthropic Haiku):
```
cost = (inputTokens * 1.00/1M) + (outputTokens * 5.00/1M) + (cacheWriteTokens * 1.25/1M) + (cacheReadTokens * 0.10/1M)
```

**After** (OpenAI GPT-5.4 Mini):
```
cost = (uncachedInputTokens * 0.75/1M) + (cachedInputTokens * 0.075/1M) + (outputTokens * 4.50/1M) + (reasoningTokens * 4.50/1M)
```

Pricing is read from `backend/src/config/model-pricing.json` (FR-020).

## TenantAiConfig — Model Selection

The existing `model` field on TenantAiConfig stores the selected model string. No schema change needed — just update the allowed values:

**Before**: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, etc.
**After**: `gpt-5.4-mini-2026-03-17`, `gpt-5.4-nano`, `gpt-5.4`

## model-pricing.json — Updated Content

```json
{
  "gpt-5.4-mini-2026-03-17": { "input": 0.75, "cachedInput": 0.075, "output": 4.50 },
  "gpt-5.4-mini": { "input": 0.75, "cachedInput": 0.075, "output": 4.50 },
  "gpt-5.4-nano": { "input": 0.20, "cachedInput": 0.02, "output": 1.25 },
  "gpt-5.4": { "input": 2.50, "cachedInput": 0.25, "output": 15.00 }
}
```
