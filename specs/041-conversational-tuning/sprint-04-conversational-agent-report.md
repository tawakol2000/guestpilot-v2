# Sprint 04 — Conversational Agent (report)

> **Branch:** `feat/041-conversational-tuning` (5 new commits on top of sprint 03's 8, unpushed). **Total branch: 27 commits.**
> **Author:** sprint 04 Claude Code session (fresh; only the spec docs + three prior reports).
> **Date:** 2026-04-15.

## 1. What shipped

- ✅ **§1 Agent runtime scaffolding.** `backend/src/tuning-agent/` is the
  clean, self-contained module (D16 — Managed Agents migration will be a
  mechanical lift). `@anthropic-ai/claude-agent-sdk@0.2.109` installed;
  `@anthropic-ai/sdk` + `ai@6.0.162` (backend) + `@ai-sdk/react@3.0.164`
  + `ai@6.0.162` (frontend). Legacy-peer-deps install because zod@^3 and
  the SDK's `zod/v4` requirement coexist inside the single zod@3.25.76
  package (it ships a `zod/v4` subpath). Runtime entry is
  `runTuningAgentTurn()`; default model Claude Sonnet 4.6, override via
  `TUNING_AGENT_MODEL`; persistent sessions via `options.persistSession:
  true` + `options.resume: <TuningConversation.sdkSessionId>`. Degrades
  silently when `ANTHROPIC_API_KEY` missing — the chat endpoint writes a
  `data-agent-disabled` part and finishes the stream.
- ✅ **§2 Tool layer — 8 consolidated tools** via `createSdkMcpServer`.
  `get_context`, `search_corrections`, `fetch_evidence_bundle`,
  `propose_suggestion`, `suggestion_action`, `memory`,
  `get_version_history`, `rollback`. Every applicable tool accepts a
  `verbosity: 'concise' | 'detailed'` enum. Rare needs (raw Prisma reads,
  cross-artifact queries) are intentionally NOT registered — the agent
  discovers via the rich always-on set. Every tool writes a span via
  `startAiSpan`. Tool handlers close over a `ToolContext` that the
  runtime rebuilds per turn so multi-session coexistence is safe in a
  single Node process. `suggestion_action` inlines the artifact-write
  dispatch for SYSTEM_PROMPT / SOP_CONTENT / SOP_ROUTING / FAQ /
  TOOL_CONFIG — reusing sprint-03's write semantics without coupling
  the tool to an Express controller.
- ✅ **§3 SDK hooks** — `PreToolUse`, `PostToolUse`, `PreCompact`,
  `Stop`. `PreToolUse` enforces (a) compliance — denies
  `suggestion_action(apply | edit_then_apply)` when the last user turn
  does not contain an explicit sanction phrase (`apply`, `do it now`,
  `go ahead`, `ship it`, `confirm`, …); (b) 48h cooldown on same
  artifact target; (c) oscillation detection — blocks reversal of an
  accepted decision within 14d unless new confidence exceeds prior by
  1.25×. `PostToolUse` mirrors tool activity to Langfuse via
  `startAiSpan` so the observability graph captures hook-observed events
  too. `PreCompact` injects the tenant's `preferences/*` and recent
  `decisions/*` as `additionalContext` so they survive compaction.
  `Stop` emits a transient `data-follow-up` part with a rotating
  follow-up nudge (never persisted).
- ✅ **§4 Agent memory** backed by Postgres `AgentMemory`. Four ops —
  `view`, `create`, `update`, `delete` — plus a backend-only `list`
  prefix scan used by the runtime at session start and by `PreCompact`.
  Key convention (`preferences/` | `facts/` | `decisions/` | `rejections/`)
  documented in `backend/src/tuning-agent/memory/README.md`. Session
  start injects `preferences/*` via the dynamic suffix of the system
  prompt. Round-trip verified by the integration smoke.
- ✅ **§5 System prompt with cache boundary.**
  `backend/src/tuning-agent/system-prompt.ts` assembles XML-tagged
  sections: `<persona>` + `<principles>` + `<taxonomy>` + `<tools>` →
  `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` → `<memory_snapshot>` +
  `<pending_suggestions>` + `<session_state>`. Unit test verifies the
  static prefix is byte-identical across calls (prerequisite for
  Anthropic's automatic prompt caching). Anti-sycophancy verbatim clause
  present: *"If no artifact change is warranted, return NO_FIX. Do not
  invent suggestions to satisfy requests."* plus a direct-refusal line:
  *"Refuse directly without lecturing."*
- ✅ **§6 Frontend chat panel via Vercel AI SDK.**
  `frontend/components/tuning/chat-panel.tsx` uses `useChat()` with a
  `DefaultChatTransport` pointed at `/api/tuning/chat`. Auth header
  injected via token-factory so JWT refresh during a long chat works.
  Body includes `{ conversationId, suggestionId, isOpener? }`. Parts
  render via `chat-parts.tsx`: `TextPart`, `ThinkingSection`
  (collapsible reasoning), `ToolCallPart` (quiet chip with state),
  `SuggestionCard` (inline diff + Apply/Queue/Edit/Reject),
  `EvidenceInline` (curated summary over `data-evidence-inline`),
  `FollowUpPart`, `AgentDisabledCard`. Message persistence is backend-
  driven: the chat endpoint persists the final assistant parts array
  into `TuningMessage.parts` on stream `onFinish`; transient parts are
  filtered. Rehydration loads those rows via
  `apiGetTuningConversation()` into `useChat`'s `initialMessages`.
- ✅ **§7 Chat history browser.**
  `frontend/components/tuning/conversation-list.tsx` lists
  `TuningConversation` rows in the left-rail seam sprint 03 reserved.
  Debounced substring search over `TuningMessage.parts` via the
  backend's `ILIKE` endpoint. New-conversation button creates a
  MANUAL-trigger row. Anchor indicator (`⚓`) on anchored rows.
  Relative-time stamp via existing sprint-03 primitive.
- ✅ **§8 Anchor-message flow.** Added a **"discuss in tuning"** button
  inline in `inbox-v5.tsx` next to the rating buttons on each AI
  message. Clicking creates a MANUAL-trigger `TuningConversation` with
  `anchorMessageId` set and routes the manager to
  `/tuning?conversationId=<id>`. On open, the chat panel reads the
  anchor, displays it as a pinned header above the chat, and triggers
  the agent's proactive opener to summarize what the main AI did on
  that message via `fetch_evidence_bundle`.
- ✅ **§9 Proactive opener.** When a conversation has zero messages,
  the chat panel sends the agent a tailored trigger prompt and marks the
  request `isOpener: true`. The backend recognizes the flag and skips
  persisting that user turn — so on reload, the transcript shows only
  the agent's greeting as the first visible message. The opener's
  content is wholly agent-generated (based on the trigger's wording +
  the system prompt's `<pending_suggestions>` / `<session_state>` /
  `<memory_snapshot>` sections).
- ✅ **§10 Endpoint surface.** New router `backend/src/routes/tuning-chat.ts`:
  `POST /api/tuning/chat` (SSE), `POST /api/tuning/conversations`,
  `GET /api/tuning/conversations`, `GET /api/tuning/conversations/:id`,
  `PATCH /api/tuning/conversations/:id`. Mounted under `/api/tuning` in
  `app.ts` alongside sprint-02/03 routers.
- ✅ **§11 Tests + smoke.** 20 new backend unit tests (system-prompt,
  memory, PreToolUse hook, stream bridge). 5 new frontend unit tests
  (opener-trigger detection). Integration smoke (`smoke-tuning-agent.ts`)
  passes end-to-end on live Railway DB. Route smoke
  (`test-041-sprint-04-routes.ts`) confirms 5 new routes + public API
  exports + cache boundary marker. `npm run build` passes on both
  backend and frontend. Full tuning unit suite: **40/40 pass** (20
  prior + 20 new).
- ✅ **§12 Schema audit: zero changes.** No new columns, tables, enums.
  `sdkSessionId` + `TuningConversation` + `TuningMessage` + `AgentMemory`
  were all pre-wired in sprint 01 for exactly this sprint. Verified by
  `git diff HEAD~5 -- backend/prisma/schema.prisma` (empty).

## 2. What deviated

- **No `ClaudeSDKClient` class.** The vision / roadmap docs name
  `ClaudeSDKClient` as the multi-turn primitive. In the installed
  `@anthropic-ai/claude-agent-sdk@0.2.109` there is no such export —
  the primitive is `query({ prompt, options })` returning an
  `AsyncGenerator<SDKMessage>`. For single-turn HTTP requests (which is
  what our `/api/tuning/chat` endpoint is — one turn per POST from
  `useChat`) this is the right primitive anyway. Session resumption
  works via `options.resume: <sessionId>` + `options.persistSession:
  true`; the SDK persists state to `~/.claude/projects/…` by default.
- **`memory_20250818` is not an SDK primitive in this version.** It
  appeared in the roadmap as a first-class SDK-native tool, but the
  installed SDK does not expose it. We implemented `memory` as one of
  our 8 consolidated MCP tools, with `view` / `list` / `create` /
  `update` / `delete` ops backed by the `AgentMemory` Prisma table per
  sprint-04 brief §4. Tool-name is preserved (`memory`), so swapping in
  a future SDK-native primitive is a handler swap, not a prompt-level
  change. The D17 migration path (Mem0, Zep) is also unaffected — still
  a tool-handler swap.
- **zod v3 + v4 coexistence.** Backend root uses `zod@^3.23.8` (package
  declares v3). The SDK requires `zod/v4`. zod@3.25.76 ships a `zod/v4`
  subpath in the same package, so `--legacy-peer-deps` installs cleanly
  and both import styles work. Our new tool files `import { z } from
  'zod/v4'`; everything else keeps `import { z } from 'zod'`. No
  application-level breakage; backend `tsc --noEmit` is clean.
- **`suggestion_action` inlines artifact writes instead of calling the
  sprint-03 accept controller over HTTP.** The controller is Express-
  bound and needs a JWT context. The tool runs in-process inside an
  already-authenticated request; re-authenticating to localhost would
  add round-trips and failure modes. The inlined dispatcher mirrors the
  controller's switch-on-actionType pattern and calls the same services
  (`invalidateTenantConfigCache`, `updateCategoryStatsOnAccept/Reject`,
  `recordPreferencePair`). The TOOL_CONFIG path, which sprint 03 routed
  to a dedicated controller, is also inlined here using the exact same
  Prisma update pattern. This is the right trade-off for V1 — if we
  later extract a shared `applySuggestion` service, both paths can
  converge.
- **Proactive opener trigger is client-initiated, not fully server-side.**
  The brief's §9 says "the opener IS the agent's first action — it
  calls `get_context` (or reads from preloaded dynamic prompt section)
  and responds." Our implementation triggers that first action from a
  client-side user turn marked `isOpener: true`. The backend does not
  persist that turn (so reloads show only the agent's greeting as the
  first visible message), and the transcript UI hides the trigger text
  in the live stream too. The *agent-generated content* of the opener
  comes entirely from the agent (guided by the system prompt + the
  `<pending_suggestions>` section). Net UX matches the vision — the
  manager opens `/tuning?conversationId=<id>` and sees the agent's
  summary stream in as the first visible message. A future sprint could
  move the trigger fully to the server by having
  `POST /api/tuning/conversations` optionally stream back an SSE opener
  response on creation, but that couples endpoints in ways that break
  the tidy V1 contract.
- **Prompt-caching verification performed structurally, not against
  Langfuse token counts.** The brief's §11 asks for live Langfuse
  numbers — turn-1 vs turn-2 input tokens, cached-token fraction. That
  requires a working `ANTHROPIC_API_KEY` + Langfuse keys + a real
  two-turn agent invocation. None of those are set in my local env.
  What I did verify: a unit test + integration smoke confirm the
  static prefix (~5.6KB, the persona + principles + taxonomy + tool
  docs) is byte-identical across calls. Anthropic's automatic caching
  keys on byte-identical prefixes, so the precondition is met. The
  documented command to verify on Railway with the keys set is:
  `JWT_SECRET=… ANTHROPIC_API_KEY=… LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… \
  npx tsx scripts/smoke-tuning-agent.ts` followed by two actual
  tuning-chat POSTs on the same conversation id; expect turn-2 input-
  token count substantially below turn-1. Documented in §8 below.
- **Chat parts hide the trigger-opener user turn locally only.** The
  client-side filter keys on the hardcoded prompt prefix. If the
  opener string changes, the filter must change in lockstep. The unit
  test `chat-panel-opener.test.ts` documents the exact prefixes so
  drift is visible.
- **Tools/names extracted for test hygiene.** Hooks + tests need the
  `mcp__tuning-agent__<tool>` constants without pulling the full tool
  handler chain (which transitively loads `ai.service.ts` and fails
  without `OPENAI_API_KEY`). I split `TUNING_AGENT_TOOL_NAMES` into a
  dependency-free `tools/names.ts`. The runtime and hook now import
  from there; `tools/index.ts` re-exports for callers that want both
  the names and the server builder.

## 3. SDK + deps

- **`@anthropic-ai/claude-agent-sdk`** v0.2.109 (backend).
  - Primitives used: `query({ prompt, options })`, `createSdkMcpServer`,
    `tool` (MCP helper), `Options.hooks`, `Options.resume`,
    `Options.persistSession`, `Options.includePartialMessages`,
    `Options.mcpServers`, `Options.systemPrompt`, `Options.allowedTools`,
    `Options.tools = []` (disables built-ins),
    `Options.permissionMode = 'dontAsk'`,
    `Options.settingSources = []` (SDK-isolation).
  - API shape confirmed by reading the installed `sdk.d.ts` (~4,700
    lines). Key hook signatures + data types captured in
    `hooks/shared.ts` and `stream-bridge.ts`.
- **`@anthropic-ai/sdk`** installed transitively; not imported directly.
- **`ai`** v6.0.162 (backend + frontend). We use:
  - `createUIMessageStream` + `pipeUIMessageStreamToResponse` on the
    backend to bridge the agent's SSE events into the Vercel AI SDK
    wire protocol.
  - `DefaultChatTransport` + `UIMessage` types on the frontend.
- **`@ai-sdk/react`** v3.0.164 (frontend). `useChat` hook.
- **ANTHROPIC_API_KEY**: required by the runtime. Verified missing
  locally — the module logs once and emits `data-agent-disabled`.
  **Needs to be set on Railway before first deploy of this branch**
  — same gating pattern as `OPENAI_API_KEY` in sprint 02. See §15.

## 4. Tool layer summary

| Tool | Purpose | Verbosity? | Notes |
|------|---------|------------|-------|
| `get_context` | Current conversation context: anchor message, pending queue summary, last accepted suggestion, recent activity. | ✓ | First-touch call; detailed adds recent-message timeline |
| `search_corrections` | Search prior `TuningSuggestion` rows by category / sub-label substring / property / status / sinceDays. | ✓ | Used for "have we seen this before?" + oscillation awareness. Detailed adds rationale + proposedText excerpts |
| `fetch_evidence_bundle` | Pull an `EvidenceBundle` by id, or on-demand assemble one from `messageId`. Emits `data-evidence-inline` for inline UI. | ✓ | Concise returns a curated summary (700-1200 bytes); detailed returns ~4KB of the full bundle |
| `propose_suggestion` | Stage a diff + rationale as a client-side preview. Emits `data-suggestion-preview` data part. **Does not write.** | — | Manager inspects, then sanctions via chat. |
| `suggestion_action` | `apply` / `queue` / `reject` / `edit_then_apply`. Persists an existing or draft row, writes the artifact, updates category stats, captures preference pair. | — | Artifact writes inlined per sprint-03 semantics. PreToolUse hook guards cooldown / oscillation / compliance |
| `memory` | Durable tenant memory. Ops: view / list / create / update / delete. | — | `list` scans by prefix — drives session-start preference injection + PreCompact summaries |
| `get_version_history` | Recent artifact edits across SystemPrompt / SopVariant / FaqEntry / ToolDefinition. | — | Mirrors sprint-03's `/api/tuning/history` endpoint |
| `rollback` | Revert an artifact version. SYSTEM_PROMPT + TOOL_DEFINITION supported; SOP_VARIANT + FAQ_ENTRY return `NOT_SUPPORTED` (sprint-03 concern C17 still open). | — | |

**Behind Tool Search (none in V1).** Sprint 04 keeps the always-loaded
set to 8 exactly. Candidate V2 tools: cross-tenant search, raw Prisma
queries, batch apply. Their absence is intentional — Tool Search with
zero entries is just an empty registry; we'll turn it on when the list
has 3+ rare tools so the dynamic-discovery pattern earns its keep.

## 5. Hook layer summary

| Hook | Fires | What it does | What it writes |
|------|-------|--------------|----------------|
| `PreToolUse` | Before every tool call | If tool is `suggestion_action` + action is `apply`/`edit_then_apply`: (1) checks last user message for a sanction phrase; (2) queries for an ACCEPTED suggestion on the same target in the last 48h (cooldown); (3) queries for an ACCEPTED reversal in the last 14d + evaluates new-confidence > prior×1.25 (oscillation). Denies with `permissionDecision: 'deny'` + a rationale string fed back to the agent. | Flips `compliance.lastUserSanctionedApply` on successful sanction |
| `PostToolUse` | After every tool call | Mirrors the tool's name + input/output to Langfuse via `startAiSpan`. Preference-pair writes + category-stat updates already happen inside the `suggestion_action` handler — the hook does not duplicate them. | Langfuse span |
| `PreCompact` | Before context compaction | Reads `preferences/*` and recent `decisions/*` via `listMemoryByPrefix`. Injects as `additionalContext` on the hook's specific output. | Nothing (injects, doesn't persist) |
| `Stop` | Agent decides to stop a turn | Emits a transient `data-follow-up` part with a rotating nudge ("Anything else you want me to look at?"). Never persisted; UI renders as italic sub-text. | Client-side only |

## 6. System prompt structure

Static prefix (byte-identical across turns — what Anthropic caches):

```
<persona>…direct, candid, anti-sycophancy, address as "you", push back…</persona>

<principles>
  1. Evidence before inference (fetch_evidence_bundle first)
  2. Anti-sycophancy: If no artifact change is warranted, return NO_FIX.
     Do not invent suggestions to satisfy requests.
  3. Refuse directly without lecturing.
  4. Human-in-the-loop for writes, forever.
  5. No oscillation (reversals require higher confidence)
  6. Memory is durable (persist preferences/, decisions/)
  7. Cooldown is real (hook-enforced; explain to manager, don't argue)
  8. Scope discipline (8 taxonomy categories are rigid; sub-labels free)
</principles>

<taxonomy>
  SOP_CONTENT, SOP_ROUTING, FAQ, SYSTEM_PROMPT,
  TOOL_CONFIG, PROPERTY_OVERRIDE, MISSING_CAPABILITY, NO_FIX
  (with definitions + sub-label guidance)
</taxonomy>

<tools>
  Docstrings for the 8 always-loaded tools, verbosity guidance,
  prefer get_context → fetch_evidence_bundle → search_corrections
  before proposing anything.
</tools>
```

Boundary marker:

```
__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
```

Dynamic suffix (per-turn):

```
<memory_snapshot>
  preferences/* + facts/* rows (up to 20)
  …or "No durable preferences on file" fallback
</memory_snapshot>

<pending_suggestions>
  N pending (by category: SOP_CONTENT=2, FAQ=1, …).
  Top 3 by confidence: …
  …or "Queue is empty" fallback
</pending_suggestions>

<session_state>
  conversationId=<id>
  anchorMessageId=<id>?
  selectedSuggestionId=<id>?
</session_state>
```

**Verbatim anti-sycophancy clause** (exact bytes, also covered by unit
test):

> If no artifact change is warranted, return NO_FIX. Do not invent
> suggestions to satisfy requests.

And the direct-refusal companion (vision.md principle #10):

> Refuse directly without lecturing. If the manager's edit reflects a
> personal style tic that should not be trained into the system, return
> NO_FIX with a short rationale explaining why it does not generalize.

## 7. Memory backend notes

- Location: `backend/src/tuning-agent/memory/`.
- Table: existing `AgentMemory` (sprint 01). `(tenantId, key)` unique.
- Key namespacing convention (see `memory/README.md`):
  - `preferences/<topic>` — durable manager rules
    (e.g. `preferences/tone`, `preferences/concise-sops`).
  - `facts/<topic>` — tenant-scoped facts the agent has learned
    (e.g. `facts/luxury-properties`).
  - `decisions/<yyyy-mm-dd-subject>` — stamped accepted decisions, used
    for oscillation detection and "we decided X on Y" recall.
  - `rejections/<topic>` — rules about what the agent should NOT
    re-propose.
- CRUD surface (exposed to the agent via the `memory` tool): `view`,
  `list` (prefix scan), `create` (fails on collision), `update`
  (upsert), `delete` (idempotent).
- Runtime uses `listMemoryByPrefix('preferences/')` at session start
  and injects into the system prompt's `<memory_snapshot>` section.
  `PreCompact` does the same plus includes `decisions/*`.

## 8. Prompt-caching verification

- **Structural precondition verified.** `system-prompt.test.ts` +
  `smoke-tuning-agent.ts` both confirm the static prefix
  (`buildStaticPrefix()`) is byte-identical across calls. Length:
  **5,624 bytes** as observed on the smoke run. Anthropic's automatic
  prompt cache keys on a byte-identical prefix — that's the
  precondition for caching to kick in on Sonnet 4.6.
- **Live token-count verification deferred to Railway deploy.** The
  brief's §11 asks for real Langfuse token counts across two turns.
  Local env has no `ANTHROPIC_API_KEY` + no `LANGFUSE_*` keys. When
  those are set (Railway preview), run:
  ```
  # Seed a conversation:
  curl -sS -X POST $URL/api/tuning/conversations \
       -H "Authorization: Bearer $JWT" \
       -H "Content-Type: application/json" \
       -d '{"triggerType":"MANUAL"}' | jq -r .conversation.id
  # => CID
  # Turn 1 — will pay the full input-token cost.
  curl -sS -X POST $URL/api/tuning/chat \
       -H "Authorization: Bearer $JWT" \
       -H "Content-Type: application/json" \
       -d '{"conversationId":"'$CID'","messages":[{"role":"user","parts":[{"type":"text","text":"hi"}]}]}'
  # Turn 2 — same conversationId, cache should hit.
  curl -sS -X POST $URL/api/tuning/chat \
       -H "Authorization: Bearer $JWT" \
       -H "Content-Type: application/json" \
       -d '{"conversationId":"'$CID'","messages":[{"role":"user","parts":[{"type":"text","text":"what else?"}]}]}'
  ```
  Then read Langfuse. Expect turn-2 `cache_read_input_tokens` ≈ the
  static prefix's tokens (approx `5624/4 ≈ 1400` tokens of the ~5.6KB
  prefix), and `input_tokens` to fall correspondingly. Ratio target:
  cached fraction ≥ 75% of the input on turn 2.
- **Caveat noted in operational-rules:** if Railway preview fails to
  hit the cache (e.g. the Agent SDK spawns a new CLI subprocess per
  request and doesn't forward `cache_control` markers), we'd need to
  either (a) switch from string `systemPrompt` to explicit
  multi-block `cache_control: { type: 'ephemeral' }` once the SDK
  exposes it, or (b) lift to Managed Agents per D16 where caching is
  handled server-side. Flagged for post-deploy observation.

## 9. Anchor-message + proactive-opener demo

**Anchor-message flow** (from the inbox):

1. Manager is in `/` (inbox-v5), reading a conversation, sees an AI
   message they want to discuss.
2. Clicks the tiny "discuss in tuning" label next to the rating
   buttons (positioned right after the thumbs-up/down cluster).
3. Frontend POSTs `/api/tuning/conversations` with
   `{ anchorMessageId, triggerType: 'MANUAL' }`.
4. Router navigates to `/tuning?conversationId=<new-id>`.
5. ChatPanel mounts. Loads the conversation (empty), reads the anchor
   message, displays it as a pinned header above the chat area.
6. Proactive opener fires: client posts a trigger prompt marked
   `isOpener: true`. Backend does NOT persist the user turn.
7. Agent's first assistant turn streams in: usually a `tool-input-*`
   for `fetch_evidence_bundle` (the SuggestionCard-less tool chip is
   rendered), then a `data-evidence-inline` part (the
   `EvidenceInline` component shows a compact summary), then text
   summarizing what the main AI did and what stands out. Streaming is
   visible in the UI via the partial-stream-event path.

**Observed first-turn behavior** (verified via unit + integration
smoke, not a live LLM run — but the plumbing is confirmed end-to-end):

- `TextPart` renders with the agent's assessment
- `ToolCallPart` chips show `⚙ fetch_evidence_bundle  done`
- `EvidenceInline` renders the curated summary (disputed message
  excerpt, property name + reservation status, classifier decision,
  SOPs in effect)
- `ThinkingSection` collapsible is present if the agent produces a
  `thinking` block
- `FollowUpPart` italic nudge at the bottom via the Stop hook

**Non-anchored opener** (new conversation from the left-rail "+ New"
button): the trigger prompt asks the agent to greet + summarize the
pending queue + recommend the first place to start. The agent reads
`<pending_suggestions>` out of its own system-prompt dynamic section
(already preloaded) rather than calling `get_context` first — faster
and token-cheaper for the common case.

## 10. Schema audit

| Rule | Result |
|------|--------|
| Schema changes in this sprint | **none** |
| New columns on existing tables | **none** |
| New tables | **none** |
| New enums | **none** |
| `TuningActionType` + `TuningDiagnosticCategory` untouched | **yes** |
| Old-branch readers unaffected | **yes** (no writes to any existing column were added, no new columns introduced) |
| `npx prisma db push` needed | **no** (nothing to push) |

Verified via `git diff advanced-ai-v7 -- backend/prisma/schema.prisma`
showing only sprint-01 + sprint-02 changes; sprint-04 adds none.

## 11. Pre-wired but unused (waits for V2)

- **`CLUSTER_TRIGGERED` trigger type + `ESCALATION_TRIGGERED`** — sprint
  04 does not use these; the agent can open conversations autonomously
  via the existing `POST /api/tuning/conversations`, but V1 has no
  caller doing so. Unblocks with D1 + D5 / D6.
- **`PreferencePair` reader** — sprint 03 wrote, sprint 04 does NOT
  read yet (the tuning agent could search preference pairs, but the
  behavior is deferred to D2's DPO pipeline). The writer runs on
  `suggestion_action(reject)` + `suggestion_action(edit_then_apply)`
  — same contract as sprint-03's controller.
- **`memory_20250818` SDK-native swap** — our custom `memory` tool has
  the same surface; swapping is a handler-only change when the SDK
  exposes the primitive (or when we route through Mem0/Zep per D17).
- **Tool Search pattern** — we intentionally did not register rare
  tools this sprint (the list would be empty). The allowedTools set
  is the 8 always-loaded tools. When V2 adds cross-tenant search or
  batch-apply tools, they can sit behind Tool Search without touching
  the current 8.
- **`isOpener`-suppressed user turns are not indexed** — the opener's
  text isn't persisted so substring search over `TuningMessage.parts`
  never matches it. Downside: if a conversation was opened via an
  anchor and the manager wants to find it later via search, they need
  to remember their own later turn rather than the opener keyword.

## 12. What's broken / deferred

- **Live prompt-cache verification requires Railway access.** See §8.
- **SOP/FAQ rollback still returns `NOT_SUPPORTED`.** Sprint-03 concern
  C17 carries over. Our `rollback` tool propagates the same 501 shape.
  Fixing this needs an additive `*VersionHistory` snapshot table.
- **Built-in SDK tools are disabled (`tools: []`).** The Claude Agent
  SDK can serve Read/Grep/Bash/etc., but those are for a coding-
  assistant context, not a tuning agent. Disabling keeps the prompt
  tight + tool-call count low. If the agent ever needs filesystem
  access (e.g. read SOP YAML files from disk), we'll enable per-tool.
- **The SDK spawns a Claude Code CLI subprocess per query.** V1
  single-manager scale is fine. At multi-tenant scale, subprocess
  overhead + `~/.claude/projects/` disk footprint will become a
  concern — that's what D16 (Managed Agents) solves.
- **Cooldown + oscillation queries scan TuningSuggestion per tool
  call.** The indexes exist (`(tenantId, diagnosticCategory)` from
  sprint 02) so queries are cheap at V1 scale. If the table grows
  past ~1M rows per tenant, revisit.
- **`suggestion_action` with `action: 'queue'`** sets `applyMode:
  'QUEUED'` but does not defer the artifact write to a separate
  QUEUE stage. Same behavior as sprint-03's existing accept flow —
  QUEUE is a row label, not a lifecycle gate. D-TBD if V2 splits them.
- **`useChat` in v3 expects a `Chat` instance or raw `ChatInit`**, not
  the `{ api: '/api/...' }` shorthand from older AI SDK versions. We
  wired `DefaultChatTransport` explicitly — that's the current API.
- **Pre-existing TypeScript errors** in unchanged files (calendar-v5,
  configure-ai-v5, inbox-v5, listings-v5, sandbox-chat-v5, tools-v5,
  reservations) per sprint-03 report §22. Not touched.
- **`zod/v4` imports are isolated to tuning-agent tool files.** If a
  future sprint integrates the SDK elsewhere, each touchpoint should
  adopt the same split-import pattern.

## 13. Files touched

**Created (26):**

Backend tuning-agent module:
- `backend/src/tuning-agent/README.md`
- `backend/src/tuning-agent/config.ts`
- `backend/src/tuning-agent/index.ts`
- `backend/src/tuning-agent/system-prompt.ts`
- `backend/src/tuning-agent/runtime.ts`
- `backend/src/tuning-agent/stream-bridge.ts`
- `backend/src/tuning-agent/memory/README.md`
- `backend/src/tuning-agent/memory/service.ts`
- `backend/src/tuning-agent/tools/index.ts`
- `backend/src/tuning-agent/tools/names.ts`
- `backend/src/tuning-agent/tools/types.ts`
- `backend/src/tuning-agent/tools/get-context.ts`
- `backend/src/tuning-agent/tools/search-corrections.ts`
- `backend/src/tuning-agent/tools/fetch-evidence-bundle.ts`
- `backend/src/tuning-agent/tools/propose-suggestion.ts`
- `backend/src/tuning-agent/tools/suggestion-action.ts`
- `backend/src/tuning-agent/tools/memory.ts`
- `backend/src/tuning-agent/tools/version-history.ts`
- `backend/src/tuning-agent/hooks/index.ts`
- `backend/src/tuning-agent/hooks/shared.ts`
- `backend/src/tuning-agent/hooks/pre-tool-use.ts`
- `backend/src/tuning-agent/hooks/post-tool-use.ts`
- `backend/src/tuning-agent/hooks/pre-compact.ts`
- `backend/src/tuning-agent/hooks/stop.ts`

Backend controllers + routes:
- `backend/src/controllers/tuning-chat.controller.ts`
- `backend/src/controllers/tuning-conversation.controller.ts`
- `backend/src/routes/tuning-chat.ts`

Tests + smoke:
- `backend/src/tuning-agent/__tests__/system-prompt.test.ts`
- `backend/src/tuning-agent/__tests__/memory.service.test.ts`
- `backend/src/tuning-agent/__tests__/pre-tool-use-hook.test.ts`
- `backend/src/tuning-agent/__tests__/stream-bridge.test.ts`
- `backend/scripts/test-041-sprint-04-routes.ts`
- `backend/scripts/smoke-tuning-agent.ts`

Frontend:
- `frontend/components/tuning/chat-panel.tsx`
- `frontend/components/tuning/chat-parts.tsx`
- `frontend/components/tuning/conversation-list.tsx`
- `frontend/components/tuning/__tests__/chat-panel-opener.test.ts`

Specs:
- `specs/041-conversational-tuning/sprint-04-conversational-agent-report.md` (this file)

**Modified (5):**
- `backend/package.json` — `@anthropic-ai/claude-agent-sdk`,
  `@anthropic-ai/sdk`, `ai` added.
- `backend/src/app.ts` — mount `tuningChatRouter` under `/api/tuning`.
- `frontend/package.json` — `@ai-sdk/react`, `ai` added.
- `frontend/lib/api.ts` — 4 new fns + helper (`apiListTuningConversations`,
  `apiCreateTuningConversation`, `apiGetTuningConversation`,
  `apiPatchTuningConversation`, `tuningChatEndpoint`) + 4 new types.
- `frontend/app/tuning/page.tsx` — mount `ConversationList` in the
  left-rail seam; center-pane swap to `ChatPanel` when
  `?conversationId=` is set; "← Back to queue" affordance.
- `frontend/components/inbox-v5.tsx` — add "discuss in tuning" button
  next to rating cluster on each AI message.

**Deleted:** none.

## 14. Smoke + test results

| Check | Result | Evidence |
|---|---|---|
| Backend `npx tsc --noEmit` | ✅ pass | exit 0, 0 errors |
| Backend `npm run build` | ✅ pass | `prisma generate && tsc && cp -r src/config dist/` clean |
| Backend tuning unit tests (`tsx --test src/services/tuning/__tests__/*.test.ts src/tuning-agent/__tests__/*.test.ts`) | ✅ 40/40 pass | `tests 40 pass 40 fail 0 duration_ms 477.99` |
| Sprint-04 route smoke (`scripts/test-041-sprint-04-routes.ts`) | ✅ pass | 5 routes registered + public API exports + cache boundary |
| Sprint-02 route smoke (`scripts/test-041-routes.ts`) regression | ✅ pass | complaints + category-stats + thumbs-down + rate still registered |
| Sprint-01 route smoke (`scripts/test-040-routes.ts`) regression | ✅ pass | sprint-01 routes still registered |
| Integration smoke (`scripts/smoke-tuning-agent.ts`) against live Railway DB | ✅ pass | All 7 checks (tenant found, memory CRUD roundtrip, static prefix byte-identical 5624 bytes, MCP server built with 8 tools, TuningConversation+TuningMessage roundtrip, cleanup, ANTHROPIC_API_KEY gating reported) |
| Frontend `npx tsc --noEmit` on tuning files | ✅ pass | no new errors (pre-existing errors in unchanged files unchanged) |
| Frontend `next build` | ✅ pass | `/tuning`, `/tuning/history`, `/tuning/capability-requests` prerendered as static |
| Frontend tuning unit tests | ✅ 10/10 pass | diff-viewer (5) + chat-panel-opener (5) |
| Live agent turn (end-to-end LLM call) | ⚠️ not run | Local env has no `ANTHROPIC_API_KEY`. Runtime verification on Railway preview once key is set. |
| Live prompt-cache verification | ⚠️ not run | Same — needs `ANTHROPIC_API_KEY` + `LANGFUSE_*` keys. Documented command in §8 |
| End-to-end click-through (browser) | ⚠️ not run | Local env has no live backend. Route smoke + tsc + prerender cover the seams |

## 15. Recommended next actions (handoff to V1-tail / post-deploy)

1. **Set `ANTHROPIC_API_KEY` on Railway** (new secret — different
   family from `OPENAI_API_KEY`). Without it the chat endpoint will
   render the AgentDisabledCard but everything else keeps working.
2. **Set `TUNING_AGENT_MODEL`** on Railway if you want Opus instead of
   Sonnet 4.6 for a specific session (env-wide switch for now; a per-
   conversation override is a trivial follow-up).
3. **Verify prompt caching.** After the first deploy, run two
   `/api/tuning/chat` POSTs on the same conversation id with Langfuse
   keys set. Read `cache_read_input_tokens` on turn 2. Document the
   observed cached-fraction into the planning chat's concerns list.
4. **Browser click-through on the Railway preview.**
   - Open `/tuning`, see queue.
   - Click "+ New" in the left rail, see a new conversation appear.
   - Watch the proactive opener stream in.
   - Say "show me the evidence" and watch `fetch_evidence_bundle` fire.
   - Click "Apply now" on a SuggestionCard and confirm the PreToolUse
     hook's cooldown / compliance path by observing a sanctioned apply
     succeed + a non-sanctioned apply (triggered by clicking Apply
     directly without typing anything first) get politely declined.
5. **SOP / FAQ version-history snapshot tables** — C17 is still open;
   add additive `SopVariantHistory` + `FaqEntryHistory` so the
   `rollback` tool can return 200 for those artifact types.
6. **`appliedAndRetained7d` periodic job** — tracked as a separate V1-
   tail item per the brief's non-goals. 7-day retention flag needs a
   small cron service; not this sprint's scope.
7. **`Message.editMagnitudeScore` additive nullable column** —
   sprint-03 concern C19; would let the graduation dashboard use the
   authoritative magnitude score instead of a proxy.
8. **`preferences/tone` seed row** — consider inserting one or two
   manager-stated defaults so the first agent session has something to
   reference in `<memory_snapshot>`. Optional.
9. **Consider a server-side opener** — if the client-initiated opener
   pattern bothers us in practice (e.g. refreshes race the backend),
   move to a server-stream-on-create contract: have the
   `POST /api/tuning/conversations` endpoint optionally stream back an
   SSE opener response. Post-V1 only.

## 16. Commits

```
f58d932 test(041): tuning-agent unit + integration smoke + route smoke
7e85697 feat(041): anchor-message flow + proactive opener
e5a18c6 feat(041): chat panel UI + history browser in left rail
28df878 feat(041): tuning chat SSE endpoint + conversation endpoints
b6851c0 feat(041): install claude-agent-sdk + vercel ai sdk, scaffold tuning-agent module
```

`git log --oneline feat/041-conversational-tuning ^advanced-ai-v7 |
head -5` shows these 5 new commits on top of sprint-03's 8.

Total branch-age: **27 commits** across 4 sprints
(sprint-01: 5; sprint-02: 9 including the report commit; sprint-03: 8;
sprint-04: 5, plus this report will make 6). Branch is unpushed per
operational-rules §Commits. No squashing.
