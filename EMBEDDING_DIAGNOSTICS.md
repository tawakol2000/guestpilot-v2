# Embedding Diagnostics

**Last run**: never
**Command**: Tell Claude "run embedding diagnostics"

## What it does

Pulls ALL pipeline data from AiApiLog since the last run and displays a per-message breakdown of the AI flow — from guest message to AI response. Designed to spot classification errors, wrong SOPs, topic switch failures, and other pipeline bugs without reading full SOP content or system prompts.

## Data pulled per message

| Field | Source |
|-------|--------|
| Timestamp | AiApiLog.createdAt |
| Guest message | AiApiLog.userContent (last guest message extracted) |
| AI response | AiApiLog.responseText (first 200 chars) |
| Escalation | Parsed from responseText |
| Tier 1: LR confidence | ragContext.classifierConfidence |
| Tier 1: confidence tier | ragContext.confidenceTier (high/medium/low) |
| Tier 1: classified labels | ragContext.classifierLabels |
| Tier 1: method | ragContext.classifierMethod |
| Tier 1: top candidates | ragContext.topCandidates (top 3 with scores) |
| Tier 3: re-injected | ragContext.tier3Reinjected |
| Tier 3: topic switch | ragContext.tier3TopicSwitch |
| Tier 3: centroid similarity | ragContext.centroidSimilarity |
| Tier 3: switch method | ragContext.switchMethod |
| Tier 2: fired | ragContext.tier2Output (exists or null) |
| Tier 2: topic | ragContext.tier2Output.topic |
| Tier 2: SOPs | ragContext.tier2Output.sops |
| SOPs selected | ragContext.chunks[].category (titles only, no content) |
| Chunk count | ragContext.totalRetrieved |
| Escalation signals | ragContext.escalationSignals |
| Judge: evaluated | ragContext linked to ClassifierEvaluation |
| Judge: correct | ClassifierEvaluation.retrievalCorrect |
| Judge: auto-fixed | ClassifierEvaluation.autoFixed |
| Model | AiApiLog.model |
| Cost | AiApiLog.costUsd |
| Duration | AiApiLog.durationMs |
| Conversation | AiApiLog.conversationId |
| Agent | AiApiLog.agentName |

## Output format

```
=== EMBEDDING DIAGNOSTICS: [start] → [end] ===
Messages analyzed: N

--- MSG 1/N [3:02 AM] conv:cmmy6il5... agent:Omar ---
Guest: "I have a booking issue"
Tier 1: sop-amenity-request (47%) LOW | labels: [sop-amenity-request, non-actionable, ...]
Tier 3: skipped
Tier 2: FIRED → topic: "booking issue reported" → [sop-booking-confirmation, payment-issues]
Signals: (none)
SOPs: sop-booking-confirmation, payment-issues (2 chunks)
AI: "I'm here to help. What's the booking issue you're experiencing?"
Escalation: none
Judge: Incorrect → auto-fixed [sop-booking-confirmation, payment-issues]
Cost: $0.0018 | 888ms

--- MSG 2/N [3:15 AM] conv:cmmy6il5... agent:Omar ---
...
```

## Flags (anomalies highlighted)

- 🔴 WRONG SOP: Tier 1 label doesn't match Tier 2 correction
- 🔴 DUPLICATE: Same SOP appears twice in chunks
- 🟡 LOW CONF: Tier 1 confidence < 0.55
- 🟡 TIER 2 FIRED: Intent extractor was needed
- 🟢 HIGH CONF: Tier 1 confidence ≥ 0.85, single SOP
- 🔵 TOPIC SWITCH: Centroid or keyword switch detected
- ⚠️ ESCALATION: Escalation created
- 🔴 EMPTY RESPONSE: guest_message was empty (check if conversation closer)
