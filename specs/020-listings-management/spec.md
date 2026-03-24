# Feature Specification: Listings Management Page

**Feature Branch**: `020-listings-management`
**Created**: 2026-03-24
**Status**: Draft
**Input**: User description: "New Listings page with property cards, editable Hostaway data, amenity classification (default/available/on-request), AI-powered description summarization, per-listing Hostaway resync, and removal of the old settings-page knowledge base editor."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View and Edit Listing Details (Priority: P1)

The operator opens the new Listings page and sees a card for each property. Each card displays the property's data pulled from Hostaway: name, address, door code, WiFi credentials, check-in/out times, house rules, bed types, capacity, and the full amenities list. The operator can edit any field inline and save changes. Each listing card has a "Resync from Hostaway" button that re-pulls fresh data from Hostaway and updates the card (overwriting local edits with the latest Hostaway data).

The old "Listing Knowledge Base" editor in the Settings page is removed — all property data management now lives on the Listings page.

**Why this priority**: This is the foundation — operators need to see and correct property data that the AI uses. Incorrect data = incorrect AI responses.

**Independent Test**: Open Listings page. See all properties. Edit a WiFi password. Save. Verify the AI uses the new value in its next response.

**Acceptance Scenarios**:

1. **Given** 20 properties synced from Hostaway, **When** the operator opens the Listings page, **Then** all 20 properties appear as cards with their full details.
2. **Given** a property card, **When** the operator edits the door code and saves, **Then** the change persists and the AI uses the new code in responses.
3. **Given** a property card, **When** the operator clicks "Resync from Hostaway", **Then** the card refreshes with the latest data from Hostaway, replacing any local edits.
4. **Given** the Settings page, **When** the operator navigates to it, **Then** the old "Listing Knowledge Base" section is no longer present.

---

### User Story 2 - Classify Amenities (Priority: P2)

Each property has a list of amenities pulled from Hostaway as a flat comma-separated string (e.g., "Swimming pool, Extra towels, Air conditioning, Baby crib, Internet, Parking"). The problem: the AI treats all amenities the same — it doesn't know which are permanent features of the property (pool, AC, parking) vs. which are items that need to be requested and delivered (extra towels, baby crib, hair dryer).

The operator can classify each amenity into one of three categories:
- **Available** — permanent feature, always there (pool, AC, internet, parking)
- **On Request** — needs to be scheduled/delivered by housekeeping (towels, crib, hair dryer, blender)
- **Default** — unclassified (original state from Hostaway)

The AI uses these classifications:
- **Amenity request SOP** receives the "on request" list so it knows which items to schedule
- **Property description context** receives the "available" list so the AI accurately describes the property

**Why this priority**: This directly fixes the problem of the AI trying to schedule permanent amenities or confirming delivery of items that are already there.

**Independent Test**: Classify "Swimming pool" as Available and "Extra towels" as On Request. Ask the AI "do you have a pool?" → confirms it's available. Ask "can I get extra towels?" → offers to schedule delivery.

**Acceptance Scenarios**:

1. **Given** a property with 15 amenities, **When** the operator opens the amenities section, **Then** each amenity shows with a 3-way toggle (Default / Available / On Request).
2. **Given** "Extra towels" classified as On Request, **When** a guest asks for extra towels, **Then** the AI's SOP includes "extra towels" in the on-request list and offers to schedule delivery.
3. **Given** "Swimming pool" classified as Available, **When** a guest asks about amenities, **Then** the AI's property context lists it as an available feature.
4. **Given** a new amenity that hasn't been classified, **When** viewing it, **Then** it shows as "Default" (treated as available in the AI context, same as current behavior).

---

### User Story 3 - Summarize Property Descriptions (Priority: P3)

Each property has a `listingDescription` pulled from Hostaway — a long, marketing-heavy paragraph meant for guests browsing listings. It's too verbose for the AI context and wastes tokens. The operator can click a "Summarize" button that uses AI to condense the description into a concise, informative paragraph useful for the AI — stripping marketing fluff, keeping factual details (location, nearby landmarks, transport, key features).

There are two summarization options:
- **Per-listing**: Summarize one property's description
- **Summarize All**: Batch-summarize all properties in one click

The summarized description replaces the long one in the AI's context. The original is preserved for reference (can be viewed or restored).

**Why this priority**: Reduces token usage per message and gives the AI cleaner context. But it's lower priority because the AI already works with the raw description — this is an optimization.

**Independent Test**: Click Summarize on a property with a 500-word description. Verify it becomes ~100 words of factual, useful content. Verify the AI uses the summarized version.

**Acceptance Scenarios**:

1. **Given** a property with a 500-word marketing description, **When** the operator clicks "Summarize", **Then** the system generates a ~100-word factual summary and displays it for review.
2. **Given** a summarized description, **When** the operator approves it, **Then** the AI uses the summary instead of the full description.
3. **Given** a summarized description, **When** the operator wants the original back, **Then** they can view and restore the original Hostaway description.
4. **Given** 20 properties, **When** the operator clicks "Summarize All", **Then** all properties are summarized in batch (showing progress).

---

### Edge Cases

- What happens when Hostaway returns empty amenities? The amenities section shows "No amenities from Hostaway" with an option to add manually.
- What happens when resync fails (Hostaway API down)? Show error toast, keep existing data.
- What happens when a new property is imported after initial setup? It gets default (unclassified) amenities and the raw Hostaway description.
- What happens when the AI summarization fails? Show error, keep original description.
- What happens when the operator edits a field, then resyncs? Resync overwrites local edits (the operator is warned before confirming).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: New "Listings" tab in the main navigation, replacing the old knowledge base section in Settings.
- **FR-002**: The Listings page MUST display a card for each property with all fields from the property knowledge base (name, address, door code, WiFi, check-in/out times, house rules, amenities, capacity, bed types, cleaning fee, URLs).
- **FR-003**: All property fields MUST be editable inline and saveable without a deploy.
- **FR-004**: Each listing card MUST have a "Resync from Hostaway" button that fetches fresh data from the Hostaway API and updates the property record.
- **FR-005**: Amenities MUST be individually classifiable as Default, Available, or On Request via a 3-way toggle per amenity.
- **FR-006**: The "on request" amenities list MUST be injected into the amenity request SOP content when the AI processes an amenity request for that property.
- **FR-007**: The "available" amenities list MUST be injected into the property context that the AI sees for property description/info questions.
- **FR-008**: "Default" amenities MUST be treated as "available" in the AI context (backward compatible with current behavior).
- **FR-009**: Each listing MUST have a "Summarize" button that generates a concise AI summary of the listing description.
- **FR-010**: A "Summarize All" button MUST batch-summarize all property descriptions.
- **FR-011**: The original Hostaway description MUST be preserved and restorable after summarization.
- **FR-012**: The old "Listing Knowledge Base" editor in the Settings page MUST be removed.
- **FR-013**: Amenity classifications MUST be stored per-property and persist across sessions and deploys.
- **FR-014**: Resync MUST warn the operator before overwriting local edits.

### Key Entities

- **Property** (existing): Gains structured amenity classifications. The `customKnowledgeBase` JSON field stores amenity categories alongside existing fields. A new `summarizedDescription` field (or stored in customKnowledgeBase) holds the AI-generated summary.

### Assumptions

- Amenity classification is stored in the existing `customKnowledgeBase` JSON field as a new structure (e.g., `amenityClassifications: { "Swimming pool": "available", "Extra towels": "on_request" }`).
- The summarized description is stored alongside the original `listingDescription` — the original is never deleted.
- AI summarization uses the same model as the main AI pipeline (GPT-5.4 Mini) with a short prompt.
- The Listings page replaces the knowledge base editor in Settings — no duplicate functionality.
- Amenities are parsed from the comma-separated string in `customKnowledgeBase.amenities`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All properties are visible and editable on the Listings page within 3 seconds of loading.
- **SC-002**: Amenity classification changes take effect in the AI's next response (within 60 seconds, cache refresh).
- **SC-003**: Summarized descriptions are 80%+ shorter than originals while preserving all factual details (location, features, capacity).
- **SC-004**: The AI correctly distinguishes between "available" amenities (confirms immediately) and "on request" amenities (offers to schedule) in 95%+ of cases.
- **SC-005**: Zero instances of the old knowledge base editor appearing in the Settings page.
