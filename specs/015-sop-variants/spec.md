# Feature Specification: Status-Aware SOP Variants & Interactive SOP Management

**Feature Branch**: `015-sop-variants`
**Created**: 2026-03-22
**Status**: Draft
**Input**: Add booking-status-aware SOP content variants with a fully interactive SOP management page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Status-Aware SOP Content (Priority: P1)

When the AI classifies a guest message into an SOP category, the system retrieves the correct procedure variant based on the guest's booking status (INQUIRY, CONFIRMED, or CHECKED_IN). The AI receives ONE clear procedure with no conditional branching — the application picks the right version before the AI sees it. SOPs that don't vary by status have a single default version.

**Why this priority**: Without this, the AI gives inappropriate guidance — telling INQUIRY guests to schedule amenity delivery, or telling CHECKED_IN guests information meant for pre-booking. This directly affects response accuracy.

**Independent Test**: Send "is there a baby crib?" as an INQUIRY guest and as a CHECKED_IN guest. Verify the AI gives availability info to the INQUIRY guest and asks for delivery time for the CHECKED_IN guest.

**Acceptance Scenarios**:

1. **Given** an INQUIRY guest asks about amenities, **When** the SOP is retrieved, **Then** the content focuses on availability confirmation without mentioning delivery scheduling
2. **Given** a CONFIRMED guest asks about amenities, **When** the SOP is retrieved, **Then** the content assures the amenity will be ready for arrival without scheduling delivery
3. **Given** a CHECKED_IN guest asks about amenities, **When** the SOP is retrieved, **Then** the content asks for preferred delivery time during working hours
4. **Given** an SOP has no status-specific variants, **When** retrieved for any status, **Then** the default content is returned regardless of booking status
5. **Given** an SOP variant is disabled for a specific status, **When** a guest with that status triggers the SOP, **Then** the default variant is used instead
6. **Given** a new SOP variant is created for a status, **When** saved, **Then** subsequent messages for that status use the new variant immediately

---

### User Story 2 - Interactive SOP Management Page (Priority: P1)

Operators can view, edit, enable/disable, and manage all SOPs and their variants from a dedicated management page. The page shows a comprehensive table of all SOP categories with their tool descriptions, content variants per booking status, and enable/disable toggles. Operators can edit SOP content inline, adjust tool descriptions that guide AI classification, and see which SOPs have status-specific variants.

**Why this priority**: Operators need to customize SOP procedures for their properties. Without an interactive page, SOP changes require code deployments. This is tied with US1 as both are needed for a complete solution.

**Independent Test**: Open the SOP management page. Edit the CHECKED_IN variant of the amenity request SOP. Save. Send a CHECKED_IN guest message about amenities. Verify the AI uses the updated procedure.

**Acceptance Scenarios**:

1. **Given** an operator opens the SOP page, **When** it loads, **Then** they see all SOP categories in a table with columns: SOP name, tool description, and content (with status variant selector)
2. **Given** an operator selects a booking status tab for an SOP, **When** they view the content, **Then** they see the variant specific to that status (or "Using default" if no variant exists)
3. **Given** an operator edits an SOP's content for a specific status, **When** they save, **Then** the change takes effect immediately for new messages
4. **Given** an operator edits a tool description, **When** they save, **Then** the AI classification uses the updated description for subsequent messages
5. **Given** an operator disables an SOP for a specific status, **When** a guest with that status triggers the category, **Then** the system falls back to the default variant
6. **Given** an operator wants to add a new variant, **When** they click "Add variant" for a status, **Then** they can write custom content for that status

---

### User Story 3 - Property-Specific SOP Overrides (Priority: P2)

Operators can override SOP content for specific properties. A property-level SOP override takes precedence over the global SOP for guests at that property. This allows different properties to have different procedures (e.g., one property has a pool, another doesn't — the amenity SOP should differ).

**Why this priority**: Multi-property operators have different amenities, rules, and procedures per property. Global SOPs can't account for these differences.

**Independent Test**: Override the cleaning SOP for Property A with a custom fee. Verify guests at Property A see the custom procedure while guests at Property B see the global default.

**Acceptance Scenarios**:

1. **Given** a property has an SOP override, **When** a guest at that property triggers the SOP, **Then** the property-specific content is used instead of the global content
2. **Given** a property has no override for an SOP, **When** a guest triggers it, **Then** the global SOP content is used
3. **Given** an operator views the SOP page with a property selected, **When** they see an SOP row, **Then** it shows whether it's using the global default or a property override
4. **Given** an operator creates a property override, **When** they save, **Then** guests at that property immediately see the updated procedure

---

### User Story 4 - SOP Data Persistence (Priority: P1)

All SOP content, variants, tool descriptions, and enable/disable states are stored in the database per tenant. The system no longer relies on hardcoded SOP content in source code. When the system starts, it loads SOPs from the database. If no database SOPs exist (new tenant), it seeds from the default content.

**Why this priority**: Without persistence, all edits are lost on deploy. Operators can't customize SOPs across restarts.

**Independent Test**: Edit an SOP's content. Restart the server. Verify the edited content persists.

**Acceptance Scenarios**:

1. **Given** an operator edits SOP content, **When** the server restarts, **Then** the edited content is preserved
2. **Given** a new tenant is created, **When** they first access SOPs, **Then** the system seeds default SOP content from built-in templates
3. **Given** tool descriptions are edited, **When** saved, **Then** the AI classification tool schema uses the updated descriptions on the next message

---

### Edge Cases

- **Missing variant**: If a variant is requested but doesn't exist, fall back to the default content for that SOP
- **Empty content**: If an SOP variant has empty content, treat it as "no procedure available" — the AI responds from general knowledge
- **All variants disabled**: If all variants of an SOP are disabled, the SOP category still appears in classification but returns no procedure content
- **Tool description too long**: Tool descriptions contribute to the cached prompt. Warn operators if the total description length exceeds a recommended limit
- **Concurrent edits**: If two operators edit the same SOP simultaneously, last-write-wins with a timestamp
- **Seeding on upgrade**: When existing tenants upgrade to this feature, seed their SOPs from the current hardcoded defaults without overwriting any previously saved data
- **Property dropdown integration**: The SOP page's property dropdown controls which property overrides are shown. "Global" shows the tenant-wide defaults.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST retrieve SOP content based on both the classified category AND the guest's booking status (INQUIRY, CONFIRMED, CHECKED_IN)
- **FR-002**: System MUST support a default variant for each SOP that applies when no status-specific variant exists
- **FR-003**: System MUST support up to 3 status-specific variants per SOP (INQUIRY, CONFIRMED, CHECKED_IN) in addition to the default
- **FR-004**: System MUST allow operators to enable or disable individual SOP variants per status
- **FR-005**: System MUST allow operators to edit SOP procedure content inline for each variant
- **FR-006**: System MUST allow operators to edit the tool description for each SOP category (the text that guides AI classification)
- **FR-007**: System MUST persist all SOP data (content, variants, descriptions, enable/disable states) in the database per tenant
- **FR-008**: System MUST seed default SOP content from built-in templates for new tenants or tenants without saved SOPs
- **FR-009**: System MUST allow property-specific SOP overrides that take precedence over global SOPs for guests at that property
- **FR-010**: System MUST display all SOPs in a manageable table view with columns for name, tool description, and content variants
- **FR-011**: System MUST show a property dropdown to switch between global SOPs and property-specific overrides
- **FR-012**: System MUST apply SOP content changes immediately — no restart or redeploy required
- **FR-013**: System MUST keep the AI classification tool schema at 22 categories — status variants do NOT add new enum values
- **FR-014**: System MUST fall back to the default variant when a status-specific variant is missing or disabled
- **FR-015**: System MUST regenerate the tool schema description dynamically from saved tool descriptions when they are edited
- **FR-016**: System MUST indicate in the SOP table which SOPs have status-specific variants vs only a default

### Key Entities

- **SOP Definition**: A single SOP category (e.g., "sop-amenity-request") with a tool description and one or more content variants. Belongs to a tenant. Has an enabled/disabled state per variant.
- **SOP Variant**: A specific version of an SOP's procedure content for a given booking status (DEFAULT, INQUIRY, CONFIRMED, CHECKED_IN). Contains the procedure text and an enabled flag.
- **SOP Property Override**: A property-level override for an SOP's content that takes precedence over the tenant's global SOP for guests at that property.
- **Tool Description**: The lean text used in the AI classification tool schema. One per SOP category. Editable by operators. Affects how the AI decides which SOP to select.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: AI responses for INQUIRY guests never include delivery scheduling language when asking about amenities
- **SC-002**: AI responses for CHECKED_IN guests include delivery/scheduling guidance when requesting amenities
- **SC-003**: All SOP content changes made by operators take effect within 60 seconds (no restart required)
- **SC-004**: The SOP management page loads all SOPs with variants in under 2 seconds
- **SC-005**: Operators can edit and save any SOP variant in under 30 seconds
- **SC-006**: The AI classification accuracy is maintained at the same level after adding status variants (no degradation from tool schema changes)
- **SC-007**: All SOP data survives server restarts (database persistence verified)
- **SC-008**: At least 8 of the 20 operational SOPs have status-specific variants that improve response appropriateness

## Assumptions

- The 22 SOP classification categories remain unchanged — variants only affect the procedure content, not the classification
- The booking status (INQUIRY, CONFIRMED, CHECKED_IN) is always known before SOP content retrieval
- Tool descriptions are shared across all statuses — the AI classifies into the same category regardless of booking status
- The SOP content text is plain text or simple markdown — no rich formatting required
- Property-specific overrides are optional — most properties will use the global defaults
- The system prompt and tool schema can be regenerated dynamically when tool descriptions change
- Existing hardcoded SOP content serves as the seed data for database initialization
