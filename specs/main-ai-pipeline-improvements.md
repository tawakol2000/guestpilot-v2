# Main AI Pipeline Improvements — Sprint Spec

> Non-prompt engineering changes to the coordinator/screening AI pipeline.
> The system prompt rewrites are handled separately (Claude AI task).
> This spec covers: message timestamps, automated message compaction, summary scope, baked-in SOP injection verification, image instruction cache fix, screening reasoning effort.

---

## Goal

Improve the main AI's context quality — better signal per token in the message history, timestamps for temporal reasoning, and fixes for identified gaps. No new features, no frontend changes.

---

## Workstream A — Message Timestamps in History

### A.1 Add timestamps to conversation history messages

In `ai.service.ts`, where the conversation history is built for injection into `{CONVERSATION_HISTORY}`:

Currently messages are formatted as something like:
```
Guest: Can we get the apartment cleaned today?
Omar: Sure, extra cleaning is available between 10am and 5pm. What time works best?
```

Change to:
```
[Apr 17, 3:15 PM] Guest: Can we get the apartment cleaned today?
[Apr 17, 3:16 PM] Omar: Sure, extra cleaning is available between 10am and 5pm. What time works best?
```

Format: `[MMM DD, h:mm A]` — short, human-readable, uses the tenant's timezone (from `workingHoursTimezone` config field). Fall back to `Africa/Cairo` if not set.

Same-day messages can optionally drop the date: `[3:15 PM]` — but only if the message is from today relative to `{CURRENT_LOCAL_TIME}`. This saves tokens on recent messages while keeping full dates on older ones.

---

## Workstream B — Automated Message Compaction

### B.1 Compact long automated messages via nano model

When building the message history, detect messages that are likely automated templates (long messages from the HOST/AI role that exceed a token threshold). Compact them using gpt-5-nano before injection.

**Detection heuristic:** Any HOST or AI message that exceeds 300 tokens (roughly 200+ words). Most real conversational messages are 1-2 sentences (~20-50 tokens). Automated messages (booking confirmations, check-in instructions, pre-arrival info) are typically 400-1000 tokens.

**Compaction flow:**
1. When building conversation history, check each HOST/AI message length
2. If over threshold, call gpt-5-nano with a compaction prompt
3. Store the compacted version on the Message record (new field: `compactedContent`)
4. On subsequent calls, use the cached compacted version (don't re-compact)
5. If nano call fails, fall back to the full message (current behavior)

**Compaction prompt:**
```
Compress this automated guest message into 2-3 sentences preserving:
- Any access codes, passwords, WiFi info, or door codes
- Specific times, dates, or deadlines
- Any property-specific instructions (parking, check-in procedure)
- Any amounts or fees mentioned

Drop: greetings, marketing language, generic hospitality text, repeated info.
Output plain text only, no formatting.
```

**Schema change:** Add `compactedContent: String?` field to the Message model in `schema.prisma`.

**When to compact:** Run compaction at message save time (when an automated message is stored), not at AI call time. This way the compaction cost is paid once per message, not once per AI call.

**Token savings estimate:** A 600-token automated message compacted to ~80 tokens saves ~520 tokens per message. With 2-3 automated messages in a typical 10-message window, that's 1,000-1,500 tokens saved per AI call.

---

## Workstream C — Summary Service Scope Expansion

### C.1 Include unresolved complaints about routine topics

In `summary.service.ts`, update the `SUMMARIZE_PROMPT` and `EXTEND_PROMPT`:

Current exclusion list:
```
EXCLUDE all of the following (these are tracked separately in open tasks):
- Cleaning requests and scheduling
- WiFi password or door code exchanges
- Amenity deliveries and requests
- Check-in/checkout logistics and instructions
- Routine acknowledgments
- Resolved escalations and manager responses
```

Change to:
```
EXCLUDE routine, resolved exchanges:
- Routine cleaning/amenity scheduling that was completed
- WiFi password or door code exchanges (already in reservation details)
- Check-in/checkout logistics that went smoothly
- Routine acknowledgments ("thanks", "ok", "got it")
- Resolved escalations where the issue was fully addressed

INCLUDE even if the topic seems routine:
- Complaints or dissatisfaction about ANY topic (including cleaning, amenities, WiFi)
- Unresolved issues where the guest is still waiting
- Promises made by Omar that haven't been fulfilled yet
- Any negative emotional tone, frustration, or repeated requests
```

This way a complaint about cleaning quality IS captured (emotional context for future interactions) while a routine "cleaning at 2pm please" / "confirmed" exchange is still excluded.

---

## Workstream D — Pipeline Fixes

### D.1 Verify baked-in SOPs injection

Check whether `BAKED_IN_SOPS_TEXT` from `backend/src/config/baked-in-sops.ts` is actually injected into the coordinator system prompt during `generateAndSendAiReply()`. 

If it IS injected — document where and move on.
If it is NOT injected — add it. Inject it as the last static section before `<!-- CONTENT_BLOCKS -->`. It should be part of the cached static prefix, not a dynamic content block.

### D.2 Move image instructions out of static prompt

In `ai.service.ts`, find where image handling instructions are appended to the system prompt when images are present (around line 1940 per the audit). Move these instructions into a dynamic content block instead of appending to the static prompt prefix. This prevents cache-busting on image messages.

Change from: appending to the system prompt string
Change to: adding as a `<!-- BLOCK -->` content block:
```
<!-- BLOCK -->
<image_instructions>
[the existing image handling instructions]
</image_instructions>
```

### D.3 Set screening reasoning to low

In `ai.service.ts` or wherever the reasoning effort is determined per agent type:

Currently screening defaults to `none` (no reasoning tokens). Change to `low`. The screening logic involves multi-hop nationality × party composition × gender decisions that benefit from even minimal reasoning.

Cost impact: negligible on gpt-5.4-mini. Accuracy impact on edge cases: meaningful.

### D.4 Enforce get_faq before info_request escalation (code-level)

This is a code-level safety net alongside the prompt-level instruction. In the response parsing logic, after the AI returns its structured JSON:

If `escalation.urgency === 'info_request'` AND the AI did NOT call `get_faq` during this turn's tool loop, log a warning. This is telemetry only for now — don't block the response. Use the telemetry to measure how often the AI skips get_faq before escalating, which validates whether the prompt change is working.

---

## Acceptance Criteria

1. [ ] Conversation history messages include timestamps in `[MMM DD, h:mm A]` format
2. [ ] Timestamps use tenant timezone, fallback to Africa/Cairo
3. [ ] Same-day messages use short format `[h:mm A]`
4. [ ] Messages over 300 tokens from HOST/AI role are compacted via gpt-5-nano
5. [ ] Compacted content is cached on the Message record (`compactedContent` field)
6. [ ] Compaction runs at message save time, not at AI call time
7. [ ] Compaction failure falls back to full message
8. [ ] Summary service captures complaints/dissatisfaction about routine topics
9. [ ] Summary service captures unresolved issues and unfulfilled promises
10. [ ] Summary service still excludes routine resolved exchanges
11. [ ] Baked-in SOPs are verified as injected (or fixed if missing)
12. [ ] Image instructions are in a dynamic content block, not the static prefix
13. [ ] Screening reasoning effort is `low`, not `none`
14. [ ] Telemetry logs when AI escalates info_request without calling get_faq
15. [ ] All existing tests pass
16. [ ] `npx tsc --noEmit` passes
