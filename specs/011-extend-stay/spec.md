# Feature Specification: Extend Stay Tool

**Feature Branch**: `011-extend-stay`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "AI tool for extending stays — checks availability, calculates price, guides guest through alteration flow per channel."

## Architecture Decision

A new `check_extend_availability` tool is added to the AI's tool use infrastructure (built in 010). When a confirmed or checked-in guest asks to extend their stay (or shorten, or change dates), the AI checks whether the property is available for the requested dates, calculates the price difference, and guides the guest through the appropriate channel-specific alteration process.

This tool is available to the **guest coordinator** (CONFIRMED/CHECKED_IN guests) — unlike the property search tool which is screening-agent only. Guests who are already booked are the ones asking to extend.

**Channel-aware alteration flow:**
- **Direct / WhatsApp**: AI can confirm availability and pricing, then escalate to the manager to finalize the modification directly
- **Airbnb**: AI confirms availability and pricing, then instructs the guest to submit an alteration request through Airbnb — the manager approves it from the Hostaway dashboard
- **Booking.com**: AI confirms availability and pricing, then instructs the guest to modify through Booking.com

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Guest Asks to Extend Stay (Priority: P1)

A confirmed guest messages: "Can I stay 2 more nights?" or "Is the apartment available until Sunday?" The AI checks if the property is available for the extended dates, calculates the price for the additional nights, and responds with availability + pricing + clear instructions for how to proceed based on their booking channel.

**Why this priority**: This is the most common date modification request. Guests frequently want to extend, and managers currently check availability manually for every request.

**Independent Test**: Send "Can I stay 2 more nights?" on a CONFIRMED conversation. Verify the AI responds with availability status, price for additional nights, and channel-specific instructions.

**Acceptance Scenarios**:

1. **Given** a confirmed guest with checkout on March 25, **When** they ask "Can I extend until March 27?", **Then** the AI checks availability for March 25-27, returns the price for the 2 extra nights, and provides channel-appropriate instructions for making the change.
2. **Given** a confirmed guest on Airbnb, **When** the property IS available for extended dates, **Then** the AI says: "Yes, [property] is available until March 27. The additional 2 nights would be approximately [price]. To extend, please submit an alteration request through Airbnb and we'll approve it right away."
3. **Given** a confirmed guest on a Direct booking, **When** the property IS available, **Then** the AI says: "Yes, [property] is available until March 27. The additional 2 nights would be approximately [price]. I'll arrange the extension for you." and creates an escalation task for the manager.
4. **Given** a confirmed guest, **When** the property is NOT available for the extended dates (another booking exists), **Then** the AI apologizes and says the property is booked for those dates. Optionally suggests the nearest available dates.

---

### User Story 2 - Guest Asks to Shorten Stay or Change Dates (Priority: P2)

A guest wants to check out early ("I need to leave a day earlier") or shift their dates ("Can I arrive on Thursday instead of Wednesday?"). The AI checks availability for the modified dates and provides pricing + channel instructions.

**Why this priority**: Less common than extensions but same infrastructure. Early checkouts and date shifts are handled identically — check availability for new dates, calculate price difference.

**Independent Test**: Send "Can I check out a day early?" Verify the AI confirms the new checkout date and provides channel-specific modification instructions.

**Acceptance Scenarios**:

1. **Given** a guest with checkout March 30, **When** they ask "Can I leave on March 28 instead?", **Then** the AI confirms the shortened stay and explains how to modify through their channel. No availability check needed for shortened stays (property becomes MORE available).
2. **Given** a guest, **When** they ask to shift dates ("arrive Thursday instead of Wednesday"), **Then** the AI checks availability for the new arrival date and responds accordingly.
3. **Given** a checked-in guest asking to leave early, **When** the AI processes the request, **Then** it creates an escalation task for the manager with the new dates and any pricing implications.

---

### User Story 3 - Price Transparency (Priority: P1)

The guest asks "How much would it cost to stay 3 extra nights?" before deciding. The AI calculates the price for the additional nights and provides it, so the guest can make an informed decision before submitting an alteration.

**Why this priority**: Tied with US1. Guests always want to know the price before committing. If the AI can't quote a price, the guest has to wait for the manager — defeating the purpose.

**Independent Test**: Ask "How much for 2 more nights?" Verify the AI returns a price figure for the extension.

**Acceptance Scenarios**:

1. **Given** a confirmed guest, **When** they ask about pricing for extra nights, **Then** the AI uses the price calculation to return the cost for the additional period.
2. **Given** a confirmed guest, **When** the price calculation service is unavailable or returns an error, **Then** the AI says "I'll check with the team on pricing" and escalates to the manager.

---

### User Story 4 - Manager Visibility (Priority: P3)

When the AI handles an extend/modify request, the manager sees the details in the pipeline view and task list — what was requested, availability status, price quoted, and channel instructions given.

**Why this priority**: Operational visibility. The manager needs to know what the AI told the guest so they can act on alteration requests coming through Airbnb/Booking.com.

**Independent Test**: Trigger an extend-stay request, then check the pipeline view. Verify tool usage details (dates checked, availability result, price quoted) are visible.

**Acceptance Scenarios**:

1. **Given** the AI handled an extension request, **When** the manager views the pipeline/AI log, **Then** they can see: dates checked, availability result, price quoted, and channel instructions given.
2. **Given** an escalation task was created for the extension, **When** the manager views the task, **Then** it includes: current dates, requested new dates, price for the change, and the guest's booking channel.

---

### Edge Cases

- **Guest is an INQUIRY (not booked)**: Tool does NOT fire — inquiries don't have existing bookings to extend. The property search tool (010) handles inquiries.
- **Same-day extension**: Guest asks to extend on their checkout date — availability should still be checked starting from today.
- **Property is partially available**: Extension of 5 nights requested but only 3 are available — AI should tell the guest the maximum available extension.
- **Guest asks for dates that overlap with their existing booking**: "Can I arrive 2 days earlier?" — need to check only the NEW dates, not re-check existing ones.
- **Guest provides vague dates**: "A few more days" without specifying — AI should ask for specific dates before calling the tool.
- **Price calculation fails**: AI should still confirm availability and escalate pricing to the manager.
- **Multiple extensions in one conversation**: Guest extends, then asks to extend again — each request should check against the latest dates.

## Requirements *(mandatory)*

### Functional Requirements

**Availability Check**

- **FR-001**: AI MUST check real-time availability of the guest's current property for the requested date extension/modification.
- **FR-002**: Availability MUST be checked against the authoritative booking source (same approach as the property search tool — calendar/reservation data).
- **FR-003**: For shortened stays, the AI MUST NOT require an availability check — the property becomes more available, not less.

**Price Calculation**

- **FR-004**: AI MUST provide the price for additional nights when the property is available for the extended dates.
- **FR-005**: Price calculation MUST use the property's actual pricing (not a guess or average).
- **FR-006**: If price calculation fails or is unavailable, the AI MUST still confirm availability and escalate pricing to the manager.

**Channel-Aware Instructions**

- **FR-007**: For Airbnb guests, the AI MUST instruct them to submit an alteration request through Airbnb and confirm the host will approve it promptly.
- **FR-008**: For Booking.com guests, the AI MUST instruct them to modify their reservation through Booking.com.
- **FR-009**: For Direct/WhatsApp guests, the AI MUST confirm the extension and create an escalation task for the manager to process the modification.
- **FR-010**: The AI MUST identify the guest's booking channel from their reservation data and apply the correct flow automatically.

**Escalation**

- **FR-011**: For all channels, the AI MUST create an escalation task when a date modification is requested, containing: current dates, requested new dates, price for the change, guest's channel, and any special notes.
- **FR-012**: Escalation urgency MUST be "scheduled" for routine extensions, "immediate" if the guest needs same-day changes.

**Scope**

- **FR-013**: This tool MUST only be available to the guest coordinator (CONFIRMED/CHECKED_IN guests). INQUIRY guests do not have bookings to extend.
- **FR-014**: The tool MUST use the existing tool use infrastructure from feature 010 — same `createMessage()` tool loop, same handler registry pattern.
- **FR-015**: Tool usage MUST be logged to the pipeline view (same `ragContext` metadata pattern as 010).

### Key Entities

- **Date Extension Request**: The guest's request containing: current checkout date, desired new checkout (or check-in) date, and the number of additional (or fewer) nights.
- **Availability Result**: Whether the property is available for the requested dates, and if partially available, the maximum extension possible.
- **Price Quote**: The calculated cost for the additional nights, based on the property's actual pricing.

## Assumptions

- The property's calendar data (via Hostaway) accurately reflects availability including bookings from all channels.
- Hostaway's price calculation endpoint provides accurate per-night pricing for the property.
- The guest coordinator system prompt can be extended with tool instructions (same pattern as the screening agent in 010).
- The existing escalation/task system handles date modification requests without schema changes.
- Guests always know their desired dates or can provide them when asked.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a guest asks to extend their stay, the AI responds with availability and pricing in the same message — no manager lookup needed for the initial answer.
- **SC-002**: 95% of availability checks return accurate results (property actually available/unavailable as stated).
- **SC-003**: Channel-specific instructions are correct 100% of the time — Airbnb guests are never told to "contact us directly" and Direct guests are never told to "submit through Airbnb."
- **SC-004**: The AI response time is not degraded by more than 3 seconds when the extend-stay tool is invoked.
- **SC-005**: Managers receive an escalation task for every date modification request with all necessary details to process it.
- **SC-006**: The extend-stay tool reuses the existing tool infrastructure from 010 — no changes to the core `createMessage()` tool loop.
