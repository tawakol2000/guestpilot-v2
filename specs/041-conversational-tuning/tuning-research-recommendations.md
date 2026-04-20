# Tuning Agent — Research-Backed Recommendations

> Synthesized from two research papers: (1) Claude Code source leak architectural analysis, (2) Claude AI deep research on tuning agent design + system prompt engineering. Cross-referenced against the actual GuestPilot tuning codebase (103 commits, 148 files, +24,715 lines).
>
> Created: 2026-04-17

---

## Status Legend

- **SPRINT 10** — implement now, highest ROI
- **SPRINT 11+** — implement after production data validates the need
- **DEFERRED** — collect data now, implement when scale justifies it
- **BACKLOG** — good idea, no urgency, revisit quarterly
- **CROSS-APPLY** — applicable to the main guest-facing AI (coordinator + screening agents), not just tuning

---

## MODIFY — Change What Exists

### M1. proposedText format → search/replace for large artifacts
**Status: SPRINT 10** | **Priority: #1** | **Risk: highest**

Current full-text replacement is the single biggest risk — silent artifact truncation when the LLM emits a fragment instead of the complete text.

**Change:** For artifacts over ~2K tokens, switch to Claude-native `old_string`/`new_string` exact-match pattern (the `str_replace_based_edit_tool` format). Keep full replacement as fallback for small artifacts (FAQs, short SOPs under ~2K tokens).

**Evidence:**
- Aider benchmarks: 3× less laziness/truncation on diff formats vs full replacement
- Claude 3.5 Sonnet hit 92.1% on polyglot with diff format (Gauthier 2024)
- Diff-XYZ (arXiv 2510.12487, 2025): search/replace is best for generation on large models
- Claude Code leak: Anthropic uses exact-match `old_string`/`new_string` with read-before-edit invariant in production

**Known failure modes to guard against:**
- Tab→space coercion (GH #26996)
- Straight-vs-curly-quote collisions (#1986)
- Literal-tab input (#18050)
- Mitigation: Read-immediately-before-Edit + 3+ lines surrounding context for uniqueness

**Implementation notes:**
- Add an `editFormat` field to `propose_suggestion` tool: `"search_replace"` (default for >2K) or `"full_replacement"` (default for <2K)
- The `apply` path must handle both formats
- Add a deterministic post-generation validator (see A1 below)

---

### M2. System prompt section order → principles-first
**Status: SPRINT 10** | **Priority: #2** | **Risk: low, high reward**

Current order: persona → principles → taxonomy → tools → platform_context → [boundary] → dynamic.

**Change to:** principles → persona (≤150 tokens) → taxonomy → tools → platform_context → [cache boundary] → dynamic sections. Add a terminal recap line restating top 3 hard constraints.

**Evidence:**
- Liu et al. "Lost in the Middle" (TACL 2024): U-shaped attention — accuracy highest at start and end, worst in middle
- Chroma "Context Rot" (2025): effect persists in GPT-4.1, Claude Opus 4, Gemini 2.5
- IFEval (Zhou et al., arXiv 2311.07911): terminal recap measurably improves strict-accuracy
- FollowBench: constraint drift over turns is the primary failure mode — terminal recap mitigates

**Terminal recap content (append after platform_context, before boundary):**
```
<critical_rules>
1. proposedText must be a COMPLETE replacement — never a fragment. If unsure, fetch the current text first.
2. Never apply without explicit manager sanction in their last message.
3. NO_FIX is the correct default. Justify any non-NO_FIX with specific evidence.
</critical_rules>
```

**CROSS-APPLY:** The principles-first ordering and terminal recap pattern should be applied to the coordinator and screening system prompts too. Those prompts have the same Lost in the Middle vulnerability.

---

### M3. Oscillation mechanic → invert the 1.25× boost
**Status: SPRINT 10** | **Priority: #3** | **Risk: correctness bug**

The current 1.25× boost makes re-proposal *easier* after a previous rejection within the 14-day window. This amplifies oscillation instead of damping it.

**Change:** Invert so re-proposal requires 1.25× *higher* confidence than the original threshold. One-line change in `hooks/shared.ts`.

**Evidence:**
- Classic hysteresis requires re-entry threshold to be stricter than initial threshold to damp oscillation
- No published production system uses a confidence-boost-on-re-propose mechanic (research paper surveyed PromptLayer, LangSmith, Humanloop, Braintrust, Langfuse)
- Braintrust's Loop auto-optimizer (closest analog) iterates on evals, not confidence multipliers

**Implementation:** In `hooks/shared.ts`, change the oscillation check from `confidence >= original * 0.8` (or equivalent easing) to `confidence >= original * 1.25`. Treat 48h/14d/1.25× as hyperparameters — log them as config, tune on held-out traces after production launch.

---

### M4. Anti-sycophancy default → invert to "justify any non-NO_FIX"
**Status: SPRINT 10** | **Priority: #4** | **Risk: accuracy**

The diagnostic engine is biased toward inventing fixes because (a) RLHF models lean toward confirming user-implied goals (Sharma et al., arXiv 2310.13548), and (b) reasoning fine-tuning *degraded* abstention by ~24% (AbstentionBench, arXiv 2506.09038, 2025).

**Change:** In the diagnostic system prompt:
1. Reframe: model must pass an explicit sufficiency check ("evidence entails a concrete, testable edit to a specific artifact") before any non-NO_FIX label
2. Neutralize author framing: don't lead with "manager thinks X is wrong" — present it as one datum, flagged as a claim
3. Add: "When in doubt between a fix and NO_FIX, choose NO_FIX and explain what evidence would change the classification"

**Evidence:**
- AbstentionBench (arXiv 2506.09038): reasoning fine-tuning degraded abstention ~24%
- R-Tuning (Zhang et al. 2023, arXiv 2311.09677): refusal-aware framing at prompt layer
- Kadavath et al. (arXiv 2207.05221): calibrated P(True) only emerges when abstention is structured

---

### M5. Anti-sycophancy language → priority hierarchy
**Status: SPRINT 10** | **Priority: #5**

**Change:** Replace the current "never sycophantic" and "do not invent suggestions" directives with a priority hierarchy framing (proven more effective than adjective-based directives):

```
Prioritize diagnostic accuracy and truthfulness over validating the manager's
implied correction. Focus on evidence and artifact state, providing direct
assessment without unnecessary agreement. It is better for the manager if
you honestly apply rigorous standards and return NO_FIX when warranted, even
if the manager clearly expects a fix. Objective diagnosis is more valuable
than false agreement.
```

**Evidence:**
- Claude Code leak: Anthropic's production anti-sycophancy directive uses exactly this priority-hierarchy framing
- Effective across all Claude/GPT products in the leak

**CROSS-APPLY:** This exact phrasing pattern should be adapted for the coordinator and screening agents. Their version: "Prioritize guest safety and accuracy over guest satisfaction. It is better for the guest if you escalate honestly than if you provide a reassuring but incorrect answer."

---

### M6. Memory snapshot → lazy loading via index
**Status: SPRINT 10** | **Priority: #6**

Currently injecting up to 20 full key-value pairs into every turn's dynamic section.

**Change:** Inject only the index (key names + one-line summaries, ~150 chars each) into the dynamic section. The agent loads specific preferences on demand via the `memory` tool when a key is relevant to the current context.

**Evidence:**
- Claude Code leak: three-layer memory (index → topic files → transcripts), "never dump content into the index"
- Reduces dynamic section from ~500 tokens to ~200 tokens
- Keeps cache efficiency high as preferences grow over months

**Implementation notes:**
- Change `<memory_snapshot>` to inject only `key: one-line-summary` pairs
- The `memory(op: "view")` tool already exists for on-demand retrieval
- Add to principles: "Read memory keys at session start. Load full values only when relevant to the current discussion."

---

### M7. Persona framing → task-scoped
**Status: SPRINT 10** | **Priority: #7**

**Change:** Rewrite from identity-scoped ("you are the manager's trainer") to task-scoped:

```
<persona>
You review AI-generated guest replies alongside the property manager and
propose durable configuration changes — system prompt edits, SOP updates,
FAQ additions, tool adjustments — so the main AI improves over time. You
are direct, willing to push back, and never patronizing. When you disagree
with the manager's correction, say so and explain why.
</persona>
```

Collapse to ≤150 tokens. Remove "You are NOT the guest-facing AI" (unnecessary once the task framing is clear).

**Evidence:**
- Zheng/Pei/Jurgens (EMNLP 2024): role personas yield no reliable accuracy lift
- Claude Code leak: Anthropic uses task-scoped personas across all products
- Kong et al. (NAACL 2024): gains from persona are only on reasoning benchmarks as CoT trigger, not dialogue

---

### M8. Diagnostic prompt → pad past 1,024 tokens
**Status: SPRINT 10** | **Priority: #8**

The ~700-token static block is too short for OpenAI's automatic caching minimum (1,024 tokens).

**Change:** Pad the stable instruction + schema block past 1,024 tokens. The anchored-contrast exemplars (A3 below) will naturally do this. Alternatively, expand the taxonomy definitions with the per-category elimination criteria and negative definitions.

**Evidence:**
- OpenAI automatic caching: 50-90% discount on cached input tokens, ~3-5 min TTL, 1,024-token minimum

---

### M9. Cache breakpoints → use 3 of 4 allowed
**Status: SPRINT 11+** | **Priority: #9**

Currently using 1 breakpoint.

**Change:** Split to:
- BP1 after tools block (1h TTL, rarely changes)
- BP2 after principles+persona+taxonomy (1h TTL, version-bump only)
- BP3 after platform_context (5m TTL, per-session)
- BP4 reserved for sliding cache on last user turn

**Evidence:**
- Anthropic docs: up to 4 `cache_control` breakpoints per request
- ProjectDiscovery Neo agent: 7%→74% hit rate = 59% cost cut from proper breakpoint placement
- Longer TTLs must precede shorter TTLs (hard Anthropic ordering rule)

**Implementation notes:**
- Keep dynamic suffix deterministically ordered with stable JSON key serialization
- Sweet spot for dynamic suffix: ~300-800 tokens (at ~500 dynamic / ~2,400 static, cached = ~83% of input)
- Never put dynamic IDs or timestamps in the static block

---

---

## ADD — New Things That Don't Exist Yet

### A1. Deterministic post-generation validator
**Status: SPRINT 10** | **Priority: tied with M1**

A non-LLM check that runs after every `propose_suggestion` tool call.

**Checks:**
- No elision markers: `...`, `// rest unchanged`, `[unchanged]`, `TODO: fill`, `# existing code`, `<!-- remaining -->`
- If category targets a specific artifact type → proposedText must be present
- If NO_FIX or MISSING_CAPABILITY → proposedText must be null
- If search/replace format → `old_string` must be non-empty, `new_string` must differ from `old_string`
- Basic structural integrity: if the artifact is XML-tagged, check that opening/closing tags are balanced

**Evidence:**
- Aider methodology: deterministic validators catch ~80% of laziness slips
- Zero latency cost, zero token cost

---

### A2. Self-consistency k=3 on the diagnostic
**Status: SPRINT 10** | **Priority: #10**

Run the diagnostic 3 times with temperature > 0, majority-vote on the label.

**Key rule:** If all 3 disagree on category, default to NO_FIX rather than majority-voting a fix.

**Evidence:**
- Wang et al. 2022: self-consistency transfers to classification even with hidden CoT
- AbstentionBench: self-consistency disagreement is the strongest signal for ambiguous cases

**Cost:** 3× on diagnostic calls. But the diagnostic is a single fire-and-forget call per trigger event (not per turn), so the absolute cost is low. The accuracy lift on ambiguous cases is well-documented.

**Implementation notes:**
- Use `temperature: 0.7` or similar for diversity
- Reducer: majority vote on category; on tie or full disagreement → NO_FIX with `rationale: "diagnostic disagreement — insufficient evidence for confident classification"`
- Log all 3 results to `AiApiLog` for offline analysis

---

### A3. `decision_trace` field in diagnostic JSON schema
**Status: SPRINT 10** | **Priority: #11**

A structured array of per-category elimination verdicts populated *before* the final label.

**Schema addition:**
```json
{
  "decision_trace": [
    {
      "category": "SOP_CONTENT",
      "evidence_citation": "SOP 'check-in' variant CONFIRMED contains parking info",
      "verdict": "eliminated",
      "reason": "correct content was present in the retrieved SOP"
    },
    {
      "category": "SOP_ROUTING",
      "evidence_citation": "classifier selected 'check-in' SOP, correct for parking query",
      "verdict": "eliminated",
      "reason": "routing was correct"
    }
  ]
}
```

**Evidence:**
- Tree Prompting (Morris et al., EMNLP 2023): guided elimination outperforms freeform on structured classification
- Makes reasoning visible to downstream eval without relying on hidden tokens
- Feeds self-consistency reducers (A2)

---

### A4. Anchored-contrast exemplars in taxonomy
**Status: SPRINT 10** | **Priority: #12**

One positive + one nearest-confusable negative per category (16 total), embedded inline in each category's definition.

**Example for SOP_CONTENT:**
```
SOP_CONTENT — the relevant SOP said the wrong thing or didn't cover this case.
  ✓ POSITIVE: Manager corrected "checkout is 11am" to "checkout is 12pm" — the
    check-out SOP had the wrong time. Fix: edit SopVariant.content.
  ✗ NEAR-MISS (SOP_ROUTING): Manager corrected parking info — but the parking SOP
    existed with correct content; the classifier routed to check-in SOP instead.
    That's SOP_ROUTING, not SOP_CONTENT.
```

**Evidence:**
- Zhao et al. "Calibrate Before Use": anchored contrasts attack diagonal-adjacent confusions in ≥5-class problems
- Over-prompting paper (arXiv 2509.13196): cap at ~16 exemplars; more can hurt in >5-class
- Min et al. (EMNLP 2022): much of few-shot benefit is format/label-space demonstration

**Implementation notes:**
- Store exemplars behind the cache boundary to keep static prefix stable
- Version exemplars alongside the prompt — regression-test on held-out traces
- Rotate canonical near-misses as you collect production data

---

### A5. Memory-as-hint principle in system prompt
**Status: SPRINT 10** | **Priority: #13**

Add to principles block:
```
Memory is a hint, not ground truth. When a stored preference is relevant,
verify it against the current evidence bundle before applying it. Preferences
may be outdated or overridden by new context. If a preference contradicts
the evidence, flag the conflict to the manager.
```

**Evidence:**
- Claude Code leak: "the agent treats memory as a hint rather than ground truth, verifying against actual code before acting"

---

### A6. Compaction strategy for long tuning sessions
**Status: SPRINT 11+** | **Priority: #14**

Currently zero compaction. Long sessions (30+ turns discussing multiple edits) will hit context limits.

**Design:**
- MicroCompact: drop `fetch_evidence_bundle` tool results older than the last 3 (these are 20-30K tokens each)
- Preserve all human messages verbatim
- PreCompact hook (already exists): reinject memory index + recent decisions
- Guard: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (the constant that saved Anthropic 250K API calls/day)

**Evidence:**
- Claude Code leak: 5 compaction strategies, self-drain protection, append-only transcript
- Claude Agent SDK: PreCompact hook is the designated injection point

---

### A7. Cache-miss telemetry
**Status: SPRINT 11+** | **Priority: #15**

Track `cache_read_input_tokens / input_tokens` per request. Alert when it drops below 0.95.

**Why:** Earliest warning for accidental prefix invalidation. The following silently bust cache:
- tool_choice changes between turns
- JSON key reordering in dynamic sections
- Image presence toggling
- Extended-thinking budget changes
- Timestamp injection into static block

---

### A8. Protective comments in artifacts
**Status: BACKLOG** | **Priority: low**

Instruct the tuning agent to preserve and add protective comments in artifacts (e.g., `<!-- DO NOT remove — parking policy override for Marina Tower -->`). Makes artifacts more resilient to future edits by both the tuning agent and the main AI.

**Evidence:**
- Claude Code leak: "agents always read comments in the line of sight of the task" — inline comments are persistent agent memory with zero infrastructure

**CROSS-APPLY:** The coordinator and screening agents would also benefit from protective comments in SOPs and system prompts.

---

---

## SKIP / DEFER — Recommended Against (For Now)

### D1. Thompson sampling for oscillation
**Status: DEFERRED until 1,000+ proposals**

The research paper recommends replacing the fixed 1.25× with discounted Thompson sampling over artifact-variant arms (Beta(α, β) per variant, exponential forgetting). Academically elegant but requires meaningful traffic volume to make the statistics work. The simple inversion (M3) solves the actual bug now. Revisit when you have 1,000+ proposals with acceptance/rejection data per artifact.

---

### D2. Two-pass diagnostic bundle split
**Status: DEFERRED until production accuracy data**

Split the 20-30K monolithic evidence bundle into Pass 1 (cheap classify, ~2-4K) → Pass 2 (diagnose with fetched slices, ~5-10K). The degradation literature is strong (Liu 2024, RULER, Chroma Context Rot), but this is a significant architecture change that adds latency. Ship the other fixes first (M2 prompt reorder, A2 self-consistency, A4 exemplars), measure diagnostic accuracy on real traffic, and only split if the monolithic bundle causes actual misclassifications.

**Quick win alternative:** Reorder the evidence bundle with most-relevant evidence first and last (primacy + recency slots), distractors in the middle. That's the 80/20 of the two-pass idea without the architecture change.

---

### D3. Structured approve/reject UI (LangGraph interrupt-style)
**Status: DEFERRED to sprint 12+**

Replace NL parsing for "apply it" / "roll it back" with deterministic button clicks in the frontend. Right end-state, wrong sprint. The current regex gate works. The quick improvement: maintain a versioned phrase list as config with morphological tolerance (case, punctuation, contractions, variants like "apply that," "go ahead and apply," "please roll that back").

---

### D4. DPO on accepted/rejected proposals
**Status: DEFERRED until 500+ pairs**

Every accepted edit vs rejected suggestion is a (chosen, rejected) pair — exactly DPO's data shape. But Apple ML 2024 showed DPO's implicit reward generalizes poorly under distribution shift. Collect the pairs in Langfuse now (already happening via PostToolUse), defer the actual DPO fine-tuning until you have 500+ pairs with stable category distributions.

---

### D5. Proactive pattern clustering
**Status: DEFERRED until post-launch**

Online micro-clustering on embeddings + nightly HDBSCAN re-fit. LLM labels/merges clusters, proposes generalized fixes. Horvitz-style utility gating. Per-user interruption budget. The right long-term vision, but requires production traffic volume. The prerequisite is solid diagnostic accuracy and enough accepted edits to cluster meaningfully.

---

### D6. MCP tool surface migration
**Status: BACKLOG**

Migrate tool integrations to MCP for cross-provider portability. Correct in principle, but current tools are internal (Prisma queries, Hostaway API). No cross-provider benefit yet. Revisit when adding external integrations.

---

### D7. Cursor Fast Apply / architect-editor split
**Status: SKIP**

Two-model complexity (architect proposes, editor applies) isn't warranted. Sonnet 4.6 with search/replace format is already 90%+ on Aider's polyglot benchmark. Only revisit if Sonnet's edit accuracy plateaus on your specific artifact types.

---

### D8. Memory upgrade to bi-temporal semantic + episodic + procedural
**Status: SPRINT 11+**

Three Postgres tables with different TTLs. Zep/Graphiti-style `t_valid`/`t_invalid` edges for preference drift. Recency × importance × relevance retrieval scoring (Park et al. Generative Agents). Periodic reflection pass for procedural memory. Important for long-term manager preference management, but the current flat key-value system works for launch. Upgrade when preference count exceeds ~50 per tenant.

---

### D9. Two-tier HITL gate (regex + scoped LLM classifier)
**Status: SPRINT 11+**

Add a cheap LLM intent classifier as a second necessary condition inside PreToolUse, with input strictly limited to the manager's last turn (no tool output, no history). Belt-and-suspenders with the regex. Fail closed on classifier timeout or low confidence. The regex alone works for launch; this is hardening.

---

### D10. Verification subagent for proposedText integrity
**Status: SPRINT 11+**

Spawn a lightweight verification call after every `propose_suggestion` — "does this proposedText contain all the structural elements (XML tags, section headers, variable placeholders) from the original?" Catches the most dangerous failure mode (fragment replacing full artifact). The deterministic validator (A1) covers ~80%; this catches the remaining ~20% but at LLM cost.

**Evidence:**
- Claude Code leak: "for any non-trivial change, spawn an adversarial verifier with different tool access before declaring success"

---

---

## CROSS-APPLY — Gold for the Main AI Agents

These findings from the tuning research are directly applicable to the coordinator and screening system prompts. Defer implementation but track as a separate workstream.

### X1. Principles-first prompt ordering for coordinator + screening
Same Lost in the Middle evidence applies. Move hard behavioral rules (never expose access codes to INQUIRY guests, escalate on threats, channel-specific formatting) to the primacy slot. Add terminal recap of top 3 safety constraints.

### X2. Anti-sycophancy priority hierarchy for guest-facing agents
Adapt the framing: "Prioritize guest safety and policy accuracy over guest satisfaction. It is better to escalate honestly than to provide a reassuring but incorrect answer."

### X3. Cache breakpoint optimization for coordinator + screening
The coordinator prompt is likely longer than the tuning agent's. Audit cache hit rates and apply the same 3-of-4 breakpoint strategy.

### X4. Protective comments in SOPs
Add structural comments to SOPs that help the main AI understand the intent behind each section. These survive compaction and serve as persistent context.

### X5. Evidence-bundle primacy/recency ordering
When the main AI retrieves SOPs and FAQs, order them with the most-relevant first and last. This is the same Lost in the Middle mitigation applied to retrieval results rather than system prompts.

### X6. Deterministic output validation
The same elision-marker and structural-integrity checks that protect proposedText should protect the main AI's guest-facing JSON output. Cheap insurance against hallucinated responses.

---

## Source Papers

1. **Claude Code Source Leak Analysis** (March 31, 2026) — architectural patterns from Anthropic's production agent harness (512K lines TypeScript). Key findings: prompt caching discipline, three-layer memory, five compaction strategies, `str_replace_based_edit_tool`, verification subagents.

2. **Claude AI Deep Research: Tuning Agent Design + System Prompt Engineering** (April 2026) — 14-topic research covering diagnostic classification, anti-sycophancy, memory architecture, oscillation control, proactive intelligence, HITL enforcement, prompt structure, caching, anti-hallucination, structured output, prompt length, few-shot, and production agent patterns. 40+ cited papers.
