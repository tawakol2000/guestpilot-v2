# Feature Specification: Prompt Template Variables

**Feature Branch**: `021-prompt-template-variables`
**Created**: 2026-03-24
**Status**: Draft
**Input**: Replace all hardcoded dynamic content in system prompts with user-movable template variables. Operators arrange `{VARIABLE}` placeholders in the system prompt editor and customize variable output per listing.

## Clarifications

### Session 2026-03-24

- Q: Where do variables live — system prompt or user message content? → A: Variables in the system prompt are labels/references only (e.g., "See PROPERTY & GUEST INFO below"). Actual data resolves as separate user message content blocks. This preserves prompt caching — system prompt stays static and cacheable.
- Q: Which variables support per-listing customization? → A: Only property-bound variables: `{PROPERTY_GUEST_INFO}`, `{AVAILABLE_AMENITIES}`, `{ON_REQUEST_AMENITIES}`, `{DOCUMENT_CHECKLIST}`. Conversation-specific variables (`{CONVERSATION_HISTORY}`, `{OPEN_TASKS}`, `{CURRENT_MESSAGES}`, `{CURRENT_LOCAL_TIME}`) are runtime-only and not customizable per listing.
- Q: Migration strategy for existing custom prompts? → A: Append a variable reference block at the end of existing prompts. The auto-append fallback handles missing variables. No data loss — some redundancy until the operator cleans up their prompt manually.

## User Scenarios & Testing

### User Story 1 — Variable Injection Engine (Priority: P1)

The system prompt currently hardcodes where dynamic content appears (property info, conversation history, open tasks, etc.). Instead, the system prompt stored in the DB should contain only static instructions plus `{VARIABLE}` references (e.g., "See PROPERTY & GUEST INFO below"). The variables themselves are NOT inlined into the system prompt — they resolve as separate user message content blocks. This preserves prompt caching (system prompt stays static).

**Template variables:**

| Variable | Description |
|----------|-------------|
| `{CONVERSATION_HISTORY}` | All prior guest/agent messages (last 20, formatted as "Guest:/Omar:" lines) |
| `{PROPERTY_GUEST_INFO}` | Reservation details, access codes, property description |
| `{AVAILABLE_AMENITIES}` | Amenities classified as "available" or "default" for this property |
| `{ON_REQUEST_AMENITIES}` | Amenities classified as "on request" for this property |
| `{OPEN_TASKS}` | Currently open escalation tasks for this conversation |
| `{CURRENT_MESSAGES}` | The new guest message(s) requiring a response |
| `{CURRENT_LOCAL_TIME}` | Property's current local time (timezone-aware) |
| `{DOCUMENT_CHECKLIST}` | Pending passport/marriage certificate items |

> `{AVAILABLE_AMENITIES}` is available in system prompts only. `{ON_REQUEST_AMENITIES}` is available in both system prompts and SOP templates (replacing the legacy `{PROPERTY_AMENITIES}` alias).

**Why this priority**: This is the core architectural change. Without the injection engine, nothing else works.

**Independent Test**: Edit the system prompt in Configure AI to move `{PROPERTY_GUEST_INFO}` from the middle to the top. Send a guest message. Verify the AI receives property info at the new position in the prompt.

**Acceptance Scenarios**:

1. **Given** a system prompt containing `{CONVERSATION_HISTORY}`, **When** a guest message is processed, **Then** the placeholder is replaced with the actual conversation history text
2. **Given** a system prompt with `{PROPERTY_GUEST_INFO}`, **When** the AI processes a message for Apartment 101, **Then** the variable is replaced with Apartment 101's specific data (door code, WiFi, description, etc.)
3. **Given** a system prompt with no `{CURRENT_MESSAGES}` placeholder, **When** the message is processed, **Then** the current messages are still appended (safety fallback — essential variables cannot be omitted)
4. **Given** a variable like `{OPEN_TASKS}` that has no data (no open tasks), **When** injected, **Then** the variable renders as a sensible empty state (e.g., "No open tasks.")
5. **Given** `{AVAILABLE_AMENITIES}` in the prompt, **When** a property has amenities classified as available, **Then** only those amenities appear in that position
6. **Given** `{ON_REQUEST_AMENITIES}` in an SOP, **When** a property has amenities classified as on-request, **Then** only those amenities appear in that position

---

### User Story 2 — Clean Static System Prompt (Priority: P1)

The stored system prompt (in `TenantAiConfig.systemPromptCoordinator` and `systemPromptScreening`) must be stripped of ALL dynamic content. Only static behavioral instructions remain. The operator then places `{VARIABLE}` placeholders wherever they want the dynamic data to appear.

The seed prompts shipped with the system should already include the variables in sensible default positions, so new tenants get a working prompt out of the box.

**Why this priority**: Tied to US1 — the prompt must be cleaned before variables work. If dynamic content stays hardcoded AND variables are injected, data gets duplicated.

**Independent Test**: View the seed system prompt. Confirm it contains `{VARIABLE}` placeholders but zero hardcoded property data, conversation history, or task lists. Deploy and verify no duplication.

**Acceptance Scenarios**:

1. **Given** the default seed coordinator prompt, **When** inspected, **Then** it contains all variable placeholders in sensible positions — no hardcoded dynamic content
2. **Given** the default seed screening prompt, **When** inspected, **Then** it follows the same pattern with appropriate variables for that agent type
3. **Given** an operator who previously customized their system prompt, **When** this feature deploys, **Then** a migration adds the variables to their existing prompt in the default positions without breaking their custom text

---

### User Story 3 — Prompt Editor Variable Awareness (Priority: P2)

The system prompt editor in Configure AI should show operators which variables are available, help them insert variables, and warn if essential variables are missing.

**Why this priority**: Good UX but the system works without it — operators can manually type `{VARIABLE_NAME}`.

**Independent Test**: Open Configure AI, edit the system prompt. See a list of available variables. Click one to insert it. Remove `{CURRENT_MESSAGES}` and see a warning.

**Acceptance Scenarios**:

1. **Given** the system prompt editor, **When** an operator views it, **Then** a reference panel shows all available variables with descriptions
2. **Given** a system prompt missing `{CURRENT_MESSAGES}`, **When** the operator tries to save, **Then** a warning appears: "Essential variable {CURRENT_MESSAGES} is missing. The system will auto-append it, but placement may not be optimal."
3. **Given** the variable reference panel, **When** the operator clicks a variable name, **Then** it is inserted at the cursor position in the editor

---

### User Story 4 — Per-Listing Variable Preview & Editor (Priority: P2)

A new page (or section within Listings) where operators can view and customize the property-bound variables per listing. Only property-bound variables are customizable: `{PROPERTY_GUEST_INFO}`, `{AVAILABLE_AMENITIES}`, `{ON_REQUEST_AMENITIES}`, `{DOCUMENT_CHECKLIST}`. Operators can add custom titles (prepended as a header line before auto-generated content) and notes (appended after auto-generated content). Conversation-specific variables (`{CONVERSATION_HISTORY}`, `{OPEN_TASKS}`, `{CURRENT_MESSAGES}`, `{CURRENT_LOCAL_TIME}`) are runtime-only and not shown here.

For example, an operator could customize `{PROPERTY_GUEST_INFO}` for Apartment 101 to include a custom title like "Palm Residence - Unit 101" or add a special note like "VIP unit — always offer welcome basket". This customization is stored per property and merged into the variable output at runtime.

**Why this priority**: Enhances operator control but the system works with auto-generated variable output from existing data.

**Independent Test**: Open the variable editor for Apartment 101. Add a custom title to `{PROPERTY_GUEST_INFO}`. Send a guest message for that apartment. Verify the custom title appears in the AI's context.

**Acceptance Scenarios**:

1. **Given** the per-listing variable editor, **When** an operator selects a property, **Then** they see a preview of how each variable resolves for that property with current data
2. **Given** the editor for `{PROPERTY_GUEST_INFO}`, **When** an operator adds a custom title or note, **Then** that customization appears in the variable output when the AI processes messages for that property
3. **Given** a property with no customizations, **When** the variable resolves, **Then** the default auto-generated output is used (backward compatible)
4. **Given** the editor for `{AVAILABLE_AMENITIES}`, **When** an operator views it, **Then** they see the list of amenities currently classified as available for that property

---

### Edge Cases

- What happens when an operator removes ALL variables from the prompt? The system auto-appends essential variables (`{CURRENT_MESSAGES}`, `{PROPERTY_GUEST_INFO}`, `{CONVERSATION_HISTORY}`) as a safety fallback.
- What happens when a variable placeholder is misspelled (e.g., `{CONVERSTAION_HISTORY}`)? It remains as literal text — no silent failure. The variable reference panel helps prevent typos.
- What happens when the same variable appears twice in the prompt? Both instances get replaced. The operator is responsible for avoiding duplication.
- What happens to existing tenants with customized prompts on deploy? A one-time migration appends a variable reference block at the end of existing prompts. The auto-append fallback ensures all essential data is present even if the operator hasn't cleaned up yet. Some redundancy may exist until the operator manually updates their prompt.
- What happens to `{PROPERTY_AMENITIES}` in existing SOPs? It is replaced by `{ON_REQUEST_AMENITIES}` which serves the same purpose. The old variable name is supported as an alias during migration.
- What happens to the screening agent prompt? It gets the same variable treatment with its own applicable subset (e.g., no `{DOCUMENT_CHECKLIST}`, no `{OPEN_TASKS}`).
- What happens when a property has no amenities classified? `{AVAILABLE_AMENITIES}` and `{ON_REQUEST_AMENITIES}` render the full unclassified list and empty respectively (backward compatible).

## Requirements

### Functional Requirements

- **FR-001**: System MUST define a fixed set of template variables with `{VARIABLE_NAME}` syntax
- **FR-002**: System MUST replace all recognized variables in the system prompt with their runtime values before sending to the AI
- **FR-003**: System MUST auto-append essential variables (`{CURRENT_MESSAGES}`, `{PROPERTY_GUEST_INFO}`, `{CONVERSATION_HISTORY}`) if they are missing from the stored prompt
- **FR-004**: System MUST strip all hardcoded dynamic content from the seed system prompts, replacing them with variable placeholders
- **FR-005**: System MUST handle empty variable values gracefully (e.g., no open tasks → "No open tasks." rather than blank)
- **FR-006**: System MUST preserve backward compatibility — existing customized prompts receive a migration that adds variables
- **FR-007**: System MUST support variables in both coordinator and screening agent prompts. Each agent receives its applicable subset based on `agentScope` (e.g., screening does not receive `{DOCUMENT_CHECKLIST}` or `{OPEN_TASKS}`)
- **FR-008**: System MUST provide separate `{AVAILABLE_AMENITIES}` and `{ON_REQUEST_AMENITIES}` variables based on amenity classification
- **FR-009**: The prompt editor MUST display available variables with descriptions
- **FR-010**: The prompt editor MUST warn when essential variables are missing from the prompt
- **FR-011**: Unrecognized `{SOME_TEXT}` in the prompt MUST be left as-is (not stripped, not errored)
- **FR-012**: System MUST NOT inject dynamic content outside of variable placeholders — no duplication
- **FR-016**: Variable data MUST resolve as separate user message content blocks, NOT inline in the system prompt text, to preserve prompt caching
- **FR-013**: Operators MUST be able to view how each variable resolves per listing
- **FR-014**: Operators MUST be able to customize variable output per listing (custom titles, notes)
- **FR-015**: Per-listing customizations MUST be stored persistently and survive resyncs from Hostaway

### Key Entities

- **TemplateVariable**: A named placeholder (e.g., `CONVERSATION_HISTORY`) with a human-readable description, a runtime resolver that produces the replacement text, and an `essential` flag indicating whether the system auto-appends it if missing
- **SystemPrompt**: The stored prompt text in `TenantAiConfig` containing static behavioral instructions + `{VARIABLE}` placeholders
- **PropertyVariableOverride**: Per-property customizations (custom title, notes, field ordering) that get merged into the variable output at runtime

## Success Criteria

### Measurable Outcomes

- **SC-001**: Operators can rearrange the position of any dynamic content block in the system prompt and the AI receives data in the new order
- **SC-002**: Zero duplication of dynamic content when using the default seed prompts
- **SC-003**: Existing tenants with custom prompts continue to work after migration without manual intervention
- **SC-004**: 100% of previously hardcoded dynamic blocks are now controlled by variables
- **SC-005**: Prompt editor shows all available variables and warns on missing essentials within 1 second of opening
- **SC-006**: Per-listing variable preview accurately reflects the data the AI would receive for that property

## Assumptions

- The `{VARIABLE}` syntax (single curly braces, uppercase with underscores) is sufficient and won't conflict with prompt content. If an operator writes literal `{SOME_TEXT}` in their instructions, it would only be affected if it matches a registered variable name exactly.
- The variable set is fixed at the system level — operators cannot create custom variables, only rearrange and customize the built-in ones.
- The screening agent uses a subset of the same variables (e.g., no `{DOCUMENT_CHECKLIST}`, no `{OPEN_TASKS}`).
- Migration for existing prompts appends a default variable block rather than trying to detect and replace inline dynamic content.
- Per-listing customizations are stored in `customKnowledgeBase` (existing JSON field) under a dedicated key, preserved during Hostaway resyncs.
