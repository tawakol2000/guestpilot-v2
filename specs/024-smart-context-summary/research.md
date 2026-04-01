# Research: Smart Conversation Context Summarization

**Date**: 2026-04-01 | **Feature**: 024-smart-context-summary

## Decision 1: Summary Storage

**Decision**: Use existing `conversationSummary`, `summaryUpdatedAt`, `summaryMessageCount` fields on the Conversation model.

**Rationale**: The Prisma schema already defines these three fields (schema.prisma lines 115-117) but they are completely unused — no code references them. This is zero-migration, zero-risk.

**Alternatives considered**:
- New separate table (ConversationSummary) — unnecessary complexity, one summary per conversation is sufficient
- JSON field on Conversation — less queryable, existing Text field is better

## Decision 2: Summarization Model

**Decision**: Use `gpt-5.4-nano` (cheapest available model in the pricing config).

**Rationale**: Summarization is a simple extraction task — no reasoning, no tool use, no structured output needed. The cheapest model handles it well. Cost estimate: ~$0.001 per summary call (200 input tokens, 100 output tokens at nano pricing).

**Alternatives considered**:
- Same model as main AI (gpt-5.4-mini) — works but 3-4x more expensive, unnecessary for extraction
- Local/embedded model — adds deployment complexity, not worth it for this scale

## Decision 3: Incremental Extension Strategy

**Decision**: Feed the existing summary + newly scrolled-out messages to the model, asking it to produce an updated summary.

**Rationale**: Re-summarizing the entire conversation from scratch every time is wasteful (costs scale linearly with conversation length). Incremental extension keeps costs constant — each call processes only the existing summary (~100 tokens) + new messages (~50-200 tokens).

**Alternatives considered**:
- Full re-summarization every time — O(n) cost growth, wasteful for long conversations
- Append-only (just concatenate new message summaries) — degrades quality, no deduplication, grows without bound
- Sliding window summary (summarize blocks of 10) — more complex, no clear benefit over incremental

## Decision 4: Summary Trigger Logic

**Decision**: Generate/extend summary asynchronously after the AI response, only when `summaryMessageCount` < (total GUEST+AI messages - 10).

**Rationale**: This means the summary only fires when messages have actually scrolled out of the window that the existing summary doesn't cover. For a 20-message conversation, summary fires ~2-3 times total (not 20 times). The async fire-and-forget pattern ensures zero latency impact.

**Alternatives considered**:
- Trigger on every message — too expensive, defeats the purpose
- Batch every N messages (e.g., every 5) — adds complexity, the "stale check" approach is simpler and naturally batches
- Synchronous before AI call — adds 1-2s latency per message, unacceptable

## Decision 5: Message Counting (GUEST + AI only)

**Decision**: The 10-message window and summarization input only count GUEST and AI messages. AI_PRIVATE, MANAGER_PRIVATE, and [MANAGER]-prefixed messages are excluded.

**Rationale**: AI_PRIVATE messages are internal system notes (delivery failures, escalation details). They waste tokens and provide no conversational context. The current code already filters them out (ai.service.ts line 1236-1237).

**Alternatives considered**:
- Include all roles — wastes tokens on "AI reply saved but Hostaway delivery failed" noise
- Include HOST messages — HOST is rarely used and maps to "Omar" anyway; already included in the GUEST+AI filter via role check
