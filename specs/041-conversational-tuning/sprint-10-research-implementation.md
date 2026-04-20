# Sprint 10 — Research-Backed Tuning Intelligence Upgrades

> Implements the top-priority findings from two research papers:
> (1) Claude Code source leak architectural analysis
> (2) Deep research on tuning agent design + system prompt engineering
>
> Reference: `specs/041-conversational-tuning/tuning-research-recommendations.md`

---

## Goal

Make the tuning agent smarter, more accurate, and less prone to the three identified failure modes: (1) silent artifact truncation from fragment proposedText, (2) sycophantic over-classification (inventing fixes when NO_FIX is correct), (3) constraint drift over long conversations. Zero new features — this is pure intelligence and correctness hardening.

---

## Workstream A — proposedText Format (M1 + A1)

### A.1 Search/replace edit format for large artifacts

Add an `editFormat` field to the `propose_suggestion` tool schema:
- `"search_replace"` — default for artifacts >2K tokens. The agent provides `oldText` (exact match from the current artifact) and `newText` (the replacement). The apply path performs string replacement.
- `"full_replacement"` — default for artifacts ≤2K tokens. Current behavior, unchanged.

Update the tuning agent system prompt `<principles>` block — replace principle #9 (the current full-replacement instruction) with:

```
9. Edit format depends on artifact size.
   - For artifacts OVER ~2,000 tokens: use search/replace. Provide the exact
     text to find (oldText, 3+ lines of context for uniqueness) and the
     replacement (newText). The apply path does a literal string replacement.
     Read the current artifact text first. Copy the target passage verbatim
     including all whitespace, tags, and punctuation. If oldText is not unique,
     widen the context until it is.
   - For artifacts UNDER ~2,000 tokens: use full replacement. Provide the
     complete revised text as proposedText. Every untouched section must be
     preserved verbatim.
   - NEVER use placeholders like "// ... existing code ...", "# rest unchanged",
     or "[remaining content]". This is a critical failure.
```

Update the `propose_suggestion` tool schema to accept either format:
```typescript
{
  editFormat: "search_replace" | "full_replacement",
  // For search_replace:
  oldText?: string,   // exact match from current artifact
  newText?: string,   // replacement text
  // For full_replacement:
  proposedText?: string,  // complete artifact text
}
```

Update the apply path in the suggestion-action handler to perform string replacement when `editFormat === "search_replace"`.

### A.2 Deterministic post-generation validator

Add a validation function that runs in the `PostToolUse` hook after every `propose_suggestion` call. This is NOT an LLM call — it's pure regex/string checks.

**Checks:**
1. **Elision markers:** Reject if proposedText/newText contains any of: `...`, `// rest unchanged`, `[unchanged]`, `TODO: fill`, `# existing code`, `<!-- remaining -->`, `[rest of`, `// ...`, `/* ... */`
2. **Format consistency:** If `editFormat === "search_replace"`, both `oldText` and `newText` must be present and non-empty, and `oldText !== newText`
3. **Format consistency:** If `editFormat === "full_replacement"`, `proposedText` must be present and non-empty
4. **Null checks:** If category is `NO_FIX` or `MISSING_CAPABILITY`, proposedText/oldText/newText must all be null
5. **Structural integrity:** If the target artifact contains XML tags, verify that proposedText/newText has balanced opening/closing tags (simple regex, not a full parser)

On validation failure: the PostToolUse hook should append a system message to the conversation: `"[Validation error: {reason}. Please re-examine the current artifact text and regenerate the suggestion.]"` — forcing the agent to self-correct.

---

## Workstream B — System Prompt Reorder + Hardening (M2, M4, M5, M7, A5)

### B.1 Reorder the tuning agent system prompt

Change the section order in `backend/src/tuning-agent/system-prompt.ts`:

**Current:** persona → principles → taxonomy → tools → platform_context → [boundary] → dynamic
**New:** principles → persona → taxonomy → tools → platform_context → critical_rules → [boundary] → dynamic

### B.2 Collapse persona to ≤150 tokens

Replace the current ~250-token persona with:
```xml
<persona>
You review AI-generated guest replies alongside the property manager and
propose durable configuration changes — system prompt edits, SOP updates,
FAQ additions, tool adjustments — so the main AI improves over time. Direct,
candid, willing to push back. Never open with flattery. When you disagree,
say so with evidence.
</persona>
```

### B.3 Rewrite anti-sycophancy as priority hierarchy

In `<principles>`, replace the current anti-sycophancy directive (#2) with:
```
2. Truthfulness over validation. Prioritize diagnostic accuracy over
   confirming the manager's implied correction. It is better to return
   NO_FIX honestly than to invent a suggestion that satisfies the request.
   The manager benefits more from rigorous standards than from agreement.
```

### B.4 Invert the default to "justify any non-NO_FIX"

Add a new principle after the anti-sycophancy directive:
```
3. NO_FIX is the default. Every non-NO_FIX classification must clear a
   sufficiency check: the evidence must entail a concrete, testable edit
   to a specific artifact. If the correction is cosmetic, a style
   preference, or ambiguous, return NO_FIX and explain what evidence
   would change the classification.
```

### B.5 Add memory-as-hint principle

Add to principles:
```
Memory is a hint, not ground truth. When a stored preference is relevant,
verify it against the current evidence bundle before applying it. Preferences
may be outdated or overridden by new context. If a preference contradicts
the evidence, flag the conflict to the manager.
```

### B.6 Add terminal critical_rules recap

Add immediately before the cache boundary:
```xml
<critical_rules>
Three rules that override everything above:
1. proposedText/newText must never be a fragment — if using full_replacement,
   include the COMPLETE artifact text; if using search_replace, include enough
   context for a unique match.
2. Never apply or rollback without explicit manager sanction in their last message.
3. NO_FIX is correct more often than you think. Justify any non-NO_FIX.
</critical_rules>
```

---

## Workstream C — Diagnostic Engine Upgrades (M4, M8, A2, A3, A4)

### C.1 Invert diagnostic default framing

In `backend/src/services/tuning/diagnostic.service.ts`, update the diagnostic system prompt:

Add after the taxonomy:
```
DEFAULT DISPOSITION: NO_FIX. Before committing to any other category, you must
identify: (a) the specific artifact that would change, (b) the specific
observation in the evidence bundle that necessitates the change, and (c) a
falsifiable prediction about what the change would fix. If any of (a), (b), or
(c) is missing, return NO_FIX.

The manager's correction is ONE datum, not ground truth. The manager may be
wrong, may be expressing a style preference, or may be correcting a one-off
mistake that doesn't generalize. Treat the correction as a claim to be
evaluated against the evidence, not as a directive to be satisfied.
```

### C.2 Add `decision_trace` field to diagnostic JSON schema

Add to the strict JSON schema:
```json
{
  "decision_trace": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "category": { "type": "string", "enum": [...8 categories] },
        "verdict": { "type": "string", "enum": ["eliminated", "candidate"] },
        "reason": { "type": "string", "maxLength": 200 }
      },
      "required": ["category", "verdict", "reason"]
    },
    "minItems": 8,
    "maxItems": 8
  }
}
```

Add instruction: "Populate decision_trace BEFORE committing to the final category. Evaluate ALL 8 categories, marking each as 'eliminated' or 'candidate' with a one-sentence reason citing specific evidence."

### C.3 Add anchored-contrast exemplars

Add one positive + one nearest-confusable negative inline per category definition. 16 exemplars total. Place them inside the taxonomy section.

Example pattern:
```
SOP_CONTENT — the relevant SOP said the wrong thing or didn't cover this case.
  Fix: edit SopVariant.content or SopPropertyOverride.content.
  ✓ Example: Manager corrected "checkout is 11am" to "checkout is 12pm" — the
    SOP had the wrong time.
  ✗ Contrast (SOP_ROUTING): Manager corrected parking info, but the parking SOP
    existed with correct content; the classifier routed to the wrong SOP.

FAQ — factual info the AI needed was missing or wrong.
  Fix: create or edit a FaqEntry.
  ✓ Example: Guest asked about nearest pharmacy, AI said "I don't have that info"
    — no FAQ entry existed for pharmacy locations.
  ✗ Contrast (SOP_CONTENT): Guest asked about check-in time, AI gave wrong time —
    but check-in time is in the SOP, not FAQ. That's SOP_CONTENT.
```

Write exemplars for all 8 categories. This will naturally pad the diagnostic prompt past 1,024 tokens (M8), qualifying for OpenAI's automatic caching discount.

### C.4 Self-consistency k=3

In `diagnostic.service.ts`, modify the diagnostic call:
1. Set `temperature: 0.7` (currently likely 0 or default)
2. Run 3 parallel calls to the diagnostic endpoint
3. Majority-vote on the `category` field
4. If all 3 disagree → override to NO_FIX with rationale "diagnostic disagreement"
5. If 2 agree → use the majority category, take the higher-confidence result's full output
6. Log all 3 results to `AiApiLog` with a shared `batchId` for offline analysis

**Cost:** 3× on diagnostic calls. The diagnostic runs once per trigger event (not per chat turn), so absolute cost is low. Use `Promise.all()` for parallel execution — latency stays ~equal to a single call.

---

## Workstream D — Oscillation Fix (M3)

### D.1 Invert the 1.25× confidence boost

In `backend/src/tuning-agent/hooks/shared.ts`:

Find the oscillation check constant. Change from: re-proposal succeeds if `confidence >= previousConfidence * 0.8` (or equivalent easing) to: re-proposal requires `confidence >= previousConfidence * 1.25`.

This means: if the original suggestion was applied at confidence 0.7, reversing it within 14 days requires confidence ≥ 0.875. This is classic hysteresis — re-entry is stricter than initial entry.

Log the oscillation check result (passed/failed, original confidence, new confidence, boost factor) to the tuning event for observability.

---

## Workstream E — Memory Snapshot Optimization (M6)

### E.1 Switch to index-only injection

In the system prompt builder (where `<memory_snapshot>` is assembled):
1. Change from injecting full key-value pairs to injecting only key + one-line summary
2. Format: `key: summary` (one per line, max 150 chars per line)
3. Add to the `<memory_snapshot>` header: "These are summaries only. Use memory(op: 'view', key: '...') to load the full value when needed."

Update the principles to reference this: "Review memory keys at session start. Load full values via the memory tool only when relevant to the current discussion."

---

## Acceptance Criteria

1. [ ] `propose_suggestion` accepts both `search_replace` and `full_replacement` formats
2. [ ] Artifacts >2K tokens default to search/replace; <2K default to full replacement
3. [ ] `suggestion_action` apply path handles both formats correctly
4. [ ] Post-generation validator runs in PostToolUse hook, rejects elision markers
5. [ ] System prompt section order is: principles → persona → taxonomy → tools → platform_context → critical_rules → [boundary] → dynamic
6. [ ] Persona is ≤150 tokens
7. [ ] Anti-sycophancy uses priority-hierarchy framing
8. [ ] "NO_FIX is the default" principle exists with sufficiency check requirement
9. [ ] Memory-as-hint principle exists
10. [ ] Terminal `<critical_rules>` recap exists before cache boundary
11. [ ] Diagnostic JSON schema includes `decision_trace` array with 8 entries
12. [ ] Diagnostic prompt includes anchored-contrast exemplars for all 8 categories
13. [ ] Diagnostic prompt exceeds 1,024 tokens (OpenAI cache threshold)
14. [ ] Diagnostic runs 3× parallel with majority vote, disagreement → NO_FIX
15. [ ] Oscillation boost is inverted: re-proposal requires 1.25× higher confidence
16. [ ] Memory snapshot injects index-only (key + summary), not full values
17. [ ] All existing tests pass
18. [ ] Manual test: trigger a cosmetic edit → diagnostic returns NO_FIX (anti-sycophancy)
19. [ ] Manual test: trigger a real SOP error → diagnostic returns SOP_CONTENT with decision_trace
20. [ ] Manual test: propose a large artifact edit → search/replace format used, no truncation
