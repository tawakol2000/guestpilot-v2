# Feature Specification: Web Push Notifications for Mobile PWA

**Feature Branch**: `019-web-push`
**Created**: 2026-03-23
**Status**: Draft
**Input**: User description: "Add Web Push notification support so the mobile PWA receives push notifications for guest messages, tasks, escalations, and reservation events."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator Receives Push for New Guest Messages (Priority: P1)

The property manager has the GuestPilot mobile PWA installed on their phone. When a guest sends a message through any channel (Airbnb, Booking, WhatsApp, Direct), the manager's phone receives a push notification showing the guest's name, property name, and a preview of the message. Tapping the notification opens the conversation in the app.

**Why this priority**: Guest message notifications are the core use case — the manager needs to know immediately when a guest reaches out, even when the app is closed or the phone is locked.

**Independent Test**: Subscribe to push via the mobile app. Send a guest message through Hostaway. Verify push notification arrives on the phone within seconds.

**Acceptance Scenarios**:

1. **Given** the manager has subscribed to push notifications on their phone, **When** a guest sends a message, **Then** the phone receives a push notification with title "[Guest Name] — [Property Name]" and body showing the first 200 characters of the message.
2. **Given** the manager has multiple devices subscribed (phone + tablet), **When** a guest sends a message, **Then** both devices receive the notification.
3. **Given** the app is closed/backgrounded, **When** the notification arrives, **Then** tapping it opens the app to the relevant conversation.
4. **Given** the AI is in autopilot mode and responds automatically, **When** a guest message arrives, **Then** the manager still receives the push notification (so they can monitor AI responses).

---

### User Story 2 - Operator Receives Push for Tasks and Escalations (Priority: P2)

When the AI creates a new task (escalation), the manager receives a push notification with the task title and urgency. This covers all escalation types: maintenance, complaints, booking issues, document requests, and AI-needs-help scenarios.

**Why this priority**: Escalations require human action — the manager needs to see them immediately, not when they next open the app.

**Independent Test**: Trigger an AI escalation (e.g., guest reports a broken appliance). Verify the manager receives a push with the task title.

**Acceptance Scenarios**:

1. **Given** the AI creates an "immediate" urgency task, **When** the task is saved, **Then** the manager receives a push with title "New Task" and body showing the task title and urgency.
2. **Given** the AI creates a "scheduled" task, **When** the task is saved, **Then** the manager receives a push (same as immediate — all tasks trigger push).

---

### User Story 3 - Operator Receives Push for Reservation Events (Priority: P3)

When a new reservation is created, a booking is modified, or a reservation status changes (confirmed, cancelled, checked-in, checked-out), the manager receives a push notification summarizing the change.

**Why this priority**: Reservation events affect property operations — knowing about a new booking or cancellation immediately helps with planning.

**Independent Test**: Create a new reservation via Hostaway webhook. Verify push notification arrives with guest name and event type.

**Acceptance Scenarios**:

1. **Given** a new reservation is created (via webhook), **When** the system processes it, **Then** the manager receives a push with title "New Booking" and body "[Guest Name] — [Property Name], [Check-in] to [Check-out]".
2. **Given** a reservation is modified, **When** the webhook fires, **Then** the manager receives a push with title "Booking Modified" and updated details.
3. **Given** a reservation is cancelled, **When** the webhook fires, **Then** the manager receives a push with title "Booking Cancelled" and guest/property details.

---

### User Story 4 - Subscription Management (Priority: P4)

The mobile PWA can subscribe to and unsubscribe from push notifications. The backend stores subscription data per tenant, supporting multiple devices. Expired or invalid subscriptions are automatically cleaned up.

**Why this priority**: Foundation — without subscription management, no push notifications can be sent. But it's lower priority because the mobile app team handles the frontend subscription flow.

**Independent Test**: Call the subscribe endpoint with a push subscription object. Verify it's stored. Call unsubscribe. Verify it's removed.

**Acceptance Scenarios**:

1. **Given** the mobile app requests the public key, **When** calling the key endpoint (no auth required), **Then** it returns the key needed to create a browser push subscription.
2. **Given** the mobile app subscribes (auth required), **When** sending the subscription object, **Then** it's stored linked to the tenant.
3. **Given** a device is already subscribed, **When** subscribing again with the same endpoint, **Then** the existing record is updated (no duplicate).
4. **Given** the mobile app unsubscribes, **When** sending the endpoint, **Then** the subscription is removed.
5. **Given** a push notification fails with 410/404 (subscription expired), **When** the system detects it, **Then** the subscription is automatically deleted from the database.

---

### Edge Cases

- What happens when VAPID keys are not configured? Push notifications are silently disabled — no crash, no error to guests.
- What happens when a tenant has zero subscriptions? Push send is a no-op — no error.
- What happens when the push service (Google/Apple) is temporarily down? Fire-and-forget — log warning, don't block the message flow.
- What happens when a guest sends multiple messages rapidly? Each message triggers a push (the debounce is for AI replies, not notifications).
- What happens when the manager sends a message themselves? No push for host-originated messages — only guest messages trigger push.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST send push notifications to all subscribed devices for a tenant when a guest sends a message.
- **FR-002**: The system MUST send push notifications when a new task is created (any source: AI escalation, manual).
- **FR-003**: The system MUST send push notifications for reservation events: created, modified, cancelled.
- **FR-004**: The system MUST provide an unauthenticated endpoint to retrieve the VAPID public key.
- **FR-005**: The system MUST provide an authenticated endpoint to subscribe a device (store push subscription).
- **FR-006**: The system MUST provide an authenticated endpoint to unsubscribe a device.
- **FR-007**: Subscriptions MUST be tenant-scoped — a tenant can have multiple device subscriptions.
- **FR-008**: Duplicate subscriptions (same endpoint for same tenant) MUST be updated, not duplicated.
- **FR-009**: Expired/invalid subscriptions (410/404 from push service) MUST be automatically cleaned up.
- **FR-010**: Push notification delivery MUST be fire-and-forget — failures MUST NOT block the message processing pipeline.
- **FR-011**: Missing VAPID configuration MUST silently disable push — no crashes.
- **FR-012**: Host-originated messages MUST NOT trigger push notifications (only guest messages).
- **FR-013**: Each push notification MUST include: title, body (max 200 chars), icon, and data payload with conversationId for deep linking.

### Key Entities

- **PushSubscription**: Stores a device's push subscription. Fields: id, tenantId, endpoint (unique per tenant), p256dh key, auth key, userAgent, createdAt. One tenant can have many subscriptions (multiple devices).

### Assumptions

- The mobile PWA at `https://v0-gp-mobile.vercel.app` handles the frontend push subscription flow (service worker, permission request, subscription creation). This spec covers only the backend.
- VAPID keys are generated once and stored as environment variables on Railway.
- Push notification icons are hosted on the mobile PWA domain.
- The push payload format follows the Web Push standard (title, body, icon, badge, data).
- No notification preferences or quiet hours for now — all events trigger push to all subscribed devices.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Push notifications arrive on the manager's device within 5 seconds of the triggering event (message, task, reservation).
- **SC-002**: 100% of guest messages trigger push notifications to all subscribed devices (zero missed messages).
- **SC-003**: Expired subscriptions are cleaned up within one failed delivery attempt (no stale records accumulating).
- **SC-004**: Push notification failures cause zero disruption to the core message processing pipeline.
- **SC-005**: A tenant can have up to 10 subscribed devices simultaneously with all receiving notifications.
