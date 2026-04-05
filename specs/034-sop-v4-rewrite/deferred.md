# Deferred Items: SOP Library v4 Rewrite

**Created**: 2026-04-06
**Feature**: 034-sop-v4-rewrite

## Deferred from this feature

### 1. Programmatic Confirmation Gate
**What**: Application code that prevents the model from escalating before receiving guest confirmation on two-turn SOPs (cleaning, amenity-request, visitor-policy, property-viewing, post-stay-issues).
**Why defer**: The v4 SOPs include clear worked examples showing two-turn behavior. The `sop_step` field makes violations traceable. Monitor multi-turn failure rate first — if >10%, implement the gate.
**When to implement**: After 2 weeks of production data with the new SOPs. Check AiApiLog for cases where `action: "escalate"` was used on the first turn of a confirmation-required SOP.
**Implementation notes**: Needs `sop_step` and `action` persisted in conversation message metadata (not just ragContext). The gate logic reads the previous assistant turn's sop_step to verify an "ask" happened first.

### 2. Eval Harness (40+ Labeled Test Cases)
**What**: Automated test suite with labeled input/expected-output pairs covering all SOP paths, multi-turn flows, and edge cases.
**Why defer**: Important tooling but doesn't block the SOP rewrite itself. Can be built in parallel with production monitoring.
**When to implement**: Before expanding to Wave 2 SOPs in production. Target: 3+ test cases per SOP path.
**Implementation notes**: Test case structure: guest_message, booking_status, conversation_history, expected action, expected sop_step prefix, expected escalation, guest_message contains/excludes checks.

### 3. Wave-Based Rollout with Feature Flags
**What**: Feature flag per SOP allowing rollback to v3 content independently per category.
**Why defer**: Adds complexity. If we test thoroughly via sandbox before deploying, the risk is manageable.
**When to implement**: Only if regression is detected in production. Keep v3 SOP content in the codebase (commented out or in a separate constant) for 30 days.

### 4. Persisting action and sop_step in Message Metadata
**What**: Store `action` and `sop_step` on the Message record so they're available for the confirmation gate and conversation history analysis.
**Why defer**: Currently only logged in ragContext/AiApiLog. Sufficient for debugging. Only needed if the confirmation gate is implemented.
**When to implement**: Same time as the confirmation gate.

### 5. Conversation History as Role-Separated Messages
**What**: Send conversation history as proper role-separated `user`/`assistant` turns instead of a flat text block.
**Why defer**: Deferred from 033. Still deferred — requires pipeline restructuring.

## Deferred from 033 (carried forward)

### 6. get_faq Dynamic Category Loading
**What**: Load FAQ categories from DB instead of hardcoded enum.
**Why defer**: Works as-is. Would be nice but separate concern.

### 7. get_faq query_terms Parameter
**What**: Add keywords array for logging and future embedding-based retrieval.
**Why defer**: No retrieval change needed yet.

### 8. check_extend_availability change_type Enum
**What**: Explicit intent declaration (extend, shorten, change_checkin, change_both).
**Why defer**: Date-based inference works fine.
