# Prompt Rework Requirements Quality Checklist: Coordinator Prompt Rework with Reasoning

**Purpose**: Validate completeness, clarity, and consistency of requirements for the coordinator prompt rewrite, reasoning field lifecycle, escalation specification, and reasoning effort selector before implementation.
**Created**: 2026-04-05
**Feature**: [spec.md](../spec.md)
**Depth**: Thorough (PR review)
**Focus**: Prompt behavior + Reasoning lifecycle + Cost/performance + Deferred dependency risks

## Prompt Behavior — Escalation Ladder

- [X] CHK001 Are all 9 escalation ladder levels explicitly defined with unambiguous trigger conditions? [Completeness, Spec §FR-002]
- [X] CHK002 Is the priority order between ladder levels clear — specifically, is it documented that "strong negative emotion" outranks "unauthorized action" (e.g., angry refund request → immediate, not scheduled)? [Clarity, Spec §FR-002]
- [X] CHK003 Are the escalation urgency values ("immediate", "scheduled", "info_request") consistently used between the ladder definition and the schema enum? [Consistency, Spec §FR-002 vs contracts/coordinator-schema.md]
- [X] CHK004 Is "uncertain, none of the above" specified as info_request with a required note prefix ("Omar uncertain:")? [Completeness, Spec §FR-002]
- [X] CHK005 Are requirements defined for what happens when the AI applies the ladder but the SOP says a different urgency? (e.g., SOP says scheduled but emotion says immediate — which wins?) [Ambiguity, Spec §FR-002 level 4]

## Prompt Behavior — Escalation Note Format

- [X] CHK006 Are all 6 note fields (Guest, Situation, Guest wants, Context, Suggested action, Urgency reason) explicitly required or is this a soft guideline? [Clarity, Spec §FR-003]
- [X] CHK007 Is "Guest wants: verbatim or near-verbatim" sufficiently defined — does the AI know when to paraphrase vs quote directly? [Ambiguity, Spec §FR-003]
- [X] CHK008 Is it specified what goes in "Urgency reason" — is it "why this level" or "why this level AND why not the level below"? [Clarity, Spec §FR-003]

## Prompt Behavior — Tool Routing

- [X] CHK009 Does the tool routing table in the spec cover all guest intent categories — are any common intents missing (e.g., pricing questions, booking confirmations, local recommendations)? [Coverage, Spec §FR-006]
- [X] CHK010 Is the SOP-first pattern unambiguously defined — specifically, does the spec clarify that get_sop is called FIRST even when get_faq seems more appropriate for factual questions? [Clarity, Spec §FR-015]
- [X] CHK011 Is multi-intent routing specified — which tool runs first when a message contains both an operational request and a factual question? [Gap, Spec §FR-006]

## Prompt Behavior — Tone & Conversation Repair

- [X] CHK012 Are the "good/bad examples" in FR-005 sufficient to cover the main tone scenarios (operational, emotional, complaint, Arabic)? [Coverage, Spec §FR-005]
- [X] CHK013 Is "acknowledge a misunderstanding in four words or fewer" specific enough — does this mean exactly 4 words max, or approximately 4? [Clarity, Spec §FR-004]
- [X] CHK014 Are language matching rules defined for languages other than Arabic and English (e.g., French, German)? [Coverage, Spec §FR-005]
- [X] CHK015 Is "match formality register" defined with specific examples for Arabic (حضرتك vs انت) and English (formal vs casual)? [Clarity, Spec §FR-005]

## Prompt Behavior — Worked Examples

- [X] CHK016 Do the worked examples cover all 4 required scenarios: direct answer, SOP-grounded with clarification, multi-intent with escalation, acknowledgment? [Completeness, Spec §FR-007]
- [X] CHK017 Do the worked examples demonstrate the reasoning field being populated in each scenario? [Consistency, Spec §FR-007 vs FR-001]
- [X] CHK018 Do the worked examples show the structured escalation note format when escalation is present? [Consistency, Spec §FR-007 vs FR-003]

## Reasoning Field Lifecycle

- [X] CHK019 Is the reasoning field's position (first property) documented as a hard requirement with rationale (token-order chain-of-thought)? [Clarity, Spec §FR-001]
- [X] CHK020 Is it specified what "under 80 words" means — is this a schema-enforced constraint or a soft prompt guideline? [Ambiguity, Spec §FR-001, Edge Cases]
- [X] CHK021 Is the stripping behavior precisely defined — is reasoning removed from the parsed JSON object before Hostaway send, or from the serialized string? [Clarity, Spec §FR-012]
- [X] CHK022 Is it specified whether reasoning appears in the Message database record content field, or only in AiApiLog? [Gap, Spec §FR-012]
- [X] CHK023 Are requirements defined for what the SSE broadcast payload looks like when reasoning is included — is it a new field on the existing message object or a separate event? [Clarity, Spec §FR-012]
- [X] CHK024 Is the empty-reasoning edge case (model returns reasoning: "") handled — does the system log an anomaly, skip display, or treat as normal? [Edge Case, Spec US1 scenario 4]

## Settings Toggle — Reasoning Visibility

- [X] CHK025 Is the default value for showAiReasoning (false) explicitly documented as a requirement, not just an assumption? [Completeness, Spec §FR-013]
- [X] CHK026 Is the UI presentation of reasoning in the inbox specified — is it collapsible, inline, tooltip, separate panel, or unspecified? [Gap, Spec §FR-013]
- [X] CHK027 Are requirements defined for how historical messages (sent before toggle was enabled) display — do they show reasoning retroactively or only for new messages? [Gap, Spec §FR-013]
- [X] CHK028 Is it specified whether the toggle applies per-user or per-tenant? [Clarity, Spec §FR-013 — spec says per-tenant but should confirm]

## Tool Reasoning Parameters

- [X] CHK029 Is the reasoning parameter description consistent across all tool definitions (get_sop, get_faq, check_extend, mark_document, search_properties)? [Consistency, Spec §FR-008]
- [X] CHK030 Are CALL/DO NOT CALL boundaries defined for ALL five system tools, not just the new ones? [Completeness, Spec §FR-009]
- [X] CHK031 Is it specified whether the tool reasoning field is logged in ragContext.tools alongside existing tool call data? [Gap, Spec §FR-008]

## Reasoning Effort Selector

- [X] CHK032 Are all distress signal keywords listed — or is the requirement "a configurable list" with examples? [Clarity, Spec §FR-010]
- [X] CHK033 Is the Arabic distress signal list (غاضب, مش معقول, بشتكي) documented as extensible/configurable or hardcoded? [Clarity, Spec Assumptions]
- [X] CHK034 Is "ALL CAPS over 20 characters" a clear threshold — does it mean the entire message is uppercase, or that it contains 20+ uppercase characters? [Ambiguity, Spec §FR-010]
- [X] CHK035 Is the "2+ open tasks" threshold justified — why 2 and not 3? Is this configurable? [Clarity, Spec §FR-010]
- [X] CHK036 Is "message length > 300 characters" tested against the raw guest message or the full input including context? [Ambiguity, Spec §FR-010]
- [X] CHK037 Is the fallback behavior (default "low" on error) consistently specified between FR-011 and the edge cases section? [Consistency, Spec §FR-011 vs Edge Cases]
- [X] CHK038 Are requirements defined for logging the selected reasoning effort level — where is it stored? [Gap, Spec §FR-010]

## Acceptance Criteria Quality

- [X] CHK039 Can SC-001 ("100% of responses include non-empty reasoning") be measured without manual inspection — is automated validation defined? [Measurability, Spec §SC-001] — Measured by querying AiApiLog for empty reasoning in responseText. Automated via SQL.
- [X] CHK040 Is SC-002 ("90% of escalation notes follow structured format") measurable — how is "structured format" evaluated (regex, manual spot-check, AI judge)? [Measurability, Spec §SC-002] — Measured by spot-checking AI Logs. Format has 6 labeled fields — presence is easily checkable.
- [X] CHK041 Is SC-004 ("tool call misrouting rate decreases") measurable — how is a "wrong tool" defined and how is the baseline established? [Measurability, Spec §SC-004] — Baseline from current AI Logs before deployment. "Wrong tool" = manager override or correction within same conversation. Manual review.
- [X] CHK042 Is SC-005 ("90% of simple messages use low effort") measurable — how is "simple" vs "complex" categorized for measurement? [Measurability, Spec §SC-005] — "Simple" = reasoning effort selector picked "low". "Complex" = picked "medium". Logged in ragContext.reasoningEffort, queryable.

## Deferred Item Dependency Risks

- [X] CHK043 Does the deferred "conversation history as role-separated messages" have any dependency on the reasoning field lifecycle (e.g., will reasoning need to be included in conversation turns later)? [Dependency, Out of Scope] — No dependency. Reasoning is not stored in Message records, so conversation history format change is independent.
- [X] CHK044 Does the deferred "get_faq query_terms" interact with the new reasoning parameter on get_faq — will adding query_terms later require a schema migration or is it additive? [Dependency, Out of Scope] — Additive. query_terms would be a new property alongside reasoning. No conflict.
- [X] CHK045 Is the screening agent explicitly excluded — does the reasoning field only apply to the coordinator schema, or will it break the screening agent's schema validation? [Dependency, Out of Scope] — Explicitly excluded in spec. Coordinator and screening use separate schema definitions. No breakage.

## Notes

- Check items off as completed: `[x]`
- Items marked [Gap] indicate missing requirements that should be added to the spec
- Items marked [Ambiguity] indicate requirements that could be interpreted multiple ways
- Items marked [Dependency] flag deferred work that may interact with in-scope changes
