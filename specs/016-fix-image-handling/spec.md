# Feature Specification: Fix Image Handling for OpenAI Migration

**Feature Branch**: `016-fix-image-handling`
**Created**: 2026-03-22
**Status**: Draft
**Input**: User description: "Fix broken image handling — no separate image branch. If there's an image, send it with the text to the AI. Simple."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Guest Sends a Photo of a Problem (Priority: P1)

A guest staying at a serviced apartment sends a photo through any messaging channel (Airbnb, Booking, WhatsApp, Direct). The photo might show a broken appliance, a leak, damage, or any issue they want help with. The AI assistant (Omar) must actually see the image, respond appropriately based on what it shows, and escalate to the property manager with a description of what the image contains.

**Why this priority**: This is the entire bug — images are currently stripped before reaching the AI, so the AI never sees them. Guest safety and property damage issues go unaddressed.

**Independent Test**: Send a message with an image attachment through any channel. The AI should reference the image content in its response and create an escalation with a description of what the image shows.

**Acceptance Scenarios**:

1. **Given** a confirmed guest sends a photo of a broken mirror, **When** the AI processes the message, **Then** the AI responds acknowledging the damage and creates a maintenance escalation describing the damage in the escalation note.
2. **Given** a confirmed guest sends a photo of a water leak, **When** the AI processes the message, **Then** the AI responds with urgency and creates an urgent repair escalation describing the leak.
3. **Given** a confirmed guest sends a photo with no accompanying text, **When** the AI processes the message, **Then** the AI still responds based on the image content alone.

---

### User Story 2 - Guest Sends an Unclear or Non-Issue Image (Priority: P2)

A guest sends an image that is blurry, unclear, or doesn't show an obvious problem. The AI should acknowledge the image and escalate for manager review if it cannot determine the intent.

**Why this priority**: Not all images are damage reports. The AI must handle ambiguous images gracefully rather than hallucinating an issue.

**Independent Test**: Send a blurry or non-issue image. The AI should acknowledge receipt and escalate with a note that the image requires manager review.

**Acceptance Scenarios**:

1. **Given** a guest sends a blurry photo, **When** the AI processes it, **Then** the AI tells the guest it's looking into their message and escalates with a note that the image is unclear.
2. **Given** a guest sends a photo of a receipt, **When** the AI processes it, **Then** the AI acknowledges and escalates appropriately.

---

### User Story 3 - Image Download Fails (Priority: P3)

The image URL from the messaging channel is expired, returns an error, or the download times out. The AI should still respond to the guest's text (if any) and escalate that an image was sent but could not be retrieved.

**Why this priority**: Network failures and expired URLs are common with channel-hosted images. The system must not crash or silently ignore the message.

**Independent Test**: Simulate an unreachable image URL. The AI should respond to any accompanying text and escalate noting an image was sent.

**Acceptance Scenarios**:

1. **Given** a guest sends a message with an image but the image URL is expired, **When** the system attempts to download, **Then** the system logs a warning, proceeds with the text-only flow, and the image handling instructions tell the AI an image was sent but couldn't be loaded.
2. **Given** a guest sends only an image (no text) and the download fails, **When** the system processes it, **Then** the AI responds that it received a photo and is forwarding it to the manager, and creates an escalation.

---

### Edge Cases

- What happens when a guest sends multiple images in one message? Only the first image is processed (existing behavior, acceptable).
- What happens when an inquiry-status guest sends an image? Image handling applies regardless of booking status — the screening agent also has image instructions.
- What happens when the image is very large (>10MB)? Download may timeout — same as download failure, handled gracefully.
- What happens when the image format is unsupported (e.g., HEIC, TIFF)? Only JPEG/PNG/GIF/WEBP are supported — unsupported formats treated as download failure.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: There MUST be NO separate code branch for image messages. One code path handles both text-only and text+image messages.
- **FR-002**: The old image branch (separate content building, separate API call, separate response parsing) MUST be completely removed.
- **FR-003**: When an image is present, it MUST be attached to the last user message alongside all text context — sent as a single message to the AI, not in isolation.
- **FR-004**: The image MUST be in the format the current AI provider accepts (inline in the message content array).
- **FR-005**: Image download, MIME type detection, and download failure handling MUST be preserved — just moved into the single code path before the AI call.
- **FR-006**: Image handling instructions MUST be baked permanently into both system prompts (guest coordinator and screening agent) so the prompt never changes based on image presence — this ensures prompt caching always hits.
- **FR-007**: All features available to text-only messages (tools, streaming, SOP classification, reasoning effort, prompt caching) MUST also be available when an image is present — no feature degradation.
- **FR-008**: System MUST work for both the guest coordinator and the screening agent when images are received.
- **FR-009**: Image presence MUST be logged in the API log entry.

### Assumptions

- Only one image per message is processed (first image from the image URL array) — matches existing behavior
- Image format support limited to JPEG, PNG, GIF, WEBP — matches existing behavior
- The AI provider supports inline base64 images in the input message content array
- Response format from the AI is identical whether an image was included or not — no separate parsing needed

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a guest sends a photo, the AI's response references the specific content of the image in 90%+ of cases
- **SC-002**: Zero instances of "I can't see images" or equivalent responses when a valid image is sent
- **SC-003**: Image-bearing messages are processed within the same time budget as text-only messages (no more than 3 seconds additional latency for image download)
- **SC-004**: Tools (SOP classification, property search, extend-stay) work identically whether an image is present or not
- **SC-005**: The entire old image branch is deleted — zero duplicate code paths for text vs image
