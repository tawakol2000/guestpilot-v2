# Feature Specification: Cross-Sell Property Suggestions (Tool Use)

**Feature Branch**: `010-property-suggestions`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "Guests ask for amenities their booked property doesn't have (e.g., pool). AI should suggest alternative properties from the same portfolio that match what they're looking for and are available for their dates. Use tool use so the AI can dynamically search and handle follow-ups naturally."

## Architecture Decision

The **screening agent** (which handles INQUIRY-status guests) is given the ability to dynamically search the property portfolio during a conversation. When an inquiry guest asks about an amenity the property doesn't have, the AI searches for matching alternatives, checks availability, and presents results — helping convert the inquiry into a booking on the right property.

This capability is **only available to the screening agent** — confirmed/checked-in guests asking about amenities are handled by the guest coordinator using existing SOP routing (they're asking about their current stay, not shopping for alternatives).

This is the first dynamic action capability added to the AI. The infrastructure built here (tool use loop, tool handler registry) is designed to be reusable for future capabilities on any agent.

**Key principles:**
- Tool use only on the screening agent (INQUIRY conversations) — not the guest coordinator
- The existing classification architecture (SOP routing) remains unchanged
- Dynamic actions handle live data lookups that depend on the conversation context
- The AI decides when to search — no separate trigger logic or classifier category needed
- Follow-up questions (refining criteria, asking about specific results) are handled naturally within the same conversation flow
- Frontend includes a Tools section for managing and viewing tool configurations and usage

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inquiry Guest Asks for Unavailable Amenity (Priority: P1)

An inquiry guest messages: "Does this apartment have a pool?" The property they're inquiring about does not have a pool. The screening AI recognizes this from the property info already in its context, searches the portfolio for properties with a pool that are available for the guest's requested dates, and responds in a single message: acknowledges this property doesn't have one, and presents alternatives with names, highlights, and booking links — helping direct the guest to the right listing before they book.

**Why this priority**: Core value proposition — turning an inquiry "no" into a booking on a better-matched property. Inquiry guests are actively shopping; suggesting the right property increases conversion.

**Independent Test**: Send a message on an INQUIRY-status conversation asking for a specific amenity the property lacks. Verify the screening AI returns matching alternatives with availability in the same response.

**Acceptance Scenarios**:

1. **Given** an inquiry guest is looking at a property without a pool, **When** they ask "Is there a pool?", **Then** the screening AI acknowledges this property doesn't have one and presents 1-3 alternative properties with a pool available for their dates, including property name, key highlights, and a booking/viewing link.
2. **Given** an inquiry guest asks about an amenity the property already has, **When** they say "Does this place have WiFi?", **Then** the AI answers normally (confirms the amenity) and does NOT search for alternatives.
3. **Given** an inquiry guest asks about a missing amenity but no other portfolio properties have it either, **When** they ask "Is there a jacuzzi?", **Then** the AI politely says none of the properties offer that amenity — no empty list, no search shown.
4. **Given** a CONFIRMED or CHECKED_IN guest asks about a missing amenity, **When** they say "Is there a pool?", **Then** the guest coordinator handles it normally (no tool use, no property suggestions — they're asking about their current stay).

---

### User Story 2 - Conversational Follow-Ups (Priority: P1)

After the AI suggests alternative properties, the guest asks follow-up questions: "Is the first one close to the beach?", "What about one with parking too?", "How much would that cost?" The AI handles these naturally — it can refine the search with additional criteria, answer questions about suggested properties using their details, and redirect pricing questions to the booking link.

**Why this priority**: Without follow-up handling, suggestions are a dead end. Guests rarely accept the first result without questions. This is what makes tool use the right approach over a simple static list.

**Independent Test**: Trigger a property suggestion, then send 2-3 follow-up messages refining criteria or asking about specific results. Verify the AI maintains context and responds coherently.

**Acceptance Scenarios**:

1. **Given** the AI just suggested 3 properties with pools, **When** the guest says "Do any of those have parking too?", **Then** the AI refines the search and responds with properties that have both pool and parking.
2. **Given** the AI suggested properties, **When** the guest asks "How much is the Beach Villa?", **Then** the AI does NOT quote a price but directs the guest to the booking link where live pricing is shown.
3. **Given** the AI suggested properties, **When** the guest says "Actually never mind, what's the WiFi password?", **Then** the AI switches back to normal conversation and answers the WiFi question from property info — no forced cross-sell continuation.

---

### User Story 3 - Guest Interested in a Suggested Property (Priority: P1)

An inquiry guest sees the suggested alternatives and expresses interest: "The Beach Villa looks great, how do I book it?" or "Can I book that one instead?" The AI directs them to the booking link and creates an escalation task so the manager knows a lead was generated for that property.

**Why this priority**: The natural conclusion of the cross-sell flow. The inquiry guest is ready to act — the AI needs to facilitate the next step.

**Independent Test**: After receiving suggestions, express interest in a specific property. Verify the AI provides the booking link and creates an escalation task for follow-up.

**Acceptance Scenarios**:

1. **Given** the AI suggested 3 properties, **When** the guest says "I'd like to book the Beach Villa", **Then** the AI provides the booking link for that property and creates an escalation task for the manager with: target property name, guest's requested dates, and the amenity that triggered the suggestion.
2. **Given** an inquiry guest wants a property but no alternatives are available for their dates, **When** the AI searches and finds nothing, **Then** it apologizes and offers to escalate to the manager for manual assistance with finding availability.
3. **Given** a guest says "I need a bigger place" without specifying amenities, **When** the AI searches, **Then** it uses property capacity/size as the search criteria (not just amenities).

---

### User Story 4 - Subtle / Indirect Requests (Priority: P2)

Not all guests ask directly "do you have X?" Some express dissatisfaction or wishes indirectly: "I wish this place had a view", "The apartment feels a bit small for our group", "Is there anywhere nearby I could swim?" The AI recognizes these as potential cross-sell moments and proactively searches for better-fitting alternatives.

**Why this priority**: Captures a wider set of cross-sell opportunities beyond explicit amenity questions. Lower priority because the explicit flow (US1) delivers the core value.

**Independent Test**: Send indirect messages expressing dissatisfaction or wishes. Verify the AI searches for alternatives when appropriate but doesn't over-trigger on casual comments.

**Acceptance Scenarios**:

1. **Given** a guest says "The apartment is too small for 6 people", **When** the AI recognizes this as a capacity issue, **Then** it searches for properties with higher capacity available for their dates.
2. **Given** a guest casually says "Nice place, shame there's no balcony though", **When** the AI reads this as a mild comment (not a request), **Then** it may acknowledge the comment but does NOT aggressively push alternatives — it should feel natural, not salesy.

---

### User Story 5 - Manager Dashboard Visibility (Priority: P3)

Property managers can see in the dashboard when a property search was performed, which properties were suggested, and whether the guest expressed interest in switching. This helps managers follow up and track cross-sell conversion.

**Why this priority**: Operational visibility. Managers need to know what the AI suggested. Lower priority because the guest-facing flow works independently.

**Independent Test**: Trigger a property suggestion, then check the dashboard pipeline view to see the search metadata logged alongside the AI response.

**Acceptance Scenarios**:

1. **Given** the AI searched for and suggested alternative properties, **When** the manager views the conversation in the pipeline/inbox, **Then** they can see: the search criteria used, which properties were suggested, and whether the guest expressed interest.
2. **Given** the guest expressed interest and an escalation task was created, **When** the manager views the task, **Then** it includes the target property name, guest's requested dates, and the amenity that prompted the suggestion.

---

### User Story 6 - Frontend Tools Management (Priority: P2)

The dashboard includes a Tools section where managers can see which AI tools are available, their configuration, and usage history. This provides visibility into the tool use infrastructure and allows future tools to be managed from the same place.

**Why this priority**: Operational control. Managers need to understand what capabilities the AI has and see when tools are being used. Also establishes the frontend pattern for future tools.

**Independent Test**: Navigate to the Tools section in the dashboard. Verify the property search tool is listed with its description, status, and recent usage stats.

**Acceptance Scenarios**:

1. **Given** the tools section is loaded, **When** the manager views it, **Then** they see a list of available tools with: tool name, description, status (enabled/disabled), and usage count.
2. **Given** the property search tool has been used in recent conversations, **When** the manager views tool details, **Then** they can see recent tool invocations with: timestamp, search criteria, results count, and which conversation triggered it.
3. **Given** a tool usage occurred during an AI response, **When** the manager views the pipeline/AI log for that response, **Then** the tool section shows: tool name, input (search criteria), output (properties found), and duration.

---

### Edge Cases

- **Tenant has only one property**: AI says it doesn't have alternative options and offers to escalate to the manager. The search returns empty, AI handles gracefully.
- **Confirmed/checked-in guest asks about amenities**: Guest coordinator handles normally — no tool use, no property suggestions. Tool is screening-agent only.
- **Multiple amenities requested**: Guest says "I need a pool and parking." AI searches for properties with ALL requested amenities, falling back to partial matches ranked by how many criteria they meet.
- **Guest asks in Arabic or another language**: AI handles this naturally — it already responds in the guest's language. Search criteria are interpreted semantically regardless of language.
- **Rate/pricing differences**: AI MUST NOT quote specific prices. Directs guests to the booking link for live pricing.
- **Same property suggested twice in conversation**: If the AI already suggested properties earlier in this conversation, it should reference the previous suggestions rather than re-running an identical search.
- **Guest is mid-stay (checked in)**: Tool is not available to the guest coordinator — this edge case doesn't apply since tools are screening-agent only.
- **Search fails or times out**: AI responds helpfully ("Let me check with the team") and escalates to the manager. Never shows an error to the guest.
- **Property has no listing URL**: AI suggests the property by name and description but notes that the guest should contact the team for booking details, rather than showing a broken or missing link.

## Requirements *(mandatory)*

### Functional Requirements

**Core Search & Suggestions**

- **FR-001**: AI MUST be able to dynamically search the tenant's property portfolio during a conversation, filtering by amenities, capacity, and other property attributes.
- **FR-002**: AI MUST check real-time availability of matching properties for the guest's reservation dates before suggesting them. Availability MUST be verified against Hostaway's live API (authoritative source across all channels), not local reservation data which may have sync gaps.
- **FR-003**: AI MUST return a maximum of 3 matching available properties per search, ordered by relevance to the guest's request.
- **FR-004**: Each suggested property MUST include: property name, 1-2 key highlights relevant to the guest's request, and a link to view/book (when available). The link MUST match the guest's booking channel — Airbnb guests receive Airbnb listing links, Booking.com guests receive Booking.com links, and Direct/WhatsApp guests receive the direct booking engine link. If the matching channel link is unavailable for a suggested property, fall back to the direct booking engine URL or omit the link and direct the guest to contact the team.
- **FR-005**: AI MUST NOT suggest the guest's current property in search results.
- **FR-005a**: AI MUST only suggest properties in the same city as the guest's current booking. Properties in other cities are never shown, even if no local matches exist.
- **FR-006**: AI MUST NOT quote specific prices — direct guests to the listing link for live pricing.
- **FR-007**: AI MUST match amenities semantically, not by exact string match (e.g., "swimming pool" = "pool" = "outdoor pool").

**Conversation Flow**

- **FR-008**: AI MUST handle follow-up questions about suggested properties naturally within the same conversation — refining search criteria, answering questions about specific properties, or switching topics entirely.
- **FR-009**: AI MUST respond in the same language the guest is using.
- **FR-010**: The property search tool MUST only be available to the screening agent (INQUIRY-status conversations). The guest coordinator (CONFIRMED/CHECKED_IN) MUST NOT have access to this tool.
- **FR-010a**: Within the screening agent, the AI MUST decide autonomously when a property search is relevant — no separate classifier category or trigger needed.
- **FR-011**: AI MUST NOT aggressively cross-sell. Casual comments ("shame there's no balcony") should be handled with tact, not an immediate property list.

**Escalation & Handoff**

- **FR-012**: When an inquiry guest expresses interest in a suggested property, the AI MUST create an escalation task for the property manager containing: target property, guest's requested dates, and the amenity/reason that prompted the suggestion.
- **FR-013**: When no matching properties exist, AI MUST handle gracefully — polite explanation, offer to escalate for manual assistance.

**Resilience & Logging**

- **FR-014**: If the property search fails or times out, the AI MUST still respond helpfully and escalate to the manager. Never show errors to guests.
- **FR-015**: System MUST log search criteria, results returned, and guest interest as metadata on the AI response.
- **FR-016**: System MUST leave the existing classification architecture unchanged — dynamic actions complement SOP routing, they do not replace it.

**Infrastructure**

- **FR-017**: The dynamic action infrastructure MUST be designed for reuse — adding future capabilities (e.g., availability extensions, pricing lookups) should require only defining a new action and its handler, not restructuring the AI response flow.

**Frontend**

- **FR-018**: The dashboard MUST include a Tools section showing: available tools with name/description/status, and recent tool invocations with search criteria, results count, and linked conversation.
- **FR-019**: The AI pipeline/log view MUST show tool usage details (tool name, input, output, duration) when a tool was invoked during a response.

### Key Entities

- **Property Portfolio**: The set of all properties belonging to a tenant, each with amenities, description, capacity, location, and booking links.
- **Property Search**: A dynamic query against the portfolio with criteria (amenities, capacity, dates) and results (matching available properties with details and links).
- **Lead / Interest Signal**: When an inquiry guest expresses interest in a suggested property — includes target property, requested dates, and triggering amenity. Results in an escalation task for manager follow-up.

## Assumptions

- Property amenities are already stored in the system (via Hostaway sync into the property's knowledge base) as human-readable strings.
- Listing URLs (Airbnb, Booking.com, booking engine) are synced from Hostaway on each property. The system uses these channel-provided links when suggesting properties to guests.
- Hostaway's API supports filtering listings by availability date range (`availabilityDateStart`, `availabilityDateEnd` parameters). This is the authoritative source for availability checks.
- The existing escalation/task system can handle property switch requests without schema changes.
- The feature applies to all channels (Airbnb, Booking.com, WhatsApp, Direct) equally.
- This is the first dynamic action capability — no existing infrastructure for mid-conversation data lookups exists yet.

## Clarifications

### Session 2026-03-21

- Q: Which booking link should be shown to guests — always the same URL, or matched to the guest's channel? → A: Match the link to the guest's booking channel (Airbnb → Airbnb link, Booking.com → Booking.com link, Direct/WhatsApp → booking engine link). Prevents Airbnb TOS violations from showing competitor links.
- Q: Should suggestions include properties from any city in the portfolio or only same-city? → A: Strictly same-city only — never suggest properties in a different city, even if no local matches exist.
- Q: Should availability be checked via Hostaway's live API or local reservation data? → A: Always use Hostaway's live API (authoritative across all channels). False availability is worse than slightly slower responses.
- Q: Which agent gets the tool? → A: Screening agent only (INQUIRY-status conversations). Guest coordinator (confirmed/checked-in) does not get property search — those guests are asking about their current stay, not shopping.
- Q: Does the frontend need a tools section? → A: Yes. Dashboard needs a Tools section showing available tools, status, and recent usage. Pipeline view also shows tool invocation details per response.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a guest asks about a missing amenity, the system suggests alternatives within the same response — no multi-message back-and-forth needed before showing results.
- **SC-002**: 90% of property suggestions include only properties that are genuinely available for the guest's dates (no false availability).
- **SC-003**: Guests can ask follow-up questions about suggestions (refine criteria, ask about specific properties) and receive coherent responses without losing conversation context.
- **SC-004**: Guests who want to switch have an escalation task created within the same conversation turn — no manual manager intervention needed to start the process.
- **SC-005**: The AI response time is not degraded by more than 3 seconds when a property search is performed (only on messages that trigger a search — all other messages unaffected).
- **SC-006**: Property managers can identify all cross-sell suggestions made in the last 7 days from the dashboard without searching individual conversations.
- **SC-007**: Adding a new dynamic action capability (beyond property search) requires no changes to the core AI response flow — only a new action definition and handler.
