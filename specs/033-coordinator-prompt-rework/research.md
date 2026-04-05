# Research: Coordinator Prompt Rework with Reasoning

## R1: OpenAI Reasoning Effort Parameter Compatibility

**Decision**: Use `reasoning: { effort: "low" | "medium" }` parameter in the Responses API call. Fall back silently if unsupported.

**Rationale**: The OpenAI Responses API supports a `reasoning` parameter that controls how much the model "thinks" before responding. gpt-5.4-mini supports this. The parameter is optional — if the model version doesn't support it, the API ignores it or returns an error. Our `createMessage` wrapper should catch and handle gracefully.

**Alternatives considered**:
- Fixed reasoning effort for all messages: Simpler but wastes cost on simple messages (90% of traffic).
- Three-tier (low/medium/high): "high" adds significant cost for minimal benefit. Two tiers (low/medium) capture the important distinction.

## R2: Reasoning Field in Schema — Position and Enforcement

**Decision**: Add `reasoning` as the first property in the coordinator JSON schema. Required string. Strict schema enforcement guarantees it's always present.

**Rationale**: Token generation order matters in autoregressive models. When `reasoning` is the first field, the model writes its internal thinking before committing to `guest_message`. This is structurally equivalent to chain-of-thought prompting but enforced by the schema. The strict JSON schema makes it impossible for the model to skip the field.

**Alternatives considered**:
- Reasoning as last field: Model would generate guest_message first, defeating the purpose.
- Reasoning as optional field: Model might skip it, especially on simple messages where it matters less but still helps prevent errors.
- Separate API call for reasoning: Too expensive and slow. One call with reasoning first is the right tradeoff.

## R3: Reasoning Field Stripping — Where and How

**Decision**: Strip reasoning from the parsed JSON before sending `guest_message` to Hostaway. Include reasoning in the SSE broadcast. Log in AiApiLog.

**Rationale**: The reasoning field is for internal debugging. Guests must never see it. But operators viewing the inbox should be able to see it (behind a settings toggle) for quick debugging without opening AI Logs. The SSE broadcast already carries the AI message to the frontend — adding reasoning to the broadcast payload is trivial.

**Implementation**: After parsing the AI JSON response, extract `reasoning` into a separate variable, log it, include in SSE broadcast payload, then use `guest_message` for Hostaway send. The reasoning never touches the Hostaway API.

## R4: Settings Toggle — Data Model

**Decision**: Add `showAiReasoning` boolean field (default false) to the TenantAiConfig model.

**Rationale**: Per-tenant setting follows our existing pattern (TenantAiConfig stores all AI-related toggles). The frontend reads this via the existing config API. Default off because most operators won't need it — it's a debugging aid.

**Alternatives considered**:
- Per-user setting: More granular but unnecessary complexity. If one operator wants to see reasoning, it's fine for all operators on that tenant to see it.
- Frontend-only toggle (localStorage): Wouldn't persist across sessions or devices. DB-backed is more reliable.

## R5: System Prompt Structure — Merging New and Existing

**Decision**: Rewrite SEED_COORDINATOR_PROMPT incorporating the expert's recommended structure while keeping our content blocks, SOP-first pattern, and GuestPilot-specific rules.

**Key merges**:
- NEW: `reasoning` field in output contract description and worked examples
- NEW: Numbered escalation decision ladder (9 levels)
- NEW: Structured escalation note format (Guest/Situation/Guest wants/Context/Suggested action/Urgency reason)
- NEW: Conversation repair section
- NEW: Tone calibration with good/bad examples
- NEW: Tool routing table
- KEEP: Content blocks (`<!-- CONTENT_BLOCKS -->` section unchanged)
- KEEP: SOP-first tool pattern
- KEEP: Document checklist handling
- KEEP: Task management rules
- KEEP: GuestPilot-specific rules (family-only, no refunds, etc.)
- UPDATE: search_available_properties references to match nano scoring

**Alternatives considered**:
- Drop in the expert's prompt verbatim: Missing content blocks, wrong tool priority, missing GuestPilot-specific rules.
- Minimal changes only: Misses the structural improvements (escalation ladder, reasoning, tone calibration) that are the whole point.

## R6: Tool Description Enrichment — Scope

**Decision**: Add `reasoning` parameter and CALL/DO NOT CALL boundaries to get_faq, check_extend_availability, mark_document_received, and search_available_properties. Update get_sop description for consistency.

**Rationale**: Reasoning on every tool call creates a complete audit trail. CALL/DO NOT CALL boundaries reduce the AI's decision space, making misrouting less likely. The property search failure showed that vague tool descriptions lead to bad routing decisions.

**Changes per tool**:
- `get_sop`: Already has reasoning. Add CALL/DO NOT CALL list.
- `get_faq`: Add reasoning. Add CALL/DO NOT CALL (factual questions only, not procedural).
- `check_extend_availability`: Add reasoning. Add CALL/DO NOT CALL (extend/shorten dates, not late checkout under 2 hours).
- `mark_document_received`: Add reasoning. Add CALL/DO NOT CALL (clear document images only, not unclear images).
- `search_available_properties`: Already has description from 031 rewrite. Add reasoning. Keep current description.
