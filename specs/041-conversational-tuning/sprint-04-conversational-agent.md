# Sprint 04 — Conversational Agent

> **You are a fresh Claude Code session with no memory of prior work.** Read the files listed below, plus all three prior sprint reports, before writing any code. This sprint is the biggest in V1; expect to span 5 roadmap days.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md` — branch, DB-coexistence, commit rules.
2. `specs/041-conversational-tuning/vision.md` — product vision, agent principles.
3. `specs/041-conversational-tuning/roadmap.md` — this sprint covers **days 10-14** of V1. It's the single biggest chunk; read it carefully.
4. `specs/041-conversational-tuning/deferred.md` — what's deferred, what's pre-wired.
5. `specs/041-conversational-tuning/glossary.md` — vocabulary (particularly: Claude Agent SDK, ClaudeSDKClient, PreToolUse/PostToolUse/PreCompact hooks, memory_20250818, Tool Search, Verbosity enum, Dynamic boundary, Data part, Transient part, useChat).
6. `specs/041-conversational-tuning/concerns.md` — open concerns.
7. `specs/041-conversational-tuning/sprint-01-evidence-and-schema-report.md`.
8. `specs/041-conversational-tuning/sprint-02-taxonomy-and-diagnostic-pipeline-report.md`.
9. `specs/041-conversational-tuning/sprint-03-tuning-surface-report.md` — read §8 carefully (chat seam already reserved).
10. `CLAUDE.md`.
11. `backend/prisma/schema.prisma` — `TuningConversation`, `TuningMessage`, `AgentMemory`, `EvidenceBundle`, `CapabilityRequest`, `PreferencePair` all exist and are empty (except a couple smoke-test `EvidenceBundle` rows).
12. `backend/src/services/evidence-bundle.service.ts` — assembler used by the agent's `fetch_evidence_bundle` tool.
13. `backend/src/services/tuning/diagnostic.service.ts` + `suggestion-writer.service.ts` — the agent can optionally trigger these via tools.
14. `backend/src/services/tuning/preference-pair.service.ts` — sprint 03 wrote it, sprint 04 adds the reader.
15. `backend/src/controllers/tuning-suggestion.controller.ts` — existing accept/reject endpoints. Agent's `suggestion_action` tool calls these (or a thin wrapper).
16. `backend/src/controllers/tuning-dashboards.controller.ts` — agent can read category-stats.
17. `frontend/app/tuning/page.tsx` — the surface; left-rail chat seam + URL param handling (`?suggestionId=`, `?conversationId=`).
18. `frontend/components/tuning/` — existing component conventions, tokens, design language.

Before writing code, **also verify**:
- `@anthropic-ai/claude-agent-sdk` version in `backend/package.json` (or install it if absent). Read the installed package's types to confirm the API shape.
- `@ai-sdk/react` and `@ai-sdk/anthropic` versions in `frontend/package.json`. Install if absent.
- `ANTHROPIC_API_KEY` env variable presence — the agent requires it (unlike the main AI which uses OpenAI). Document whether it's set on Railway.
- `LANGFUSE_*` env keys — required for verifying prompt caching via token counts per §12.

## Branch

`feat/041-conversational-tuning`. Keep committing on top. No merge. No push.

## Goal

Ship the conversational tuning agent end-to-end: backend runtime on Claude Agent SDK with consolidated tools + hooks + memory + a cache-boundary-aware system prompt, frontend chat panel mounted in the left-rail seam via Vercel AI SDK `useChat()`, a proactive opener that greets the manager with pending work, an anchor-message flow from the inbox, a chat history browser, verified prompt caching. All of this hanging off `/tuning` alongside the queue + detail + dashboards that sprint 03 already delivered.

## Non-goals (do NOT do in this sprint)

- **Do NOT build HDBSCAN clustering, shadow evaluation, A/B testing, or cluster-triggered proactive openings.** All deferred (D1, D3, D4, D5).
- **Do NOT integrate the Anthropic Managed Agents API.** V1 keeps the agent in the existing backend. D16 covers the scale-up path.
- **Do NOT add multi-user collaboration.** Single-user UI per D15.
- **Do NOT change the three-region `/tuning` layout.** Sprint 03's structure stands; you mount inside the reserved seam.
- **Do NOT implement auto-apply without manager approval.** D13 — anti-goal, forever.
- **Do NOT embed this chat inline in the inbox.** Separate surface per vision; inline is D9.
- **Do NOT schema-change** unless absolutely forced. Schema was designed for this sprint in sprint 01. If something seems missing, stop and ask.
- **Do NOT build the `appliedAndRetained7d` periodic job.** That's a separate small V1-tail task; it's not part of this sprint.

## Acceptance criteria

### 1. Agent runtime scaffolding

- [ ] `@anthropic-ai/claude-agent-sdk` installed (or confirmed present) in `backend/`. Read the installed package to confirm the `ClaudeSDKClient` API shape and the `memory_20250818` tool signature.
- [ ] New module directory `backend/src/tuning-agent/` with clean internal API. Per `deferred.md` D16, the agent is self-contained here so it can be lifted to Managed Agents later with mechanical effort.
- [ ] `ClaudeSDKClient` is instantiated per `TuningConversation`, with `persist_session: true` and `include_partial_messages: true`. The SDK's session id is stored in `TuningConversation.sdkSessionId` (schema column already exists, sprint 01).
- [ ] Default model: **Claude Sonnet 4.6** per vision.md. Add a config flag `TUNING_AGENT_MODEL` with Sonnet default and allow override to Opus for intensive sessions.
- [ ] Session resumption works: given an existing `TuningConversation` row with `sdkSessionId`, the agent resumes state rather than starting fresh.
- [ ] Agent runtime degrades silently if `ANTHROPIC_API_KEY` is missing (logs once, returns a user-facing message indicating chat is disabled).

### 2. Tool layer — ~8 consolidated tools

Per roadmap.md days 10-14 and the research findings (tool count >7 degrades selection). Implement as an in-process MCP server the SDK registers.

All tools must accept a `verbosity: 'concise' | 'detailed'` parameter where applicable; `concise` is the default, `detailed` expands the return payload.

- [ ] `get_context` — returns the current tuning conversation's key context: selected suggestion (if any), anchor message (if any), recent activity. Replaces multiple narrower getters.
- [ ] `search_corrections` — search prior `TuningSuggestion` records by `(property, category, sub-label text match, time range)`. Returns ranked results. Replaces the old `get_suggestion_stats` + corrections browser.
- [ ] `fetch_evidence_bundle` — pulls an `EvidenceBundle` row by id, or assembles on demand for a given `messageId`. Uses sprint 01's `evidence-bundle.service.ts`.
- [ ] `propose_suggestion` — agent proposes a new `TuningSuggestion` without writing it. Emits a streamed `data-suggestion-preview` part to the client so the manager sees the diff inline before accepting.
- [ ] `suggestion_action` — apply/queue/reject/edit-then-apply a suggestion. Wraps existing sprint-02/03 endpoints. Honors the 48h cooldown.
- [ ] `memory` — passthrough to the SDK's `memory_20250818` tool. See §4.
- [ ] `get_version_history` — list recent artifact edits for a given artifact type/id. Reuses sprint-03's history controller.
- [ ] `rollback` — rollback an artifact version. Wraps sprint-03's rollback endpoint; respects the 501 NOT_SUPPORTED response for SOP/FAQ (concern C17).

**Rare tools behind Tool Search:** anything else (searching `PreferencePair` history, listing capability requests, raw Prisma reads) goes behind the SDK's Tool Search pattern — loadable on demand, not always in the system prompt. Keep the always-loaded set to the 8 above.

- [ ] Every tool is fully typed (TS types exported + matching JSON Schema for the SDK registration).
- [ ] Every tool call writes a span via the `startAiSpan` primitive from sprint 01's observability service.

### 3. SDK hooks

Implement the lifecycle hooks outside the token budget per the SDK's hook API. Read the installed package for exact signatures before writing.

- [ ] **`PreToolUse` hook** — runs before every tool call. Enforces:
  - **Cooldown** on `suggestion_action(apply)` for the same artifact target in 48h. Uses sprint-02's cooldown logic. Deny with `permissionDecision: 'deny'` + a rationale string when cooldown blocks.
  - **Oscillation detection** — refuse `suggestion_action(apply)` if the proposed change reverses a change applied in the last 14d unless the new evidence materially exceeds the prior evidence's confidence (simple heuristic: new confidence > prior * 1.25). Log.
  - **Compliance check** — any `suggestion_action(apply)` requires manager confirmation. In the chat flow the manager explicitly says apply; if the agent tries to apply without an explicit user turn sanctioning it (check the last user message), deny.
- [ ] **`PostToolUse` hook** — runs after every tool call. Does:
  - Langfuse logging via existing observability primitives.
  - Acceptance-stat updates (delegate to sprint-02's `category-stats.service`).
  - **Preference-pair capture** on `suggestion_action(reject)` and `suggestion_action(edit_then_apply)` — writes a `PreferencePair` row via sprint-03's `preference-pair.service`.
- [ ] **`PreCompact` hook** — runs before context compaction. Injects a summary of the manager's durable preferences + recent decisions so they survive compaction. Pulls from `AgentMemory`.
- [ ] **`Stop` hook** — runs when the agent decides to stop a turn. Emits a follow-up prompt suggestion ("Anything else you'd like me to look at?") as a transient client data part.

### 4. Agent memory backed by Postgres `AgentMemory`

- [ ] Implement the backend for the SDK's `memory_20250818` tool against the existing `AgentMemory` table. Four commands supported: `view`, `create`, `update`, `delete`. All tenant-scoped.
- [ ] Keys use a simple namespacing convention (`preferences/tone`, `facts/luxury-properties`, `decisions/2026-04-15-parking`) — document the convention in a README inside `backend/src/tuning-agent/memory/`.
- [ ] Memory reads return JSON values. Writes set `updatedAt` via the Prisma schema's `@updatedAt`.
- [ ] At session start, the agent runs a one-time `memory.view(key: "preferences/*")` and injects results into the dynamic portion of the system prompt via the `PreCompact`-style pattern (but on startup, not only on compaction).
- [ ] Memory writes during a session are visible in the next session (proven by a smoke test: write a preference, start a new session for the same tenant, the agent recalls it).

### 5. System prompt with cache boundary

- [ ] Assemble the system prompt as XML-tagged sections in a single string:
  - `<persona>` — who the agent is, tone, anti-sycophancy clause.
  - `<principles>` — direct-refusal pattern, NO_FIX as a first-class option, no-apply-without-manager-confirmation.
  - `<taxonomy>` — 8-category definitions, sub-label guidance.
  - `<tools>` — tool docstrings (static, so they cache).
  - `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` — literal marker string as the cache boundary.
  - `<memory_snapshot>` — current `AgentMemory` preferences + key facts.
  - `<pending_suggestions>` — summary of pending queue, aggregate counts.
  - `<session_state>` — anchor message / selected suggestion / conversation id.
- [ ] Prompt caching is verified via Langfuse token counts: on turn 2 of the same session, the input tokens billed must be substantially lower than turn 1 (static prefix is cached). Document the observed ratio in the report.
- [ ] Anti-sycophancy wording is verbatim: *"If no artifact change is warranted, return NO_FIX. Do not invent suggestions to satisfy requests."* Copy the direct-refusal pattern from the vision doc / leaked Claude prompts research.

### 6. Frontend chat panel via Vercel AI SDK

- [ ] Install `@ai-sdk/react` (`useChat`) and `@ai-sdk/anthropic` in `frontend/` if not already present. Confirm major version.
- [ ] New component `frontend/components/tuning/chat-panel.tsx` mounted into the left-rail seam in `frontend/app/tuning/page.tsx`. Do NOT redesign the three-region layout; mount inside the placeholder section labeled "Conversations — coming soon".
- [ ] The chat panel uses `useChat({ api: '/api/tuning/chat', ...})`. The backend endpoint proxies to the agent runtime and streams SSE.
- [ ] Streamed message parts render via typed components:
  - `<TextPart>` — base assistant text.
  - `<ThinkingSection>` — collapsible, shows the agent's reasoning when present.
  - `<ToolCallPart>` — quiet chip showing tool name + status (pending/complete/error).
  - `<SuggestionCard>` — renders a `data-suggestion-preview` data part with inline diff preview and an Apply/Queue/Edit/Reject action row.
  - `<EvidenceInline>` — renders a `data-evidence-inline` data part with a compact summary view of bundle key fields (reuses sprint 03's `EvidencePane` primitives).
  - `<DiffPreview>` — reuses sprint 03's `diff-viewer.tsx`.
- [ ] `transient: true` parts (progress spinners, "agent is thinking", tool-call-starting indicators) do not persist into `TuningMessage` rows. Regular parts do.
- [ ] Message persistence: every turn's final parts array is written to `TuningMessage` rows (role, parts JSON). On page load, existing messages rehydrate into `useChat`'s `initialMessages`.
- [ ] Editorial design language consistent with sprint 03 (cream canvas, hairline borders, editorial typography, restrained accent).

### 7. Chat history browser

- [ ] The left-rail seam holds a list of `TuningConversation` rows for the tenant, title (auto-derived from first user message if not set), timestamp, anchor indicator when `anchorMessageId` is set.
- [ ] Clicking a conversation deep-links to `/tuning?conversationId=...` and rehydrates the chat.
- [ ] New-conversation button creates a `TuningConversation` (trigger_type `MANUAL`) and navigates.
- [ ] Search within conversations by substring over `TuningMessage.parts` text content. Simple Postgres `ILIKE` is fine for V1.

### 8. Anchor-message flow

- [ ] In `frontend/components/inbox-v5.tsx`, add a **"Discuss in tuning"** button on each main-AI message. Clicking it:
  - POSTs to `/api/tuning/conversations` with `{ anchorMessageId, triggerType: 'MANUAL' }` (or an appropriate specific trigger if the context fits).
  - Creates a `TuningConversation`, returns its id.
  - Navigates to `/tuning?conversationId=...`.
- [ ] The agent, on opening a conversation with `anchorMessageId` set, proactively fetches that message's evidence bundle and greets the manager with a short summary of what the main AI did on that message.

### 9. Proactive opener

- [ ] On conversation create (any trigger type), the agent greets the manager with:
  - A summary of pending suggestions (aggregate counts by category, the top 3 by confidence).
  - The most actionable next step ("We have N suggestions. The biggest one is X — want to start there?").
- [ ] The opener is streamed as the first assistant turn, not hard-coded client-side. It IS the agent's first action — it calls `get_context` (or reads from preloaded dynamic prompt section) and responds.

### 10. Endpoint surface

All additive, tenant-scoped.

- [ ] `POST /api/tuning/conversations` — create a `TuningConversation`. Body: `{ anchorMessageId?, triggerType, initialMessage? }`. Returns the id.
- [ ] `GET /api/tuning/conversations` — list conversations for the tenant (for the history browser). Pagination + search.
- [ ] `GET /api/tuning/conversations/:id` — fetch conversation with messages for rehydration.
- [ ] `PATCH /api/tuning/conversations/:id` — rename / archive.
- [ ] `POST /api/tuning/chat` — the Vercel AI SDK streaming endpoint. Proxies to the agent runtime. Body follows `useChat` conventions.

### 11. Tests + smoke

- [ ] Backend unit tests for: each tool (at least happy path + one error), each hook (at least the cooldown and preference-pair-capture paths), memory CRUD, system-prompt assembler (static prefix byte-identical across calls).
- [ ] Backend integration smoke: `scripts/smoke-tuning-agent.ts` — starts a fake conversation, sends 3 user turns, verifies: `TuningConversation` + `TuningMessage` rows written, `sdkSessionId` populated, at least one tool call traced, memory write from a "remember this" user turn visible in the `AgentMemory` table, session resumes cleanly in a second invocation.
- [ ] Frontend: component test for `SuggestionCard` rendering a mock data-suggestion-preview part.
- [ ] `npm run build` passes on both frontend and backend.
- [ ] **Prompt-caching verification.** Run two turns on the same session against the live Anthropic API (or document the exact command to run on Railway). Report Langfuse's observed cached-input-tokens vs non-cached-input-tokens ratio for turn 2.

### 12. Schema audit

Expected: **zero schema changes this sprint.** If you find you need one, stop and ask.

Document the check in the report: "No schema changes" + rationale.

## Commits

Commit per logical unit. No squashing. Suggested sequence:

1. `feat(041): install claude-agent-sdk + vercel ai sdk, scaffold tuning-agent module`
2. `feat(041): tuning-agent system prompt with cache boundary`
3. `feat(041): tuning-agent memory backed by Postgres AgentMemory`
4. `feat(041): tuning-agent consolidated tool layer (~8 tools)`
5. `feat(041): PreToolUse hook — cooldown + oscillation + compliance`
6. `feat(041): PostToolUse hook — langfuse + stats + preference-pair capture`
7. `feat(041): PreCompact and Stop hooks`
8. `feat(041): tuning-agent SSE chat endpoint`
9. `feat(041): tuning conversations + messages endpoints`
10. `feat(041): chat panel UI with streamed parts + SuggestionCard + EvidenceInline`
11. `feat(041): chat history browser in left rail`
12. `feat(041): anchor-message flow — "discuss in tuning" button`
13. `feat(041): proactive opener`
14. `test(041): tuning agent unit + integration smoke + prompt-cache verification`

## What to report back

Write `specs/041-conversational-tuning/sprint-04-conversational-agent-report.md` with:

1. **What shipped** — delivered acceptance criteria.
2. **What deviated** — differences from the brief, reason.
3. **SDK + deps** — versions installed, API shape confirmed.
4. **Tool layer summary** — the 8 tools + what's behind Tool Search.
5. **Hook layer summary** — what each hook does and what it writes.
6. **System prompt structure** — XML sections + cache boundary + verbatim anti-sycophancy clause.
7. **Memory backend notes** — key namespacing, CRUD surface.
8. **Prompt-caching verification** — exact Langfuse numbers: turn 1 input tokens, turn 2 input tokens, cached-input-tokens fraction.
9. **Anchor-message + proactive-opener demo** — description of the observed first-turn behavior.
10. **Schema audit** — confirm no changes.
11. **Pre-wired but unused** — anything that ships dormant for V2.
12. **What's broken / deferred** — V2 prep, known issues.
13. **Files touched** — created / modified / deleted.
14. **Smoke + test results** — with command output.
15. **Recommended next actions** — handoff to V1-tail (the retention job, deploy, bake).
16. **Commits** — `git log --oneline feat/041-conversational-tuning ^main`.

## When to ask vs when to just implement

Stop and use AskUserQuestion (or stop and write the report early) when:
- Schema change seems necessary.
- Installed Claude Agent SDK version differs meaningfully from the roadmap assumptions (signature changes, missing primitives).
- Vercel AI SDK's `useChat` API has breaking changes that force a different protocol.
- Langfuse token-count verification can't be performed (keys missing in deploy env).

Do NOT ask for:
- System prompt wording, tool names, memory key names, microcopy.
- Component file layout.
- Tailwind choices.
- Commit message style.
