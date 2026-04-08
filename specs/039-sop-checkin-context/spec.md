# Feature Specification: SOP Check-in/Checkout Context Injection

**Feature Branch**: `039-sop-checkin-context`
**Created**: 2026-04-08
**Status**: Draft
**Input**: Inject pre-computed check-in/checkout situation into early check-in and late checkout SOPs so the AI reads facts instead of reasoning about dates

## User Scenarios & Testing

### User Story 1 - Early check-in with pre-computed situation (Priority: P1)

A confirmed guest asks "Can I check in early?" The get_sop tool returns the early check-in SOP. Instead of the AI reasoning about dates and availability, the SOP content already includes a computed paragraph like: "YOUR SITUATION: Check-in is in 1 day. Back-to-back booking detected. Early check-in is NOT available. Tell the guest and suggest O1 Mall." The AI reads and follows.

**Why this priority**: Eliminates the AI's most error-prone task — date arithmetic and availability logic.

**Independent Test**: Set up reservations with different check-in timings, send "Can I check in early?" and verify correct responses.

**Acceptance Scenarios**:

1. **Given** check-in is 5 days away, **When** the AI gets the early check-in SOP, **Then** the content says check-in is 5 days away, early check-in can only be confirmed 2 days before, suggest O1 Mall.
2. **Given** check-in is tomorrow and there IS a back-to-back, **When** the AI gets the SOP, **Then** it says back-to-back detected, early check-in NOT available.
3. **Given** check-in is tomorrow and NO back-to-back, **When** the AI gets the SOP, **Then** it says no conflict, early check-in may be possible, escalate to manager.
4. **Given** guest is INQUIRY status, **When** the AI gets the SOP, **Then** it gets the simple informational variant with no availability data.

---

### User Story 2 - Late checkout with pre-computed situation (Priority: P1)

Same pattern for late checkout. The SOP includes computed facts about days until checkout and back-to-back status.

**Why this priority**: Same reasoning — removes date arithmetic from the AI.

**Independent Test**: Same approach with checkout scenarios.

**Acceptance Scenarios**:

1. **Given** checkout is 4 days away, **When** the AI gets the late checkout SOP, **Then** it says can only confirm 2 days before, quote tiers.
2. **Given** checkout is tomorrow with back-to-back, **When** the AI gets the SOP, **Then** it says NOT available.
3. **Given** checkout is tomorrow without back-to-back, **When** the AI gets the SOP, **Then** it says may be possible, quote tiers, escalate.

---

### Edge Cases

- Back-to-back data unavailable (API error): default to "availability unknown, escalate to manager"
- CHECKED_IN status asking about early check-in: empty SOP variant, doesn't apply
- No check-in/checkout dates on reservation: treat as unknown, escalate

## Requirements

### Functional Requirements

- **FR-001**: System MUST compute check-in/checkout situation paragraphs using reservation dates and back-to-back booking data
- **FR-002**: System MUST inject these paragraphs into the SOP content via template variables before the AI sees them
- **FR-003**: The injected paragraph MUST tell the AI exactly what to do — no ambiguity
- **FR-004**: Injection MUST only apply to CONFIRMED and CHECKED_IN variants. INQUIRY stays informational.
- **FR-005**: System MUST fall back gracefully when data is unavailable

## Success Criteria

### Measurable Outcomes

- **SC-001**: The AI never performs date arithmetic for early check-in or late checkout requests
- **SC-002**: 100% of responses correctly reflect actual availability
- **SC-003**: No increase in response latency from the injection

## Assumptions

- Back-to-back data is derivable from `checkExtendAvailability` or similar calendar lookup
- The SOP template variable system (`{VARIABLE}` resolved via `variableDataMap`) is the injection mechanism
- This works on the current main branch without needing 037-perfect-ai-mix
