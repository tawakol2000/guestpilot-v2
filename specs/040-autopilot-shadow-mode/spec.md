# Feature Specification: Copilot Shadow Mode for AI Tuning

**Feature Branch**: `040-autopilot-shadow-mode` *(historical branch name — feature targets **copilot**, not autopilot)*
**Created**: 2026-04-10
**Status**: Draft
**Input**: User description: "so have a look at the code. when its on autopilot, the messages suggested, i want to see them in chat, just to see what the AI would of replied. but obviously show that its not sent the guest, and the last one have it have a send button and edit button, and when i edit it, the edits are saved some where, and have an AI analyze it and suggest edits in the AI flow (system prompts, FAQs and sops) what we should edit. now all this feature, have a toggle in the settings to turn it on, because i will use it for a while to tune the AI and flow, and then i wont need it."

> **Scope correction (post-clarification)**: The user's initial description used the word "autopilot" but clarified afterward that this feature only makes sense in **copilot** mode: in autopilot the message is already sent and cannot be edited, whereas in copilot the reply is held for manual approval. Shadow Mode enhances the copilot approval flow — it does NOT intercept autopilot.

## Clarifications

### Session 2026-04-10

- Q: When a preview is sent (edited or unedited), what role/attribution should the resulting message carry so downstream pipelines behave correctly? → A: Always stored with role `AI`; if the admin edited the preview, the message carries `editedByUserId` and `originalAiText` metadata so the tuning analyzer can compare versions. This keeps the existing FAQ auto-suggest pipeline (which only runs on genuine Hostaway-direct manager replies) from double-processing edited previews.
- Q: What happens when a new guest message triggers a new preview while the admin is actively editing the previous preview? → A: The old preview locks immediately when the new preview is generated; any in-progress edit on the old preview is discarded and the admin is shown a brief toast/warning. The new preview becomes the actionable one.
- Q: Where should the Tuning tab (the list of analyzer-generated suggestions) live in the UI? → A: A new top-level "Tuning" tab inside AI settings, peer to the existing Configure AI / SOPs / FAQs / AI Logs tabs. Keeps all suggestions in one discoverable place, stays accessible after Shadow Mode is disabled, and is trivial to retire as a unit.
- Note (user-added): Preview generation must cover all guest messages that have not yet received a delivered reply. If the guest sends message A and the resulting preview is never sent, then sends message B, the new debounce cycle must produce a new preview that addresses BOTH A and B together (because from the guest's perspective neither was answered). This is the natural consequence of the earlier assumption that unsent previews do not feed back into the AI's conversation context — the guest-visible conversation state remains "A and B unanswered" until the admin actually sends something. The old preview is then locked per FR-011.
- Q: What granularity and scope should the tuning analyzer operate at when proposing changes? → A: The analyzer first diagnoses the root cause(s) of the gap between the AI's original reply and the admin's edit, then proposes concrete actions across the whole AI flow. Scope is deliberately broad: it can edit an existing system prompt (the specific variant the AI actually used — coordinator or screening), edit an existing SOP's content (at the most-specific level the AI consulted — variant, or property override if one applied), fix a SOP's classifier routing (`toolDescription`) when the wrong SOP was chosen or the right one was missed, edit an existing FAQ entry, create a brand-new SOP for a situation with no coverage, or create a brand-new FAQ entry for recurring knowledge gaps. A single edit MAY produce multiple suggestions spanning several artifacts when more than one root cause is at play.
- Q: Which reservation AI mode does Shadow Mode target? → A: **Copilot only.** The user initially said "autopilot" but clarified: in autopilot the message is already sent and cannot be edited — there is nothing for the feature to intercept. Copilot, by contrast, already holds AI replies for manual approval (currently via a suggestion-card UI). Shadow Mode replaces the copilot suggestion-card UX with an in-chat preview-bubble experience (Send + Edit on the latest preview) and adds the tuning analyzer on edited sends. Autopilot, manual, and AI-off reservations are completely unaffected.

## User Scenarios & Testing

### User Story 1 - See copilot replies as previews inside the inbox (Priority: P1)

The tenant admin turns on Shadow Mode from the AI settings. From that moment on, whenever a reservation in copilot mode generates an AI reply, the reply appears inside the inbox conversation as a preview bubble, clearly labeled as *not yet sent to the guest*. Instead of seeing a separate suggestion card, the admin reads the reply in the same chat where they read guest messages — full conversational context at a glance — without any risk of the guest seeing it.

**Why this priority**: This is the whole point of the feature — upgrading the copilot approval flow so the admin can review AI replies in-context, cheaply, without impacting guest experience. Without this, the feature delivers zero value.

**Independent Test**: Enable Shadow Mode, send a test message from a guest on a copilot reservation, confirm the AI's reply appears as a preview bubble in the inbox within the normal debounce window and that nothing reaches the guest channel.

**Acceptance Scenarios**:

1. **Given** Shadow Mode is enabled and a reservation is in copilot, **When** a guest message triggers AI reply generation, **Then** the AI's generated text appears in the inbox as a preview bubble visibly marked "Not sent to guest" and no message is delivered to the guest channel. The existing copilot suggestion-card UI is bypassed.
2. **Given** Shadow Mode is disabled, **When** a guest message triggers AI reply generation on a copilot reservation, **Then** the existing copilot suggestion-card flow continues to apply unchanged — no preview bubble is created.
3. **Given** a reservation is in autopilot mode (not copilot), **When** a guest message triggers AI reply generation, **Then** Shadow Mode has no effect — the reply is sent to the guest immediately via the normal autopilot pathway. Shadow Mode does not intercept autopilot.
4. **Given** Shadow Mode is enabled, **When** multiple guest messages on a copilot reservation arrive in sequence and each produces a preview, **Then** all previews appear as bubbles in chronological order in the chat and none are delivered to the guest.

---

### User Story 2 - Send or edit the most recent preview (Priority: P1)

On the most recent preview in any conversation, the admin sees two actions: **Send** and **Edit**. Clicking Send delivers the current preview text to the guest through the normal messaging pipeline, converting the preview into a sent message. Clicking Edit opens an inline editor letting the admin revise the text, after which Send delivers the edited version. Older previews in the same conversation remain visible as historical context but have no action buttons.

**Why this priority**: Without Send and Edit, Shadow Mode is read-only and the admin cannot actually complete a guest interaction, making the feature unusable for day-to-day tuning work. Without locking older previews, stale drafts could be sent by accident.

**Independent Test**: Generate two previews in a conversation; verify that only the latest preview exposes Send/Edit, edit the latest preview, click Send, and confirm the edited text is delivered to the guest and the bubble transitions from preview to sent.

**Acceptance Scenarios**:

1. **Given** a conversation with exactly one preview, **When** the admin views the inbox, **Then** that preview shows Send and Edit buttons.
2. **Given** a conversation with two previews (older and newer), **When** the admin views the inbox, **Then** only the newer preview shows Send and Edit buttons and the older preview is visible but inert.
3. **Given** a preview with Edit enabled, **When** the admin clicks Edit, revises the text, and clicks Send, **Then** the revised text is delivered to the guest and the preview transitions into a regular sent AI message in the chat.
4. **Given** an unedited preview, **When** the admin clicks Send, **Then** the original AI text is delivered to the guest unchanged and the preview transitions into a regular sent AI message.
5. **Given** an unsent preview on a conversation, **When** a new guest message arrives and a new preview is generated, **Then** the old preview automatically loses its Send and Edit buttons and the new preview becomes the actionable one.

---

### User Story 3 - AI suggests tuning changes based on operator edits (Priority: P2)

When the admin sends a preview whose final text differs from the original AI draft, the system runs an analyzer that first diagnoses the *root cause(s)* of the gap between the AI's draft and the admin's edit, then proposes concrete actions across the whole AI flow. Actions can include: editing an existing system prompt, editing an existing SOP's content, fixing a SOP's classifier routing description when the wrong SOP was chosen, editing an existing FAQ entry, creating a brand-new SOP for an uncovered situation, or creating a brand-new FAQ entry for recurring knowledge gaps. A single edit can yield multiple suggestions when more than one root cause is at play. The admin reviews suggestions in a dedicated tuning surface and can accept (apply the change directly), reject (dismiss), or edit (revise before applying).

**Why this priority**: Edits without analysis are just noise. The analyzer turns every manual correction into a concrete, actionable recommendation for prompt/FAQ/SOP improvement, which is the core tuning loop the feature is supposed to accelerate. It is P2 rather than P1 because the feature still delivers value (edit capture) even without the analyzer.

**Independent Test**: Edit an AI preview in a noticeable way, click Send, open the Tuning tab, and verify a new suggestion appears within 30 seconds pointing at a specific system-prompt line, FAQ entry, or SOP category with a proposed revision and a rationale.

**Acceptance Scenarios**:

1. **Given** a preview whose text the admin has edited, **When** the admin clicks Send, **Then** the system captures both the original AI text and the final sent text, together with the system prompt used, the SOPs consulted (with their resolution level), and the FAQ entries considered — and queues an analyzer run with that full context.
2. **Given** an analyzer run has completed, **When** the admin opens the Tuning tab, **Then** they see one or more suggestions produced for the triggering preview, each identifying an action type (edit prompt / edit SOP content / fix SOP routing / edit FAQ / create new SOP / create new FAQ), the specific target reference or new-artifact fields, a before/proposed diff (for edits) or proposed content (for creates), and a root-cause rationale.
3. **Given** a single preview edit that had multiple root causes, **When** the analyzer completes, **Then** the admin sees multiple suggestions spanning the different affected artifacts (e.g. one EDIT_SYSTEM_PROMPT and one CREATE_FAQ) grouped under the same source preview.
4. **Given** an EDIT-type tuning suggestion, **When** the admin accepts it, **Then** the proposed revision is applied directly to the referenced prompt / FAQ / SOP and the suggestion is marked as accepted.
5. **Given** a CREATE-type tuning suggestion, **When** the admin accepts it, **Then** a new SOP or FAQ entry is created with the proposed fields and the suggestion is marked as accepted.
6. **Given** a tuning suggestion, **When** the admin rejects it, **Then** the suggestion is marked as rejected and no changes are applied.
7. **Given** a tuning suggestion, **When** the admin edits it before accepting, **Then** the admin's revised text is applied in place of the analyzer's proposal.
8. **Given** a preview that was sent unedited, **When** Send is clicked, **Then** no analyzer run is triggered.

---

### User Story 4 - Turn Shadow Mode off when tuning is done (Priority: P3)

Once the admin has finished tuning, they disable Shadow Mode from the same settings toggle. From that moment on, new copilot replies revert to the legacy suggestion-card flow (or whatever the existing copilot UI is) instead of the in-chat preview bubble. Historical previews and suggestions remain visible in conversation history and in the Tuning tab so the admin can still reference them.

**Why this priority**: This is an exit ramp. It is not required for day-one tuning work, but is needed to cleanly retire the feature once its diagnostic purpose is fulfilled.

**Independent Test**: Disable Shadow Mode, trigger a new copilot AI reply, confirm it flows through the legacy copilot suggestion path (not the preview bubble), then confirm historical previews and tuning suggestions from the enabled period are still visible.

**Acceptance Scenarios**:

1. **Given** Shadow Mode is currently enabled with historical previews in some conversations, **When** the admin disables it, **Then** previously generated previews remain visible in conversation history as inert bubbles.
2. **Given** Shadow Mode has just been disabled, **When** the next copilot AI reply is generated, **Then** it flows through the legacy copilot suggestion-card path unchanged — no preview bubble is created.
3. **Given** Shadow Mode is disabled, **When** the admin opens the Tuning tab, **Then** previously generated suggestions are still visible and still actionable (accept / reject / edit).

---

### Edge Cases

- **Manager replies directly in Hostaway while a preview is pending**: existing pre-response sync detects the manager reply and aborts the AI generation run. The pending preview is not replaced by a new preview for the same turn. Behavior matches current copilot handling, unchanged by this feature.
- **Shadow Mode toggled mid-debounce**: the toggle state at the moment the AI reply is about to be delivered (not the moment debounce started) determines whether the reply is rendered as an in-chat preview bubble (shadow mode on) or via the legacy copilot suggestion-card UI (shadow mode off).
- **Very old unsent previews**: previews older than the most recent in their conversation are inert forever. They are never auto-deleted.
- **Escalations during Shadow Mode**: escalation detection, task creation, and manager notification continue to fire normally — Shadow Mode only affects how the guest-facing copilot reply is surfaced, not the internal escalation pathway.
- **Tool calls during preview generation**: the AI's tool use loop runs normally while generating the preview — SOPs are fetched, FAQ lookups happen, property searches run. The preview reflects the full AI pipeline output.
- **Conversations with mixed history** (some copilot replies approved via the legacy suggestion card before Shadow Mode was enabled, some as previews after): the chat displays each message in its own state; no retroactive conversion happens.
- **Unedited Send**: clicking Send without editing delivers the original AI text verbatim and does NOT trigger the tuning analyzer (there is nothing to learn from).
- **Analyzer fails to produce a meaningful suggestion**: the edit is still captured for later review, but no suggestion appears in the review surface. Failures do not block the Send action.
- **Reservation AI mode is `off`**: Shadow Mode has no effect because no AI reply is generated in the first place.
- **Autopilot-mode reservation while Shadow Mode is ON**: completely unaffected — autopilot replies continue to be delivered to guests automatically. Shadow Mode does not intercept autopilot because the message would already be sent by the time the feature could act.

## Requirements

### Functional Requirements

#### Shadow Mode toggle and copilot interception

- **FR-001**: System MUST provide a single tenant-wide Shadow Mode toggle inside AI settings, defaulting to OFF.
- **FR-002**: When Shadow Mode is ON, the system MUST render every copilot-generated AI reply as an in-chat preview bubble (the new UX) instead of using the legacy copilot suggestion-card UI. No reply reaches the guest channel until the admin clicks Send.
- **FR-003**: Shadow Mode MUST only affect reservations in copilot mode. **Autopilot, manual, and AI-off reservations MUST be completely unaffected by the toggle** — autopilot replies continue to be sent to guests automatically because by the time Shadow Mode could intercept, the message would already be out the door.
- **FR-003a**: When Shadow Mode is OFF, copilot MUST fall through to its existing suggestion-card flow (write to `PendingAiReply.suggestion`, broadcast `ai_suggestion` event) unchanged. The legacy flow is not deleted — it is bypassed only while the toggle is on. *(FR-025 restates this requirement from the toggle-lifecycle perspective.)*
- **FR-004**: Shadow Mode MUST NOT alter escalation handling — tasks, internal notifications, and private notes continue to fire exactly as they would in normal copilot generation.
- **FR-005**: The AI reply generation pipeline (SOP classification, tool use loop, FAQ retrieval, structured output, escalation enrichment, task dedup) MUST run unchanged under Shadow Mode. Only how the final copilot reply is surfaced to the admin is diverted.

#### Preview rendering in the inbox

- **FR-006**: Intercepted replies MUST appear as preview bubbles in the inbox conversation in the same position they would have occupied if they had been sent.
- **FR-006a**: Preview generation MUST respect the existing debounce behavior — rapid-fire guest messages coalesce into a single preview cycle, and the resulting preview addresses the whole batch of unanswered guest messages at once.
- **FR-006b**: When a new guest message arrives on a conversation that already has an unsent preview, a fresh debounce cycle MUST start. The next preview that cycle produces MUST cover ALL guest messages that have not yet received a delivered reply — including the messages the unsent preview was originally addressing. The earlier unsent preview is then locked per FR-011.
- **FR-007**: Preview bubbles MUST be visually distinct from sent messages and MUST carry an explicit "Not sent to guest" label.
- **FR-008**: Preview bubbles MUST be streamed/broadcast to the inbox in real time the same way regular AI messages are, so the admin sees them as soon as the AI finishes generating.
- **FR-009**: The most recent preview per conversation MUST expose a Send action and an Edit action.
- **FR-010**: All previews other than the most recent in a conversation MUST remain visible as historical context and MUST NOT expose Send or Edit actions.
- **FR-011**: When a new preview is generated while an older one in the same conversation is still unsent, the older preview MUST automatically lose its Send and Edit actions and the newer preview MUST become the actionable one.
- **FR-011a**: If the admin has an active in-progress edit on the older preview at the moment the new preview arrives, the in-progress edit MUST be discarded (the edit buffer is cleared) and the admin MUST be shown a brief notification explaining that a newer preview replaced the one they were editing.

#### Editing and sending a preview

- **FR-012**: The Edit action MUST allow the admin to revise the preview text in-place before sending.
- **FR-013**: The Send action MUST deliver the current preview text (edited or unedited) through the normal guest messaging pipeline and MUST transition the preview into a regular sent AI message (role: `AI`) in the conversation history.
- **FR-013a**: If the admin edited the preview before sending, the resulting sent message MUST carry `editedByUserId` and `originalAiText` metadata so the edit can be audited and fed to the tuning analyzer.
- **FR-013b**: The FAQ auto-suggest pipeline (which runs on manager replies) MUST NOT treat sent previews as manager replies, regardless of whether they were edited. Only the shadow-mode tuning analyzer consumes edit metadata.
- **FR-014**: Send MUST be idempotent — a successful Send MUST prevent the same preview from being sent twice, even if the admin clicks Send multiple times.
- **FR-015**: If Send fails to deliver to the guest channel, the preview MUST remain in its preview state and the admin MUST see the failure so they can retry.
- **FR-016**: The system MUST persist the original AI-generated text separately from any edited final text, so the two can be compared later.

#### Tuning analyzer and suggestions

- **FR-017**: When a preview is sent and its final text differs from the original AI draft, the system MUST queue an analyzer run. The analyzer input MUST include: the conversation history, the original AI draft, the final edited text, the system prompt variant the AI actually used (coordinator or screening), every SOP that was consulted during generation (with the specific resolution level — default content / status variant / property override), every FAQ entry that was consulted or could plausibly have been consulted, and the AI's tool-call trace for the turn.
- **FR-018**: The analyzer MUST first diagnose the root cause(s) of the gap between the AI's original draft and the admin's final text. Root causes may include: unclear or incorrect system prompt guidance; the wrong SOP was selected by the classifier; the selected SOP's content is incomplete or incorrect; an FAQ entry is unclear, wrong, or unreachable by the classifier; or a needed SOP or FAQ entry does not exist at all.
- **FR-018a**: Based on the diagnosis, the analyzer MUST produce zero or more tuning suggestions. A single analyzer run MAY produce multiple suggestions spanning different artifacts when more than one root cause is at play. Multiple suggestions sharing a single source preview MUST be grouped together in the review surface.
- **FR-018b**: Each suggestion MUST carry exactly one of the following action types:
  - **EDIT_SYSTEM_PROMPT** — modify the specific system prompt variant the AI actually used (coordinator OR screening). Target reference identifies which variant.
  - **EDIT_SOP_CONTENT** — modify the specific SOP content the AI actually consulted, at the most-specific level that applied (the property override if one was in effect, otherwise the status variant, otherwise the default). Target reference identifies category, status, and (if applicable) property.
  - **EDIT_SOP_ROUTING** — modify a SOP's classifier description (`toolDescription`) because the wrong SOP was chosen or the right one was missed. Target reference identifies the SOP category.
  - **EDIT_FAQ** — modify a specific existing FAQ entry's question or answer text. Target reference identifies the FAQ entry id.
  - **CREATE_SOP** — add a new SOP for a situation with no coverage. Payload includes proposed category, status scope, optional property scope, proposed tool description, and proposed content.
  - **CREATE_FAQ** — add a new FAQ entry for recurring content that wasn't in the knowledge base. Payload includes proposed category, scope (global / property-specific), proposed question, and proposed answer.
- **FR-018c**: Every suggestion MUST include a short root-cause rationale explaining WHY the proposed change or addition would have produced output closer to the admin's edited version.
- **FR-019**: Tuning suggestions MUST be persisted and viewable in a dedicated Tuning tab inside settings.
- **FR-019a**: The Tuning tab MUST be implemented as a new top-level tab in the AI settings area, peer to the existing Configure AI, SOPs, FAQs, and AI Logs tabs, so it is discoverable in the familiar settings layout and can be retired as a single unit when the feature is no longer needed.
- **FR-020**: The Tuning tab MUST support three actions per suggestion: accept, reject, and edit-then-accept. The edit-then-accept flow MUST allow the admin to revise the proposed text (for EDIT actions) or the proposed new-artifact fields (for CREATE actions) before applying.
- **FR-021**: Accepting a suggestion (with or without prior edit) MUST apply it directly according to its action type:
  - For **EDIT** action types, the proposed text replaces the referenced artifact's current content at the exact target level specified.
  - For **CREATE** action types, a new `SopDefinition` / `SopVariant` / `SopPropertyOverride` or `FaqEntry` is created with the proposed fields.
  - In all cases, the suggestion is marked accepted and the change takes effect on the very next AI generation with no extra steps.
- **FR-022**: Rejecting a suggestion MUST mark it as rejected and MUST NOT modify or create any prompt, FAQ, or SOP.
- **FR-023**: Analyzer failures (model errors, parse errors, empty outputs) MUST NOT block Send. Failures SHOULD be logged for debugging but MUST NOT surface as user-facing errors.
- **FR-024**: Sending a preview unedited MUST NOT trigger an analyzer run.

#### Lifecycle and reversibility

- **FR-025**: Disabling Shadow Mode MUST restore the legacy copilot suggestion-card flow for the next and all subsequent copilot-generated AI replies. Autopilot behavior is unchanged in either toggle state. *(This is the lifecycle-level restatement of FR-003a; both are covered by the same fall-through code path in T006.)*
- **FR-026**: Disabling Shadow Mode MUST NOT delete, hide, or convert historical previews or accumulated tuning suggestions. Both remain viewable after the toggle is flipped.
- **FR-027**: The Tuning tab MUST remain accessible regardless of whether Shadow Mode is currently enabled or disabled, so admins can continue processing previously captured suggestions after exiting Shadow Mode.

### Key Entities

- **Shadow Preview**: a record representing an AI reply that was generated but held back from the guest. Carries the original AI text, any edited final text, a preview state (draft / sent / abandoned), timestamps for generation and (if applicable) send, and a link back to the AI generation log that produced it. Rendered in the inbox chat as a preview bubble.
- **Tuning Suggestion**: a record produced by the analyzer after an edit-then-send event. Carries an **action type** (`EDIT_SYSTEM_PROMPT` / `EDIT_SOP_CONTENT` / `EDIT_SOP_ROUTING` / `EDIT_FAQ` / `CREATE_SOP` / `CREATE_FAQ`) and a payload appropriate to that type: for EDIT actions, the fully-qualified target reference (e.g. `coordinator` prompt for a screening-status reservation, or the exact `SopPropertyOverride` the AI consulted) plus the before text and proposed text; for CREATE actions, the proposed new-artifact fields (category, scope, status, content / question / answer). Every suggestion also carries a short root-cause rationale, a link back to the Shadow Preview that triggered the analyzer run, and a status (pending / accepted / rejected). Multiple suggestions can share a single source preview and are grouped together in the Tuning tab when displayed.
- **Shadow Mode Setting**: a per-tenant boolean stored alongside other AI configuration. When true, the interception and analyzer pathways are active.

## Success Criteria

### Measurable Outcomes

- **SC-001**: After enabling Shadow Mode, 100% of copilot-generated AI replies are rendered as in-chat preview bubbles (instead of going through the legacy suggestion-card UI) — zero copilot replies slip through to the old UI path while the toggle is on.
- **SC-002**: A preview appears in the inbox within ≤5 seconds after copilot AI generation completes — matching the latency a guest would see from the legacy suggestion-card flow, so the admin experiences no added lag.
- **SC-003**: Admins can send a preview (edited or not) and have it reach the guest within 5 seconds of clicking Send, matching normal Hostaway delivery latency.
- **SC-004**: After sending an edited preview, a corresponding tuning suggestion appears in the review surface within 30 seconds in at least 80% of edits that change the reply's meaning (edits that are cosmetic-only, such as whitespace, may legitimately yield no suggestion).
- **SC-005**: An admin can accept a tuning suggestion and have the referenced system prompt, FAQ entry, or SOP reflect the change on the very next AI generation, with no additional configuration steps.
- **SC-006**: Disabling Shadow Mode restores direct-to-guest delivery on the next generated reply; no restart, re-login, or re-deploy is required.
- **SC-007**: Historical previews and tuning suggestions captured during a Shadow Mode session remain fully viewable and actionable after the toggle is turned off, with no data loss.
- **SC-008**: Shadow Mode adds zero guest-visible side effects — the guest channel receives exactly the same messages it would have received under the legacy copilot flow (only the admin-facing review UX changes).

## Assumptions

- **Copilot scope (corrected)**: Shadow Mode targets **copilot reservations only**. In copilot, the AI already generates a reply and holds it for manual approval, so there is a natural hook to divert the reply into an in-chat preview bubble. Autopilot is out of scope because the message is already delivered to the guest by the time the feature could act — there is nothing to preview or edit. Manual and AI-off reservations are also out of scope (no AI reply is generated).
- **Legacy copilot flow preserved**: When Shadow Mode is OFF, the existing copilot suggestion-card flow continues to work unchanged. Shadow Mode does NOT delete or replace the legacy flow — it only bypasses it while the toggle is on. This keeps the retirement path trivial (flip the toggle off).
- **Toggle scope**: The toggle is a single tenant-wide setting. There is no per-property or per-reservation override in v1.
- **Permission scope**: The toggle, the Send action on previews, and the Accept/Reject actions on tuning suggestions are available to **any authenticated user of the tenant** (mirroring the existing `PATCH /api/tenant-config` authorization). Narrative references to "the tenant admin" in user stories describe the expected persona, not an enforced role restriction. If stricter gating is needed later, it can be added without changing the feature shape.
- **Conversation-context isolation**: Unsent previews do NOT feed back into the AI's conversation context for subsequent reply generation. The AI always operates on the real, as-delivered conversation state. This prevents the AI from hallucinating that previous previews were actually sent.
- **Analyzer trigger**: The analyzer runs automatically on Send when final text differs from original AI text. There is no manual "Analyze" button and no analyzer run on unedited sends.
- **Analyzer target types**: Targets are limited to the three artifacts the user explicitly called out — system prompts, FAQ entries, and SOPs. Tool definitions, escalation rules, and other flow artifacts are out of scope for v1 suggestions.
- **Suggestion acceptance is direct**: Accepting a suggestion applies the change immediately. There is no staging, preview, or diff-review workflow beyond the inline edit-before-accept option already described.
- **Temporary feature**: Per the user, Shadow Mode is a short-lived diagnostic tool intended to be used for a tuning period and then disabled. The design prioritizes a clean disable path and non-destructive coexistence with normal flows over deep architectural integration. The feature should be cheap to retire later.
- **No guest-facing impact**: Under no circumstances does any preview reach any guest channel until the admin explicitly clicks Send. No push notifications, no SMS, no email, no webhook delivery tied to preview generation.
- **Escalations are independent**: The escalation pathway (task creation, manager push notifications, private notes) is preserved exactly as-is. A guest situation that would have escalated still escalates, regardless of whether the guest-facing reply was a preview or a real send.
- **Historical preservation**: Disabling Shadow Mode preserves all preview and suggestion history as-is. There is no "clear history" action in v1.
