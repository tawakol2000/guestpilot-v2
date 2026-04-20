# Conversational Tuning Agent — Vision

> **Working draft.** Source of truth for the end state. Updated as decisions are made.
> **Status:** In discussion (April 2026). Research pending: conversational agent layer, Cowork/managed-agent architecture.

## Scale assumptions (V1 intensive month)

- **Single user** — Abdelrahman, one manager, one tenant. Multi-user deferred until SaaS launch.
- **Edit volume** — ~20 edits/day expected, producing ~10 suggestions/day after taxonomy filtering and deduplication. Low-volume, chat-heavy UX (not triage UX).
- **Cost envelope** — expected <$20/day sustained. Model choice unconstrained by budget.
- **Clean-slate frontend** — existing `tuning-review-v5.tsx` is being thrown away. New tuning surface is built fresh, not an evolution of the old UI.

## The strategic bet

The tuning feature is what makes GuestPilot a shippable, sellable product. It's the difference between "an AI that works sometimes" and "an AI that gets better every day until it can run on its own."

The bet: **run the main AI in co-pilot mode for ~1 month of intensive use. During that month, the tuning agent compresses Abdelrahman's judgment into durable artifacts (system prompt, SOPs, FAQs, tool definitions). At the end of the month, the main AI is dialed-in enough to graduate to autopilot, and tuning usage tapers naturally.**

This reframes the tuning agent's job. It is not a suggestion feeder. It is a **meta-agent that reasons about the main AI with the manager, collaboratively**, and turns corrections into durable system improvements.

## End-state product

A separate surface inside the GuestPilot UI — `/tuning` — that feels like Claude Cowork on Opus 4.6. Long conversations, persistent memory across sessions, chat history as a first-class object, real tools the agent uses in front of the user, visible reasoning, and fluid "do it now" vs "queue for final review" per suggestion.

The tuning agent:
- Reads full evidence bundles (tool traces, retrieval context, property metadata, prior correction history) via tool calls, not pre-stuffed context
- Reasons about why the main AI answered the way it did
- Proposes concrete changes to the main AI's artifacts (system prompt, SOPs, FAQs, tool definitions) with diffs and rationale
- Applies changes on approval (immediately or queued), with version history and undo
- Remembers preferences, past decisions, and tenant-specific context across sessions
- Pushes back constructively — asks clarifying questions, surfaces conflicts with prior decisions, refuses to optimize in circles
- Eventually (post-MVP) proactively surfaces patterns it notices across many edits

The manager:
- Talks to the agent in long-form conversations, not one-shot prompts
- Can say "do it now" or "queue for final review" on any proposed change
- Can anchor a conversation to any message from the inbox ("why did the AI say this?")
- Can complain about a sent-and-unedited message retroactively
- Can scroll back through old tuning conversations, search them, reference them
- Sees a graduation dashboard tracking per-tenant readiness to move the main AI to autopilot

## Scope

### In scope (end-state)

- **Conversational tuning surface** — separate `/tuning` tab in the frontend with chat, sidebar queue, chat history browser
- **Tuning agent (Claude Agent SDK based)** — long-context agent with tool use, streaming, reasoning, memory; `ClaudeSDKClient` for multi-turn sessions with built-in persistence (`persist_session: true`, `resume: sessionId`)
- **Evidence bundles** — rich structured JSON produced on every triggering event, available to the agent via tool call
- **Agent tools — consolidated to ~8 core tools with `verbosity` enum** (concise / detailed) so the agent controls return size per call:
  - `get_context(type, id, verbosity)` — unified fetch for SOP, FAQ, property, reservation, conversation
  - `search_corrections(filters, verbosity)`
  - `fetch_evidence_bundle(triggerId)`
  - `propose_suggestion(category, payload, confidence, rationale)`
  - `suggestion_action(id, action, payload?)` — unified apply / queue / reject / apply-with-edit
  - `memory(op, args)` — Claude SDK memory tool (`memory_20250818`) backed by Postgres
  - `get_version_history(artifactType, artifactId)`
  - `rollback(versionId)`
  Rarely-used tools (e.g. cross-tenant search, batch apply) are discovered on-demand via Tool Search rather than always-loaded. Anthropic's own data shows 50+ always-loaded tools degrades accuracy (49% → 74% when moved to on-demand discovery).
- **SDK hooks as the home for cross-cutting logic** — `PreToolUse` for cooldown enforcement, oscillation detection, compliance checks; `PostToolUse` for Langfuse logging, acceptance stat updates, preference pair capture; `PreCompact` for injecting preference summaries so they survive context compaction; `Stop` for follow-up prompts. Hooks run outside the context window, consume no tokens, and cannot be prompt-injected around.
- **Durable memory via SDK memory tool backed by Postgres** — `memory_20250818` tool primitive where the agent issues `view`/`create`/`update`/`delete` commands; our implementation stores against the `AgentMemory` Prisma table. Gets SDK-native memory primitives without a Mem0 dependency.
- **Chat history** — tuning conversations stored as first-class objects with titles, timestamps, search, anchored message IDs
- **Trigger events** — edited copilot send, rejected-draft (draft replaced wholesale), manager-initiated complaint, thumbs-down on unedited send, cluster-triggered (post-MVP), escalation-triggered (post-MVP)
- **Suggestion lifecycle** — `PENDING` (queued for review), `APPLIED` (do-it-now), `REJECTED`, `SUPERSEDED`, with acceptance stats per category
- **Two dashboards, distinct audiences:**
  - **Tuning velocity dashboard** (lives in `/tuning`, for the manager) — three compounding signals: suggestion acceptance rate monotonically improving, new-suggestion-type volume decreasing over time (system captures common patterns early, tail slows), coverage increasing (% of conversations needing no edit). Answers "is the tuning loop healthy?"
  - **Graduation dashboard** (lives in operations view) — per-tenant: edit rate, edit magnitude, escalation rate, critical failures, rolling 14-day window. Answers "is the main AI ready to move to autopilot?"
- **Three-phase autopilot ramp** — shadow autopilot (AI sends, manager sees retroactively) → monitored autopilot (25% random sample review) → full autopilot
- **Feedback loop** — per-category acceptance rate tracking, distinct tracking of `applied` vs `applied_and_retained_7d` (applied suggestions still present after 7 days are stronger signal than applied-then-rolled-back), cooldown on same artifact, preference-pair logging for future DPO
- **Verbalized confidence** — agent self-rates confidence (0-1) on each suggestion; we track gap between stated confidence and actual acceptance rate (Platt-scaled for calibration). Avoids dependence on logprobs.
- **Pattern detection** — clustering past edits to propose generalized fixes (post-MVP, unlocks at data threshold)
- **Shadow evaluation** — before offering a suggestion, run the proposed config against recent conversations with an LLM judge to confirm the change wouldn't regress (post-MVP)
- **Safety rails** — version history on all artifacts, undo/rollback, oscillation detection (no reversing yesterday's decision without stronger evidence), edit quality scoring (detect low-quality manager edits so they don't train the agent), immutable brand rails
- **Evaluation** — golden dataset of representative conversations, regression testing on config changes, leading indicators (edit rate, quality scores) and lagging indicators (guest sentiment, reviews) tracked independently
- **Eventually** — autonomous background analysis, DPO fine-tuning loop, A/B testing per tenant, cross-tenant pattern learning (opt-in), embedded inline tuning next to the inbox

### Out of scope (forever, unless explicitly re-opened)

- Tuning the main AI's underlying *model weights*. We only tune prompts, SOPs, FAQs, tool definitions. No fine-tuning of gpt-5.4-mini itself.
- Multi-manager consensus inside a single tenant. For now, tuning agent assumes one manager's voice per tenant.
- Tuning cross-tenant without explicit opt-in and anonymization.

## Principles

1. **Evidence over inference.** The tuning agent should pull evidence via tool calls, not guess from truncated context. Rich evidence with a mid-tier model beats thin context with a reasoning model.
2. **Conversation is signal acquisition.** The chat is how we extract *why* a manager edited something, which is the highest-value signal we can get and one that no analyzer can infer from the diff alone.
3. **Graduation is the product.** The tuning agent exists to make itself less necessary. We track graduation readiness as a first-class metric.
4. **Per-tenant, not per-property.** The AI matches the property manager's style and rules, not each property's. Property-specific variation lives in SOP property overrides and property-scoped FAQs, not in separate tuning streams.
5. **Rigid backbone, fluid labels.** The diagnostic taxonomy (7 artifact-mapped categories + "no fix needed") is a locked enum. Sub-labels within each category are free-form and accumulate over time.
6. **Agentic search over semantic search.** Tools beat embeddings for GuestPilot's domain. The main AI already uses tool calls for SOP routing and it works. The tuning agent should do the same — scan past edits and artifacts via tool calls, not vector retrieval.
7. **Fluid apply vs. queue.** Every suggestion can be applied immediately on "yes" or queued for final review — manager's choice per suggestion, not a global mode.
8. **Human-in-the-loop forever for writes.** The agent never applies changes without explicit manager approval, even when confidence is high. Auto-apply is not a future feature; it is an anti-goal.
9. **Pre-wire for later, ship only what's credible today.** Backend schema and instrumentation include v2/v3 fields from day one (nullable). Forward-facing behaviors ship only when the data exists to make them credible.
10. **The tuning agent has a persona.** It is not the guest-facing AI. It is the manager's trainer — direct, willing to push back, willing to say "I don't know why you made that edit, tell me."

## The diagnostic taxonomy

Eight artifact-mapped categories + one abstain. Locked at the schema level (Prisma enum). Sub-labels within each category are free-form.

1. **SOP content wrong or missing** — the SOP for this status/category said the wrong thing or didn't cover this case. Fix: edit `SopVariant.content` or `SopPropertyOverride.content`.
2. **SOP routing wrong** — the classifier picked the wrong SOP; correct content existed elsewhere. Fix: edit `SopDefinition.toolDescription` or system prompt tool-selection logic.
3. **FAQ missing or wrong** — factual info the AI needed wasn't in any FAQ, or was but was incorrect. Fix: create/edit `FaqEntry` (global or property-scoped).
4. **System prompt issue** — tone, policy, reasoning, or conditional-branch behavior at the prompt level. Fix: edit `TenantAiConfig.systemPromptCoordinator` or `systemPromptScreening`.
5. **Tool configuration issue** — wrong tool called, right tool called wrong, tool description unclear, tool parameters misused. Fix: edit `ToolDefinition`.
6. **Missing capability** — AI needed a tool that doesn't exist. Fix path is a dev backlog item, NOT an artifact edit. Flagged for engineering review, not auto-applied. Creates a `CapabilityRequest` record.
7. **Property override needed** — content is right globally but this property is different; needs a `SopPropertyOverride` or property-scoped FAQ.
8. **No artifact fix needed** — edit was cosmetic, a typo fix, or manager preference that doesn't generalize. **First-class abstain path.** Logged for stats, no suggestion surfaced.

## Trigger events

- **Edited copilot send** — manager edited the AI's suggestion before sending. Current v1 trigger.
- **Rejected-draft** — manager replaced the AI's suggestion wholesale (semantic similarity < 0.3 between original and final). Stronger signal than an edit.
- **Manager-initiated complaint** — from the inbox or tuning surface, manager says "this was bad" about any past message (edited, unedited, sent, or not). Starts a tuning conversation anchored to that message.
- **Thumbs-down on unedited autopilot send** — lightweight "AI sent this and it was wrong" signal, especially valuable during monitored-autopilot phase.
- **Cluster-triggered** (post-MVP) — the agent itself opens a conversation when it notices a pattern across many edits.
- **Escalation-triggered** (post-MVP) — when the AI escalates to a human and the human's resolution differs substantially from what the AI was saying, that's a retroactive tuning signal.

## Graduation metric

Per-tenant, rolling 14-day window. Graduation to autopilot requires all of:

- Edit rate < 10% of AI responses
- Average edit magnitude < 20% of response text when edits occur
- Zero critical failures (policy violations, factual errors on property info) over 30 days
- Escalation rate ≤ 5%
- LLM-as-judge quality score ≥ 4.0/5.0 on golden-set regression (post-MVP, when golden set exists)
- Minimum 200 conversations in the measurement window
- Statistical confidence p < 0.05 (SPRT / sequential analysis)

Three-phase ramp:

1. **Shadow autopilot** — AI sends automatically, manager sees every message within minutes, can intervene retroactively.
2. **Monitored autopilot** — manager reviews 25% random daily sample + all escalations.
3. **Full autopilot** — daily summary dashboard, weekly random audit, automatic regression rollback.

The phase transition itself is a separate feature that builds on the graduation metric. The tuning feature ships the *metric and dashboard*; the phase mechanics are a follow-on build.

## Architecture — high level

- **Backend runtime:** Claude Agent SDK TypeScript (`@anthropic-ai/claude-agent-sdk`) on Node.js, orchestrating the tuning agent loop via `ClaudeSDKClient`. Tools defined as in-process MCP servers with Zod schemas (`createSdkMcpServer({ tools: [...] })`). Hooks (`PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`) handle cross-cutting logic. `include_partial_messages: true` for streaming.
- **Streaming protocol:** SSE via Vercel AI SDK's `toUIMessageStreamResponse()`. Reasoning parts, tool calls, and custom data parts (typed, reconcilable by ID) flow through the same stream. Transient parts (`transient: true`) for progress indicators that don't persist in history.
- **System prompt structure:** XML-tagged sections (`<tuning_persona>`, `<taxonomy>`, `<artifact_reference>`, `<suggestion_flow>`, `<pending_context>`) with a `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` cache marker separating static (persona, taxonomy, tool docs, principles) from dynamic (current suggestions, memory, session state). Static content cached for ~80% input token savings on repeated calls. Includes anti-sycophancy directive ("never open with 'great question'") and refuse-without-lecturing refusal pattern, both copied from leaked Claude production prompts.
- **Deployment:** shipped as routes inside the existing backend service on Railway for V1 (faster to iterate, shared Prisma client, shared auth). Scale-up path when runtime contention appears: **Anthropic Managed Agents API** ($0.08/session-hour hosted runtime with append-only event log and `wake(sessionId)` crash recovery) is the preferred migration, not splitting into another self-managed Railway service. Not a V1 concern.
- **Frontend:** Next.js 16 route at `/tuning`. **Vercel AI SDK 6** via `@ai-sdk/react`'s `useChat()` hook and `@ai-sdk/anthropic` provider. Message `parts[]` typed objects (`text`, `tool-*`, `reasoning`, `data-*`) rendered as dedicated components: `<SuggestionCard>`, `<DiffPreview>`, `<EvidenceInline>`, `<ThinkingSection>` (collapsible reasoning). Chat panel, sidebar queue of pending suggestions, chat history browser, anchor-message context panel.
- **Data model:** New Prisma models — `TuningConversation` (with optional `anchorMessageId`, `sdkSessionId` for Agent SDK resume, `userId`, `status`, `title`), `TuningMessage` (role, Json content parts, metadata), `AgentMemory` (tenant/property/key scoped Markdown content), `EvidenceBundle` (structured JSON snapshot on each trigger), `CapabilityRequest` (MISSING_CAPABILITY outputs), `PreferencePair` (DPO pre-wiring). Extends existing `TuningSuggestion` with `applyMode` (`IMMEDIATE` | `QUEUED`), `conversationId` back-reference, `confidence`, `appliedAndRetained7d` (computed flag), nullable `editEmbedding` (pre-wiring for D1). Reuses existing `AiConfigVersion`, `SopVariant`, `FaqEntry`, `ToolDefinition`.
- **Observability:** **Langfuse Cloud** as the trace/span/session store. Every main-AI run emits OpenInference-compatible spans. Tuning agent tool calls logged via `PostToolUse` hook (not from application code). Evidence bundles assembled from Langfuse traces + Prisma state.
- **Model choice:** Claude Sonnet 4.6 for the conversational tuning agent (upgrade to Opus for complex multi-artifact diagnostic sessions via dynamic model switching). Keep GPT-5.4-mini for the main guest-messaging AI. Different model families for judge-vs-judged avoids self-enhancement bias.

## The suggestion-then-chat flow

Suggestions are computed *before* the chat opens, not inside it. Flow:

1. Trigger event fires (edit, complaint, thumbs-down, rejected draft)
2. Background analyzer pipeline (lexical diff → semantic classification → LLM diagnostic call with evidence bundle) produces one or more `TuningSuggestion` records with `status=PENDING`, confidence score, rationale, and proposed diff
3. Manager opens `/tuning` — sidebar queue shows pending suggestions grouped by trigger event
4. Manager can:
   - **Accept directly from queue** without opening chat — for suggestions obvious enough that no discussion is needed
   - **Open chat** anchored to one or more suggestions — agent's opening message references the pending items ("We have 3 suggestions on the table. The biggest one is X — want to start there, or somewhere else?")
   - **Open chat without anchor** — free-form "why did the AI do Y" questions
5. Inside the chat, manager can reference, modify, accept, reject, or queue any pending suggestion. The agent can also propose *new* suggestions mid-conversation as it learns from the discussion.
6. The chat is a *collaboration layer on top of* pre-computed suggestions, not a replacement for them.

This means lazy-day usage is possible — manager opens `/tuning`, sweeps the queue, accepts/rejects without chatting. And deep-investigation usage is possible — manager opens chat to unpack one specific suggestion. Both paths use the same underlying suggestion records.

## What "done" looks like

A manager can:

- Open `/tuning` and see a prioritized queue of recent triggers
- Click any trigger to start a conversation anchored to that specific edit/message
- Ask the agent "why did the AI say X?" and have it fetch evidence, explain the root cause, and propose a specific artifact fix
- Apply the fix immediately, queue it for final review, reject it, or edit-then-accept
- Revisit any past tuning conversation, search by keyword, re-read decisions
- See per-tenant graduation readiness and trend in a dashboard
- Trust the system enough to move the main AI through shadow → monitored → full autopilot

And the tuning agent:

- Pulls richer evidence than the current analyzer sees
- Routes fixes to the right artifact using the 7-category taxonomy
- Learns preferences and stores them durably
- Never repeats the same rejected suggestion
- Detects oscillation and refuses to reverse yesterday's accepted decisions without strong new evidence
- Gets measurably better at suggestion acceptance rate over the intensive month
