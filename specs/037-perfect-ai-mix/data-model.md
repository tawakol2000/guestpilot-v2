# Data Model: Perfect AI Mix

## Schema Changes

### TenantAiConfig (existing model — add field)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| showAiReasoning | Boolean | false | Toggle to show/hide AI reasoning in inbox |

No other schema changes. The screening schema field rename (`guest message` → `guest_message`) is a JSON schema constant change, not a database change.

## New Entities

### ScreeningState (computed, not persisted)

A runtime-only entity computed per AI call for INQUIRY/PENDING reservations. Not stored in the database — computed fresh each time from conversation history and open tasks.

| Field | Type | Description |
|-------|------|-------------|
| phase | GATHER / DECIDE / POST_DECISION | Current screening phase |
| nationalityMentioned | boolean | Whether any guest message contains nationality indicators |
| compositionMentioned | boolean | Whether any guest message contains composition indicators |
| screeningDecisionExists | boolean | Whether an open task with a screening title exists |
| screeningDecisionTitle | string or null | The existing screening task's title |
| checklistCreated | boolean | Whether a document checklist has been created |
| awaitingManagerReview | boolean | Whether the guest is awaiting manager decision |
| hint | string | Human-readable instruction injected as content block |

**Phase Logic**:
- POST_DECISION: screening task exists in open tasks (eligible-*, violation-*, awaiting-manager-review)
- DECIDE: both nationality and composition mentioned, no screening task yet
- GATHER: either nationality or composition not yet mentioned

### PreComputedContext (computed, not persisted)

A runtime-only entity computed per AI call. Injected as a content block.

| Field | Type | Description |
|-------|------|-------------|
| is_business_hours | boolean | 10am-5pm Cairo time |
| day_of_week | string | Current day name |
| days_until_checkin | number | Days from today to check-in |
| is_within_2_days_of_checkin | boolean | Derived from above |
| days_until_checkout | number | Days from today to check-out |
| is_within_2_days_of_checkout | boolean | Derived from above |
| stay_length_nights | number | Total stay duration |
| is_long_term_stay | boolean | > 21 nights |
| has_back_to_back_checkin | boolean | Another booking ends on check-in day |
| has_back_to_back_checkout | boolean | Another booking starts on check-out day |
| booking_status | string | Current reservation status |
| existing_screening_escalation_exists | boolean | (screening only) |
| existing_screening_title | string or null | (screening only) |
| document_checklist_already_created | boolean | (screening only) |

## Existing Entities (unchanged)

- **Conversation**: conversationSummary field used for summary injection (already exists)
- **Task**: open tasks queried for duplicate prevention and screening state (already exists)
- **Reservation**: screeningAnswers JSON field stores document checklist (already exists)
- **AiApiLog**: ragContext stores derived action, sop_step, screening phase (already exists, JSON field)

## Tool Scope Change

### search_available_properties

| Field | Old Value | New Value |
|-------|-----------|-----------|
| agentScope | INQUIRY,PENDING | CONFIRMED,CHECKED_IN |

This removes the property search tool from the screening agent's available tools.
