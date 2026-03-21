# API Format Changes: OpenAI Migration

## SDK Change

| Before | After |
|--------|-------|
| `@anthropic-ai/sdk` | `openai` |
| `import Anthropic from '@anthropic-ai/sdk'` | `import OpenAI from 'openai'` |
| `new Anthropic({ apiKey: ANTHROPIC_API_KEY })` | `new OpenAI({ apiKey: OPENAI_API_KEY })` |

## API Call Format

### Classification Call (forced get_sop)

**Before** (Anthropic Messages API):
```typescript
const response = await anthropic.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 200,
  temperature: 0,
  system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: userContent }],
  tools: [SOP_TOOL_DEFINITION],
  tool_choice: { type: 'tool', name: 'get_sop' },
}, { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } });
```

**After** (OpenAI Responses API):
```typescript
const response = await openai.responses.create({
  model: 'gpt-5.4-mini-2026-03-17',
  max_output_tokens: 200,
  instructions: systemPrompt,
  input: conversationMessages,
  tools: [SOP_TOOL_DEFINITION],
  tool_choice: { type: 'function', name: 'get_sop' },
  reasoning: { effort: 'none' },
  prompt_cache_key: `tenant-${tenantId}-${agentType}`,
  prompt_cache_retention: '24h',
  store: true,
});
```

### Response Call (with SOP tool result)

**Before**:
```typescript
const followUp = await anthropic.messages.create({
  ...createParams,
  messages: [
    { role: 'user', content: userContent },
    { role: 'assistant', content: classificationResponse.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: sopContent }] },
  ],
});
```

**After**:
```typescript
const followUp = await openai.responses.create({
  model: 'gpt-5.4-mini-2026-03-17',
  instructions: systemPrompt,
  input: [{ type: 'function_call_output', call_id: item.call_id, output: sopContent }],
  previous_response_id: classificationResponse.id,
  tools: otherTools,
  tool_choice: 'auto',
  reasoning: { effort: reasoningEffort },
  text: { verbosity: 'low' },
  max_output_tokens: 300,
  prompt_cache_key: `tenant-${tenantId}-${agentType}`,
  store: true,
});
```

## Tool Schema Format

### get_sop Tool

**Before** (Anthropic):
```json
{
  "name": "get_sop",
  "description": "Classifies a guest message...",
  "input_schema": {
    "type": "object",
    "properties": { "reasoning": {...}, "categories": {...}, "confidence": {...} },
    "required": ["reasoning", "categories", "confidence"],
    "additionalProperties": false
  },
  "input_examples": [...]
}
```

**After** (OpenAI):
```json
{
  "type": "function",
  "name": "get_sop",
  "description": "Classifies a guest message...",
  "strict": true,
  "parameters": {
    "type": "object",
    "properties": { "reasoning": {...}, "categories": {...}, "confidence": {...} },
    "required": ["reasoning", "categories", "confidence"],
    "additionalProperties": false
  }
}
```

Changes: `input_schema` → `parameters`, add `type: "function"`, add `strict: true`, remove `input_examples`.

### search_available_properties + check_extend_availability

Same pattern: `input_schema` → `parameters`, wrap with `type: "function"`, add `strict: true`.

## Response Parsing

### Text Extraction

**Before**: `response.content.find(b => b.type === 'text')?.text`
**After**: `response.output_text`

### Tool Call Extraction

**Before**: `response.content.find(b => b.type === 'tool_use')` → `{ id, name, input }`
**After**: `response.output.find(i => i.type === 'function_call')` → `{ call_id, name, arguments }`

Note: OpenAI returns `arguments` as a JSON string, not parsed object. Parse with `JSON.parse(item.arguments)`.

### Stop Reason

**Before**: `response.stop_reason === 'tool_use'`
**After**: Check if `response.output` contains items with `type === 'function_call'`

### Token Usage

**Before**:
```typescript
inputTokens = response.usage.input_tokens;
outputTokens = response.usage.output_tokens;
cacheWriteTokens = response.usage.cache_creation_input_tokens;
cacheReadTokens = response.usage.cache_read_input_tokens;
```

**After**:
```typescript
inputTokens = response.usage.input_tokens;
outputTokens = response.usage.output_tokens;
cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
```

## Environment Variables

| Before | After |
|--------|-------|
| `ANTHROPIC_API_KEY` (required) | `OPENAI_API_KEY` (required) |

Server startup validation changes from checking `ANTHROPIC_API_KEY` to `OPENAI_API_KEY`.

## No Endpoint Changes

All REST API endpoints exposed by the backend remain UNCHANGED. This is purely a backend service-layer migration. The frontend communicates with the same backend API — no frontend API calls change.
