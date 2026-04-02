# Feature Specification: FAQ Knowledge System

**Feature Branch**: `027-faq-knowledge`
**Created**: 2026-04-02
**Status**: Draft
**Input**: FAQ Knowledge System with auto-suggest pipeline, per-property and global FAQ entries, get_faq tool, and Markdown tool output format.

## Problem Statement

Guests across properties ask the same 20-50 questions repeatedly — nearest supermarket, parking availability, WiFi password, gym access, check-in directions. Each time, the AI doesn't know the answer, escalates as `info_request`, and the manager answers manually. The same question comes up next week from a different guest, and the cycle repeats.

There is no mechanism for the system to learn from manager responses and reuse that knowledge for future guests. Every answered question is lost as a one-time conversation reply instead of becoming permanent property knowledge.

Additionally, the current AI tool outputs use JSON format, which is 16-34% less token-efficient and scores lower on LLM comprehension accuracy than Markdown format for text-heavy content like SOPs and FAQs.

## Clarifications

### Session 2026-04-02

- Q: Where does the FAQ management UI live? → A: New dedicated top-level "FAQs" tab in the main navigation — its own page for managing all FAQ entries (both global and property-specific).
- Q: How does the AI know when to call get_faq? → A: AI calls get_faq only when it's about to escalate info_request — the tool description guides this behavior. Not called on every message.
- Q: How are managers notified of FAQ suggestions? → A: Both — inline prompt in the chat right after replying to an info_request (primary), plus all pending suggestions visible on the FAQs page (fallback).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - AI Answers From FAQ Before Escalating (Priority: P1)

A guest asks "is there a gym nearby?" The AI checks the property's FAQ entries before deciding to escalate. If an approved FAQ entry exists for this topic, the AI answers directly using the FAQ content — no escalation, no manager involvement. The guest gets an instant, accurate answer.

**Why this priority**: This is the core value. Every FAQ-answered question eliminates a manual escalation and speeds up guest response time from minutes to seconds.

**Independent Test**: Add an FAQ entry for a property ("Q: Is there a gym? A: Yes, O1 Mall has a full gym, 1 minute walk."). Send a guest message asking about a gym. Verify the AI answers from the FAQ without escalating.

**Acceptance Scenarios**:

1. **Given** an active FAQ entry exists for a property in the "local-recommendations" category, **When** a guest asks a question that matches that FAQ topic, **Then** the AI retrieves the FAQ and uses it to answer directly without creating an `info_request` escalation.
2. **Given** no FAQ entry matches the guest's question, **When** the AI cannot find a relevant FAQ, **Then** the AI escalates as `info_request` as usual — the FAQ system does not change the fallback behavior.
3. **Given** a global FAQ entry exists (applies to all properties) and no property-specific override exists, **When** a guest at any property asks that question, **Then** the AI uses the global FAQ to answer.
4. **Given** both a global FAQ and a property-specific FAQ exist for the same topic, **When** a guest asks, **Then** the AI uses the property-specific FAQ (property overrides global).

---

### User Story 2 - Auto-Suggest FAQ From Manager Replies (Priority: P2)

A manager replies to an `info_request` escalation (e.g., telling a guest "the nearest pharmacy is Seif Pharmacy, 3 minutes walk from Building 8"). The system detects this is a reusable answer, extracts a clean Q&A pair, and creates a suggested FAQ entry. The manager sees the suggestion and can approve it with one tap, optionally toggling it between property-specific or global scope.

**Why this priority**: This is how the knowledge base grows organically. Without auto-suggestion, managers must manually write FAQ entries — which they won't do. Auto-suggest turns every manager reply into a potential FAQ entry with minimal friction.

**Independent Test**: Create an `info_request` escalation. Reply as the manager with a reusable answer. Verify a suggested FAQ entry appears for approval.

**Acceptance Scenarios**:

1. **Given** a manager replies to an `info_request` escalation with a reusable answer (general property info, not booking-specific), **When** the reply is sent, **Then** the system creates a suggested FAQ entry with an extracted Q&A pair, defaulting to property-specific scope.
2. **Given** a suggested FAQ entry exists, **When** the manager views it, **Then** they can approve it (making it active), edit the question or answer before approving, toggle scope between global and property-specific, or reject it.
3. **Given** a manager replies with a booking-specific answer (references dates, prices, or this guest's reservation), **When** the reply is sent, **Then** the system does NOT create a suggested FAQ (the answer is not reusable).
4. **Given** an existing active FAQ already covers the same topic (semantically similar), **When** the auto-suggest pipeline runs, **Then** it skips creating a duplicate suggestion.

---

### User Story 3 - Manager Manages FAQ Entries (Priority: P3)

A manager can view, create, edit, and organize FAQ entries for their properties. They can see all entries by category, filter by property or global scope, see which FAQs are most used, and manually add new entries.

**Why this priority**: While auto-suggest handles most entry creation, managers need to manually create FAQs for known questions (e.g., during property onboarding) and maintain existing entries over time.

**Independent Test**: Open the FAQ management UI, create a new entry, assign a category and scope, verify it becomes available to the AI.

**Acceptance Scenarios**:

1. **Given** a manager opens the FAQ management section, **When** they view the entry list, **Then** they see all FAQ entries organized by category, with status (suggested/active/stale), scope (global/property), and usage count.
2. **Given** a manager creates a new FAQ entry, **When** they provide a question, answer, category, and scope, **Then** the entry is immediately active and available to the AI.
3. **Given** an active FAQ entry has not been used in 90 days, **When** the staleness check runs, **Then** the entry is marked as "stale" and flagged for the manager to review (keep, update, or archive).
4. **Given** a manager edits a global FAQ for a specific property, **When** they save, **Then** a property-specific override is created and the global entry remains unchanged for other properties.

---

### User Story 4 - Markdown Tool Output Format (Priority: P2)

The AI tools that return text-heavy content (SOP procedures, FAQ entries) switch from JSON format to Markdown format. This improves the AI's comprehension of the content and reduces token usage by 16-34%.

**Why this priority**: Markdown is proven to score higher on LLM comprehension benchmarks (60.7% vs 52.3% JSON) and uses significantly fewer tokens. This applies to every AI response that uses tool content — a system-wide improvement.

**Independent Test**: Trigger a `get_sop` call and verify the output is in Markdown format. Verify the AI's response quality is at least as good as with JSON output.

**Acceptance Scenarios**:

1. **Given** the AI calls a knowledge retrieval tool (SOP or FAQ), **When** the tool returns content, **Then** the content is formatted in Markdown (headers, Q:/A: labels) instead of JSON strings.
2. **Given** the AI calls a data-oriented tool (availability check, property search, document checklist), **When** the tool returns results, **Then** the content remains in JSON format (structured data is better suited to JSON).

---

### Edge Cases

- What happens when a guest asks a question that partially matches multiple FAQ entries across categories? The tool returns all entries for the matched category; the AI selects the most relevant one.
- What happens when a FAQ entry contains outdated information (e.g., a restaurant that closed)? The staleness detection flags entries unused for 90 days. Managers can also manually archive or update entries at any time.
- What happens when the auto-suggest pipeline extracts a poor Q&A pair (too vague or incorrect)? The manager can edit the suggestion before approving or reject it entirely. Suggestions are never auto-published.
- What happens when a manager replies to an escalation in Arabic but the FAQ system stores entries in English? The extraction pipeline normalizes the Q&A to the property's primary language, preserving the factual content.
- What happens when the same question is asked differently ("where's the gym" vs "is there a fitness center")? The AI's natural language understanding handles semantic matching. FAQ entries should use common phrasing; variant phrasings can be added as alternative question forms.
- What happens when a property has zero FAQ entries? The `get_faq` tool returns an empty result, and the AI falls back to escalating as `info_request` — identical to current behavior.
- What happens when the auto-suggest creates a suggestion but the manager never reviews it? Suggestions auto-expire after 4 weeks if not acted upon.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a `get_faq` tool that the AI can call to retrieve FAQ entries by category for the current property. The tool returns all active entries for the requested category (property-specific + inherited global entries) in Markdown Q&A format.
- **FR-002**: The AI MUST call `get_faq` when it determines the guest's question could be answered by property knowledge and it would otherwise escalate as `info_request`. The tool description guides this behavior — the AI decides when to call it based on context, not on every message. If a relevant FAQ answer is found, the AI responds directly without escalating.
- **FR-003**: The system MUST support 15 fixed FAQ categories: check-in-access, check-out-departure, wifi-technology, kitchen-cooking, appliances-equipment, house-rules, parking-transportation, local-recommendations, attractions-activities, cleaning-housekeeping, safety-emergencies, booking-reservation, payment-billing, amenities-supplies, property-neighborhood.
- **FR-004**: Each FAQ entry MUST have a scope: GLOBAL (applies to all properties) or PROPERTY (applies to one specific property). Property-specific entries override global entries on the same topic.
- **FR-005**: Each FAQ entry MUST have a status lifecycle: SUGGESTED (pending manager review) → ACTIVE (available to the AI) → STALE (unused for 90 days, flagged for review) → ARCHIVED (removed from AI access).
- **FR-006**: When a manager replies to an `info_request` escalation (NOT `inquiry_decision` or `modification_request` — those are booking decisions, not reusable knowledge), the system MUST automatically classify the reply as reusable or booking-specific using a lightweight, low-cost AI model (same tier as the Task Manager dedup agent). For reusable replies, the system MUST extract a clean Q&A pair and create a SUGGESTED FAQ entry.
- **FR-007**: The auto-suggest extraction MUST remove personal details, booking references, greetings, and sign-offs from both the question and answer, producing generalized Q&A text.
- **FR-008**: The system MUST check for duplicates before creating a suggestion using text similarity (first 100 characters of question, lowercased). If an existing active FAQ has a matching prefix, the suggestion is skipped. Full semantic dedup (embeddings) is deferred — text matching is sufficient at 20-50 entries per property, and the manager can reject false suggestions.
- **FR-009**: Managers MUST be able to approve, edit, reject, or toggle scope (global/property) on suggested FAQ entries. The primary notification is an inline "Save as FAQ?" prompt that appears in the chat immediately after the manager replies to an `info_request` escalation, showing the extracted Q&A for one-tap approval. All pending suggestions are also accessible on the dedicated FAQs page as a fallback.
- **FR-010**: Managers MUST be able to manually create, edit, and archive FAQ entries, assigning category and scope.
- **FR-011**: The system MUST track usage count per FAQ entry and last-used timestamp. Count is incremented for all entries returned by a `get_faq` tool call (the tool returns all entries for a category — per-entry precision would require the AI to report which entry it used, adding complexity for minimal value).
- **FR-012**: FAQ entries unused for 90 days MUST be automatically marked as STALE and surfaced for manager review.
- **FR-013**: Suggested FAQ entries not acted upon within 4 weeks MUST auto-expire.
- **FR-014**: The `get_sop` tool output MUST be changed from JSON format to Markdown format for text-heavy SOP content. The `get_faq` tool MUST also use Markdown format.
- **FR-015**: Tools that return structured data (availability checks, property search, document checklist) MUST continue using JSON format.
- **FR-016**: The system MUST provide a dedicated "FAQs" page accessible via a new top-level tab in the main navigation. The page shows all FAQ entries (global and property-specific) organized by category with filtering by property, scope, status, and usage statistics. Suggested entries awaiting approval are prominently surfaced.

### Non-Functional Requirements

- **NFR-001**: The `get_faq` tool MUST respond within 500ms (database query, not embedding search).
- **NFR-002**: The auto-suggest extraction MUST complete within 5 seconds of the manager's reply being sent.
- **NFR-003**: The FAQ system MUST support up to 100 entries per property and 50 global entries without performance degradation.
- **NFR-004**: The Markdown tool output format change MUST not degrade AI response quality compared to the current JSON format.

### Key Entities

- **FAQ Entry**: A question-answer pair with category, scope (global/property), status (suggested/active/stale/archived), usage count, last-used timestamp, and source (manual/auto-suggested).
- **FAQ Category**: One of 15 fixed categories covering the full range of guest questions. Categories are system-defined, not tenant-configurable.
- **FAQ Suggestion**: A pending FAQ entry created by the auto-suggest pipeline from a manager's reply. Awaiting manager approval, editing, or rejection.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `info_request` escalation rate decreases by at least 40% within 30 days of FAQ system activation for properties with 10+ active FAQ entries.
- **SC-002**: 80% of auto-suggested FAQ entries are approved by managers (indicating high extraction quality).
- **SC-003**: Average time to answer a FAQ-covered question drops from 5+ minutes (manual escalation → manager reply) to under 5 seconds (AI answers directly).
- **SC-004**: Each property accumulates at least 15 active FAQ entries within 60 days through the auto-suggest pipeline (organic knowledge growth).
- **SC-005**: Token usage for SOP/FAQ tool outputs decreases by at least 15% after switching to Markdown format.
- **SC-006**: Zero FAQ entries are served to guests from the wrong property (scope isolation is enforced).
- **SC-007**: 90% of FAQ-answered responses are rated as accurate by managers reviewing AI logs (FAQ content quality).

## Assumptions

- The AI model can reliably decide when to call `get_faq` vs. when to escalate directly. The tool description in the system prompt guides this behavior.
- The existing tool-calling infrastructure (up to 5 rounds, auto tool_choice) supports adding a new tool without degrading performance.
- The LLM extraction for auto-suggest (classifying replies as reusable vs. booking-specific) achieves sufficient accuracy (>80%) to be useful. Poor extractions are caught by the manager approval step.
- FAQ entries are short (1-3 sentences per answer). Long-form content belongs in SOPs, not FAQs.
- The 15 fixed categories are sufficient for the serviced apartment domain. An "Other" catch-all is not needed initially — unmatched questions continue to escalate as `info_request`.
- Semantic duplicate detection for auto-suggest uses simple text similarity (first 100 chars + keyword overlap), not embedding-based similarity — sufficient for the expected volume of 20-50 entries per property.

## Scope Boundaries

### In Scope
- New `get_faq` tool for the AI to retrieve FAQ entries by category
- FAQ entry storage with scope (global/property), status lifecycle, category, usage tracking
- Auto-suggest pipeline: detect reusable manager replies → extract Q&A → create suggestion
- Manager approval workflow: approve, edit, reject, toggle scope
- Manual FAQ entry creation and management
- Staleness detection (90 days unused → flag for review)
- Suggestion expiry (4 weeks unanswered → auto-expire)
- Switch `get_sop` output from JSON to Markdown format
- New `get_faq` output in Markdown format
- FAQ management UI section

### Out of Scope
- Embedding-based semantic search for FAQ retrieval (overkill at 20-50 entries — upgrade path for >75 entries)
- Merging `get_faq` into `get_sop` (they serve different purposes and have different trigger patterns)
- Multi-language FAQ variants (single language per entry for now)
- AI auto-publishing FAQ entries without manager approval
- Analytics dashboard for FAQ usage trends (usage count per entry is tracked; a dedicated dashboard is a future feature)
- Tenant-configurable categories (fixed 15 categories for consistency)
