# Research: FAQ Knowledge System

## R1: Separate Tool vs Merged Tool

**Decision**: Separate `get_faq` tool, not merged into `get_sop`
**Rationale**: `get_sop` fires on every message for SOP routing. `get_faq` only fires when the AI is about to escalate `info_request`. Different triggers, different frequencies. Merging would add unnecessary FAQ lookups to 80%+ of messages. User explicitly requested separation. TaskBench data shows tool accuracy drops at 6+ tools, but we're well within the safe range with separate tools.
**Alternatives considered**:
- Merge into `get_knowledge` with type param → Saves one tool definition but mixes routing logic. Research paper recommended this, but user's insight about different trigger patterns is better.

## R2: Tool Output Format

**Decision**: Markdown Q&A format for get_faq and get_sop output. JSON for structured data tools.
**Rationale**: Improving Agents benchmark (2025) found Markdown-KV format at 60.7% accuracy vs 52.3% JSON, using 16-34% fewer tokens. SOP and FAQ content is prose text — Markdown is natural. Structured data tools (availability, search, checklist) stay JSON — better for discrete fields.
**Alternatives considered**:
- JSON for everything (current) → More tokens, lower comprehension for text content
- Markdown for everything → Bad for structured data (availability booleans, search results)

## R3: Auto-Suggest Classification Model

**Decision**: GPT-5 Nano (`gpt-5-nano`) for classification and Q&A extraction
**Rationale**: Simple binary classification (reusable vs booking-specific) with short prompts (~200 tokens). GPT-5 Nano at $0.05/1M input is 4x cheaper than 5.4-nano and 15x cheaper than 5.4-mini. Same pattern as Task Manager dedup (also switched to 5-nano). Structured JSON output supported.
**Alternatives considered**:
- GPT-5.4 Nano → 4x more expensive for same quality on this task
- GPT-5.4 Mini → 15x more expensive, overkill

## R4: Storage Architecture

**Decision**: Dedicated FaqEntry Prisma model (not JSON field, not RAG/embeddings)
**Rationale**: At 20-50 entries per property (~5,000 total), a relational table is optimal. Supports per-entry queries, usage tracking, status filtering, scope management. The existing `customKnowledgeBase` JSON field can't support per-entry status/usage. RAG embeddings are overkill at this scale. Upgrade path: add pgvector column later if any property exceeds ~75 entries.
**Alternatives considered**:
- JSON field on Property → Can't query/filter individual entries, no usage tracking
- RAG with embeddings → Overkill infrastructure for 20-50 entries
- Context stuffing (inject all FAQs into prompt) → Wastes tokens on messages that don't need FAQs

## R5: FAQ Category Taxonomy

**Decision**: 15 fixed categories covering 95% of guest questions
**Rationale**: Cross-referenced from Hospitable, Hostaway, Guesty, Touch Stay, Hostfully, Airbnb host forums, and serviced apartment FAQ pages. 15 categories is within the comfortable range for flat classification. Fixed categories enable consistent analytics and instant onboarding. Research shows hierarchical classification only helps at 50+ categories with overlap — unnecessary here.
**Alternatives considered**:
- Tenant-configurable categories → Inconsistent analytics, onboarding friction
- Fewer categories (5-8) → Too coarse, FAQ retrieval returns too many irrelevant entries
- More categories (25+) → Diminishing returns, classification accuracy drops

## R6: Notification Method for Suggestions

**Decision**: Inline chat prompt (primary) + FAQs page (fallback)
**Rationale**: Inline catches the manager in context — they just answered the question and are most likely to approve. The FAQs page catches anything missed. Research shows Intercom's inline approach has higher acceptance rates than dashboard-only notifications.
**Alternatives considered**:
- Dashboard only → Manager must navigate there, lower engagement
- Email digest → Too slow, not actionable in the moment

## R7: Approval Workflow

**Decision**: Three states (SUGGESTED → ACTIVE → STALE) with human-in-the-loop
**Rationale**: Follows Intercom's two-state simplicity pattern. Never auto-publish — hospitality errors have outsized consequences (wrong check-in time = guest arrives early). Staleness at 90 days unused follows industry standard. Suggestions expire at 4 weeks if not reviewed (Intercom's pattern).
**Alternatives considered**:
- Auto-publish with confidence threshold → Too risky for hospitality domain
- Enterprise 4-state workflow (Draft → Review → Approved → Published) → Overkill for solo manager
