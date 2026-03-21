# Feature Specification: OpenAI GPT-5.4 Mini Migration

**Feature Branch**: `014-openai-migration`
**Created**: 2026-03-22
**Status**: Draft
**Input**: Migrate the entire AI pipeline from Anthropic Claude (Haiku 4.5) to OpenAI GPT-5.4 Mini using the Responses API, with optimized prompt caching, reasoning effort control, and structured outputs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - AI Pipeline Continues Working on New Model (Priority: P1)

When a guest sends a message, the AI pipeline processes it through the new model provider and returns an accurate, contextual response. The guest experience is identical or better — same persona (Omar), same SOP-guided responses, same multilingual support, same escalation behavior. The operator sees no difference in message quality. This is a transparent backend migration.

**Why this priority**: Without the core pipeline working, nothing else matters. Every other story depends on this.

**Independent Test**: Send guest messages via sandbox covering all 22 SOP categories. Verify correct classification, SOP retrieval, and response quality. Compare response accuracy with the previous model.

**Acceptance Scenarios**:

1. **Given** a guest sends a message about a broken dishwasher, **When** the AI processes it, **Then** it classifies as "sop-maintenance" and responds following the maintenance SOP — identical behavior to the previous model
2. **Given** a guest sends a message in Arabic, **When** the AI processes it, **Then** it responds in Arabic with the same tone and accuracy
3. **Given** a guest asks for towels AND the WiFi password, **When** the AI processes it, **Then** it correctly identifies both intents and addresses both
4. **Given** the AI model API is temporarily unavailable, **When** a guest message arrives, **Then** the system retries with exponential backoff and eventually escalates if all retries fail
5. **Given** a manager has sent manual messages in the conversation, **When** the AI processes the next guest message, **Then** it sees the full conversation history including manual messages (no threading dependency)

---

### User Story 2 - Optimized Prompt Caching Per Tenant (Priority: P1)

Each tenant gets two persistent cache slots — one for the screening agent and one for the guest coordinator. The prompt structure is ordered so static content (tool definitions, system instructions, few-shot examples) comes first and dynamic content (property context, conversation history, current message) comes last. This maximizes cache hit rates across all conversations for that tenant.

**Why this priority**: Caching is the primary cost optimization. Without it, per-message costs increase 10x. Tied with US1 as both are needed for production viability.

**Independent Test**: Send multiple messages across different properties for the same tenant. Verify via API response headers or logging that cache hits occur on the static prefix after the first message.

**Acceptance Scenarios**:

1. **Given** a tenant's first guest message is processed, **When** subsequent messages arrive for the same agent type, **Then** the static prefix (tools + instructions + examples) is served from cache
2. **Given** two different properties under the same tenant, **When** messages arrive for both, **Then** they share the same cache for their agent type (cache key is tenant+agent, not property)
3. **Given** 30 minutes pass without messages for a tenant, **When** a new message arrives, **Then** the cache is still warm (24-hour retention)
4. **Given** the system prompt is updated in Configure AI, **When** the next message is processed, **Then** the cache naturally refreshes with the new prompt (no manual cache invalidation needed)

---

### User Story 3 - Intelligent Reasoning Control (Priority: P2)

The system adjusts AI reasoning effort based on the task complexity. SOP classification uses no reasoning (fast, cheap). Standard guest Q&A uses no reasoning. Complex scenarios (booking modifications, billing disputes, escalation decisions) use low reasoning for more careful analysis.

**Why this priority**: Reasoning tokens are billed as output tokens. Without control, unnecessary reasoning inflates costs. But some scenarios genuinely benefit from reasoning.

**Independent Test**: Send a simple greeting (should use no reasoning) and a complex booking modification request (should use low reasoning). Verify via logs that reasoning effort differs.

**Acceptance Scenarios**:

1. **Given** a guest says "hi", **When** the classification call runs, **Then** no reasoning tokens are generated
2. **Given** a guest requests a complex date change with pricing questions, **When** the response call runs, **Then** low reasoning is used for the response
3. **Given** the system processes 100 messages, **When** checking the logs, **Then** at least 80% of messages used no reasoning (cost optimization)

---

### User Story 4 - Model Selection in Operator Dashboard (Priority: P2)

Operators can select which AI model powers their tenant from the Configure AI page. Options include the primary model and alternative tiers (more capable but expensive, or cheaper but less capable). The current model and per-message cost estimate are displayed.

**Why this priority**: Gives operators control over cost vs quality tradeoff. Some tenants may want the cheapest option, others may want premium quality.

**Independent Test**: Change model selection in Configure AI → send a sandbox message → verify the response came from the selected model.

**Acceptance Scenarios**:

1. **Given** an operator opens Configure AI, **When** they view model settings, **Then** they see the current model, available alternatives, and estimated per-message cost for each
2. **Given** an operator selects a different model tier, **When** they save, **Then** subsequent AI responses use the new model
3. **Given** a model tier is selected, **When** messages are processed, **Then** the cost tracking accurately reflects the pricing of the selected model

---

### User Story 5 - Updated Cost Tracking and Observability (Priority: P2)

All AI API logs accurately reflect the new model's pricing, token counts, and response metadata. The pipeline view shows the correct model name, cached vs uncached token breakdown, reasoning tokens used, and classification details. The OPUS daily audit report uses the correct cost calculations.

**Why this priority**: Operators need accurate cost visibility. Without updated tracking, cost dashboards show incorrect data.

**Independent Test**: Process several messages, then check the pipeline view and OPUS report. Verify model name, token counts, and cost calculations are correct.

**Acceptance Scenarios**:

1. **Given** a message is processed, **When** viewing the pipeline log, **Then** it shows the correct model name, input/output/cached token counts, and calculated cost
2. **Given** reasoning was used on a message, **When** viewing the log, **Then** reasoning tokens are shown separately from output tokens
3. **Given** the daily audit report runs, **When** viewing it, **Then** cost calculations use the correct per-token pricing for the active model

---

### User Story 6 - Concise Response Control (Priority: P3)

Guest responses are concise and chat-appropriate — 1-3 sentences for routine messages. The system uses built-in verbosity control to prevent unnecessarily long responses without relying solely on prompt instructions.

**Why this priority**: Nice-to-have polish. Prompt instructions already handle this, but native verbosity control is more reliable.

**Independent Test**: Send routine messages (WiFi password, check-in time). Verify responses are 1-3 sentences, not paragraphs.

**Acceptance Scenarios**:

1. **Given** a guest asks for the WiFi password, **When** the AI responds, **Then** the response is 1-3 sentences maximum
2. **Given** a guest asks a complex question requiring detail, **When** the AI responds, **Then** it provides adequate detail without being unnecessarily verbose

---

### User Story 7 - Streaming AI Responses (Priority: P2)

When the AI generates a response, the text streams to the guest's conversation in real-time instead of waiting for the full response. The operator sees the text appear word-by-word in the inbox, and the guest perceives near-instant response. This replaces the current "typing..." indicator with actual content streaming.

**Why this priority**: Significant UX improvement. Reduces perceived latency from seconds (wait for full response) to milliseconds (first word appears immediately). The new AI provider supports native streaming.

**Independent Test**: Send a sandbox message. See text appear word-by-word instead of all at once after a delay.

**Acceptance Scenarios**:

1. **Given** a guest sends a message, **When** the AI starts generating, **Then** text appears in the conversation progressively (not all at once)
2. **Given** the AI is streaming a response, **When** the operator views the inbox, **Then** they see the response text building in real-time
3. **Given** streaming is interrupted mid-response, **When** the connection resumes, **Then** whatever text was received is preserved and the remaining content completes

---

### User Story 8 - Cache & Cost Visibility Dashboard (Priority: P2)

Operators can see how effectively the system is caching prompts, what the average cost per message is, and how often reasoning is being used. This gives direct visibility into the cost benefits of the migration and helps identify optimization opportunities.

**Why this priority**: Without visibility, operators can't verify the migration actually reduced costs. The dashboard proves ROI.

**Independent Test**: Process 20+ messages, then check the SOP Monitor dashboard for cache hit rate, cost per message, and reasoning usage percentages.

**Acceptance Scenarios**:

1. **Given** messages have been processed, **When** the operator views the dashboard, **Then** they see cache hit rate as a percentage
2. **Given** messages have been processed, **When** the operator views cost metrics, **Then** they see average cost per message and total cost over 24 hours
3. **Given** some messages used reasoning, **When** the operator views reasoning stats, **Then** they see the percentage of messages using no reasoning vs low reasoning

---

### Edge Cases

- **API rate limiting**: If the AI provider returns a rate limit error, the system retries with exponential backoff (max 6 attempts, 1-60s range with jitter) before escalating to a human operator
- **Model unavailability**: If the selected model is temporarily unavailable, the system logs the error and retries. After max retries, it escalates the conversation rather than leaving the guest unanswered
- **Cache miss on first message**: The very first message for a new tenant has no cache — it creates the cache. Subsequent messages benefit from caching. This is expected behavior, not an error
- **Long conversations exceeding context**: For conversations approaching the context window limit, automatic truncation preserves the most recent messages and drops older ones
- **Concurrent messages across properties**: Multiple properties under the same tenant can send messages simultaneously. Each uses the same cache key (tenant+agent), so they benefit from shared caching
- **Model pricing changes**: If the AI provider changes pricing, the cost tracking configuration must be updated. The system reads pricing from configuration, not hardcoded values
- **Sandbox testing**: The sandbox endpoint follows the same model selection, caching, and reasoning logic as production conversations
- **Previous SDK removal**: After migration, no previous provider SDK code should remain in the codebase. The migration is complete, not a dual-provider setup

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST replace all AI model API calls with the new provider's API format while maintaining identical guest-facing behavior
- **FR-002**: System MUST use forced function calling with strict mode for SOP classification, guaranteeing valid enum values on every call
- **FR-003**: System MUST structure prompts with static content first (tool definitions, system instructions, examples) and dynamic content last (property context, conversation history, current message) to maximize cache utilization
- **FR-004**: System MUST implement per-tenant per-agent cache keys (2 keys per tenant: screening agent + guest coordinator) with 24-hour cache retention
- **FR-005**: System MUST use no reasoning for SOP classification calls to minimize cost and latency
- **FR-006**: System MUST dynamically adjust reasoning effort based on classified SOP category: `low` reasoning for `sop-booking-modification`, `sop-booking-cancellation`, `payment-issues`, and `escalate`; `none` for all other categories
- **FR-007**: System MUST use concise verbosity control for guest responses
- **FR-008**: System MUST implement automatic truncation for conversations approaching the context window limit
- **FR-009**: System MUST continue building conversation history manually (no automatic threading) to accommodate manager-sent messages in the conversation
- **FR-010**: System MUST implement retry with exponential backoff (max 6 attempts, 1-60 second range with jitter) for API failures
- **FR-011**: System MUST pin to a specific model version for production stability
- **FR-012**: System MUST cap maximum output tokens to prevent runaway costs
- **FR-013**: System MUST allow operators to select from available model tiers in the Configure AI page
- **FR-014**: System MUST update cost tracking to reflect the new provider's per-token pricing (input, cached input, output, reasoning)
- **FR-015**: System MUST log model name, token breakdown (input/cached/output/reasoning), and cost per API call
- **FR-016**: System MUST remove the daily audit report service (OPUS) — low priority feature, to be re-added later if needed
- **FR-017**: System MUST remove the previous AI provider's SDK entirely — no dual-provider code
- **FR-018**: System MUST maintain all existing functionality: SOP classification, property search tool, extend-stay tool, escalation, monitoring dashboard
- **FR-019**: System MUST update the sandbox endpoint to use the same new model configuration, caching, and reasoning logic
- **FR-020**: System MUST read model pricing from configuration (not hardcoded) to accommodate future pricing changes

### Key Entities

- **AI Model Configuration**: Per-tenant model selection (model tier, reasoning defaults, verbosity, max output tokens) stored in tenant settings
- **Cache Key**: Composite identifier (tenant ID + agent type) used for prompt cache routing — 2 cache slots per tenant
- **API Call Log**: Enhanced log entry with model name, token breakdown (input, cached input, output, reasoning tokens), calculated cost, reasoning effort used, cache hit status

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All 22 SOP categories classify correctly on representative test messages — matching or exceeding previous model accuracy
- **SC-002**: Per-message cost is reduced by at least 50% compared to the previous model (target: at or below $0.002/message with cache hits)
- **SC-003**: SOP classification latency is under 1 second for cached requests
- **SC-004**: Cache hit rate exceeds 80% after the first message per tenant-agent pair
- **SC-005**: Zero guest-facing service interruption during the migration
- **SC-006**: Response quality is rated equivalent or better by the operator on a sample of 50+ messages
- **SC-007**: At least 80% of messages use no reasoning tokens (cost optimization verification)
- **SC-008**: All existing tools (property search, extend-stay, get_sop) function correctly with the new model
- **SC-009**: Cost tracking in the dashboard and audit reports accurately reflects actual API costs within 5% margin
- **SC-010**: No previous AI provider SDK code remains in the codebase after migration

## Assumptions

- The new AI model provides equivalent or better multilingual support (Arabic, English, and other languages used by guests)
- The new model's function calling with strict mode provides the same schema guarantee as the previous model's constrained decoding
- Conversation history built manually (as array of messages) works correctly with the new API format
- The new model follows SOP instructions with the same fidelity as the previous model when injected into the system prompt
- Property search and extend-stay tool handlers require no changes — only the tool schema format changes
- The existing database schema requires no modifications — only the ragContext JSON field shape changes for new logging fields
- The new model's automatic prompt caching with per-tenant keys provides better cache efficiency than the previous model's manual ephemeral caching
- Model pricing is configured per-tenant so different model tiers can have accurate cost tracking

## Clarifications

### Session 2026-03-22

- Q: Which SOP categories should trigger low reasoning effort? → A: 4 categories: sop-booking-modification, sop-booking-cancellation, payment-issues, escalate. All others use none.
- Q: Should the OPUS daily audit report also migrate to OpenAI? → A: Remove OPUS entirely. Daily audit is low priority, add back later if needed.
