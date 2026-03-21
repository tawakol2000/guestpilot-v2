# Quickstart: OpenAI GPT-5.4 Mini Migration

## Integration Scenarios

### Scenario 1: Standard Guest Message (Classification + Response)

1. Guest sends: "The dishwasher is not working"
2. Build conversation history manually (all messages from DB)
3. **Call 1** (Responses API): forced get_sop function call
   - `instructions`: system prompt (static, cached)
   - `input`: conversation history + current message (dynamic)
   - `tool_choice`: forced get_sop
   - `reasoning.effort`: "none"
   - `prompt_cache_key`: "tenant-abc-coordinator"
   - Response: `function_call` with `{categories: ["sop-maintenance"], confidence: "high", reasoning: "..."}`
4. App retrieves SOP content, determines reasoning effort ("none" for maintenance)
5. **Call 2** (Responses API): respond with SOP
   - `input`: `[{type: "function_call_output", call_id: "...", output: sopContent}]`
   - `previous_response_id`: response.id from Call 1
   - `reasoning.effort`: "none"
   - `text.verbosity`: "low"
   - Response: "I'm sorry to hear about the dishwasher. I've notified our maintenance team..."
6. Log: model, tokens (input/cached/output/reasoning), cost, classification details

### Scenario 2: Complex Booking with Reasoning

1. Guest sends: "I need to change my dates from March 20-23 to April 1-5, and can you check if a bigger unit is available?"
2. **Call 1**: get_sop → `{categories: ["sop-booking-modification"], confidence: "high"}`
3. App sees `sop-booking-modification` → sets reasoning effort to "low"
4. **Call 2**: respond with SOP + extend_stay tool available
   - `reasoning.effort`: "low" (enables careful multi-step analysis)
   - Claude may call `check_extend_availability` tool → Call 3
5. Response uses reasoning to address date change + unit upgrade coherently

### Scenario 3: Cache Hit Verification

1. Tenant "abc" sends first message → cache MISS (creates cache)
2. Same tenant, different property, same agent type → cache HIT on tools + instructions
3. 30 minutes later, another message → still cache HIT (24h retention)
4. Verify via logs: `cachedInputTokens > 0`, `cacheHitRate > 0.8`

### Scenario 4: Model Tier Selection

1. Operator opens Configure AI → sees model dropdown with 3 tiers
2. Selects "GPT-5.4 Nano" ($0.20/$1.25) for cost savings
3. Saves → TenantAiConfig.model = "gpt-5.4-nano"
4. Next guest message uses Nano model
5. Pipeline log shows "gpt-5.4-nano" as model, lower per-token costs

### Scenario 5: Rate Limit Handling

1. Burst of guest messages hits API rate limit
2. First retry: wait 1-2 seconds (random jitter)
3. Second retry: wait 2-4 seconds
4. Continues doubling up to 60 seconds, max 6 attempts
5. If all retries fail: escalate conversation to human operator
6. Log: retry count, total delay, final outcome

### Scenario 6: Long Conversation Truncation

1. Guest has 200+ messages in conversation history
2. Conversation approaches context window limit
3. `truncation: "auto"` activates — preserves recent messages, drops oldest
4. Guest and AI continue conversing normally — no error, no interruption

## Environment Setup

```bash
# Add to .env
OPENAI_API_KEY=sk-...

# Remove (no longer needed)
# ANTHROPIC_API_KEY=sk-ant-...

# Backend
cd backend && npm install && npm run dev

# Frontend (no changes needed)
cd frontend && npm run dev
```

## Sandbox Testing

1. Open Sandbox tab in frontend
2. Type a guest message
3. Verify in response metadata:
   - Model: gpt-5.4-mini-2026-03-17
   - Classification: categories, confidence, reasoning
   - Tokens: input, cached, output, reasoning
   - Cost: calculated from model-pricing.json
4. Compare response quality with previous Claude responses
