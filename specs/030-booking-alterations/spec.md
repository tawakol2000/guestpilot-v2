# Feature Specification: Booking Alteration Accept/Reject

**Feature Branch**: `030-booking-alterations`  
**Created**: 2026-04-04  
**Status**: Draft  

## Clarifications

### Session 2026-04-04

- Q: How should GuestPilot obtain alteration data? → A: Hostaway sends a system message into the conversation when an alteration request is received. This message is already detected by GuestPilot (AI is skipped, a manager task is created). That same detection is the trigger — on detecting the alteration system message, GuestPilot fetches the alteration details from the Hostaway API and attaches them to the conversation.
- Q: Where should the alteration panel appear in the inbox UI? → A: Top of the right panel, above the message thread — same position as the inquiry action block from feature 029.
- Q: Should GuestPilot automatically send a chat message to the guest after accept/reject? → A: No — the booking channel (Airbnb/Booking.com) already notifies the guest officially. No duplicate message sent by GuestPilot.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Alteration Details (Priority: P1)

A guest submits a booking alteration request (e.g., date change, guest count change) through Airbnb or Booking.com. Hostaway sends a system message into the GuestPilot conversation indicating the alteration has been received. GuestPilot detects this message, fetches the alteration details from Hostaway, and displays an alteration panel in the conversation showing the original booking values side-by-side with the proposed new values.

**Why this priority**: Hosts cannot make an informed accept/reject decision without first understanding what is being requested. Visibility is the foundation of all downstream actions.

**Independent Test**: Can be tested by simulating the Hostaway system message in a conversation — GuestPilot detects it, fetches alteration details, and the host sees original check-in/check-out/guest count alongside the proposed values without needing to take any action.

**Acceptance Scenarios**:

1. **Given** a reservation has a pending alteration request and Hostaway has sent the alteration system message, **When** the host opens that conversation in the inbox, **Then** an alteration panel is visible showing the original and proposed values (dates, guest count) with a clear "Pending Alteration" label.
2. **Given** a reservation has no pending alteration (no alteration system message detected), **When** the host views the conversation, **Then** no alteration panel is shown.
3. **Given** an alteration was previously accepted or rejected, **When** the host views the conversation, **Then** the panel shows the resolved state (accepted/rejected) rather than action buttons.

---

### User Story 2 - Accept a Booking Alteration (Priority: P2)

The host reviews a pending alteration and decides to approve it. They click Accept in GuestPilot and the alteration is confirmed directly in Hostaway/the booking channel — no need to open the Hostaway dashboard or the channel's own platform.

**Why this priority**: Accepting alterations is the primary workflow action. A fast, in-app accept flow saves the host significant time and reduces the risk of the alteration expiring unanswered.

**Independent Test**: Can be fully tested by clicking Accept on a pending alteration and verifying the booking's dates/guest count update to the proposed values.

**Acceptance Scenarios**:

1. **Given** a pending alteration is displayed, **When** the host clicks "Accept Alteration", **Then** the alteration is confirmed, the booking updates to the new values, and the panel shows a success state.
2. **Given** the Hostaway dashboard connection has expired, **When** the host clicks Accept, **Then** the button shows an error and prompts the host to reconnect.
3. **Given** the alteration was already acted on externally (e.g., via Hostaway dashboard), **When** the host clicks Accept, **Then** a clear message informs them the alteration is no longer pending.

---

### User Story 3 - Reject a Booking Alteration (Priority: P3)

The host reviews a pending alteration and decides to decline it. They click Reject in GuestPilot and the rejection is sent through Hostaway — keeping the original booking dates/guest count intact.

**Why this priority**: Rejection is equally important as acceptance but listed P3 because hosts who can view and accept alterations already cover the most common case; rejection is a secondary but required action.

**Independent Test**: Can be fully tested by clicking Reject on a pending alteration and verifying the booking remains at its original values and the panel reflects a rejected state.

**Acceptance Scenarios**:

1. **Given** a pending alteration is displayed, **When** the host clicks "Reject Alteration" and confirms the confirmation prompt, **Then** the alteration is declined, the booking retains its original values, and the panel shows a rejected state.
2. **Given** the booking channel does not support API-based rejection (e.g., certain Booking.com configurations), **When** the host clicks Reject, **Then** a clear message explains rejection is not available for this channel and directs them to the channel platform directly.
3. **Given** the host clicks Reject but then cancels the confirmation dialog, **Then** no action is taken and the alteration remains pending.

---

### Edge Cases

- What happens when the alteration has expired (guest cancelled their request or channel timed it out)?
- What happens when the connection to the booking management platform is expired at the moment of accept/reject?
- How does the system handle an alteration for a channel that only supports accepting (not rejecting)?
- What if the alteration only changes guest count, not dates — should the display still be shown?
- What if a reservation has multiple sequential alteration requests (only the latest pending one should be actionable)?
- What if the Hostaway alteration details API call fails after the system message is detected?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST display a pending alteration panel within a reservation conversation showing the original booking values (check-in date, check-out date, guest count) and the proposed new values.
- **FR-002**: System MUST clearly distinguish fields that have changed from fields that are unchanged.
- **FR-003**: System MUST display Accept and Reject action buttons on the alteration panel when the alteration is in a pending state.
- **FR-004**: System MUST remove action buttons and show a resolved state (accepted or rejected) once an alteration has been actioned.
- **FR-005**: System MUST require a confirmation step before submitting a rejection (to prevent accidental rejections).
- **FR-006**: System MUST provide visual feedback (loading state, success state, error state) on action buttons during and after the accept/reject operation.
- **FR-007**: System MUST handle cases where the booking channel does not support API-based rejection and display an appropriate message directing the host to act on the channel platform directly.
- **FR-008**: System MUST handle an expired or missing platform connection gracefully, showing an error with a prompt to reconnect rather than a silent failure.
- **FR-009**: System MUST handle the case where an alteration has already been actioned externally (conflict response), informing the host to refresh and check the current status.
- **FR-010**: System MUST NOT show the alteration panel on conversations with no pending or recent alteration.
- **FR-013**: The alteration panel MUST appear at the top of the right panel in the inbox, above the message thread — consistent with the inquiry action block position from feature 029.
- **FR-014**: System MUST NOT automatically send a chat message to the guest after the host accepts or rejects an alteration. Official guest notification is handled by the booking channel (Airbnb/Booking.com).
- **FR-011**: System MUST detect the Hostaway alteration system message in a conversation and use it as the trigger to fetch and store alteration details. The AI response MUST be skipped for this message type (existing behaviour preserved).
- **FR-012**: System MUST handle failure to fetch alteration details after the trigger message is detected, displaying a graceful error state in the alteration panel rather than crashing or showing nothing.

### Key Entities

- **BookingAlteration**: Represents a guest's proposed change to a reservation. Attributes: original check-in, original check-out, original guest count, proposed check-in, proposed check-out, proposed guest count, current status (pending / accepted / rejected / expired), channel source, Hostaway alteration ID.
- **AlterationActionLog**: Audit record of each accept/reject action taken. Attributes: reservation, action type (accept/reject), initiated by (user email), timestamp, outcome (success/failed), error detail if failed.
- **Reservation**: Existing entity extended to carry the current pending alteration (if any).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A host can view, accept, or reject a pending alteration without leaving GuestPilot — 0 context switches to external platforms required when the connection is active.
- **SC-002**: Accept and reject actions complete and reflect the updated booking state within 5 seconds of the host's confirmation.
- **SC-003**: 100% of accept/reject actions are logged with the initiating user's identity and outcome for audit purposes.
- **SC-004**: When an accept/reject fails, the host receives a human-readable explanation in 100% of cases — no silent failures or blank error states.
- **SC-005**: The alteration detail panel renders within the normal inbox load time — no additional page load or navigation required.

## Assumptions

- The alteration accept/reject feature uses the same Hostaway dashboard JWT authentication mechanism established in feature 029 (inquiry accept/reject). No new auth setup is required from the host if they are already connected.
- Only one pending alteration per reservation is active at a time; if multiple exist, the most recent pending one is shown.
- All alteration data (original vs proposed values) is available from the Hostaway booking management system's alteration API.
- The exact API endpoints for accepting and rejecting alterations on the Hostaway internal dashboard are not yet confirmed; they will be discovered by intercepting network traffic when a real pending alteration is present. Placeholder endpoints will be used during development and replaced before launch.
- Channel support for alteration rejection may vary (e.g., some channels only allow acceptance); the system will detect unsupported operations via error responses and display appropriate guidance.
- Alteration requests do not have a hard expiry timer visible to the host in this version; expiry handling is managed by the channel.
- The Hostaway alteration system message has a consistent, detectable pattern (e.g., message content or sender type) that can be reliably identified in the existing message processing pipeline.

## Out of Scope

- Initiating a booking alteration on behalf of the host (host-side alteration requests).
- Proposing counter-offers or modified alternatives to the guest's request.
- Alteration history browsing (beyond showing the current or most recent resolved alteration).
- Push notifications for new incoming alteration requests (separate notification feature).
- Supporting channels beyond Airbnb and Booking.com in the first version.
