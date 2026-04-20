# Conversational Tuning Agent — Deferred Decisions

> **Working draft.** Internal source of truth for what we chose to NOT do now, and why.
> **Purpose:** Prevent "v1 ships, v2 never happens." Every deferred item has an explicit unlock trigger.
> **Status:** In discussion. Updated as decisions are made.

## How to read this doc

Each entry has:
- **What** — the thing we're not doing now
- **Why deferred** — real reason, not "scope"
- **Unlock trigger** — the specific data point, date, or condition that flips it on
- **Pre-wiring in v1** — what we build now so v2 isn't a retrofit
- **Estimated effort when unlocked**

## Deferred items

### D1. HDBSCAN edit clustering

- **What:** Nightly clustering of past edits to detect recurring patterns ("you've corrected parking info 6 times this week").
- **Why deferred:** Needs 4+ weeks of edit data and enough volume for clusters to form (200+ tagged edits, 3+ categories). Before that, clustering fires on noise and destroys agent trust.
- **Unlock trigger:** 200+ edit events logged with taxonomy tags AND 4+ calendar weeks of data.
- **Pre-wiring in v1:**
  - Every edit event logs full metadata (taxonomy category, sub-label, artifact target, property ID, timestamp)
  - Edit-description text stored in a dedicated field, not concatenated into JSON
  - Nullable `edit_embedding` column on the trigger event table (we won't populate it in v1 but the column exists)
- **Effort when unlocked:** 3-5 days (embedding generation, HDBSCAN pipeline, cluster labeling, proactive agent opening)

### D2. DPO fine-tuning from reject-and-edit pairs

- **What:** Fine-tune a diagnostic classifier using accumulated (context, rejected-suggestion, preferred-human-edit) preference pairs.
- **Why deferred:** Needs 500+ clean preference pairs minimum. Without that volume, DPO overfits or adds no signal over prompt engineering. Also: we may never need it if prompt-level improvements are sufficient.
- **Unlock trigger:** 500+ preference pairs AND current analyzer acceptance rate < 60% despite prompt iteration.
- **Pre-wiring in v1:**
  - Every reject and every edit-then-accept stores the full triple (context, original_suggestion, final_applied_content) in a `PreferencePair` table
  - Timestamped and tagged so we can filter/clean later
- **Effort when unlocked:** 1-2 weeks (data cleaning, DPO pipeline, evaluation harness, deployment)

### D3. Shadow evaluation before surfacing suggestions

- **What:** Before the agent proposes a config change, run the proposed change against recent conversations with an LLM judge to confirm no regression.
- **Why deferred:** Requires a judge model and a golden-set of recent conversations per tenant. For one manager in the intensive month, there isn't enough volume to make shadow eval statistically meaningful, and it slows down the proposal loop.
- **Unlock trigger:** Golden-set of 100+ representative conversations per tenant exists AND multiple tenants are onboarded (>1 real customer).
- **Pre-wiring in v1:** None needed — proposal/apply flow is stateless enough to insert shadow eval later.
- **Effort when unlocked:** 1 week (judge prompt suite, golden-set builder, eval runner, gating logic)

### D4. A/B testing per tenant

- **What:** Canary deployments of config changes against 5% of traffic with automated rollback on metric regression.
- **Why deferred:** Meaningless at 1-tenant scale. Needs traffic volume and multiple parallel conversations to compare.
- **Unlock trigger:** Multiple tenants live AND >500 conversations/day aggregate.
- **Pre-wiring in v1:**
  - `AiConfigVersion` already exists; extend with nullable `experimentId` and `trafficPercent`
  - Feature flag system in place (evaluate LaunchDarkly AI Configs or GrowthBook)
- **Effort when unlocked:** 2 weeks (experiment framework, routing, metric collection, auto-rollback)

### D5. Autonomous background analysis (cluster-triggered agent openings)

- **What:** The tuning agent proactively opens conversations when it notices a pattern, without manager initiating.
- **Why deferred:** Depends on D1 (clustering). Without real clusters, proactive openings are noise.
- **Unlock trigger:** D1 unlocked AND cluster quality validated (manager accepts cluster-triggered conversations at >50% rate).
- **Pre-wiring in v1:**
  - `TuningConversation.trigger_type` enum includes `CLUSTER_TRIGGERED` from day one
  - Conversation creation flow supports agent-as-initiator
- **Effort when unlocked:** 3-4 days (proactive opener logic, queue management, user-facing notification pattern)

### D6. Escalation-triggered tuning events

- **What:** When AI escalates to human and human's resolution message differs substantially from what AI was saying, auto-create a tuning trigger.
- **Why deferred:** Requires careful diff logic to avoid triggering on every escalation. Also requires escalation resolution flow to be more structured than it is.
- **Unlock trigger:** Escalation resolution flow has structured fields (resolution message, resolution outcome). Today escalations are free-form.
- **Pre-wiring in v1:** `TuningConversation.trigger_type` enum includes `ESCALATION_TRIGGERED` from day one.
- **Effort when unlocked:** 2-3 days (escalation watcher, semantic diff, trigger creation)

### D7. Thompson Sampling for suggestion prioritization

- **What:** Rank suggestion types by acceptance probability using Beta(α, β) distributions, sample at each opportunity.
- **Why deferred:** Needs per-category acceptance rate data. Also, at one-manager scale, simple EMA (α=0.3) is indistinguishable in practice.
- **Unlock trigger:** 100+ suggestions per category per tenant AND multiple suggestion categories competing for attention (review queue regularly >10 items).
- **Pre-wiring in v1:**
  - Per-category accept/reject counts tracked from day one
  - Suggestion ranking is a pluggable function in code (ranking algorithm behind an interface)
- **Effort when unlocked:** 2-3 days (Thompson Sampling implementation, swap in for EMA)

### D8. Cross-tenant pattern learning

- **What:** Identify patterns that generalize across tenants ("luxury properties in Gulf region all need X"), propose with explicit opt-in and anonymization.
- **Why deferred:** Privacy-sensitive. Requires multi-tenant scale. Product decision not yet made.
- **Unlock trigger:** 10+ tenants live AND explicit product decision to enable cross-tenant learning with opt-in UI and legal review.
- **Pre-wiring in v1:** Every record is strictly tenant-scoped. No leakage possible. Evidence bundles never include cross-tenant data.
- **Effort when unlocked:** 4-6 weeks (anonymization pipeline, opt-in UI, cross-tenant clustering, legal review, surfacing UI)

### D9. Embedded inline tuning (in the inbox, not separate surface)

- **What:** Tuning agent chimes in inline while manager is replying to guests, instead of in a separate `/tuning` surface.
- **Why deferred:** Agreed separate surface is right for now. Embedded is polish once the agent is trusted.
- **Unlock trigger:** Separate tuning surface has steady usage AND agent has >70% suggestion acceptance rate (trust signal) AND graduation metric shows main AI stabilizing.
- **Pre-wiring in v1:**
  - Agent logic is decoupled from UI — same agent serves a future inline surface
  - Agent tools return structured responses renderable in either surface
- **Effort when unlocked:** 1-2 weeks (inline UI component, placement logic, non-intrusive notification pattern)

### D17. Mem0 / Zep / Letta as external memory service

- **What:** Replace our SDK-memory-tool-backed-by-Postgres approach with a dedicated memory platform (Mem0 benchmarks 26% higher accuracy and 91% lower p95 latency vs hand-rolled; Zep adds temporal knowledge graphs; Letta is a full agent runtime).
- **Why deferred:** Claude Agent SDK's native `memory_20250818` tool backed by our Postgres `AgentMemory` table gives us SDK-native memory primitives without a new dependency. Good enough for one user / one tenant.
- **Unlock trigger:** Memory recall quality becomes a measured bottleneck (agent regularly fails to surface relevant prior decisions, or latency on memory reads impacts chat UX).
- **Pre-wiring in v1:** Memory access goes through the SDK tool, not directly through Prisma. Swapping the backend from Postgres to Mem0/Zep is a tool-handler change, not an application-wide rewrite.
- **Effort when unlocked:** 3-5 days (Mem0 or Zep integration, migration of existing preferences, tuning the `add` / `search` surfaces).

### D10. Vector search / pgvector / embeddings on dynamic user-facing content

- **What:** Embeddings over guest messages, inbound queries, or any dynamic/multilingual user text used for real-time retrieval (e.g. matching a guest message to the right SOP via cosine similarity).
- **Why deferred:** Previous production attempt — embedding guest messages and injecting the best-match SOP — failed because guest messages are too dynamic (multilingual, typos, slang, implicit context). The system moved to tool calling for SOP routing and it works. Principle: agentic search over semantic search for dynamic inbound content.
- **What is NOT ruled out:** Embeddings over *static, internal, well-structured* content can still be valuable and is considered case-by-case. Examples: edit-diff clustering (D1), tuning-conversation history search, SOP/FAQ retrieval for the tuning agent's own browsing (different from guest-facing retrieval). These are post-hoc analytics or internal tooling, not hot-path guest message matching.
- **Unlock trigger for dynamic inbound use:** Tool-call-based retrieval for the tuning agent proves insufficient AND we've exhausted prompt/tool improvements. Not expected.
- **Pre-wiring in v1:** None for hot-path retrieval. Internal embedding usage (D1 clustering) is evaluated on its own merits when that unlock triggers.
- **Effort when unlocked:** Varies by use case.

### D11. Fine-tuning a domain-specific judge model (Prometheus-2 or similar)

- **What:** Self-hosted judge model fine-tuned on GuestPilot evaluation data.
- **Why deferred:** Frontier-model-as-judge with good rubrics is sufficient for current scale. Fine-tuning is a big ops lift (training infra, serving, versioning) with marginal gains until scale.
- **Unlock trigger:** Judge costs exceed $5k/month AND frontier-model-as-judge accuracy plateaus below 80%.
- **Pre-wiring in v1:** Judge is behind a service interface — can swap implementations without changing callers.
- **Effort when unlocked:** 3-4 weeks (data prep, training, eval, serving infra)

### D12. Multi-agent architecture (planner + specialists + synthesizer)

- **What:** Decompose complex tuning requests across multiple specialist agents (SOP specialist, FAQ specialist, prompt specialist) with a planner and synthesizer on top.
- **Why deferred:** Single-agent with good tools handles everything today's scope requires. Multi-agent adds complexity that we pay for only when the single agent hits its limits.
- **Unlock trigger:** Single agent context fills regularly AND suggestion quality drops on complex multi-artifact diagnostic sessions.
- **Pre-wiring in v1:** Agent is built on Claude Agent SDK which supports subagents natively. Migration path exists.
- **Effort when unlocked:** 2-3 weeks (subagent design, coordination, evaluation)

### D13. Auto-apply high-confidence suggestions without manager approval

- **What:** At very high confidence, apply changes without asking.
- **Why deferred:** Anti-goal, not a deferral. See vision.md principle #8. Human-in-the-loop for writes, forever.
- **Unlock trigger:** None. Do not re-open without explicit product decision.

### D15. Multi-user collaboration on tuning

- **What:** Multiple team members reviewing suggestions, commenting on each other's decisions, shared chat threads, attribution.
- **Why deferred:** Today it's one manager. Multi-user is a SaaS-era concern.
- **Unlock trigger:** SaaS launch AND first customer with >1 manager seat.
- **Pre-wiring in v1:** Every record has `userId` attribution even though there's only one user today. `TuningConversation.participants` table exists as a one-row table today; becomes many-to-many later.
- **Effort when unlocked:** 2-3 weeks (permissions, collaboration UI, notifications, attribution rendering)

### D16. Scale-up agent runtime hosting

- **What:** Move the agent runtime off the shared Railway backend when runtime contention appears.
- **Why deferred:** Shared backend is fine for one user / one tenant. Splitting adds ops cost without benefit.
- **Unlock trigger:** Runtime contention — agent streams starve the main API, long sessions cause memory pressure, or deploys of one affect the other.
- **Two scale-up paths, in order of preference:**
  1. **Anthropic Managed Agents API** (public beta as of April 2026, `managed-agents-2026-04-01` header). $0.08/session-hour hosted runtime with durable append-only event log, `wake(sessionId)` crash recovery, and clean separation of stateless orchestration ("brain") from execution ("hands"). Preferred because Anthropic handles container orchestration and session durability, and our code stays mostly the same (Agent SDK is compatible with the Managed Agents primitives).
  2. **Independent Railway service.** Fallback if Managed Agents isn't a fit (e.g. networking constraints, compliance, or cost at high session-hour volume).
- **Pre-wiring in v1:** Agent code lives in its own module directory (`backend/src/tuning-agent/`) with a clean internal API. Session state persists via SDK's `persist_session` + our Postgres `sdkSessionId` column, so handing the session off to another runtime is mechanical.
- **Effort when unlocked:** 3-5 days to migrate to Managed Agents; 5-7 days if we go the Railway-split route.

### D14. Fine-tuning the main guest-messaging AI's model weights

- **What:** Fine-tune gpt-5.4-mini itself.
- **Why deferred:** Anti-goal. We tune prompts, SOPs, FAQs, tool definitions. Model weights are not our lever.
- **Unlock trigger:** None. Do not re-open without explicit product decision.

## Notes on principles that shape this list

1. **Pre-wire for later is cheap; retrofitting is expensive.** V1 carries nullable schema fields, structured logs, and service-interface boundaries so every deferred item is a flip, not a rebuild.
2. **Forward-facing behaviors need credibility.** Backend/schema pre-wiring ships silently. User-facing proactive behaviors (cluster openings, shadow eval gating) ship only when the data exists to make them accurate, because a wrong-but-visible behavior destroys trust faster than a missing feature.
3. **Thresholds, not dates.** Deferred items unlock at data or product milestones, not calendar dates. "4 weeks" is a guess; "200 tagged edits" is a fact.
