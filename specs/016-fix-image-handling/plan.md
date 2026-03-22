# Implementation Plan: Fix Image Handling

**Branch**: `016-fix-image-handling` | **Date**: 2026-03-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-fix-image-handling/spec.md`

## Summary

The image handling broke during the Anthropic→OpenAI migration. The old code has a separate image branch (~120 lines) that builds its own content, makes its own API call, and parses responses separately — but images get stripped by `.filter(b => b.type === 'text')` in `createMessage`. Also, the image format is Anthropic's (`{type: 'image', source: ...}`) not OpenAI's (`{type: 'input_image', image_url: ...}`).

**Fix**: Delete the entire image branch. Move image download/conversion into the single code path — before the AI call, check for images, download if present, and attach to the last `inputTurns` entry as a multi-part content array in OpenAI format. One path for everything.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: OpenAI Node.js SDK, Express 4.x, Prisma ORM, axios (image download)
**Storage**: PostgreSQL + Prisma ORM (no schema changes)
**Testing**: Manual — send image via messaging channel, verify AI sees it
**Target Platform**: Railway (Linux server)
**Project Type**: Web service (backend API)
**Performance Goals**: Image download adds ≤3s latency; no change to AI response time
**Constraints**: Only JPEG/PNG/GIF/WEBP; first image only per message
**Scale/Scope**: Single file change (`ai.service.ts`)

## Constitution Check

*GATE: Must pass before implementation.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Download failure → falls back to text-only, never crashes |
| §II Multi-Tenant Isolation | PASS | No tenant data changes |
| §III Guest Safety & Access | PASS | Image handling unchanged by booking status; no access code exposure |
| §IV Structured AI Output | PASS | Same JSON output format with or without image |
| §V Escalate When In Doubt | PASS | Image instructions say "always escalate with description" |
| §VI Observability | PASS | `hasImage` flag preserved in AiApiLog |
| §VII Self-Improvement | N/A | No classifier changes |
| Security | PASS | Constitution §Security says "images MUST NOT be stored permanently beyond the AI call" — base64 lives only in memory during the request |

No violations. No complexity tracking needed.

## Project Structure

### Files Modified

```text
backend/src/services/ai.service.ts    # THE ONLY FILE — single code path for text+image
```

No new files. No schema changes. No frontend changes.

## Implementation Details

### What Gets Deleted (old image branch)

Lines ~1996–2114 in `ai.service.ts`:
- Separate `imageTemplateVars` building (line 2017–2021)
- Separate `imageContent: ContentBlock[]` building via `buildContentBlocks` (line 2022)
- Anthropic-format image push `{type: 'image', source: {type: 'base64', ...}}` (lines 2024–2029)
- Separate `createMessage()` call without `inputTurns`, without tools, without streaming, without reasoning effort, with stale Anthropic params (`topK`, `topP`, `stopSequences`) (lines 2033–2049)
- Duplicate response parsing — identical copy of the text branch parsing (lines 2051–2113)

Also remove:
- The `ContentBlock` image variant from the type union (line 72) — no longer needed since images go through `inputTurns` not `ContentBlock`
- The `if (!hasImages) { ... } else { ... }` branching structure — becomes just the single path

### What Gets Added

**Step 1: Image download before AI call** (inside the single path, before `createMessage`)

After `hasImages` is detected (line 1756, already exists), add image download logic:
- Find first message with images: `currentMsgs.find(m => m.imageUrls?.length > 0)`
- Download via axios, convert to base64, detect MIME type
- On failure: log warning, set `imageBase64 = ''` (proceeds as text-only)
- This is the same download logic from the old branch, just moved up

**Step 2: If image downloaded, modify last inputTurns entry**

The `inputTurns` array is built at line 1805–1808. The last entry is:
```ts
{ role: 'user', content: lastUserMessage }  // string
```

When an image is present, change it to multi-part content (OpenAI Responses API format):
```ts
{
  role: 'user',
  content: [
    { type: 'input_text', text: lastUserMessage },
    { type: 'input_image', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
  ]
}
```

This works because the OpenAI Responses API accepts `content` as either a string or an array of content parts. The `createMessage` function passes `inputTurns` directly to `input` — no changes needed there.

**Step 3: Bake image handling into both system prompts (caching optimization)**

Instead of dynamically injecting image handling instructions via `injectImageHandling()`, bake the IMAGE HANDLING section permanently into both `OMAR_SYSTEM_PROMPT` and `OMAR_SCREENING_SYSTEM_PROMPT`. This is critical for prompt caching:
- Dynamic injection = system prompt changes when images are present = cache miss = full re-tokenization
- Baked in = system prompt is always identical = cache always hits = cheaper

Add the IMAGE HANDLING section (already written in `injectImageHandling`) directly into both prompts, before the OUTPUT FORMAT section. Then delete the `injectImageHandling()` function entirely — it's no longer needed.

For download failures (`hasImages && !imageBase64`): prepend a note to the last user message text: "[System: The guest sent an image but it could not be loaded. Acknowledge this and escalate to manager.]"

**Step 4: Set hasImage flag on createMessage options**

Already exists as a field — just set `hasImage: hasImages` instead of hardcoded `false`.

### What Gets Deleted (additionally)

- `injectImageHandling()` function (~25 lines) — no longer needed, instructions baked into prompts
- The `ContentBlock` image variant from the type union (line 72) — images go through `inputTurns` not `ContentBlock`
- All references to `injectImageHandling` in exports

### What Stays Unchanged

- `createMessage()` function — no changes needed (already passes `inputTurns` directly to OpenAI)
- `buildContentBlocks()` function — still used for text content
- All tools (SOP classification, property search, extend-stay) — work with images since they're tool calls, not content blocks
- Response parsing — one copy instead of two, but same logic
- Streaming — works with images (OpenAI streams multimodal)
- Prompt caching — IMPROVED: system prompt is now always the same whether image present or not

### OpenAI Responses API Image Format (from research)

```json
{
  "role": "user",
  "content": [
    {"type": "input_text", "text": "What's in this image?"},
    {
      "type": "input_image",
      "image_url": {
        "url": "data:image/jpeg;base64,/9j/4AAQ..."
      }
    }
  ]
}
```

Key differences from Anthropic:
- `input_image` not `image`
- `image_url.url` with data URI, not `source.type: 'base64'`
- Content is an array on the message, not separate ContentBlocks
