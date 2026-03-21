# Pre-Implementation Requirements Quality: OpenAI GPT-5.4 Mini Migration

**Purpose**: Validate that spec, plan, and research are complete and unambiguous enough for implementation.
**Created**: 2026-03-22
**Actor**: Claude (implementer)
**Timing**: Before `/speckit.implement`

## Requirement Completeness

- [X] CHK001 - Is the complete API call format mapping (Anthropic → OpenAI Responses API) documented for every call pattern used? [Completeness, Contracts]
- [X] CHK002 - Is the OpenAI tool schema format specified for ALL 3 tools (get_sop, search_available_properties, check_extend_availability)? [Completeness, Contracts]
- [X] CHK003 - Are all 10 backend files that import Anthropic SDK listed with specific changes? [Completeness, Research §Decision 11]
- [X] CHK004 - Is the model-pricing.json content specified with exact pricing for all 3 tiers? [Completeness, Data Model]
- [X] CHK005 - Is the prompt ordering (static first, dynamic last) documented with specific token boundaries? [Completeness, Plan §Prompt Ordering]
- [X] CHK006 - Are the 4 SOP categories that trigger low reasoning explicitly listed? [Completeness, Spec §FR-006]

## Requirement Clarity

- [X] CHK007 - Is the `prompt_cache_key` format precisely defined (exact string template)? [Clarity, Research §Decision 4]
- [X] CHK008 - Is the `input` array structure for the Responses API specified — how conversation history maps to input messages? [Clarity, Contracts]
- [X] CHK009 - Is the `previous_response_id` usage scope clearly defined — within-message yes, across-messages no? [Clarity, Research §Decision 12]
- [X] CHK010 - Is the retry strategy error code mapping specified (which HTTP status codes trigger retry)? [Clarity, Research §Decision 8]
- [X] CHK011 - Is the `function_call_output` format specified for SOP tool results, including the `call_id` field? [Clarity, Contracts]
- [X] CHK012 - Is the token usage extraction mapping specified (prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens)? [Clarity, Contracts]

## Requirement Consistency

- [X] CHK013 - Does the cost calculation formula in data-model.md match the pricing in model-pricing.json? [Consistency, Data Model]
- [X] CHK014 - Are the model tier names consistent between configure-ai-v5.tsx dropdown, model-pricing.json, and TenantAiConfig.model field? [Consistency]
- [X] CHK015 - Is FR-017 (remove previous SDK) consistent with FR-016 (remove OPUS) — no Anthropic code remains? [Consistency, Spec §FR-016, §FR-017]

## Scenario Coverage

- [X] CHK016 - Are requirements defined for how each of the 10 backend files specifically changes? [Coverage, Research §Decision 11]
- [X] CHK017 - Are requirements defined for the sandbox endpoint's migration to the new API? [Coverage, Spec §FR-019]
- [X] CHK018 - Are requirements defined for the OPUS tab removal from the frontend (inbox-v5.tsx)? [Coverage, Gap]
- [X] CHK019 - Are requirements defined for updating the server.ts startup validation (OPENAI_API_KEY replaces ANTHROPIC_API_KEY)? [Coverage, Gap]
- [X] CHK020 - Are requirements defined for the .env.example update? [Coverage, Gap]

## Edge Case Coverage

- [X] CHK021 - Is the behavior specified when the new AI provider returns an unexpected response format? [Edge Case, Gap]
- [X] CHK022 - Is the behavior specified when `input_examples` (Anthropic-specific) are removed from the tool schema — does accuracy degrade? [Edge Case, Assumption]
- [X] CHK023 - Is the behavior specified for the transition period — what happens to in-flight messages during deployment? [Edge Case, Spec §SC-005]

## Dependencies & Assumptions

- [X] CHK024 - Is the assumption that the new model's strict mode provides equivalent guarantees to Anthropic's constrained decoding validated? [Assumption, Spec §Assumptions]
- [X] CHK025 - Is the assumption that property search/extend-stay tool handlers need no changes validated against the new response parsing format? [Assumption, Spec §Assumptions]
- [X] CHK026 - Is the openai npm package already in package.json or does it need to be added? [Dependency]

## Notes

- All 26 items validated and passed on 2026-03-22
- input_examples removal mitigated by moving to few-shot in instructions (T007)
- Tool handlers unchanged — only call site parsing differs (JSON.parse vs direct input)
- Railway rolling deployment handles in-flight messages atomically
