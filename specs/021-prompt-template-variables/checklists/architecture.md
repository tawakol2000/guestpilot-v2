# Architecture & Migration Risk Checklist: Prompt Template Variables

**Purpose**: Validate completeness, clarity, and consistency of requirements for the variable injection engine, migration strategy, and backward compatibility
**Created**: 2026-03-24
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)

## Requirement Completeness

- [ ] CHK001 - Are all 8 template variables explicitly defined with name, description, and scope? [Completeness, Spec §US1]
- [ ] CHK002 - Is the exact regex or matching pattern for `{VARIABLE_NAME}` syntax specified? [Gap]
- [ ] CHK003 - Are requirements defined for which variables the screening agent receives vs coordinator? [Completeness, Spec §FR-007]
- [ ] CHK004 - Is the ordering logic for content blocks documented — do blocks appear in the order variables appear in the prompt text? [Gap, Plan §Architecture]
- [ ] CHK005 - Are requirements specified for what happens when `buildPropertyInfo()` output changes shape (fields added/removed)? [Gap, Dependency]
- [ ] CHK006 - Is the per-listing `variableOverrides` JSON schema fully defined (all allowed keys, value types, nesting depth)? [Completeness, Data Model]
- [ ] CHK007 - Are requirements defined for the variable preview endpoint (response format, which data is included)? [Gap]

## Requirement Clarity

- [ ] CHK008 - Is "auto-append essential variables" behavior precisely defined — appended as content blocks at the end, or inserted at a specific position? [Clarity, Spec §FR-003]
- [ ] CHK009 - Is "sensible empty state" quantified for each variable — what exact text renders when no data exists? [Ambiguity, Spec §FR-005]
- [ ] CHK010 - Is "custom title" for per-listing overrides clearly defined — does it replace the section header, prepend to content, or wrap the block? [Ambiguity, Spec §US4]
- [ ] CHK011 - Is "notes" in per-listing overrides clearly defined — where do notes appear in the resolved output relative to auto-generated content? [Ambiguity, Spec §US4]
- [ ] CHK012 - Is the distinction between "variable reference in system prompt" and "content block in user message" clearly specified for implementers? [Clarity, Clarifications §Q1]

## Migration & Backward Compatibility

- [ ] CHK013 - Is the migration trigger condition defined — how does the system detect "prompt lacks variables"? [Gap, Plan §Migration]
- [ ] CHK014 - Is the exact content of the "appended variable reference block" specified for migration? [Gap, Spec §Edge Cases]
- [ ] CHK015 - Are requirements defined for what happens if migration runs twice on the same tenant (idempotency)? [Gap, Edge Case]
- [ ] CHK016 - Is the `{PROPERTY_AMENITIES}` → `{ON_REQUEST_AMENITIES}` alias behavior precisely documented — where is the alias resolved, for how long is it supported? [Clarity, Spec §Edge Cases]
- [ ] CHK017 - Are requirements defined for the interaction between old hardcoded dynamic blocks in existing prompts AND new auto-appended variables (duplication risk)? [Gap, Risk]
- [ ] CHK018 - Is the `systemPromptVersion` bump behavior documented — what version increment, and does the frontend surface it? [Gap, Plan §Migration]
- [ ] CHK019 - Are rollback requirements defined if migration causes broken prompts? [Gap, Recovery Flow]

## Requirement Consistency

- [ ] CHK020 - Do the variable names in the spec table (§US1) match the variable names referenced in acceptance scenarios, edge cases, and FRs? [Consistency]
- [ ] CHK021 - Is `{DOCUMENT_CHECKLIST}` consistently scoped — spec says coordinator-only, but data-model says `propertyBound: true` implying per-listing customization. Are both correct simultaneously? [Consistency, Spec §FR vs Data Model]
- [ ] CHK022 - Does the "essential variables" list in FR-003 match the essentials in the data-model registry? [Consistency, Spec §FR-003 vs Data Model]
- [ ] CHK023 - Are the `agentScope` assignments in the data-model consistent with the screening agent exclusions mentioned in spec assumptions? [Consistency, Assumption §3]

## Edge Case & Exception Coverage

- [ ] CHK024 - Are requirements defined for what happens when the system prompt text contains `{SOME_TEXT}` that partially matches a variable name (e.g., `{CURRENT}`)? [Edge Case, Spec §FR-011]
- [ ] CHK025 - Are requirements specified for concurrent edits — operator editing prompt while AI is processing a message with the old version? [Gap, Concurrency]
- [ ] CHK026 - Are requirements defined for very long variable output (e.g., 20+ open tasks) — is there truncation or summarization? [Gap, Scale]
- [ ] CHK027 - Are requirements specified for the interaction between per-listing overrides and the Listings page amenity classification system? [Gap, Integration]
- [ ] CHK028 - Does the spec address what happens when an operator saves a prompt with only non-essential variables (e.g., just `{CURRENT_LOCAL_TIME}`) — no property info, no messages, no history? [Edge Case]

## Non-Functional Requirements

- [ ] CHK029 - Is the "<5ms variable replacement" performance target from the plan reflected as a measurable success criterion in the spec? [Gap, Plan vs Spec]
- [ ] CHK030 - Are prompt caching requirements explicitly stated as a constraint — not just an assumption? [Clarity, Clarifications §Q1]
- [ ] CHK031 - Is the `USER_MANAGED_KEYS` update for `variableOverrides` documented as a requirement, not just a plan detail? [Gap, Spec §FR-015 vs Plan]

## Notes

- Focus: Architecture & migration risk (per user selection)
- Depth: Standard (31 items)
- Audience: Reviewer (pre-implementation gate)
- Items reference spec.md sections, plan.md architecture decisions, and data-model.md registry
