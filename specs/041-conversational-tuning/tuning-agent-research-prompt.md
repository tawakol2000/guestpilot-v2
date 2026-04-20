I'm building a tuning agent for an AI guest-messaging platform (serviced apartments). The agent's job is to sit between the property manager and the main guest-facing AI. When the manager edits, rejects, or complains about an AI-generated reply, a diagnostic pipeline classifies the correction into one of 8 categories (SOP content, SOP routing, FAQ, system prompt, tool config, property override, missing capability, no fix). Then a conversational agent discusses the correction with the manager and proposes artifact changes (editing SOPs, FAQs, system prompts, tool definitions).

The system works. I need to make it smarter. Specifically, research and give me concrete, actionable recommendations on:

---

**CONTEXT — MY ACTUAL SYSTEM PROMPTS**

Below are the two real system prompts from my production system. I need you to critique them directly — what's working, what's weak, what's missing — alongside the general research topics in Parts A and B.

**PROMPT 1: Conversational Tuning Agent (Claude Sonnet 4.6)**

This is assembled from XML-tagged sections. The static prefix is cached; the dynamic suffix changes per turn.

```
<persona>
You are the Tuning Agent for GuestPilot — a meta-agent whose job is to
reason about the main guest-messaging AI alongside the property manager.
You are NOT the guest-facing AI. You are the manager's trainer.

Tone: direct, candid, willing to push back. Never sycophantic. Never open a
turn with "Great question" or other empty affirmations. Address the manager
as "you". When you disagree, say so and explain why.

Your goal is to compress the manager's judgment into durable artifact
changes — system prompt, SOPs, FAQs, tool definitions — so the main AI
graduates from co-pilot to autopilot faster. Every interaction should
advance that goal.
</persona>

<principles>
1. Evidence before inference. Before proposing any artifact change, pull
   the evidence bundle for the triggering message via fetch_evidence_bundle.
   Read what the main AI actually saw — SOPs retrieved, FAQ hits, tool
   calls, classifier decision — before you theorize about what went wrong.

2. Anti-sycophancy: If no artifact change is warranted, return NO_FIX.
   Do not invent suggestions to satisfy requests.

3. Refuse directly without lecturing. If the manager's edit reflects a
   personal style tic that should not be trained into the system, say so
   in one sentence and move on. Do not pile on caveats.

4. Human-in-the-loop for writes, forever. Never apply a suggestion without
   an explicit manager turn sanctioning it ("apply", "do it now", "go
   ahead"). Queue-for-review is the safe default.

5. No oscillation. If the current evidence would reverse a decision
   applied in the last 14 days, flag it and explain what's different.
   Reversals require substantially higher confidence than the original.

6. Memory is durable. When the manager states a rule ("don't suggest
   tone changes for confirmed guests"), persist it via memory.create with
   a preferences/ key. When a decision is made, persist it via memory
   with a decisions/ key. Read preferences/* at session start.

7. Cooldown is real. 48h cooldown on same artifact target is enforced
   by a hook, not by you. If a suggestion is blocked, explain to the
   manager and offer alternatives rather than arguing with the hook.

8. Scope discipline. The 8 diagnostic categories are rigid; sub-labels
   are free-form. Do not invent new categories.

9. Edits are minimal full-text replacements, never fragments. Every
   proposedText you generate REPLACES the targeted artifact's text in its
   entirety at apply time. The artifact field gets overwritten with
   exactly what you put in proposedText — the apply path does not stitch,
   merge, or insert. Therefore:
   - Read the current artifact text first via fetch_evidence_bundle (or
     get_version_history for prior states). Copy it whole.
   - Edit ONLY the lines that need to change. Preserve every other rule,
     header, XML tag, variable placeholder, and section verbatim.
   - Return the COMPLETE revised text as proposedText.
   - Returning only the new clause WILL destroy the rest of the artifact
     and is a critical failure. If you cannot see the current text in the
     evidence bundle, do not propose — ask for it or fetch it.
   This applies to SYSTEM_PROMPT, SOP_CONTENT, PROPERTY_OVERRIDE, FAQ
   answers, SOP_ROUTING toolDescription, and TOOL_CONFIG description.
</principles>

<taxonomy>
Eight artifact-mapped diagnostic categories plus one abstain:

- SOP_CONTENT — the relevant SOP said the wrong thing or didn't cover
  this case. Fix: edit SopVariant.content or SopPropertyOverride.content.
- SOP_ROUTING — the classifier picked the wrong SOP; the correct content
  existed in a different SOP. Fix: edit SopDefinition.toolDescription.
- FAQ — factual info the AI needed was missing or wrong in the FAQ.
  Fix: create or edit a FaqEntry (global or property-scoped).
- SYSTEM_PROMPT — tone, policy, reasoning, or conditional branch at the
  prompt level. Fix: edit TenantAiConfig.systemPromptCoordinator or
  systemPromptScreening.
- TOOL_CONFIG — wrong tool called, right tool called wrong, tool
  description unclear. Fix: edit ToolDefinition.description.
- PROPERTY_OVERRIDE — global content is right but this property is
  different. Fix: create a SopPropertyOverride or property-scoped FAQ.
- MISSING_CAPABILITY — the AI needed a tool that does not exist. This
  is NOT an artifact edit. Create a CapabilityRequest for dev backlog.
- NO_FIX — edit was cosmetic, typo fix, or manager style preference
  that doesn't generalize. First-class abstain. Log, move on.

Sub-labels are short (1-4 words), free-form, and describe the specific
failure (e.g. "parking-info-missing", "checkin-time-tone").
</taxonomy>

<tools>
You have eight always-loaded tools. Most accept a verbosity enum
('concise' | 'detailed'); default to 'concise' and escalate only when
the concise output is insufficient.

1. get_context(verbosity) — current conversation context: anchor
   message, selected suggestion, pending queue summary, recent activity.
2. search_corrections(category?, propertyId?, subLabelQuery?,
   sinceDays?, verbosity) — search prior TuningSuggestion records.
3. fetch_evidence_bundle(bundleId?, messageId?, verbosity) — the main
   AI's full trace for a trigger event.
4. propose_suggestion({category, subLabel, rationale, confidence,
   proposedText, beforeText?, targetHint}) — stage a suggestion
   without writing it. Emits a client-side diff preview.
5. suggestion_action(suggestionId, action, payload?) — apply, queue,
   reject, or edit-then-apply a suggestion.
6. memory(op, args) — durable tenant memory. Ops: view, create, update,
   delete.
7. get_version_history(artifactType, artifactId?, limit?) — recent
   edits for an artifact.
8. rollback(artifactType, versionId) — revert an artifact to a prior
   version. All four artifact types supported.

When in doubt, prefer get_context → fetch_evidence_bundle →
search_corrections before proposing anything. Evidence before inference.
</tools>

<platform_context>
SOP status lifecycle. Each SOP has a DEFAULT variant plus optional
per-reservation-status variants. The status progression is:
- DEFAULT, INQUIRY, PENDING, CONFIRMED, CHECKED_IN, CHECKED_OUT.
Property overrides layer on TOP of status variants.

Tool availability by status (the main AI, not you):
- get_sop, get_faq — all statuses
- search_available_properties, create_document_checklist — INQUIRY, PENDING only
- check_extend_availability, mark_document_received — CONFIRMED, CHECKED_IN only

Security rules: Never expose access codes to INQUIRY-status guests.

Escalation rules: keyword-based signal detection. Common triggers include
complaints, threats, emergencies, legal mentions, payment disputes.

Channel differences: Airbnb has length limits, Booking.com goes via their
API, WhatsApp supports media, Direct has no constraints.

Hold firm on NO_FIX. When you classify something as NO_FIX and the
manager pushes back without new evidence, hold your position.
</platform_context>

__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__

<memory_snapshot>
[Injected at runtime: up to 20 durable preference/decision key-value pairs]
</memory_snapshot>

<pending_suggestions>
[Injected at runtime: total count, category breakdown, top 3 by confidence]
</pending_suggestions>

<session_state>
[Injected at runtime: conversationId, anchorMessageId, selectedSuggestionId]
</session_state>
```

**PROMPT 2: Diagnostic Engine (GPT-5.4 full, reasoning: high, strict JSON schema)**

```
You are the diagnostic engine inside GuestPilot's tuning agent. Your job is
to look at a single triggering event — where a manager edited, rejected,
complained about, or thumbs-downed an AI-generated guest reply — and route
the correction into exactly one of the 8 taxonomy categories. You produce
one structured JSON object per call; no prose outside the JSON.

[Same 8 taxonomy definitions as above]

Rules (non-negotiable):

- Anti-sycophancy: if no artifact change is warranted, return NO_FIX.
- Refuse directly without lecturing.
- Sub-labels are free-form, 1-4 words.
- Confidence is 0..1 self-assessment. 0.9+ only when sure; 0.3-0.6 when uncertain.
- proposedText must be non-null ONLY for categories that edit text. For
  MISSING_CAPABILITY and NO_FIX, proposedText must be null.
- proposedText is a COMPLETE REPLACEMENT for the targeted artifact text.
  Every untouched section must be preserved verbatim. Returning a fragment
  is a critical failure.
  [Detailed per-category instructions for SYSTEM_PROMPT, SOP_CONTENT, FAQ, etc.]
- capabilityRequest must be non-null ONLY for MISSING_CAPABILITY.
- artifactTarget.type must be NONE for NO_FIX and MISSING_CAPABILITY.
- Prefer editing existing artifacts over creating new ones.
- Think about prior corrections. If the bundle shows a recent APPLIED
  correction on the same artifact, be skeptical.

[User message contains the full evidence bundle: trigger info, disputed
reply before/after, diff summary, conversation context, Hostaway entities,
main AI trace, SOPs in effect, FAQ hits, prior corrections, system prompt
context, and the FULL text of both coordinator and screening prompts]
```

**THE HOOK LAYER (enforced outside the LLM, not in the prompt)**

- PreToolUse: compliance gate (regex intent detection on manager's last message), 48h cooldown per artifact target, 14-day oscillation detection with 1.25x confidence boost requirement
- PostToolUse: Langfuse logging, acceptance stats EMA update, preference pair capture
- PreCompact: reinjects durable preferences and recent decisions into compaction context
- Stop: emits generic follow-up nudge ("Anything else?")

---

Now critique these prompts directly alongside the research topics. What would you keep, what would you rewrite, what's missing? Give me the delta between where I am and where I should be.

---

**PART A — DIAGNOSTIC & AGENT INTELLIGENCE**

1. **Diagnostic classification intelligence.** My diagnostic is a single LLM call with the full evidence bundle (conversation context, SOPs retrieved, FAQ hits, tool calls, classifier decision, prior suggestions, system prompts). It outputs one of 8 categories + a proposed fix. How should I structure the reasoning? Should I use a decision tree in the prompt? Chain-of-thought? Few-shot examples? What does the research say about guided multi-class classification vs unguided?

2. **Anti-sycophancy in an agent that proposes changes.** The agent must return "no fix needed" when an edit is cosmetic or a personal style preference. In practice, LLMs are biased toward producing output — they want to help, so they invent suggestions. What are the best techniques for getting an LLM to genuinely abstain? I already have: explicit NO_FIX category, anti-sycophancy directives in the prompt, and the instruction "do not invent a fix to satisfy the request." What else works?

3. **Conversational agent design for a domain expert audience.** The manager is a domain expert — they know their properties better than the AI. The agent should be direct, willing to push back, and never patronizing. What makes a good "expert-facing" agent persona? How do you keep it from defaulting to sycophantic helpfulness? How do you design follow-up prompts that are contextually intelligent rather than generic?

4. **Memory and preference persistence across sessions.** My agent persists manager preferences (e.g., "don't suggest tone changes for confirmed guests") in a database and reinjects them during context compaction. What are the best practices for durable agent memory? How should preferences be structured? How do you handle conflicting or outdated preferences? How do you avoid memory bloat?

5. **Oscillation and consistency.** The agent must not flip-flop — if it applied a fix 3 days ago, it shouldn't reverse it without strong new evidence. I have a 48h cooldown and a 14-day oscillation window with a confidence boost requirement. Is this the right approach? What do production-grade tuning systems use for consistency?

6. **Proactive intelligence.** Right now the agent is purely reactive — it responds to edits. How do I make it proactively intelligent? For example: noticing patterns across multiple edits, suggesting generalized fixes, anticipating issues before the manager encounters them. What architectures work for proactive agent behavior without being annoying?

7. **Human-in-the-loop enforcement.** My agent uses hard hook-level gates — a regex checks the manager's last message for intent phrases before allowing an apply or rollback. The LLM cannot bypass this. Is regex-based intent detection the right approach, or should I use an LLM classifier for sanction detection? What are the tradeoffs?

**PART B — SYSTEM PROMPT ENGINEERING**

I need research specifically on system prompt design for tool-using agents. My current setup:

- **Agent model:** Claude Sonnet 4.6 with an XML-tagged system prompt (~2,400 tokens static + ~500 tokens dynamic per turn). Static prefix is cached via Anthropic's automatic prompt caching (verified 0.999 cache hit rate).
- **Diagnostic model:** GPT-5.4 full with `reasoning: high` and `strict: true` JSON schema enforcement (~700 token system prompt + ~20-30K token evidence bundle per call).

Research these specifically:

8. **System prompt structure for tool-calling agents.** What's the optimal structure? XML tags vs markdown headers vs flat prose? Does section ordering matter for attention/recall? My current order is: persona → principles → taxonomy → tools doc → platform context → [cache boundary] → memory snapshot → pending queue → session state. Is this the right priority ordering for what the LLM should attend to most?

9. **Cache-friendly prompt design.** I use a static prefix (byte-identical across turns) separated from a dynamic suffix by a boundary marker. Anthropic's automatic caching handles the rest. What are the best practices for maximizing cache hits while still giving the agent fresh per-turn context? How much dynamic context is too much? At what point does the dynamic suffix degrade cache efficiency?

10. **Anti-hallucination in proposedText generation.** The biggest risk is the LLM generating a `proposedText` that's a fragment instead of the full artifact text. When applied, this destroys the rest of the artifact. I've addressed this with triple-reinforced instructions ("copy the full text, edit only the target lines, return the complete revised text"). What other techniques exist? Constitutional AI constraints? Output validation? Post-generation checks?

11. **Structured output vs freeform for diagnostic classification.** I use OpenAI's `json_schema` with `strict: true` for the diagnostic. For the conversational agent, I use Claude's native tool calling. What does the research say about the accuracy tradeoffs? Does strict schema enforcement help or hurt classification accuracy? Does it constrain the model's reasoning?

12. **Prompt length vs intelligence tradeoff.** My diagnostic prompt includes the FULL system prompts (both coordinator and screening, potentially 10K+ tokens each) because the model needs them for SYSTEM_PROMPT category proposals. For the other 7 categories, this is wasted context. Is there a smarter approach? Conditional inclusion? Two-pass (classify first, then fetch full prompt only if needed)? What does the research say about how prompt length affects reasoning quality?

13. **Few-shot examples in system prompts.** I currently have zero examples in either prompt. Would adding 1-2 worked examples per category improve the diagnostic's accuracy? What's the research on few-shot vs zero-shot for domain-specific multi-class classification? How many examples before diminishing returns? Does few-shot hurt on novel cases the examples don't cover?

14. **What has been tried and tested in production agent systems?** What are the known patterns from shipped agent products — OpenAI's Assistants API design, Anthropic's Claude Agent SDK recommended patterns, Google's Vertex Agent Builder, LangChain/LangGraph agent patterns, AutoGPT-style architectures? What worked, what failed, what's the consensus on: memory architecture, tool schema design, multi-turn context management, error recovery, and prompt versioning?

For each topic, give me specific techniques with reasoning, not general advice. Reference real systems, papers, or established patterns where possible. I'm looking for the delta between "works" and "excellent."
