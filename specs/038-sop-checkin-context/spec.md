# Feature Specification: SOP Check-in/Checkout Context Injection

**Feature Branch**: `038-sop-checkin-context`
**Created**: 2026-04-08
**Status**: Draft
**Input**: Inject pre-computed situational paragraph into early check-in and late checkout SOPs so the AI doesn't reason about dates or availability

## User Scenarios & Testing

### User Story 1 - Early check-in request gets pre-computed situation (Priority: P1)

A confirmed guest asks "Can I check in early?" The AI calls get_sop for early check-in. Instead of the AI trying to figure out "is check-in within 2 days? is there a back-to-back?", the SOP content already includes a pre-computed paragraph like: "Check-in is in 1 day. Back-to-back booking detected — early check-in is NOT available. Tell the guest early check-in is not possible and suggest O1 Mall." The AI simply reads and follows the instruction.

**Why this priority**: This eliminates the AI's most error-prone reasoning — date arithmetic and availability logic. The application code already has this data (from PRE_COMPUTED_CONTEXT and Hostaway calendar); it just needs to inject it into the SOP content.

**Independent Test**: Set up a reservation with check-in tomorrow and a back-to-back booking. Send "Can I check in early?" through sandbox. Verify the AI says early check-in is not available without doing any date reasoning.

**Acceptance Scenarios**:

1. **Given** check-in is more than 2 days away, **When** the AI gets the early check-in SOP, **Then** the SOP content includes "Check-in is X days away. Early check-in can only be confirmed 2 days before. Tell the guest this and suggest O1 Mall."
2. **Given** check-in is within 2 days and there IS a back-to-back booking, **When** the AI gets the early check-in SOP, **Then** the SOP content includes "Check-in is tomorrow. Back-to-back booking detected — early check-in is NOT available. Tell the guest and suggest cafes at O1 Mall."
3. **Given** check-in is within 2 days and there is NO back-to-back booking, **When** the AI gets the early check-in SOP, **Then** the SOP content includes "Check-in is tomorrow. No back-to-back booking — early check-in may be possible. Tell the guest you'll check with the manager and escalate."
4. **Given** guest is INQUIRY status (not booked yet), **When** the AI gets the early check-in SOP, **Then** the SOP content is the simple informational variant ("Standard 3pm, early check-in depends on prior bookings") with NO availability data injected.

---

### User Story 2 - Late checkout request gets pre-computed situation (Priority: P1)

A checked-in guest asks "Can I check out later?" The AI calls get_sop for late checkout. The SOP content already includes a pre-computed paragraph about the checkout situation.

**Why this priority**: Same reasoning as early check-in — removes date arithmetic from the AI.

**Independent Test**: Set up a reservation checking out tomorrow with no back-to-back. Send "Can I stay a bit later tomorrow?" Verify the AI quotes tiers and offers to check with the manager.

**Acceptance Scenarios**:

1. **Given** checkout is more than 2 days away, **When** the AI gets the late checkout SOP, **Then** the SOP content includes "Checkout is X days away. Late checkout can only be confirmed 2 days before. Quote tiers and tell the guest you'll confirm closer to the date."
2. **Given** checkout is within 2 days and there IS a back-to-back, **When** the AI gets the late checkout SOP, **Then** the SOP content includes "Checkout is tomorrow. Back-to-back booking detected — late checkout is NOT available. Inform the guest."
3. **Given** checkout is within 2 days and there is NO back-to-back, **When** the AI gets the late checkout SOP, **Then** the SOP content includes "Checkout is tomorrow. No back-to-back — late checkout may be possible. Quote tiers, ask preferred time, escalate."

---

### Edge Cases

- What if back-to-back data is unavailable (Hostaway API failure)? The SOP should fall back to "availability unknown — escalate to manager to check."
- What if the guest is already past check-in (CHECKED_IN status asking about early check-in)? The CHECKED_IN variant is empty — this SOP doesn't apply.
- What if the reservation has no check-in/out dates? Treat as "dates unknown — escalate."

## Requirements

### Functional Requirements

- **FR-001**: System MUST compute the check-in/checkout situation (days away, back-to-back status, availability) before returning SOP content for early check-in and late checkout categories
- **FR-002**: System MUST inject a clear, actionable paragraph into the SOP content that tells the AI exactly what to do — no ambiguity, no date reasoning required
- **FR-003**: The injected paragraph MUST cover three scenarios: more than 2 days away, within 2 days with back-to-back, within 2 days without back-to-back
- **FR-004**: The injection MUST only apply to CONFIRMED status variants (where the guest has a booking but hasn't checked in). INQUIRY variants remain informational. CHECKED_IN variants remain unchanged.
- **FR-005**: System MUST fall back gracefully when back-to-back data is unavailable — default to "escalate to manager to check availability"
- **FR-006**: The injected content MUST be computed fresh per-request (not cached), since check-in dates and availability change daily

### Key Entities

- **Check-in Situation**: Computed per-request from reservation dates and Hostaway calendar data. Contains: days until event, back-to-back detected (boolean), recommended action (inform/deny/escalate).

## Success Criteria

### Measurable Outcomes

- **SC-001**: The AI never performs date arithmetic when handling early check-in or late checkout requests — the answer is in the SOP content
- **SC-002**: 100% of early check-in responses correctly reflect back-to-back availability (no false promises, no unnecessary denials)
- **SC-003**: Response quality for check-in/checkout requests matches or exceeds a human writing the same response given the same facts

## Assumptions

- PRE_COMPUTED_CONTEXT already has `days_until_checkin`, `days_until_checkout`, `is_within_2_days_of_checkin`, `is_within_2_days_of_checkout` from the 037-perfect-ai-mix feature
- Back-to-back booking data can be obtained from the Hostaway calendar API (already used by `checkExtendAvailability`)
- The SOP template variable system (`{VARIABLE}` in content resolved via `variableDataMap`) is the right mechanism for injection
- The CONFIRMED status variant for early check-in and late checkout is the primary target — INQUIRY and CHECKED_IN variants don't need availability injection
