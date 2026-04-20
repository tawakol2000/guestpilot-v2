# Conversational Tuning Agent — Roadmap

> **Working draft.** Sequencing doc. Thresholds, not dates.
> **Status:** In discussion. Will be refined after research 2 and 3 land.

## Phasing principle

V1 includes everything *useful on day one with zero data*. V2 and V3 items unlock at explicit data/usage thresholds. Backend instrumentation for V2/V3 ships in V1 (pre-wiring), but user-facing behaviors ship only when they can be accurate.

## V1 — "MVP that I use for the intensive month"

**Goal:** Ship a conversational tuning surface that is good enough to run for one intensive month and meaningfully improve the main AI's artifacts over that month.

**Target ship date:** 2 weeks from sprint-zero kickoff. Aggressive — expect trade-offs. Chat is last to land and is the cut-line if timeline slips.

**Build sequence within V1:**

1. **Days 1-3: Evidence infrastructure + schema**
   - Langfuse Cloud project set up, OpenInference spans emitted on every main-AI call (tool params, returns, retrieval context, classifier decisions)
   - Evidence bundle assembler service that enriches each trigger event with full trace + Hostaway entity metadata + prior correction history
   - Prisma schema migration: `TuningConversation`, `TuningMessage`, `AgentMemory`, `EvidenceBundle`, `CapabilityRequest`, `PreferencePair`; extend `TuningSuggestion` with `applyMode`, `conversationId`, `confidence`, nullable `editEmbedding`
   - `AiConfigVersion`-style version history extended to `SopVariant`, `FaqEntry`, `ToolDefinition` if not already present
   - Tear out old `tuning-review-v5.tsx` and old two-step analyzer; delete dead code

2. **Days 4-6: Taxonomy + analyzer pipeline**
   - 8-category taxonomy Prisma enum: `SOP_CONTENT`, `SOP_ROUTING`, `FAQ`, `SYSTEM_PROMPT`, `TOOL_CONFIG`, `MISSING_CAPABILITY`, `PROPERTY_OVERRIDE`, `NO_FIX`
   - Diagnostic pipeline: lexical diff (Myers) → semantic magnitude classification → single LLM diagnostic call with full evidence bundle, outputting structured JSON with category, sub-label, confidence (verbalized), rationale, proposed diff
   - Trigger wiring: edited copilot send, rejected-draft (semantic similarity <0.3 between original and final), manager-initiated complaint, thumbs-down on unedited send
   - Acceptance/rejection event logging; per-category EMA acceptance rate (α=0.3); cooldown (48h) registry

3. **Days 7-9: Tuning surface (non-chat parts first)**
   - New `/tuning` Next.js route, clean slate
   - Sidebar queue of pending `TuningSuggestion` records grouped by trigger event with confidence/category/rationale
   - Accept-from-queue flow: `IMMEDIATE` apply or `QUEUED` pending; diff preview modal; one-click accept/reject/edit-then-accept
   - Version history view with rollback per artifact
   - Tuning velocity dashboard v1: acceptance rate trend, new-suggestion-type volume trend, coverage (unedited-AI-response rate)
   - Graduation dashboard v1: edit rate, edit magnitude, escalation rate (per-tenant, 14d rolling)

4. **Days 10-14: Conversational agent**
   - Claude Agent SDK integration: `ClaudeSDKClient` with `persist_session: true`, `include_partial_messages: true`
   - In-process MCP server registering ~8 consolidated tools with `verbosity` enum (`get_context`, `search_corrections`, `fetch_evidence_bundle`, `propose_suggestion`, `suggestion_action`, `memory`, `get_version_history`, `rollback`); rare tools behind Tool Search
   - SDK hooks: `PreToolUse` (cooldown + oscillation + compliance), `PostToolUse` (Langfuse + acceptance stats + preference pair capture), `PreCompact` (inject memory summary), `Stop` (follow-up prompt)
   - Memory: SDK `memory_20250818` tool backed by Postgres `AgentMemory`
   - System prompt assembly: XML-tagged sections with `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` cache boundary; static (persona, taxonomy, tool docs, principles including anti-sycophancy + direct-refusal) before boundary; dynamic (pending suggestions, memory snapshot, session state) after
   - Frontend chat panel via Vercel AI SDK `useChat()` + `@ai-sdk/anthropic`; SSE stream; `<SuggestionCard>`, `<DiffPreview>`, `<EvidenceInline>`, `<ThinkingSection>` components
   - Proactive opener: on conversation create, agent greets with pending-suggestion summary ("We have N suggestions. The biggest one is X — want to start there?")
   - Anchor-message flow: inbox gets "discuss in tuning" button that creates a `TuningConversation` with `anchorMessageId` set
   - Chat history browser in sidebar with title, timestamp, search
   - Prompt caching confirmed working via Langfuse token counts

**Scope:**

- Separate `/tuning` surface in the frontend with chat, sidebar queue, chat history browser
- Tuning agent built on Claude Agent SDK, Claude Sonnet 4.6 tier
- Rich evidence bundles assembled on every trigger event
  - Full tool-call traces (params and return values)
  - Retrieval context (what was pulled, relevance signals where available)
  - Classifier routing decisions with alternatives where available
  - Hostaway entity metadata (reservation, property, guest)
  - Prior correction history for the property/category
  - System prompt version + conditional branch taken
- Agent tools: `fetch_evidence_bundle`, `search_corrections`, `get_conversation`, `get_sop`, `get_faq`, `get_property`, `get_reservation`, `propose_suggestion`, `apply_suggestion`, `queue_suggestion`, `remember_preference`, `get_preferences`, `get_suggestion_stats`, `get_version_history`, `rollback`
- Agent memory (Postgres): durable preferences, facts, past decisions, tenant-scoped
- Chat history: `TuningConversation` and `TuningMessage` as first-class objects with titles, timestamps, search, optional `anchorMessageId`
- Trigger events: edited copilot send, rejected-draft (wholesale replacement), manager-initiated complaint, thumbs-down on unedited send
- 7-category diagnostic taxonomy (Prisma enum) + first-class "no fix needed" abstain path
- Suggestion lifecycle: `APPLIED` (immediate), `QUEUED` (pending review), `REJECTED`, `SUPERSEDED`
- Per-category acceptance rate tracking (EMA α=0.3)
- Cooldown on same artifact element (48h) to prevent oscillation
- Version history on all writes (already exists for system prompts; extend to SOPs, FAQs, tool defs)
- Basic undo/rollback
- Graduation dashboard (per-tenant): edit rate, edit magnitude, escalation rate, acceptance rate, rolling 14-day window
- Langfuse adopted for observability; main AI emits OpenInference-compatible spans
- Pre-wiring (schema present, behavior dormant): `edit_embedding` nullable column, `PreferencePair` table, `experimentId` on `AiConfigVersion`, cluster-trigger and escalation-trigger enum values, agent-as-initiator conversation flow

**Success criteria:**

- Agent consistently routes suggestions to the correct artifact category (>80% agreement with manager review)
- Suggestion acceptance rate trends upward over the month
- Edit rate on the main AI trends downward over the month
- Agent remembers preferences across sessions and doesn't repeat rejected suggestions

**Explicitly NOT in V1:**

- HDBSCAN clustering (deferred D1)
- DPO fine-tuning (D2)
- Shadow evaluation before surfacing (D3)
- A/B testing (D4)
- Autonomous cluster-triggered openings (D5)
- Escalation-triggered events (D6)
- Thompson Sampling (D7)
- Cross-tenant learning (D8)
- Inline-in-inbox tuning (D9)
- Vector search (D10)
- Custom judge model (D11)
- Multi-agent (D12)

## V2 — "The agent gets proactive"

**Goal:** Agent stops being purely reactive. Detects patterns, proposes generalized fixes, shadow-evaluates before surfacing.

**Unlock triggers (ALL required):**

- 200+ tagged edit events in the system
- 4+ calendar weeks of continuous V1 use
- V1 acceptance rate data exists per category
- At least one tenant has completed the intensive month and is in shadow or monitored autopilot phase

**Scope adds:**

- HDBSCAN clustering pipeline running nightly (unlocks D1)
- Cluster-triggered proactive agent openings (unlocks D5)
- Shadow evaluation gating on proposed changes (unlocks D3, once a tenant has a golden set)
- Escalation-triggered events (unlocks D6, if escalation resolution flow has been structured)
- Preference pair accumulation becomes visible in dashboards (prep for D2)
- Per-category confidence gating: suggestion types with <30% acceptance require higher evidence before surfacing

## V3 — "Productized, multi-tenant, compounds over time"

**Goal:** Tuning is a differentiator visible to customers. Compounding improvements across tenants and properties.

**Unlock triggers (ALL required):**

- Multiple tenants live (>3)
- >500 preference pairs per tenant OR single-tenant with strong DPO signal
- Cross-tenant product decision made
- Graduation metric proven (at least one tenant has successfully graduated to full autopilot)

**Scope adds:**

- DPO fine-tuning loop (D2, if needed)
- A/B testing per tenant (D4)
- Thompson Sampling suggestion ranking (D7)
- Cross-tenant pattern learning with opt-in (D8)
- Inline-in-inbox tuning surface (D9, once agent trust is established)
- Multi-agent architecture (D12, only if single agent hits limits)
- Custom judge model (D11, only if cost/accuracy justifies it)

## Never (unless explicitly re-opened)

- Auto-apply without manager approval (D13)
- Fine-tuning the main guest-messaging AI's model weights (D14)
- Embeddings over dynamic guest messages for hot-path retrieval (D10)
