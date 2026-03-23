# Feature Specification: Document Checklist — Screening-to-Coordinator Handover

**Feature Branch**: `017-document-checklist`
**Created**: 2026-03-23
**Status**: Draft
**Input**: User description: "Screening agent creates a document checklist based on screening outcome. Guest coordinator uses it to request and track document submission (passports, marriage certificates) via guest images."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Screening Agent Creates Document Checklist (Priority: P1)

During the screening process, the screening agent gathers the guest's nationality, party composition, and relationship status. When the screening agent escalates to the manager with a **booking acceptance recommendation**, it also creates a document checklist defining what documents are required from the guest. The screening agent MUST NOT create a checklist when recommending rejection.

The checklist is based on the screening rules:

- **All guests** must submit passports or government-issued photo IDs (one per person in the party). Passports, national ID cards, and driver's licenses all count.
- **Arab married couples** must additionally submit a marriage certificate
- The number of IDs required matches the guest count from the reservation (must be ≥ 1)

The screening agent calls the `create_document_checklist` tool in the same API turn as the escalation. The model calls the tool first, receives confirmation, then outputs its JSON response with the manager escalation. If the tool call fails, the escalation still proceeds — checklist creation is fire-and-forget.

If the screening agent calls the tool more than once for the same reservation (e.g., re-evaluation after new info), the latest call overwrites the previous checklist.

**Why this priority**: Without the checklist, the coordinator has no structured knowledge of what documents are needed. This is the foundation of the entire handover.

**Independent Test**: In the sandbox as screening agent, complete a screening conversation. Verify that the screening agent calls the `create_document_checklist` tool with the correct document requirements based on nationality and party composition.

**Acceptance Scenarios**:

1. **Given** a French couple (2 guests, non-Arab), **When** the screening agent escalates with "eligible-non-arab", **Then** a checklist is created with `passportsNeeded: 2, marriageCertNeeded: false`.
2. **Given** an Egyptian married couple (2 guests, Arab), **When** the screening agent escalates with "eligible-arab-married", **Then** a checklist is created with `passportsNeeded: 2, marriageCertNeeded: true`.
3. **Given** an Arab family of 4, **When** the screening agent escalates with acceptance, **Then** a checklist is created with `passportsNeeded: 4, marriageCertNeeded: false`.
4. **Given** a single Lebanese guest, **When** the screening agent escalates, **Then** a checklist is created with `passportsNeeded: 1, marriageCertNeeded: false`.
5. **Given** the screening agent recommends rejection, **Then** NO checklist is created.
6. **Given** the screening agent calls the tool but it fails, **Then** the escalation still proceeds normally. No checklist exists — FR-011 applies.

---

### User Story 2 - Coordinator Sees and Acts on Document Checklist (Priority: P2)

When a guest's booking is accepted (status changes to CONFIRMED) and the guest messages, the coordinator AI sees the document checklist in its context (injected as `### DOCUMENT CHECKLIST ###`). If documents are pending, the coordinator asks the guest to send them.

**Document asking behavior:**
- **First message after acceptance**: Always mention pending documents alongside the welcome.
- **Subsequent messages**: Only remind about documents when the conversation has a natural pause or the guest raises an unrelated topic. Do not repeat the request on every message.
- **Checklist complete**: The checklist section disappears from context entirely. The coordinator never mentions documents.

The checklist persists across reservation status changes (CONFIRMED → CHECKED_IN). It is not tied to a specific status.

**Why this priority**: The coordinator needs to see the checklist to act on it. Without this, the checklist created in US1 is useless.

**Independent Test**: After a booking is accepted and a checklist exists, send a message as the guest. Verify the coordinator's response references the pending documents.

**Acceptance Scenarios**:

1. **Given** a CONFIRMED reservation with a checklist showing 0/2 passports and marriage cert pending, **When** the guest sends "Hi, we just got the booking confirmation!", **Then** the coordinator welcomes them and asks them to send their passports and marriage certificate through the chat.
2. **Given** a CONFIRMED reservation where 1/2 passports have been received, **When** the guest sends a general question, **Then** the coordinator answers the question AND mentions that 1 passport and the marriage certificate are still needed.
3. **Given** a CONFIRMED reservation where all documents have been received, **When** the guest messages, **Then** the coordinator does NOT mention documents (checklist section not in context).
4. **Given** a CHECKED_IN reservation with pending documents, **When** the guest messages, **Then** the coordinator still sees and acts on the checklist (carried over from CONFIRMED).

---

### User Story 3 - Coordinator Tracks Document Receipt from Images (Priority: P3)

When a CONFIRMED or CHECKED_IN guest sends an image and a pending checklist exists, the coordinator AI analyzes what the image shows. If it looks like a government-issued photo ID (passport, national ID, driver's license) or marriage certificate, the coordinator calls `mark_document_received` to update the checklist and confirms receipt to the guest. For recognized documents, the tool call **replaces** the standard image escalation. For unrecognized or ambiguous images, the standard image handling (escalate to manager) applies.

The `mark_document_received` tool is only available to the coordinator when a checklist exists AND has pending items. When the checklist is complete or absent, the tool is not included in the API call — images fall through to standard handling.

The tool returns the updated checklist state as a JSON string (e.g., `{"passportsReceived": 1, "passportsNeeded": 2, "marriageCertReceived": false}`), which the AI uses to inform the guest of the remaining requirements.

**Why this priority**: Automatic tracking removes manual work for the property manager. But it depends on US1 (checklist exists) and US2 (coordinator sees it).

**Independent Test**: With a pending checklist, send an image of a passport. Verify the coordinator calls the mark tool, the checklist updates, and the response confirms receipt with the updated count.

**Acceptance Scenarios**:

1. **Given** a checklist with 0/2 passports pending, **When** the guest sends a passport photo, **Then** the coordinator identifies it, calls `mark_document_received(type: "passport")`, and responds with "Got it, thanks! That's 1 of 2. Please send the second one when you can."
2. **Given** a checklist with 1/2 passports and marriage cert pending, **When** the guest sends a marriage certificate photo, **Then** the coordinator marks the marriage cert as received and reminds about the remaining passport.
3. **Given** a checklist with all documents received, **When** the guest sends another image, **Then** the `mark_document_received` tool is NOT available. Standard image handling applies (escalate to manager).
4. **Given** a guest sends a blurry or unclear image, **When** the coordinator cannot identify the document type, **Then** it asks the guest what the document is, or escalates for manager review.
5. **Given** all passports already received, **When** the guest sends another passport photo, **Then** the AI says "We already have all the IDs we need, thanks!" and does NOT increment the count.
6. **Given** a guest sends an image with no text (image-only message) and a pending checklist, **Then** the coordinator still analyzes the image and calls the tool if it recognizes a document.
7. **Given** the `mark_document_received` tool call fails, **Then** the AI still responds to the guest and falls back to standard image escalation.

---

### User Story 4 - Operator Sees Checklist in Inbox (Priority: P4)

The property manager sees the document checklist status in the inbox conversation detail panel (right sidebar). It shows each required document, its status (pending/received), and allows manual override (mark as received or reset).

**Why this priority**: Operator visibility and manual control. If the AI misidentifies a document or misses one, the manager can fix it.

**Independent Test**: Open a conversation with a pending checklist. Verify the sidebar shows the checklist with status indicators and manual toggle buttons.

**Acceptance Scenarios**:

1. **Given** a conversation with a document checklist, **When** the operator views the conversation, **Then** the sidebar shows "Documents: 1/2 passports, marriage cert pending" with visual indicators.
2. **Given** a pending passport, **When** the operator clicks to manually mark it as received, **Then** the checklist updates immediately and the AI sees the updated count on the next message.

---

### Edge Cases

- What happens when a guest sends multiple passport photos in one message? Each distinct passport should increment the count by 1 (up to the needed amount).
- What happens when the screening agent doesn't call the checklist tool? (e.g., tool error, rejection recommendation, edge case screening) The coordinator functions normally without document prompting (FR-011).
- What happens when guest count changes after checklist creation? (e.g., reservation modified from 2 to 3 guests) The checklist is updatable by the manager via the sidebar.
- What happens for DIRECT/WhatsApp bookings that skip screening? No checklist is created — the coordinator handles documents ad-hoc or the manager creates one manually.
- What happens when the same guest has multiple reservations? Each reservation has its own checklist.
- What happens if the AI incorrectly identifies a non-document image as a passport? The manager can reset it in the sidebar.
- What happens when guest count is 0 or null? The screening agent should NOT create a checklist (passportsNeeded must be ≥ 1).
- What happens when a reservation is cancelled after checklist creation? Checklist is ignored — AI is disabled for cancelled reservations.
- What happens with concurrent writes? (manager marks received while AI marks received simultaneously) Last write wins. Prisma JSON writes are atomic per operation. Acceptable for this use case.
- What happens when the guest sends a driver's license or national ID card instead of a passport? Any government-issued photo ID counts — it increments the passport count.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The screening agent MUST have access to a `create_document_checklist` tool that records document requirements for the reservation. The tool MUST only be called on acceptance recommendations, never on rejections.
- **FR-002**: The checklist tool MUST accept: number of passports/IDs needed (≥ 1) and whether a marriage certificate is needed.
- **FR-003**: The checklist MUST be stored on the reservation and persist across sessions and status changes (CONFIRMED → CHECKED_IN).
- **FR-004**: The guest coordinator MUST see the current checklist state in its prompt context (injected as `### DOCUMENT CHECKLIST ###`) only when items are pending. Complete checklists are not shown.
- **FR-005**: The guest coordinator MUST have access to a `mark_document_received` tool, but ONLY when a checklist exists with pending items. When complete or absent, the tool is not provided.
- **FR-006**: The `mark_document_received` tool MUST NOT allow the passport count to exceed the number needed. It MUST return the updated checklist state as JSON.
- **FR-007**: The coordinator system prompt MUST instruct: ask for documents on first message after acceptance, then only when natural in conversation. Never on every message.
- **FR-008**: The checklist state MUST be visible to the property manager in the inbox conversation detail sidebar.
- **FR-009**: The property manager MUST be able to manually override the checklist (mark received/reset items).
- **FR-010**: The checklist MUST be created at screening escalation time (before booking acceptance). If the tool is called multiple times, the latest call overwrites.
- **FR-011**: If no checklist exists for a conversation, the coordinator MUST function normally without document prompting.
- **FR-012**: Checklist creation is fire-and-forget — tool failure MUST NOT block the screening agent's escalation.
- **FR-013**: For recognized document images (when checklist pending), `mark_document_received` replaces standard image escalation. For unrecognized images, standard escalation applies.
- **FR-014**: The checklist `updatedAt` timestamp MUST update on every tool call and manual override.

### Key Entities

- **DocumentChecklist**: Stored as JSON in `Reservation.screeningAnswers.documentChecklist`. Fields:
  - `passportsNeeded` (integer, ≥ 1, required)
  - `passportsReceived` (integer, 0..passportsNeeded, required)
  - `marriageCertNeeded` (boolean, required)
  - `marriageCertReceived` (boolean, required)
  - `createdAt` (ISO timestamp, required)
  - `updatedAt` (ISO timestamp, required)
  - `createdBy` (string: "screening-agent" or "manager", required)

### Assumptions

- "Passport" in the checklist means any government-issued photo ID — passport, national ID card, driver's license all count interchangeably.
- Only passports/IDs and marriage certificates are tracked. No other document types for now.
- The screening agent knows the guest count from the reservation context and the nationality/relationship status from the conversation.
- Passport photos are identifiable by the AI with reasonable accuracy (SC-003 targets 80%+, manager can override the rest).
- One checklist per reservation. If a guest has multiple reservations, each has its own.
- The `Reservation.screeningAnswers` JSON field (already exists, currently empty) stores the checklist data — no new model needed.
- Concurrent writes use last-write-wins semantics (Prisma JSON writes are atomic per operation).
- Reservation status sync (INQUIRY→CONFIRMED) has been fixed (016 branch) but is acknowledged as a dependency.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 90%+ of screening escalations that result in acceptance include a document checklist (screening agent calls the tool).
- **SC-002**: The coordinator mentions pending documents within the first 2 messages after booking acceptance for reservations with incomplete checklists.
- **SC-003**: 80%+ of passport/marriage certificate images are correctly identified and tracked by the AI without manager intervention.
- **SC-004**: Zero instances of the coordinator asking for documents when all documents have been received.
- **SC-005**: Property managers can see and override checklist status for every conversation that has one.
