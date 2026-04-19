I'm building a unified "build + tune" agent for an AI guest-messaging platform (serviced apartments). Today the tuning agent only runs in TUNE mode — it activates when a property manager edits or rejects an AI-generated reply, classifies the correction into one of 8 taxonomy categories, and proposes artifact changes (SOPs, FAQs, system prompt, tools, property overrides). It works well. The gap is the cold start.

The next move is BUILD mode: the same conversational agent can onboard a new manager from zero — interview them about their business, draft the first system prompt, seed the SOPs and FAQs, scaffold tools — without needing any failed guest reply to react to. Then, once the AI goes live and guest messages start flowing in, manager corrections flow to the same agent in TUNE mode.

The commercial thesis is "vibe code your AI through chat" — same experience as using Cursor or Claude Code to build software, but for a vertical AI chatbot. One agent, one chat surface, one set of mental models, for both the empty-state build phase and the living tuning phase.

I need you to research and give me concrete, actionable recommendations on how to architect this. Critique the existing tuning-agent prompt directly — what transfers, what breaks, what's missing for BUILD mode — and reference shipped agent products and real research where relevant. I'm looking for the delta between "works" and "excellent," not general advice.

---

**CONTEXT — MY ACTUAL TUNING-AGENT SYSTEM PROMPT (the one BUILD mode must coexist with)**

Assembled from XML-tagged sections. Static prefix cached, dynamic suffix reassembled per turn. Current order as of sprint 10: principles → persona → taxonomy → tools → platform_context → critical_rules → [cache boundary] → memory_snapshot → pending_suggestions → session_state.

```xml
<principles>
1. Evidence before inference. Before proposing any artifact change, pull
   the evidence bundle for the triggering message via fetch_evidence_bundle.
   Read what the main AI actually saw — SOPs retrieved, FAQ hits, tool
   calls, classifier decision — before you theorize about what went wrong.
2. Truthfulness over validation. Prioritize diagnostic accuracy over
   confirming the manager's implied correction. NO_FIX over invented fix.
3. NO_FIX is the default. Every non-NO_FIX classification must clear a
   sufficiency check: evidence must entail a concrete, testable edit.
4. Refuse directly without lecturing.
5. Human-in-the-loop for writes, forever. Never apply without explicit
   manager sanction in the last turn.
6. No oscillation. Reversals of a decision applied in the last 14 days
   require a 1.25× confidence boost (enforced by a hook).
7. Memory is a hint, not ground truth. Verify stored preferences against
   current evidence before applying.
8. Memory is durable. Persist rules under preferences/, decisions under
   decisions/. Review keys at session start; load full values on demand.
9. Cooldown is real. 48h cooldown on same artifact target is enforced
   by a hook, not by you.
10. Scope discipline. 8 categories are rigid; sub-labels are free-form.
11. Edit format depends on artifact size. >2,000 tokens → search_replace
    with 3+ lines of context for uniqueness. <2,000 tokens → full_replacement.
    NEVER use placeholders like "// ... existing code ..." — this destroys
    the artifact at apply time.
</principles>

<persona>
You review AI-generated guest replies alongside the property manager and
propose durable configuration changes — system prompt edits, SOP updates,
FAQ additions, tool adjustments — so the main AI improves over time. Direct,
candid, willing to push back. Never open with flattery. When you disagree,
say so with evidence.
</persona>

<taxonomy>
8 categories + NO_FIX abstain: SOP_CONTENT, SOP_ROUTING, FAQ, SYSTEM_PROMPT,
TOOL_CONFIG, PROPERTY_OVERRIDE, MISSING_CAPABILITY, NO_FIX.
Sub-labels are short (1-4 words), free-form.
</taxonomy>

<tools>
10 tools:
1. get_context — current conversation context
2. search_corrections — prior TuningSuggestion search
3. fetch_evidence_bundle — main AI's full trace for a trigger event
4. propose_suggestion — stage a TuningSuggestion with diff preview
5. suggestion_action — apply/queue/reject/edit-then-apply
6. memory — durable tenant memory (preferences/, decisions/ keys)
7. get_version_history — recent artifact edits
8. rollback — revert to prior version
9. search_replace — literal string replace for large artifacts
10. names — tool-name constants module
</tools>

<platform_context>
SOP status lifecycle (DEFAULT, INQUIRY, PENDING, CONFIRMED, CHECKED_IN,
CHECKED_OUT). Tool availability by status. Security: never expose access
codes to INQUIRY guests. Channels: Airbnb plaintext, Booking.com API,
WhatsApp media, Direct no constraints. Hold firm on NO_FIX when pushed back.
</platform_context>

<critical_rules>
1. proposedText/newText must never be a fragment.
2. Never apply or rollback without explicit manager sanction.
3. NO_FIX is correct more often than you think.
</critical_rules>

__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__

<memory_snapshot>
[Memory key index — summaries only. Full values via memory(op:'view') on demand.]
</memory_snapshot>
<pending_suggestions>
[Counts by category, top 3 by confidence.]
</pending_suggestions>
<session_state>
[conversationId, anchorMessageId?, selectedSuggestionId?]
</session_state>
```

**What the hook layer enforces outside the LLM:** PreToolUse (regex sanction gate, 48h cooldown, 14-day oscillation with 1.25× confidence boost), PostToolUse (Langfuse logging, acceptance EMA, preference pair capture), PreCompact (memory reinjection), Stop (follow-up nudge).

**What BUILD mode needs that TUNE mode doesn't:**
- An entry point that doesn't require a triggering failed message
- Tools for creating artifacts from conversation, not editing existing ones (create_sop, create_faq, write_system_prompt, create_tool_definition)
- A preview/sandbox capability — test the AI's behavior before deploying
- An interview posture — the agent asks about the business; the manager doesn't yet know the artifact vocabulary
- Graduation detection — knowing when "setup" is done enough to go live
- Progressive disclosure — explaining what an SOP is the first time, never again

**What should stay the same across both modes:**
- Claude Sonnet 4.6 with Claude Agent SDK
- Same chat surface (existing `/tuning/chat` frontend)
- Same persona: direct, anti-sycophantic, willing to push back
- Same memory system (durable `preferences/*` and `decisions/*` keys)
- Same XML-tagged, cache-friendly prompt architecture
- Same hook-enforced safety (no silent writes, human sanction always required)

Now critique and advise. The rest of this document is the research brief.

---

**PART A — UNIFIED BUILD + TUNE AGENT ARCHITECTURE**

1. **Mode explicit vs mode implicit.** Cursor and Claude Code don't have a "build mode" button — the agent figures out from context whether you're scaffolding a new project or fixing an existing bug. Bolt and v0 operate under an implicit "build" posture that shifts to "iterate" without ceremony. Replit Agent does both. What's the research consensus: should my agent have an explicit mode switch (buttons in the UI, `<mode>` tag in the prompt, separate system prompts) or detect intent from the conversation itself? What's the failure mode of each approach? How do shipped products handle the transition?

2. **Intent detection when modes are implicit.** If I go mode-less, the agent has to recognize "I'm setting up my business" vs "the AI just said something wrong" vs "I want to tweak the tone generally." What are robust techniques for intent detection inside a dialog agent? Classifier turn as preamble? LLM-based dispatch tool as first move? Signal from surrounding UI state (did the user arrive from inbox vs settings)? What do production agents use?

3. **Prompt architecture for dual-mode agents.** Should build and tune be one system prompt with conditional sections, two fully separate prompts with a lightweight router, or one prompt that simply describes both jobs and lets the model decide? What do papers on multi-task instruction-tuned systems say about capacity interference vs reuse? My cache is 2,400 static tokens with a 0.999 hit rate — how do I preserve that while supporting two modes? Is there a research-backed reason to prefer one architecture over the others?

4. **Tool surface: shared vs split.** TUNE mode has propose_suggestion, suggestion_action, fetch_evidence_bundle, rollback, search_corrections. BUILD mode would need create_sop, create_faq, write_system_prompt, create_tool_definition, preview_ai_response. Options: (a) keep them as separate tools and load both sets always; (b) unify under fewer verbs like upsert_artifact with a create/edit branch; (c) load tools conditionally based on detected mode. What are the ergonomic and accuracy tradeoffs? Claude Agent SDK specifically — is there a recommended pattern for conditional tool loading, and does it harm cache?

5. **The progressive-disclosure problem.** A manager opening the product for the first time doesn't know what an SOP is, what a system prompt is, or what a taxonomy category means. But the agent shouldn't dumb down every turn forever — once the manager understands, the explanations become noise. How do shipped onboarding agents handle this? Named tutorial steps? First-time overlays? Dynamic persona that notices skill progression? Memory-backed "this user already knows X"? What research exists on adaptive disclosure in conversational interfaces?

6. **Graduation detection — when is setup "done"?** BUILD mode can drag on indefinitely if the user keeps answering "yes, one more thing." But shipping with a half-built config is worse than shipping with a minimal working one. What criteria should the agent use to say "you have enough to go live, want to try it?" — a minimum-viable-config checklist? A completeness score? A coverage metric against the taxonomy? Have any shipped vibe-coding products solved graduation well?

**PART B — COLD-START INTERVIEW DESIGN**

7. **Structured vs freeform onboarding.** Options: (a) a scripted step-by-step flow ("step 1: name your properties; step 2: describe your check-in process…") that feels like a form, (b) fully freeform chat where the agent extracts everything from the conversation, (c) hybrid — a loose checklist the agent covers but in any order the manager leads. The hospitality domain has ~10 natural topic areas (check-in, check-out, cleaning, amenities, house rules, pricing/discounts, payments, escalation, accessibility, local recommendations). What does research on conversational onboarding say about completion rates, perceived effort, and output quality across these three patterns? What do products like Sierra AI, Decagon, and Ada do?

8. **Seed prompt generation from interview.** At the end of BUILD mode, the agent must produce a full coordinator system prompt (currently ~2–3K tokens of domain rules, tone, escalation policy, tool doc, channel adaptation) and a full screening prompt. Should the agent generate these from scratch via a final big generation call, build them up incrementally as the conversation progresses (each turn appends), or fill a template with slots extracted during the interview? Which gives better output? Which survives editing later? Is there a pattern from prompt-engineering-as-a-product (e.g., PromptLayer, Mirascope, Humanloop) that applies?

9. **Asking the right questions.** An interviewer that asks "describe your business" gets bad answers. An interviewer that asks "what do you tell guests who ask about late check-in on the day of arrival?" gets training-quality answers. What research exists on elicitation technique — critical-incident interviews, scenario-based prompting, cognitive task analysis, "tell me about the last time X happened"? How do I bake those into an agent without making it feel like a survey?

10. **Handling the manager who can't articulate their policy.** Many SMB operators have policies that live in their head and are inconsistently applied. The agent must surface ambiguity ("what time is late check-in? what if they arrive at 3am vs 11pm?") without being pedantic. What are the research-backed techniques for eliciting tacit knowledge through dialog? When should the agent propose a default ("most properties say 2pm check-in, 11am check-out — want to start there?") vs insist on an answer?

11. **Multi-artifact orchestration.** One user utterance often spans multiple artifacts. "We let families with kids check in early but not groups" touches: SOP (check-in), property override (if some properties), system prompt (conditional reasoning on guest type), maybe FAQ (so the rule is searchable). How should the agent orchestrate a multi-artifact create? One tool call per artifact? A bundle tool? A plan-first pattern where the agent announces "I'm going to create X, Y, Z — ok?" and waits for sanction? What do shipped multi-file-edit agents (Cursor composer, Claude Code, Bolt) do and what's their failure mode?

**PART C — VIBE-CODING PATTERNS WORTH STEALING**

12. **What transfers from code-editing agents to AI-configuring agents.** Cursor, Claude Code, v0, Bolt, Lovable, Replit Agent are all mature vibe-coding products for code. My product is "vibe code your AI chatbot" — conceptually similar (user in natural language → structured artifacts produced by an agent → preview/test → iterate). Which UX patterns transfer directly? Diff previews before write? Undo history? Agent autonomously running the tests it wrote? File tree as mental model? Which DON'T transfer and why (my artifacts are not code, my users are non-technical)?

13. **Preview/sandbox integration.** In code-editing agents, the user can instantly run the code. My equivalent is "try a message against the AI you just built." Should the BUILD agent have a preview_ai_response tool that runs the main AI pipeline against a synthetic guest message the manager types? Should it generate its own test messages and run them ("I'll send 'what time is check-in?' to your AI and show you the reply")? What's the research on synthetic eval generation by the agent itself, and where does it fail (manager trusts the agent's self-evaluation too much)?

14. **Vertical agent products as reference points.** Sierra AI, Decagon, Ada, Voiceflow, Botpress — all are "build a customer AI" platforms, all have some onboarding flow. What's publicly documented about their architectures? Who has a conversational builder vs a visual builder? Where are they succeeding/failing in onboarding conversion? What's the ceiling on "non-technical user builds a production AI via chat" right now?

15. **Managing user expectations for an LLM-built system.** Vibe-coded code compiles or fails loudly. Vibe-built AI chatbots have a subtler failure mode: they look correct and are subtly wrong. Users over-trust the output. How do mature products (or research) manage calibrated trust — forcing red-team passes before production, showing the failure modes the agent hasn't covered, running adversarial test messages by default? What's the best practice here?

**PART D — SYSTEM PROMPT ENGINEERING FOR THE MERGED AGENT**

16. **Principles reuse across modes.** My current principles list (11 items) is tuning-mode specific — it talks about evidence bundles and diagnostic categories. In BUILD mode there's no prior evidence bundle, no diagnostic category. Should I: (a) keep two principles sections and gate them; (b) abstract to mode-agnostic principles ("evidence before output," "no sycophancy," "human-in-the-loop") and add mode-specific addenda; (c) something else? What's the research on principle abstraction vs principle specificity in instruction-following models?

17. **Persona consistency across modes.** The current persona says "you review AI-generated guest replies alongside the property manager." In BUILD mode there are no replies yet. Do I rewrite the persona to be mode-agnostic ("you are the manager's trainer and co-builder"), or keep mode-specific persona blocks? Does persona drift across modes damage the perception of "one coherent agent"?

18. **U-shaped attention and the terminal recap.** I currently have a <critical_rules> block at the tail of the static prefix based on findings about primacy/recency in long prompts. For a dual-mode prompt, what are the 3 rules that should ALWAYS be terminal, regardless of mode? How does this interact with cache — can the terminal recap vary by mode without breaking the cache boundary?

19. **Anti-sycophancy when the agent is also a salesperson.** TUNE mode's anti-sycophancy is about holding NO_FIX — not inventing a fix to please. BUILD mode has a different tension: the manager is excited, the agent wants to keep them engaged and shipping, but sycophantic "great idea, adding it!" responses produce bloated, incoherent configs. What's the research on anti-sycophancy in an agent whose job includes producing output the user wanted? How do I differentiate "yes and" (generative collaboration) from "great question!" (empty validation)?

20. **Cache discipline for the merged prompt.** My current cache boundary sits after platform_context + critical_rules. If BUILD mode needs extra static content (onboarding checklist, seed templates, starter SOP bodies), it inflates the cache prefix, which in TUNE mode becomes wasted tokens. Options: (a) put build-only content in the dynamic suffix (loses cache benefit for build); (b) keep everything static and eat the tokens (wasteful for tune); (c) separate static prefixes per mode with manual cache_control annotations. What does Anthropic recommend? Is there a proven pattern?

21. **Tool descriptions that survive mode switches.** Claude's tool descriptions are read every turn and influence which tool the model calls. If BUILD mode's `create_sop` and TUNE mode's `propose_suggestion` both operate on SOPs, their descriptions must make the model pick correctly depending on intent. What's the research on tool-description engineering — naming, verb choice, negative examples ("do NOT use this tool when X"), description length vs precision?

**PART E — HANDOFF, CONTINUITY, AND VERIFICATION**

22. **Build → tune handoff.** The manager finishes BUILD mode, the AI goes live, the first guest message arrives, the AI replies, the manager edits it. That edit should land in TUNE mode, but the agent should remember the setup decisions made in BUILD (those decisions live as `decisions/*` memory keys and in the original system prompt text). How should the agent surface that continuity — "you set check-in at 2pm during setup; this edit conflicts with that, want me to revisit?" — without being annoying? What's the research on long-horizon memory for agents whose context window doesn't span weeks?

23. **Session resumption mid-onboarding.** A manager starts BUILD, answers 4 of 10 interview areas, closes the tab, comes back two days later. The agent should resume exactly where they left off, not re-ask what's already been answered. How should session state be persisted, injected, and used? Hostname for this in the literature? What's the failure mode if the agent aggressively re-reads versus aggressively skips?

24. **Verification when there's nothing to verify against.** TUNE mode has an evidence bundle — the agent can check if the proposed fix would have produced a better reply on that specific trigger. BUILD mode has no history. How should BUILD verify its output — synthetic conversations the agent generates itself, held-out adversarial prompts baked into the platform, calling the actual main-AI pipeline on ten canonical test messages? What's the state of the art in agent-self-evaluation without ground truth?

25. **Preference-pair capture in BUILD mode.** TUNE mode captures preference pairs (manager edits agent's suggestion → before/after is a preference pair usable for future fine-tuning). In BUILD mode, every manager acceptance or edit of a created artifact is also a preference signal. Should I capture these the same way? What's the downstream plan — are RLHF/DPO-style training sets from these pairs actually useful at this scale, or is the data too noisy to matter?

26. **Measuring whether BUILD mode actually works.** What are the right success metrics? Time-to-first-guest-reply (setup duration)? Setup-completion rate (percentage of managers who finish enough to go live)? Seven-day retention of configs (how much did they edit in TUNE after BUILD)? Quality of the first 100 AI replies vs a manually-configured baseline? What do analogous products (onboarding funnels for AI builders) measure, and what's the leading indicator vs lagging indicator here?

---

**CLOSING ASK**

For every section: give me specific techniques with reasoning, not general advice. Cite papers, documentation, or shipped-product patterns where you can. Where you think my current setup is already correct, say so — "keep this, it matches the literature because X" — don't pad with unnecessary changes. Where you think it's wrong, say that plainly and tell me what to do instead.

I care most about sections A (architecture), B (interview design), and D (prompt engineering) — that's where the load-bearing decisions are. Sections C and E matter but can be lighter if you need to budget.

At the end, give me a prioritized roadmap: if I could only ship 3 things for v1 of BUILD mode, what should they be, and why in that order?
