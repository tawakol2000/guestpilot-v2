# Tuning Agent (feature 041 sprint 04)

Self-contained module for the conversational tuning agent. Per
`deferred.md` D16, the agent lives here so it can be lifted to Anthropic's
Managed Agents API (or a standalone Railway service) with mechanical effort.

## What's in here

| Path | Purpose |
|------|---------|
| `runtime.ts` | Bridges Claude Agent SDK `query()` → Vercel AI SDK UIMessageChunk stream |
| `system-prompt.ts` | XML-tagged prompt assembler with `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker |
| `memory/service.ts` | Tenant-scoped `AgentMemory` CRUD (view / create / update / delete) |
| `memory/README.md` | Key-namespacing convention |
| `tools/index.ts` | In-process MCP server registering the 8 consolidated tools |
| `tools/*.ts` | One file per tool |
| `hooks/*.ts` | `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop` |
| `stream-bridge.ts` | `SDKMessage` → `UIMessageChunk` translator |

## External dependencies

- `@anthropic-ai/claude-agent-sdk` — agent runtime. **Requires `ANTHROPIC_API_KEY`.**
  Missing key → runtime degrades silently; chat endpoint returns a typed
  "chat disabled" part. Per CLAUDE.md critical rule #2.
- `ai` (Vercel AI SDK v6) — `createUIMessageStream` / `pipeUIMessageStreamToResponse`
  for the SSE writer. Imported only by the chat controller.
- `@prisma/client` — DB access for memory, conversations, messages,
  suggestions, evidence bundles, preference pairs.
- `zod/v4` subpath — used for SDK tool input schemas. The rest of the
  backend still uses `zod` (v3 API) via the top-level import.

## Sprint-04 deviations from the vision

See `sprint-04-conversational-agent-report.md` for the full list. Key ones:

- The Claude Agent SDK does **not** export a `ClaudeSDKClient` class. We use
  `query({ prompt, options })` (AsyncGenerator) per the installed package's
  public surface. Multi-turn is via `options.resume` + streaming input.
- `memory_20250818` is not a first-class SDK primitive in v0.2.109. We
  implement a `memory` MCP tool with `view` / `create` / `update` / `delete`
  ops backed by our `AgentMemory` table (per roadmap §4). The tool name
  itself is preserved so a future swap to an SDK-native memory primitive
  is a handler swap, not a prompt-level change.
