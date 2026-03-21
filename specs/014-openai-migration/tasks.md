# Tasks: OpenAI GPT-5.4 Mini Migration

**Input**: Design documents from `/specs/014-openai-migration/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks grouped by user story. US1 and US2 are both P1 and must be done together for the core migration to work.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup (SDK Swap)

**Purpose**: Replace Anthropic SDK with OpenAI SDK, update config files.

- [ ] T001 Update `backend/package.json` — run `npm uninstall @anthropic-ai/sdk && npm install openai` to swap the SDK dependency. Verify `openai` package is installed.

- [ ] T002 Update `backend/src/config/model-pricing.json` — replace all Anthropic model entries with OpenAI pricing: `gpt-5.4-mini-2026-03-17` ($0.75/$0.075/$4.50), `gpt-5.4-mini` (alias), `gpt-5.4-nano` ($0.20/$0.02/$1.25), `gpt-5.4` ($2.50/$0.25/$15.00). Add `cachedInput` field to the pricing structure.

- [ ] T003 Update `backend/.env.example` — replace `ANTHROPIC_API_KEY` with `OPENAI_API_KEY`. Add comment explaining it's required for GPT-5.4 Mini.

**Checkpoint**: SDK installed, config files ready. No code changes yet.

---

## Phase 2: User Story 1 — Core AI Pipeline Migration (Priority: P1) MVP

**Goal**: All AI API calls use OpenAI Responses API. Guest messaging works end-to-end.

**Independent Test**: Send messages via sandbox covering all SOP categories. Verify classification + response quality.

- [ ] T004 [US1] Rewrite `classifyMessageSop()` in `backend/src/services/ai.service.ts` — replace Anthropic `messages.create()` with OpenAI `responses.create()`. Use: `instructions` (not system), `input` (not messages), `tool_choice: {type:'function', name:'get_sop'}`, `reasoning: {effort:'none'}`, `max_output_tokens: 200`, `store: true`. Parse response: `response.output.find(i => i.type === 'function_call')` → `JSON.parse(item.arguments)`. Extract token usage: `response.usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`.

- [ ] T005 [US1] Rewrite `createMessage()` in `backend/src/services/ai.service.ts` — replace the core function: (1) Replace `new Anthropic()` with `new OpenAI()` at module level (line 28), using `OPENAI_API_KEY`. (2) Change API call from `anthropic.messages.create()` to `openai.responses.create()`. (3) System prompt: `instructions: systemPrompt` instead of `system: [{text, cache_control}]`. (4) Messages: `input: conversationMessages` instead of `messages: [{role, content}]`. (5) Tools: keep the same tool definitions but they'll be reformatted in T007. (6) Response text: `response.output_text` instead of `response.content.find(b => b.type === 'text')?.text`. (7) Token usage: `response.usage.input_tokens`, `output_tokens`, `input_tokens_details?.cached_tokens`, `output_tokens_details?.reasoning_tokens`. (8) Remove `cache_control` and `anthropic-beta` header. (9) Add: `text: {verbosity: 'low'}`, `truncation: 'auto'`, `store: true`.

- [ ] T006 [US1] Rewrite tool use loop in `createMessage()` — replace: (1) Stop reason check: detect `response.output.find(i => i.type === 'function_call')` instead of `response.stop_reason === 'tool_use'`. (2) Tool call extraction: `item.call_id` and `JSON.parse(item.arguments)` instead of `toolUseBlock.id` and `toolUseBlock.input`. (3) Tool result message: `{type: 'function_call_output', call_id: item.call_id, output: toolResultContent}` instead of `{type: 'tool_result', tool_use_id, content}`. (4) Follow-up call: use `previous_response_id: response.id` and pass tool result as input instead of building full messages array. (5) Remove all `Anthropic.*` type references.

- [ ] T007 [US1] Reformat tool definitions in `backend/src/services/sop.service.ts` — convert `SOP_TOOL_DEFINITION` from Anthropic format to OpenAI function format: (1) Add `type: 'function'` wrapper. (2) Rename `input_schema` → `parameters`. (3) Add `strict: true` at top level. (4) Remove `input_examples` (Anthropic-specific — move examples to few-shot in instructions instead). (5) Remove `import Anthropic` type. (6) Export as plain object (not typed as `Anthropic.Tool`).

- [ ] T008 [US1] Reformat tool definitions for property search and extend-stay in `backend/src/services/ai.service.ts` (lines ~1760-1786) — convert both `search_available_properties` and `check_extend_availability` from Anthropic format to OpenAI function format: add `type: 'function'`, rename `input_schema` → `parameters`, add `strict: true`, add `additionalProperties: false`.

- [ ] T009 [US1] Rewrite `withRetry()` in `backend/src/services/ai.service.ts` — replace Anthropic error detection (`overloaded_error`, status 529) with OpenAI error detection (status 429 rate limit, 500/502/503 server errors). Implement exponential backoff with jitter: min 1s, max 60s, max 6 attempts. Use `Math.random()` jitter to avoid thundering herd.

- [ ] T010 [US1] Update cost calculation in `backend/src/services/ai.service.ts` — replace Anthropic cost formula with OpenAI formula: `cost = (uncachedInput * price.input/1M) + (cachedInput * price.cachedInput/1M) + (output * price.output/1M)`. Read pricing from `model-pricing.json`. Account for reasoning tokens (billed as output). Update the `logEntry` construction to include `cachedInputTokens`, `reasoningTokens`, `cacheHitRate`.

- [ ] T011 [US1] Update server.ts startup validation in `backend/src/server.ts` — replace `ANTHROPIC_API_KEY` check with `OPENAI_API_KEY` check. Remove any remaining references to Anthropic env var.

- [ ] T012 [US1] Build conversation history for `input` parameter — in `generateAndSendAiReply()`, construct the `input` array for the Responses API. Map DB messages to `[{role: 'user'|'assistant', content: string}]` format. The `instructions` parameter holds the system prompt (not in input array). Property context, conversation history, and current message go in `input`. Ensure static content (instructions) is separate from dynamic content (input) for optimal caching.

**Checkpoint**: Core pipeline works with OpenAI. Sandbox chat produces correct responses.

---

## Phase 3: User Story 2 — Prompt Caching Optimization (Priority: P1)

**Goal**: Per-tenant per-agent cache keys with 24h retention. >80% cache hit rate.

**Independent Test**: Send multiple messages for same tenant, verify cached_tokens > 0 in logs after first message.

- [ ] T013 [US2] Add `prompt_cache_key` to classification call in `classifyMessageSop()` — set `prompt_cache_key: \`tenant-${tenantId}-${agentType}\`` where agentType is 'screening' or 'coordinator'. Add `prompt_cache_retention: '24h'`.

- [ ] T014 [US2] Add `prompt_cache_key` to response call in `createMessage()` — pass tenant ID and agent type through options. Set same cache key pattern. Add `prompt_cache_retention: '24h'`.

- [ ] T015 [US2] Verify prompt ordering in `generateAndSendAiReply()` — ensure the `instructions` parameter contains ONLY static content (system prompt + SOP content). All dynamic content (property context, conversation history, current message) goes in `input`. This maximizes the cached prefix. If property context is currently in the system prompt, move it to the input messages.

- [ ] T016 [US2] Log cache metrics in ragContext — add `promptCacheKey`, `cachedInputTokens`, `totalInputTokens`, `cacheHitRate` to the ragContext object. Calculate `cacheHitRate = cachedInputTokens / totalInputTokens`.

**Checkpoint**: Cache hit rate > 80% visible in logs after 2+ messages per tenant.

---

## Phase 4: User Story 3 — Reasoning Effort Control (Priority: P2)

**Goal**: Dynamic reasoning effort based on SOP category. 80%+ messages use no reasoning.

**Independent Test**: Send greeting (no reasoning) + booking modification (low reasoning), verify different reasoning tokens in logs.

- [ ] T017 [US3] Add reasoning effort mapping in `backend/src/services/ai.service.ts` — create `REASONING_CATEGORIES` set with `sop-booking-modification`, `sop-booking-cancellation`, `payment-issues`, `escalate`. After SOP classification, determine reasoning effort: if any classified category is in the set, use `'low'`; otherwise `'none'`. Pass to the response call as `reasoning: {effort}`.

- [ ] T018 [US3] Log reasoning effort and tokens in ragContext — add `reasoningEffort: 'none'|'low'` and `reasoningTokens: number` fields. Extract from `response.usage.output_tokens_details?.reasoning_tokens`.

**Checkpoint**: Logs show reasoning effort varies by category. Most messages show 0 reasoning tokens.

---

## Phase 5: User Story 4 — Model Selection UI (Priority: P2)

**Goal**: Operators can choose model tier in Configure AI page.

**Independent Test**: Change model in Configure AI → sandbox message uses new model → logs show correct model name.

- [ ] T019 [P] [US4] Update model dropdown in `frontend/components/configure-ai-v5.tsx` — replace all Anthropic model options (claude-haiku-4-5, claude-sonnet-4-6, etc.) with OpenAI tiers: `gpt-5.4-mini-2026-03-17` (default, ~$0.001/msg), `gpt-5.4-nano` (budget, ~$0.0004/msg), `gpt-5.4` (premium, ~$0.004/msg). Show estimated per-message cost next to each option.

- [ ] T020 [US4] Update default model in `backend/src/services/ai.service.ts` — change the default model constant from `'claude-haiku-4-5-20251001'` to `'gpt-5.4-mini-2026-03-17'`. Ensure TenantAiConfig.model override works with new model strings.

**Checkpoint**: Model selector shows OpenAI tiers, changing model affects sandbox responses.

---

## Phase 6: User Story 5 — Cost Tracking & Observability (Priority: P2)

**Goal**: Accurate cost tracking with new pricing. Pipeline view shows correct model + token data.

**Independent Test**: Process messages, check pipeline log shows correct model name, tokens, and cost.

- [ ] T021 [P] [US5] Update `backend/src/services/ai.service.ts` cost logging — ensure every `AiApiLog` entry includes: `model` (actual model used), `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `cost` (calculated from model-pricing.json). Update the `logEntry` object construction.

- [ ] T022 [P] [US5] Update `frontend/components/ai-pipeline-v5.tsx` — update the feed entry display to show: model name (instead of Anthropic model), cached tokens badge, reasoning tokens badge (if > 0), cost per message. Read from ragContext fields.

**Checkpoint**: Pipeline view shows GPT-5.4 Mini model name, cached/reasoning token counts, and correct costs.

---

## Phase 7: Ancillary Service Migration (Parallel)

**Goal**: All remaining services that use Anthropic SDK are migrated to OpenAI.

- [ ] T023 [P] Migrate `backend/src/services/memory.service.ts` — replace Anthropic client + `messages.create()` with OpenAI `responses.create()` for conversation summarization. Use same model from tenant config. Add graceful degradation if OPENAI_API_KEY missing.

- [ ] T024 [P] Migrate `backend/src/services/task-manager.service.ts` — replace Anthropic client with OpenAI for escalation evaluation. Same lazy-init pattern. Update response parsing.

- [ ] T025 [P] Migrate `backend/src/services/snapshot.service.ts` — replace Anthropic client with OpenAI for pipeline health snapshot AI summaries.

- [ ] T026 [P] Migrate `backend/src/controllers/knowledge.controller.ts` — replace Anthropic client with OpenAI for KB gap analysis and suggestion generation.

- [ ] T027 [P] Migrate `backend/src/controllers/ai-config.controller.ts` — replace Anthropic client with OpenAI for the test endpoint (`POST /api/ai-config/test`).

- [ ] T028 [P] Migrate `backend/src/routes/sandbox.ts` — replace Anthropic client + retry logic with OpenAI `responses.create()`. Add `prompt_cache_key`, `reasoning`, `text.verbosity`, `truncation` parameters matching the main pipeline.

**Checkpoint**: All services compile. No Anthropic imports remain anywhere.

---

## Phase 8: Streaming Responses (Priority: P2)

**Goal**: Stream AI responses to the frontend in real-time via SSE instead of waiting for the full response. Guests see text appear word-by-word.

**Independent Test**: Send a sandbox message → see text stream in real-time instead of appearing all at once.

- [ ] T029 [US7] Add streaming support to `createMessage()` in `backend/src/services/ai.service.ts` — for the response call (Call 2), use `stream: true` on `openai.responses.create()`. Process the event stream: emit `response.output_text.delta` events as they arrive. Accumulate the full text for logging. Classification call (Call 1) stays non-streaming (we need the full tool call result before proceeding).

- [ ] T030 [US7] Stream AI response via SSE in `backend/src/services/ai.service.ts` — in `generateAndSendAiReply()`, instead of waiting for the full response then sending it, emit SSE `ai_typing_text` events with each text delta as it arrives. Use the existing `broadcastToTenant()` SSE infrastructure. Add a new SSE event type `ai_typing_text` with `{ conversationId, delta, done }` payload. The final `done: true` event signals the complete response.

- [ ] T031 [US7] Handle streaming in `frontend/components/inbox-v5.tsx` — listen for the new `ai_typing_text` SSE event. When received, append `delta` text to the pending AI message bubble in real-time. On `done: true`, finalize the message. Replace the current "typing..." indicator with actual streaming text. If streaming is interrupted, show whatever text was received.

- [ ] T032 [US7] Add streaming support to `backend/src/routes/sandbox.ts` — the sandbox endpoint should also stream responses. Send SSE events or use a chunked response so the sandbox chat UI shows text appearing in real-time.

- [ ] T033 [US7] Update `frontend/components/sandbox-chat-v5.tsx` — handle streaming in the sandbox chat UI. Show text appearing word-by-word instead of waiting for the complete response.

**Checkpoint**: Both inbox and sandbox show AI responses streaming in real-time.

---

## Phase 9: Frontend Metrics & Optimization (Priority: P2)

**Goal**: Frontend shows cache efficiency, cost trends, and reasoning usage. Remove stale UI elements.

- [ ] T034 [P] [US7] Add cache + cost metrics to `frontend/components/sop-monitor-v5.tsx` — add a new section showing: (1) cache hit rate trend (% of tokens served from cache over last 24h/7d), (2) average cost per message trend, (3) reasoning usage breakdown (% of messages using none vs low), (4) model distribution (which model tier is being used). Read from the existing `evaluation-stats` endpoint (which already returns SOP classification stats — extend it with cache/cost data).

- [ ] T035 [P] Extend `GET /api/knowledge/evaluation-stats` in `backend/src/routes/knowledge.ts` — add to the response: `cacheStats: { avgHitRate, totalCachedTokens, totalUncachedTokens }`, `costStats: { avgCostPerMessage, totalCost24h }`, `reasoningStats: { noneCount, lowCount, pctNone }`. Query from AiApiLog.ragContext fields added in this migration.

- [ ] T036 [P] Add cost metrics API to `frontend/lib/api.ts` — extend `apiGetSopStats()` to return the new cache/cost/reasoning fields. Add TypeScript types.

- [ ] T037 Clean up stale frontend references — remove any remaining Anthropic-specific labels, icons, or text in the frontend. Audit: ai-pipeline-v5.tsx for any "Claude"/"Haiku"/"Anthropic" strings, configure-ai-v5.tsx for old model descriptions, analytics-v5.tsx for old cost formulas.

**Checkpoint**: SOP Monitor dashboard shows real-time cache hit rate, cost trends, and reasoning usage.

---

## Phase 10: Cleanup & OPUS Removal

**Goal**: Remove all traces of Anthropic SDK. Delete OPUS service.

- [ ] T038 [P] Delete `backend/src/services/opus.service.ts` — remove the daily audit report service entirely per clarification.

- [ ] T039 [P] Remove OPUS tab from `frontend/components/inbox-v5.tsx` — remove 'opus' from NavTab type, remove nav menu entry, remove render case, remove OpusV5 import.

- [ ] T040 [P] Remove OPUS route from `backend/src/routes/` — find and remove the opus route registration in Express.

- [ ] T041 Full grep verification — search entire `backend/src/` and `frontend/` for any remaining references to: `@anthropic-ai/sdk`, `Anthropic`, `anthropic`, `ANTHROPIC_API_KEY`, `claude-`, `opus.service`. Fix any remaining references.

**Checkpoint**: Zero Anthropic references. OPUS completely removed. Backend compiles. Frontend builds.

---

## Phase 11: Ops Logging (C3/C4)

**Goal**: Log OpenAI rate limit headers and request IDs for production ops.

- [ ] T042 [P] Log rate limit headers in `backend/src/services/ai.service.ts` — after every OpenAI API call, extract `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens` from response headers. Log to console at debug level. Add `rateLimitRemaining: { requests, tokens }` to ragContext for pipeline view.

- [ ] T043 [P] Log `x-request-id` in `backend/src/services/ai.service.ts` — extract and save the `x-request-id` header from every OpenAI response. Add to AiApiLog for debugging. Include in ragContext as `openaiRequestId`.

**Checkpoint**: Pipeline logs show rate limit headroom and request IDs.

---

## Phase 12: Polish & Verification

- [ ] T044 Run `npx tsc --noEmit` in `backend/` — verify zero TypeScript errors
- [ ] T045 Run frontend build — verify zero compilation errors
- [ ] T046 Test via sandbox chat — send representative messages for all 22 SOP categories, verify correct classification and response quality with the new model. Verify streaming works.
- [ ] T047 Commit all changes and push to `014-sop-optimization` branch

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (US1)**: Depends on Phase 1 (SDK installed)
- **Phase 3 (US2)**: Depends on Phase 2 (core pipeline working)
- **Phase 4 (US3)**: Depends on Phase 2 (needs working classification)
- **Phase 5 (US4)**: Depends on Phase 2 (needs model config working)
- **Phase 6 (US5)**: Depends on Phase 2 (needs logging working)
- **Phase 7 (Ancillary)**: Depends on Phase 1 (SDK installed). Can run parallel with Phase 2.
- **Phase 8 (Streaming)**: Depends on Phase 2 (needs working pipeline)
- **Phase 9 (Frontend Metrics)**: Depends on Phase 3 (needs cache data flowing)
- **Phase 10 (Cleanup)**: Depends on ALL phases complete
- **Phase 11 (Ops Logging)**: Depends on Phase 2 (needs working API calls)
- **Phase 12 (Polish)**: Depends on ALL phases complete

### Parallel Opportunities

```
Phase 1: T001 → T002 ‖ T003 (sequential install, parallel config)
Phase 2: T004 → T005 → T006 (sequential — same file, core flow)
          T007 ‖ T008 (parallel — different files, after T004)
          T009 ‖ T010 ‖ T011 (parallel — different concerns in same file, after T005)
          T012 (after T005 — same file)
Phase 3: T013 → T014 → T015 → T016 (sequential — builds on each other)
Phase 4: T017 → T018 (sequential — same file)
Phase 5: T019 ‖ T020 (parallel — frontend vs backend)
Phase 6: T021 ‖ T022 (parallel — backend vs frontend)
Phase 7: T023 ‖ T024 ‖ T025 ‖ T026 ‖ T027 ‖ T028 (ALL parallel — different files)
Phase 8: T029 ‖ T030 ‖ T031 (parallel — different files), T032 last
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. T001-T003: Install OpenAI SDK, update config
2. T004-T012: Core pipeline migration
3. **STOP and VALIDATE**: Sandbox chat works with GPT-5.4 Mini

### Caching + Reasoning (Phase 3 + Phase 4)

4. T013-T016: Add prompt_cache_key + retention
5. T017-T018: Add reasoning effort control
6. **STOP and VALIDATE**: Cache hits visible, reasoning tokens vary

### UI + Observability (Phase 5 + Phase 6)

7. T019-T022: Model selector + cost tracking
8. **STOP and VALIDATE**: Configure AI shows new models, pipeline shows costs

### Full Migration (Phase 7 + Phase 8)

9. T023-T028: Migrate all ancillary services
10. T029-T032: Delete OPUS, grep verification
11. **STOP and VALIDATE**: Zero Anthropic references, everything compiles

### Ship

12. T033-T036: Final checks + push

---

## Notes

- Total: 47 tasks across 12 phases
- MVP: 12 tasks (Phase 1 + Phase 2 — core pipeline on OpenAI)
- Main bottleneck: ai.service.ts (T004-T006, T009-T010, T012 are sequential — same file)
- Biggest parallel win: Phase 7 — 6 ancillary services can all migrate simultaneously
- No database migrations
- OPUS service deleted (not migrated)
- `previous_response_id` used ONLY within classify → respond flow (not across messages)
- Streaming (Phase 8) — real-time text delivery via SSE, major UX improvement
- Frontend metrics (Phase 9) — cache hit rate, cost trends, reasoning usage dashboard
- Ops logging (Phase 11) — rate limit monitoring + OpenAI request ID for debugging
