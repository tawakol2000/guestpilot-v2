# Feature Specification: Translation Toggle in Inbox

**Feature Branch**: `042-translation-toggle`
**Created**: 2026-04-18
**Status**: Draft
**Input**: User description: "i want to add a translation feature. there is already a button in the backend. but we need to wire it and make it work and find a way to display the translated messages cleanly."

## Clarifications

### Session 2026-04-18

- Q: Where are inbound message translations stored? → A: Server-persisted on the Message row (Airbnb model — translate once, cache for all clients incl. iOS, survives restart)
- Q: How should the translated text render relative to the original? → A: Inline stacked, always visible — original on top, English translation directly below in the same bubble, de-emphasized styling
- Q: Which translation provider for inbound reading? → A: Keep the current unofficial Google endpoint at launch, but isolate it behind a `translation.service.ts` interface so the provider can be swapped without touching controllers
- Q: Should the system translate *outbound* manager replies into the guest's language before sending? → A: No. Airbnb and Booking.com auto-translate on the guest's side, so the manager types English and the guest's platform handles the rest. The feature is scoped to inbound (read-side) translation only. Outbound translate-and-send is out of scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read guest messages in English on demand (Priority: P1)

A manager is triaging a conversation in the inbox where the guest writes in a non-English language (e.g., Arabic, Spanish, French, Chinese). The manager clicks the Translate toggle in the conversation header. The inbox then shows an English translation of every inbound guest message directly below the original text inside the same bubble, so the manager can fully understand the conversation without leaving the app or pasting into an external tool. Toggling the button off returns the view to showing only the original messages.

**Why this priority**: Without translation, managers either guess at meaning, miss urgency signals, or copy/paste each message into Google Translate — which is slow, error-prone, and causes escalation delays. This capability unlocks the feature's core value: comprehension of foreign-language guests at a glance. Outbound translation is not needed because the guest's own platform (Airbnb, Booking.com) auto-translates messages we send them.

**Independent Test**: Open a conversation containing non-English guest messages, click the Translate toggle in the header, verify each guest message now shows an English translation directly below the original inside the same bubble; click the toggle again and verify the view returns to originals only.

**Acceptance Scenarios**:

1. **Given** a conversation with guest messages written in Arabic, **When** the manager clicks the Translate toggle in the header, **Then** every inbound guest message bubble shows the original Arabic on top and an English translation directly below it, and the toggle visibly shows an "on" state.
2. **Given** translation is on for the current conversation, **When** the manager clicks the toggle again, **Then** translations are hidden and only original message text remains visible.
3. **Given** translation is on and a new guest message arrives via real-time update, **When** the message lands in the conversation, **Then** its English translation is fetched and displayed automatically without the manager needing to re-toggle.
4. **Given** a guest message is already in English, **When** translation is on, **Then** the message displays normally without a redundant "translation" block duplicating the same text.
5. **Given** translation is on for Conversation A, **When** the manager opens Conversation B, **Then** the toggle state is evaluated per-conversation (it does not bleed a previously "on" state into conversations where the manager has not explicitly enabled it).

---

### User Story 2 - Toggle state persists while the manager works (Priority: P2)

A manager who works with a recurring set of foreign-language guests does not want to re-enable translation every time they reopen the same conversation within a working session. Once enabled for a conversation, the toggle stays on for that conversation across page reloads within the same browser/device session, so the workflow feels continuous.

**Why this priority**: Quality-of-life improvement. Story 1 delivers the feature; this removes friction.

**Independent Test**: Turn translation on for Conversation A, reload the page, reopen Conversation A, and verify translation is still on. Open Conversation B (never toggled) and verify it is off.

**Acceptance Scenarios**:

1. **Given** translation is on for Conversation A, **When** the manager reloads the inbox and reopens Conversation A, **Then** translation is still on for Conversation A.
2. **Given** translation has never been enabled for Conversation B, **When** the manager opens Conversation B, **Then** translation is off by default.

---

### Edge Cases

- **Already-English guest message**: Detect and skip rendering a translation block to avoid duplicating the same text twice.
- **Mixed-language threads** (guest switches between languages mid-conversation): Each message is treated independently; each is translated based on its own detected source language.
- **Very long messages**: Translation must handle multi-paragraph messages without truncating the visible output.
- **Translation service fails or times out**: The original message is always shown; the translation area for that specific message shows a non-blocking "Translation unavailable" state with a retry affordance. The rest of the conversation remains readable.
- **Rate limiting / bulk load**: If many messages need translating at once (e.g., opening a long history with translation on), translations load progressively without blocking the UI. Because translations are persisted server-side after the first fetch (FR-009), subsequent opens of the same conversation do not re-hit the translation provider for already-translated messages.
- **Outbound host messages (the manager's own sent replies)**: Outbound messages are not translated on the manager's screen; they are shown exactly as sent. The translation block applies only to inbound guest messages.
- **No network / offline**: The translate toggle may be flipped, but per-message translations for newly-arriving messages will show their "unavailable" state until connectivity returns; the manager's ability to read originals is never blocked, and any translations already persisted server-side from prior visits continue to render from the cache.

## Requirements *(mandatory)*

### Functional Requirements

#### Toggle behavior

- **FR-001**: The inbox MUST expose a per-conversation Translate toggle in the conversation header whose on/off state is visible at a glance (distinct styling when active).
- **FR-002**: The toggle state MUST be scoped per conversation: enabling it in one conversation does not enable it in another.
- **FR-003**: The toggle state for a given conversation MUST persist across page reloads within the same browser session on the same device.

#### Reading inbound messages

- **FR-004**: When translation is on for a conversation, every inbound guest message MUST display an English translation in addition to the original text.
- **FR-005**: When translation is on and a new inbound guest message arrives in real time, the system MUST fetch and display its translation automatically, without requiring the manager to re-toggle or reload.
- **FR-006**: The system MUST avoid rendering a translation block when the source text is already in English (or already matches the target language), so the UI does not duplicate identical text.
- **FR-007**: Translations for individual messages MUST load progressively; a slow or failed translation for one message MUST NOT block the rest of the conversation from rendering.
- **FR-008**: If translation of a specific message fails, the UI MUST show an inline, non-blocking indicator for that message with the ability to retry, while the original message text remains fully visible.
- **FR-009**: The system MUST persist each inbound guest message's English translation server-side, keyed to that message, so that (a) reopening the conversation does not re-translate, (b) a second manager or device sees the same translation without recomputing, and (c) the translation survives a server restart and is available to both the web inbox and the iOS app.

#### Send path (explicitly unchanged)

- **FR-010**: The Translate toggle MUST NOT alter the manager's send path. When the manager sends a reply, the typed text is delivered verbatim through the existing send flow regardless of whether the Translate toggle is on or off. Outbound translation, if any, is handled by the guest's own platform (Airbnb, Booking.com, etc.).

#### Clean display

- **FR-011**: When translation is on, each inbound guest message bubble MUST render the original text on top and the English translation directly below it within the same bubble, always visible without requiring a click or expand action.
- **FR-012**: The English translation MUST be visually de-emphasized relative to the original (e.g., lighter weight, smaller size, subtle divider, or a small "Translated" label) so the manager can distinguish the two at a glance while still reading both.
- **FR-013**: The translation display MUST preserve readability of paragraphs and line breaks from the original message.
- **FR-014**: The UI MUST NOT hide or replace the original text; the manager must always be able to see the text the guest actually wrote.

#### Performance & reliability

- **FR-015**: The Translate toggle MUST provide visible feedback within 200ms of being clicked (state change is immediate, even if translations are still loading).
- **FR-016**: Opening a conversation with translation on MUST NOT block the thread from rendering on first paint; translations fill in as they arrive.

### Key Entities *(include if feature involves data)*

- **Translation Preference**: The per-conversation on/off state for the Translate toggle, scoped to the current manager's browser/device session.
- **Message Translation**: The English rendering of an inbound guest message's content. Stored server-side as a derived field attached to the message itself (one translation per message); shared across all managers and clients (web + iOS). Not a new source of truth — the original message content remains authoritative — but persisted rather than recomputed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A manager can comprehend an inbound non-English guest message within 2 seconds of the message arriving in a conversation that already has translation enabled (translation appears alongside the original without manual action).
- **SC-002**: For a representative sample of inbound messages across the top languages the business sees, at least 95% of translations are judged "accurate enough for triage" by the operations team.
- **SC-003**: The internal "copy-paste into Google Translate" workaround for inbox messages is eliminated — measured as zero operational references to that workaround in team standups or the support channel within 4 weeks of launch.
- **SC-004**: Enabling translation on a long conversation (50+ messages) does not degrade perceived inbox responsiveness: the thread remains scrollable and new-message events process without visible stalls while translations load in the background.
- **SC-005**: Because translations are persisted server-side, a given inbound guest message is translated at most once across its entire lifetime (measured: zero repeat calls to the translation provider for the same message id across distinct sessions/managers/devices after the first successful translation).

## Assumptions

- The existing server-side endpoint that translates a single message string to English is acceptable for the inbound-reading use case as a starting point; quality and provider can be revisited later without changing the user-facing contract.
- Translations are stored server-side attached to the originating message (mirroring how Airbnb, Messenger, Booking.com handle guest-facing translation). The stored translation is the same value shown to every manager, every device, and the iOS app, and persists across server restarts.
- The translation provider is abstracted behind a server-side interface, so that the current unofficial Google endpoint can be swapped for a paid/official provider (Google Cloud Translation, DeepL, OpenAI, etc.) later without changing controller or client code. Provider quality is assumed equivalent across options; the abstraction is motivated by rate-limit and terms-of-service risk of the unofficial endpoint, not translation quality.
- English is the single target language for inbound translation at launch. Multi-target display (e.g., "translate into Arabic for an Arabic-speaking operator") is out of scope.
- The translate toggle is per-conversation and per-device; cross-device sync of the toggle state is out of scope.
- Translations are advisory for the manager's comprehension; they are not stored as part of the guest-facing message record and are not shown to the guest.
- Outbound translation is handled by the guest's own platform (Airbnb, Booking.com auto-translate both directions; WhatsApp/direct guests can translate in-app if needed). This feature does not alter the outbound send path.

## Out of Scope

- **Outbound translate-and-send**: Translating the manager's typed reply into the guest's language before sending. The guest's own platform handles this. The existing backend `translateAndSend` endpoint is orthogonal to this feature and is not wired to the Translate toggle.
- Translating AI-generated auto-replies before they are shown to the manager in the shadow/preview pane (may be revisited later).
- Per-manager language preference other than English as the comprehension target.
- Translating message attachments, images, or non-text content.
- Analytics on translation usage, quality scoring, or A/B testing of translation providers.
