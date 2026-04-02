# Feature Specification: Inquiry Accept/Reject

**Feature Branch**: `029-inquiry-accept-reject`  
**Created**: 2026-04-03  
**Status**: Draft  
**Input**: Accept and reject reservation inquiries from GuestPilot using Hostaway internal dashboard API with Connect Hostaway authentication flow in settings

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect Hostaway Dashboard Account (Priority: P1)

A property manager opens GuestPilot settings and connects their Hostaway dashboard account. This enables all subsequent inquiry management actions. Without this connection, accept/reject functionality is unavailable.

The manager clicks "Connect Hostaway Dashboard," which opens the Hostaway login page in a popup window. They log in using their existing Hostaway credentials (including any two-factor authentication if prompted). Once logged in, they activate a provided bookmarklet or helper that extracts their session token and sends it back to GuestPilot. The connection status and remaining validity period are displayed in settings.

**Why this priority**: This is the prerequisite for all other functionality. Without a valid dashboard connection, no inquiry actions can be performed.

**Independent Test**: Can be fully tested by connecting an account and verifying the connection status appears with a validity countdown. Delivers value by establishing the authentication foundation.

**Acceptance Scenarios**:

1. **Given** a property manager is on the settings page with no Hostaway dashboard connection, **When** they complete the connection flow, **Then** the settings page shows "Connected" with the number of days remaining until re-authentication is needed.
2. **Given** a property manager has a connected account, **When** they view the settings page, **Then** they see the current connection status and days remaining (e.g., "Connected — 87 days remaining").
3. **Given** a property manager's connection has expired, **When** they view the settings page, **Then** they see "Disconnected — please reconnect" and the connect button is prominently displayed.
4. **Given** a property manager is connecting their account, **When** the Hostaway login popup opens, **Then** they can log in normally including completing any email-based two-factor authentication if required.
5. **Given** a property manager has a connected account, **When** they want to disconnect or reconnect, **Then** they can do so from the settings page.

---

### User Story 2 - Approve an Inquiry (Priority: P1)

A property manager views an inquiry in GuestPilot's inbox and decides to approve it. They click an "Approve" button directly within GuestPilot. The system sends the approval to Hostaway, which propagates it to the booking channel (Airbnb, Booking.com, direct booking engine, etc.). The inquiry status updates in GuestPilot to reflect the approval.

**Why this priority**: Approving inquiries is the primary revenue-generating action. Delayed approvals lead to lost bookings.

**Independent Test**: Can be fully tested by approving a test inquiry and verifying the status changes both in GuestPilot and in the Hostaway dashboard.

**Acceptance Scenarios**:

1. **Given** a reservation with "inquiry" status is displayed in the inbox, **When** the manager clicks "Approve," **Then** the approval is sent to Hostaway and the reservation status updates to reflect the approval.
2. **Given** a reservation with "pending" status (Request to Book) is displayed, **When** the manager clicks "Approve," **Then** the reservation is approved and its status changes to confirmed.
3. **Given** the Hostaway dashboard connection has expired, **When** the manager tries to approve an inquiry, **Then** they see a clear message directing them to reconnect in settings.
4. **Given** an inquiry has already been approved, **When** the manager views it, **Then** the approve button is no longer available.
5. **Given** the approval request fails (network error, Hostaway error), **When** the manager clicks "Approve," **Then** they see a clear error message and can retry.

---

### User Story 3 - Reject/Decline an Inquiry (Priority: P1)

A property manager views an inquiry and decides to reject it. They click a "Reject" button within GuestPilot. The system sends the rejection to Hostaway. The inquiry status updates accordingly. If the specific rejection action is not supported for a particular channel (e.g., Airbnb), the system informs the manager and suggests alternative actions.

**Why this priority**: Rejecting unsuitable inquiries is equally critical — it frees up calendar availability and sets clear expectations with guests.

**Independent Test**: Can be fully tested by rejecting a test inquiry and verifying the status changes in both GuestPilot and Hostaway.

**Acceptance Scenarios**:

1. **Given** a reservation with "inquiry" or "pending" status is displayed, **When** the manager clicks "Reject," **Then** a confirmation dialog appears before proceeding.
2. **Given** the manager confirms rejection, **When** the rejection is sent, **Then** the reservation status updates to declined/denied in GuestPilot.
3. **Given** the rejection is not supported for a specific channel, **When** the manager clicks "Reject," **Then** they see a message explaining the limitation and suggesting they complete the action on the channel directly.
4. **Given** the Hostaway dashboard connection has expired, **When** the manager tries to reject, **Then** they see a message directing them to reconnect.
5. **Given** a rejection fails, **When** the error occurs, **Then** the manager sees a clear error message and can retry.

---

### User Story 4 - Cancel a Reservation (Priority: P1)

A property manager decides to cancel an existing reservation. They click a "Cancel" button within GuestPilot. The system sends the cancellation to Hostaway. The reservation status updates accordingly.

**Why this priority**: Managers need to cancel problematic reservations or unwanted bookings promptly.

**Independent Test**: Can be fully tested by cancelling a test reservation and verifying the status changes in both GuestPilot and Hostaway.

**Acceptance Scenarios**:

1. **Given** a reservation is displayed in the inbox, **When** the manager clicks "Cancel," **Then** a confirmation dialog appears before proceeding.
2. **Given** the manager confirms cancellation, **When** the cancellation is sent, **Then** the reservation status updates to cancelled in GuestPilot.
3. **Given** the Hostaway dashboard connection has expired, **When** the manager tries to cancel, **Then** they see a message directing them to reconnect.
4. **Given** a cancellation fails, **When** the error occurs, **Then** the manager sees a clear error message and can retry.

---

### User Story 5 - Connection Health Monitoring (Priority: P2)

The system proactively monitors the health of the Hostaway dashboard connection. When the connection is approaching expiry or has expired, the manager is notified so they can re-authenticate before it impacts operations.

**Why this priority**: Prevents disruption to inquiry management. A silently expired connection would block all accept/reject actions without the manager understanding why.

**Independent Test**: Can be tested by simulating an approaching expiry and verifying notifications appear.

**Acceptance Scenarios**:

1. **Given** the connection will expire within 7 days, **When** the manager views the inbox or settings, **Then** they see a warning banner about upcoming expiry.
2. **Given** the connection has expired, **When** the manager tries any inquiry action, **Then** they are prompted to reconnect with a direct link to settings.

---

### Edge Cases

- What happens when the manager tries to approve an inquiry that was already approved/rejected from the Hostaway dashboard directly?
- What happens when multiple team members try to approve/reject the same inquiry simultaneously?
- What happens when Hostaway's internal API is temporarily unavailable?
- What happens when the stored session token becomes invalid before its expected expiry (e.g., user changes Hostaway password)?
- What happens when a reservation was created on a channel that restricts certain actions to the channel's own interface?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a "Connect Hostaway Dashboard" flow in the settings page that allows property managers to authenticate their Hostaway dashboard account.
- **FR-002**: System MUST guide users to open the Hostaway dashboard, log in with their own credentials (including any two-factor authentication), and use a provided bookmarklet to securely transfer their session token back to GuestPilot.
- **FR-003**: System MUST extract and securely store the dashboard session token after the user completes authentication.
- **FR-004**: System MUST display the connection status and days remaining until re-authentication on the settings page.
- **FR-005**: System MUST provide an "Approve" action on reservations with inquiry or pending status.
- **FR-006**: System MUST provide a "Reject" action on reservations with inquiry or pending status, with a confirmation dialog before executing.
- **FR-007**: System MUST provide a "Cancel" action on confirmed reservations, with a confirmation dialog before executing.
- **FR-008**: System MUST send approve/reject/cancel actions to Hostaway's internal dashboard API on behalf of the authenticated user.
- **FR-009**: System MUST update the reservation status in GuestPilot after a successful approve/reject/cancel action.
- **FR-010**: System MUST display the most recent action taken on a reservation (e.g., "Approved by Ahmed, 2 hours ago") wherever the reservation is shown.
- **FR-011**: System MUST display clear error messages when actions fail, with the ability to retry.
- **FR-012**: System MUST inform the user when a specific action is not supported for a particular channel, and suggest alternatives.
- **FR-013**: System MUST warn users when their dashboard connection is approaching expiry (within 7 days).
- **FR-014**: System MUST block approve/reject/cancel actions and prompt for reconnection when the dashboard connection has expired.
- **FR-015**: System MUST store the dashboard session token encrypted at rest.
- **FR-016**: System MUST display approve/reject/cancel buttons in two locations: inline in the inbox list view, and as a prominent action block at the top of the right panel in the conversation/chat page.
- **FR-017**: System MUST only show approve/reject/cancel buttons for reservations where the action is applicable (correct status).
- **FR-018**: System MUST handle the case where an action was already performed externally (e.g., approved via Hostaway dashboard) gracefully, without crashing or showing misleading errors.

### Key Entities

- **Dashboard Connection**: Represents the authenticated link between a GuestPilot tenant and their Hostaway dashboard account. One connection per tenant; if a different team member reconnects, the previous connection is overwritten. Key attributes: tenant, session token (encrypted), issued date, expiry date, connection status, connected by (user who last connected).
- **Inquiry Action Log**: Represents an approve, reject, or cancel action taken on a reservation. The most recent action is displayed to users on the reservation (e.g., "Approved by Ahmed, 2 hours ago"). Full history is stored backend-side for debugging. Key attributes: reservation, action type (approve/reject/cancel), initiated by (user), timestamp, result (success/failure), error details if failed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Property managers can approve an inquiry in under 5 seconds from clicking the button to seeing the updated status.
- **SC-002**: Property managers can connect their Hostaway dashboard account in under 2 minutes, including any two-factor authentication steps.
- **SC-003**: The connection flow requires no technical knowledge — no copy-pasting tokens, no browser developer tools, no manual steps beyond logging into Hostaway and clicking one helper button.
- **SC-004**: 95% of approve/reject/cancel actions succeed on the first attempt (excluding expired connections).
- **SC-005**: Property managers are warned at least 7 days before their dashboard connection expires.
- **SC-006**: When an action fails, the error message clearly explains what went wrong and what the user should do next.
- **SC-007**: The system correctly reflects reservation status changes within 10 seconds of a successful action.

## Clarifications

### Session 2026-04-03

- Q: Where do approve/reject/cancel buttons appear in the UI? → A: Both inbox list view (inline) and conversation/chat page (as a prominent action block at the top of the right panel).
- Q: Is the dashboard connection shared across all tenant users or per-user? → A: One connection per tenant. Any team member who connects overwrites the previous connection.
- Q: Is the action log visible to users in the UI or backend-only? → A: Lightweight — show last action taken on the reservation (e.g., "Approved by Ahmed, 2 hours ago").

## Assumptions

- The Hostaway dashboard session token has a 90-day validity period based on observed behavior. If Hostaway changes this, the expiry countdown will need adjustment.
- The session token is not bound to the originating IP address, allowing the GuestPilot backend to use it from its own servers.
- The Hostaway internal dashboard API endpoints for approve and cancel are stable and will continue to function as observed.
- The "Connect Hostaway Dashboard" flow will use a bookmarklet or lightweight helper mechanism to bridge the token from the Hostaway domain to GuestPilot, since direct cross-origin token extraction is not possible.
- Some channel-specific actions (e.g., declining an Airbnb inquiry vs. cancelling a direct booking) may behave differently. The system will communicate any channel-specific limitations clearly to the user.
- Each tenant connects one Hostaway dashboard account. Multi-user/multi-account connections are out of scope for the initial release.
- Token validation is reactive (checked when an action is attempted), not proactive. If a token is invalidated early (e.g., password change), the user discovers this on their next action attempt and is prompted to reconnect. Proactive health checks may be added in a future iteration.

## Scope Boundaries

### In Scope
- Connect Hostaway Dashboard authentication flow in settings
- Approve/accept inquiry or Request to Book
- Reject/decline inquiry or Request to Book
- Cancel confirmed reservation
- Connection status display and expiry warnings
- Error handling and retry for failed actions
- Graceful handling of channel-specific limitations (inform user if an action isn't supported for their channel)
- Encrypted storage of dashboard session tokens

### Out of Scope
- Automating the Hostaway login (bypassing CAPTCHA or two-factor authentication)
- Storing Hostaway dashboard credentials (email/password) — only the session token is stored
- Bulk approve/reject of multiple inquiries at once
- Automatic re-authentication when the session token expires (requires user interaction due to CAPTCHA/2FA)
