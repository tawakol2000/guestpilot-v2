# Research: OpenAI GPT-5.4 Mini Migration

## Decision 1: API — Responses API, Not Chat Completions

**Decision**: Use OpenAI Responses API (`client.responses.create()`) exclusively.

**Rationale**: OpenAI recommends Responses API for all new projects. Benefits: automatic prompt caching, `instructions` parameter, `previous_response_id` threading, `reasoning.effort` control, `text.verbosity`, `truncation: "auto"`, and future features (MCP, compaction, reusable prompts) are Responses-only.

**Alternatives considered**: Chat Completions API — rejected because it receives no new features and has worse caching.

## Decision 2: SDK — openai Node.js Package

**Decision**: Replace `@anthropic-ai/sdk` with `openai` npm package.

**Rationale**: 1:1 replacement. Same lazy-init pattern. The `openai` package may already be in package.json (used elsewhere). Remove `@anthropic-ai/sdk` entirely (FR-017).

**Key mapping**:
| Anthropic | OpenAI Responses API |
|-----------|---------------------|
| `anthropic.messages.create()` | `openai.responses.create()` |
| `system: [{text, cache_control}]` | `instructions: string` |
| `messages: [{role, content}]` | `input: [{role, content}]` |
| `max_tokens` | `max_output_tokens` |
| `tool_choice: {type:'tool', name}` | `tool_choice: {type:'function', name}` |
| `stop_reason === 'tool_use'` | Check `output` for `function_call` items |
| `response.content[n].type === 'tool_use'` | `output.find(i => i.type === 'function_call')` |
| `{type:'tool_result', tool_use_id, content}` | `{type:'function_call_output', call_id, output}` |
| `response.content[n].text` | `response.output_text` |
| `response.usage.input_tokens` | `response.usage.input_tokens` |
| `response.usage.output_tokens` | `response.usage.output_tokens` |
| `cache_creation_input_tokens` | `input_tokens_details.cached_tokens` |
| N/A | `output_tokens_details.reasoning_tokens` |

## Decision 3: Tool Schema Format

**Decision**: Convert all tool definitions from Anthropic format to OpenAI function format.

**Anthropic format** (current):
```json
{
  "name": "get_sop",
  "description": "...",
  "input_schema": { "type": "object", "properties": {...}, "required": [...] }
}
```

**OpenAI Responses API format** (new):
```json
{
  "type": "function",
  "name": "get_sop",
  "description": "...",
  "strict": true,
  "parameters": { "type": "object", "properties": {...}, "required": [...], "additionalProperties": false }
}
```

Key differences:
- `input_schema` → `parameters`
- Add `"type": "function"` wrapper
- Add `"strict": true` at tool level
- `additionalProperties: false` required by strict mode
- `input_examples` (Anthropic-specific) → removed (not supported by OpenAI, use few-shot in instructions instead)

## Decision 4: Prompt Caching Strategy

**Decision**: `prompt_cache_key` per tenant+agent type, `prompt_cache_retention: "24h"`.

**Cache keys**:
- `tenant-{tenantId}-screening` — screening agent for INQUIRY
- `tenant-{tenantId}-coordinator` — guest coordinator for CONFIRMED/CHECKED_IN

**Why tenant+agent, not property**: The system prompt and tool definitions are identical across properties for the same agent. Property-specific context (address, amenities) is dynamic and comes after the cache boundary. Caching per-property would fragment the cache across 50+ keys per tenant.

**Cache minimum**: 1,024 tokens (vs Anthropic's 4,096). Our tool definitions (~580 tokens) + system prompt (~1,500 tokens) = ~2,080 tokens — well above minimum.

**24h retention**: OpenAI offers extended cache from default 5-10 min to 24 hours. Costs nothing extra. Critical for properties with sporadic messaging.

**Prompt ordering** (static first, dynamic last):
1. Tool definitions (static per agent)
2. System instructions (static per tenant+agent)
3. Few-shot examples (static)
4. Property context (semi-dynamic)
5. Conversation history (dynamic)
6. Current message (always unique)

## Decision 5: Reasoning Effort

**Decision**: `reasoning.effort: "none"` by default, `"low"` for 4 complex categories.

**Categories triggering low reasoning**:
- `sop-booking-modification` — multi-step date/pricing logic
- `sop-booking-cancellation` — policy interpretation
- `payment-issues` — billing analysis
- `escalate` — careful assessment needed

**Cost impact**: Reasoning tokens billed as output ($4.50/1M). With `none`, zero reasoning cost. With `low`, modest output increase (~50 extra tokens). At ~18% of messages needing `low` (4/22 categories), overall cost impact is <5%.

**Temperature**: When reasoning is `none`, temperature is available. Set to 0.3 for consistent, reliable responses.

## Decision 6: Verbosity and Output Control

**Decision**: `text.verbosity: "low"`, `max_output_tokens: 300`, `truncation: "auto"`.

**Verbosity "low"**: Native control for concise chat responses. More reliable than prompt instructions alone.

**Max output 300**: Prevents runaway generation. Current guest responses average 50-150 tokens. 300 gives headroom for detailed responses without waste.

**Truncation "auto"**: For conversations approaching 400K context window. Preserves recent messages, drops oldest. Better than manual truncation logic.

## Decision 7: Model Pinning and Tiers

**Decision**: Pin to `gpt-5.4-mini-2026-03-17` for production. Offer 3 tiers.

**Available tiers** (configurable per tenant):
| Tier | Model | Input/1M | Cached/1M | Output/1M | Use Case |
|------|-------|----------|-----------|-----------|----------|
| Mini (default) | gpt-5.4-mini-2026-03-17 | $0.75 | $0.075 | $4.50 | Standard guest messaging |
| Nano | gpt-5.4-nano | $0.20 | $0.02 | $1.25 | Budget-conscious, high volume |
| Full | gpt-5.4 | $2.50 | $0.25 | $15.00 | Premium quality |

## Decision 8: Retry Strategy

**Decision**: Exponential backoff with jitter, max 6 attempts, 1-60 second range.

**Current**: `withRetry()` checks for Anthropic `overloaded_error` (status 529).
**New**: Check for OpenAI `429` (rate limit) and `500/502/503` (server errors).

## Decision 9: Environment Variables

**Decision**: Replace `ANTHROPIC_API_KEY` with `OPENAI_API_KEY`.

- Add `OPENAI_API_KEY` (required)
- Remove `ANTHROPIC_API_KEY` requirement
- Update server.ts startup validation
- Update .env.example

## Decision 10: OPUS Service

**Decision**: Delete opus.service.ts entirely. Remove the Opus tab from frontend.

**Rationale**: Per clarification, daily audit is low priority. Removing it eliminates the need for a second API provider and simplifies the migration.

## Decision 11: Files to Modify

| File | Changes | Complexity |
|------|---------|-----------|
| ai.service.ts | Core: SDK swap, Responses API, caching, reasoning, tools | HIGH |
| sop.service.ts | Tool schema format conversion | MEDIUM |
| sandbox.ts | SDK swap, Responses API, caching | MEDIUM |
| judge.service.ts | SDK swap for evaluation calls | LOW |
| memory.service.ts | SDK swap for summarization | LOW |
| snapshot.service.ts | SDK swap for AI summaries | LOW |
| task-manager.service.ts | SDK swap for escalation eval | LOW |
| knowledge.controller.ts | SDK swap for KB suggestions | LOW |
| ai-config.controller.ts | SDK swap for test endpoint | LOW |
| opus.service.ts | DELETE | LOW |
| model-pricing.json | Update to OpenAI pricing | LOW |
| package.json | Swap SDK dependency | LOW |
| configure-ai-v5.tsx | Model dropdown values | LOW |
| inbox-v5.tsx | Remove opus tab | LOW |

## Decision 12: previous_response_id Usage

**Decision**: Use `previous_response_id` ONLY within a single message's classify → respond flow. NOT across different guest messages.

**Within one message** (safe):
```
Call 1: classify → response_id_1
Call 2: respond → previous_response_id = response_id_1
```

**Across messages** (unsafe — manager may have sent messages):
```
Message 1: response_id_1
[Manager sends manual message]
Message 2: DO NOT use previous_response_id = response_id_1
           Instead: build full conversation history manually
```
