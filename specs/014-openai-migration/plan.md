# Implementation Plan: OpenAI GPT-5.4 Mini Migration

**Branch**: `014-sop-optimization` | **Date**: 2026-03-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-openai-migration/spec.md`

## Summary

Migrate the AI pipeline from Anthropic Claude (Haiku 4.5) to OpenAI GPT-5.4 Mini using the Responses API. This is a backend SDK swap affecting 10 service files + 1 frontend file. The core AI logic (SOP classification, tool use, escalation) stays identical — only the API interface changes. Key additions: per-tenant prompt cache keys with 24h retention, reasoning effort control, verbosity control, automatic truncation, and configurable model pricing.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: OpenAI Node.js SDK (`openai`), Express 4.x, Prisma ORM — replacing `@anthropic-ai/sdk`
**Storage**: PostgreSQL + Prisma ORM (no schema changes — ragContext JSON field gets new shape)
**Testing**: Manual verification via sandbox chat + curl tests
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goals**: ≤$0.002/message with cache, <1s classification latency, >80% cache hit rate
**Constraints**: Must use Responses API (not Chat Completions). No `previous_response_id` across messages (manager messages break it). Manual conversation history building.
**Scale/Scope**: ~10 backend files modified, 1 frontend file, 1 config file, 1 service deleted (opus)

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | FR-010: exponential backoff retry. Missing OPENAI_API_KEY → fallback silently (same pattern as ANTHROPIC_API_KEY) |
| II. Multi-Tenant Isolation | PASS | Cache keys are per-tenant+agent. No cross-tenant data leakage. |
| III. Guest Safety | PASS | Same SOP logic, same escalation, same access control. Model swap doesn't affect safety rules. |
| IV. Structured AI Output | PASS | `strict: true` on function calling guarantees valid JSON + valid enum values. |
| V. Escalate When In Doubt | PASS | Escalation logic unchanged. `escalate` category still creates tasks. |
| VI. Observability | PASS | FR-015: enhanced logging with model name, token breakdown (input/cached/output/reasoning), cost. |
| VII. Self-Improvement | PASS | Judge already simplified in 013. Continues logging classifications for monitoring. |

## Project Structure

### Documentation

```text
specs/014-openai-migration/
├── plan.md              # This file
├── research.md          # Phase 0: SDK mapping + API differences
├── data-model.md        # Phase 1: entity changes (ragContext, model config)
├── quickstart.md        # Phase 1: integration scenarios
├── contracts/           # Phase 1: API format changes
└── tasks.md             # Phase 2: task breakdown
```

### Source Code Changes

```text
backend/
├── package.json                          # MODIFY: swap @anthropic-ai/sdk → openai
├── src/
│   ├── config/
│   │   └── model-pricing.json            # MODIFY: OpenAI pricing (gpt-5.4-mini, nano, full)
│   ├── services/
│   │   ├── ai.service.ts                 # MODIFY: Core — Responses API, caching, reasoning, tools
│   │   ├── sop.service.ts                # MODIFY: Tool schema Anthropic → OpenAI function format
│   │   ├── judge.service.ts              # MODIFY: OpenAI client for evaluation calls
│   │   ├── memory.service.ts             # MODIFY: OpenAI client for summarization
│   │   ├── snapshot.service.ts           # MODIFY: OpenAI client for snapshot summaries
│   │   ├── task-manager.service.ts       # MODIFY: OpenAI client for escalation evaluation
│   │   ├── opus.service.ts               # DELETE: daily audit removed per clarification
│   │   └── observability.service.ts      # KEEP: string-based, provider-agnostic
│   ├── routes/
│   │   └── sandbox.ts                    # MODIFY: OpenAI Responses API + caching
│   └── controllers/
│       ├── knowledge.controller.ts       # MODIFY: OpenAI client for KB suggestions
│       └── ai-config.controller.ts       # MODIFY: OpenAI client for test endpoint
│
frontend/
├── components/
│   └── configure-ai-v5.tsx               # MODIFY: model dropdown (gpt-5.4-mini/nano/full)
```

**Structure Decision**: No new files created. Only modifications to existing files + deletion of opus.service.ts. The OpenAI SDK replaces Anthropic SDK 1:1 in every file.

## Key Implementation Details

### Responses API Format (replaces Messages API)

```typescript
// BEFORE (Anthropic)
const response = await anthropic.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 4096,
  system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: userContent }],
  tools: [{ name: 'get_sop', input_schema: {...} }],
  tool_choice: { type: 'tool', name: 'get_sop' },
}, { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } });

// AFTER (OpenAI Responses API)
const response = await openai.responses.create({
  model: 'gpt-5.4-mini-2026-03-17',
  instructions: prompt,
  input: conversationMessages,
  tools: [{ type: 'function', name: 'get_sop', strict: true, parameters: {...} }],
  tool_choice: { type: 'function', name: 'get_sop' },
  reasoning: { effort: 'none' },
  text: { verbosity: 'low' },
  max_output_tokens: 300,
  prompt_cache_key: `tenant-${tenantId}-${agentType}`,
  prompt_cache_retention: '24h',
  truncation: 'auto',
  store: true,
});
```

### Prompt Ordering for Cache Maximization

```
[Tools]                    ← STATIC: cached across all requests for tenant+agent
[Instructions/System]      ← STATIC: cached (same system prompt per tenant+agent)
[Few-shot examples]        ← STATIC: cached
--- cache boundary ---
[Property context]         ← SEMI-DYNAMIC: changes per property but within cache key
[Conversation history]     ← DYNAMIC: grows with each message
[Current guest message]    ← DYNAMIC: always unique
```

### Two-Call Flow with previous_response_id

Within a single message processing, we CAN use `previous_response_id` for the classify → respond flow:

```
Call 1: classify (forced get_sop) → response.id
Call 2: respond (function_call_output + SOP content) → previous_response_id = response.id
```

This is safe because both calls happen atomically for one guest message. We only avoid `previous_response_id` across DIFFERENT guest messages (where manager may have sent messages in between).

### Cache Key Strategy

```
tenant-{tenantId}-screening    → All INQUIRY conversations for this tenant
tenant-{tenantId}-coordinator  → All CONFIRMED/CHECKED_IN conversations
```

Two keys per tenant. The static prefix (tools + instructions + examples) is identical across all properties for the same agent type. Property-specific context varies but benefits from the cache key routing to the same inference engine.

### Reasoning Effort Mapping

```typescript
const REASONING_CATEGORIES = new Set([
  'sop-booking-modification',
  'sop-booking-cancellation',
  'payment-issues',
  'escalate',
]);

const reasoningEffort = REASONING_CATEGORIES.has(sopCategory) ? 'low' : 'none';
```
