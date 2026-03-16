# V7-Full Tiered Routing Upgrade

## Summary

Upgrades from "retrieve everything via RAG" to a **3-tier routing architecture**:

- **Tier 1:** Embedding classifier (existing pgvector/KNN) — handles ~65% of messages when confidence > 0.75
- **Tier 2:** Canonical Intent Extractor (real Haiku LLM call) — handles ~20% of ambiguous messages using conversation context
- **Tier 3:** Topic State Cache (config-driven) — handles ~15% of contextual/follow-up messages with per-category TTLs, Arabic support, and "not-switch" signals

## Changes

### 4 Baked-In SOPs Removed from RAG

These are already in the system prompt — having them in RAG caused co-occurrence confusion:
- `sop-scheduling`
- `sop-house-rules`
- `sop-escalation-immediate`
- `sop-escalation-scheduled`

A SQL safety filter (`AND category NOT IN (...)`) prevents retrieval even if they exist in the DB.

### 11 New SOP Categories Added

| Category | Description | Tokens |
|----------|-------------|--------|
| `sop-booking-inquiry` | Availability, new bookings, unit options | 90 |
| `pricing-negotiation` | Rates, discounts, budget concerns | 95 |
| `pre-arrival-logistics` | Directions, ETA, airport transfers, location sharing | 95 |
| `sop-booking-modification` | Date changes, guest count updates, unit swaps | 85 |
| `sop-booking-confirmation` | Verifying reservations, checking status | 85 |
| `payment-issues` | Payment failures, receipts, billing disputes, refunds | 85 |
| `post-stay-issues` | Lost items, post-checkout complaints, deposit questions | 90 |
| `sop-long-term-rental` | Monthly stays, corporate housing, long-term contracts | 85 |
| `sop-booking-cancellation` | Cancellation requests, policy questions | 90 |
| `sop-property-viewing` | Property tours, photo/video requests, filming inquiries | 85 |
| `non-actionable` | Greetings, test messages, wrong chat, system messages | 60 |

### Tier 2: Real Haiku LLM Call

- File: `backend/src/services/intent-extractor.service.ts`
- Fires when Tier 1 topSimilarity <= 0.75 AND Tier 3 doesn't re-inject
- Reads last 5 messages, calls Claude Haiku with 25-example prompt
- Returns TOPIC/STATUS/URGENCY/SOPS
- Cost: ~$0.0001/call | Latency: ~300-500ms
- Graceful degradation: if call fails, returns null → uses Tier 1 results

### Tier 3: Config-Driven Topic State Cache

- File: `backend/src/services/topic-state.service.ts`
- Config: `backend/config/topic_state_config.json`
- Per-category TTLs (e.g., maintenance: 60min, cleaning: 20min)
- Arabic + English topic switch keywords (30 EN, 10 AR)
- Not-switch signals (short answers, time responses, identity responses)
- Max 5 re-injections per conversation before cache expires

### Escalation Enrichment

- File: `backend/src/services/escalation-enrichment.service.ts`
- Config: `backend/config/escalation_rules.json`
- Post-routing keyword pattern matching for urgency signals
- 12 immediate triggers, 5 scheduled triggers, 8 info-request triggers
- Signals logged in ragContext for Langfuse visibility

### 120 New Seed Examples

Added to `classifier-data.ts` for the 11 new categories (includes 12 Arabic examples).

### Similarity Floor Raised

From 0.25 to 0.3 — reduces noise from low-confidence matches.

## Config Files

All stored in `backend/config/`:
- `intent_extractor_prompt.md` — Tier 2 LLM prompt (25 worked examples, 22 categories)
- `topic_state_config.json` — Tier 3 config (per-category TTLs, Arabic keywords, not-switch signals)
- `escalation_rules.json` — Post-routing escalation pattern matching
- `routing_test_suite.json` — 300 test cases for regression testing
- `v7_new_sop_chunks_and_seeds.json` — 11 new SOP texts + 120 seed examples

## Graceful Degradation

| Component | Failure Mode | Behavior |
|-----------|-------------|----------|
| Tier 1 (KNN/pgvector) | Classifier not initialized | Falls back to pgvector |
| Tier 2 (Haiku) | API key missing / call fails | Returns null, uses Tier 1 |
| Tier 3 (Cache) | Config not found | Uses hardcoded defaults |
| Escalation enrichment | Rules not found | Returns empty signals |
| Config files | Missing from disk | Service logs warning, continues |

## Verification Checklist

- [ ] `npm run build` passes with zero errors
- [ ] Server starts, logs show config loaded messages
- [ ] Cleaning message → retrieves sop-cleaning, NOT sop-scheduling
- [ ] "Do you have apartments available?" → retrieves sop-booking-inquiry
- [ ] "Can I get a discount?" → retrieves pricing-negotiation
- [ ] Contextual "ok" after cleaning → Tier 3 re-injects sop-cleaning
- [ ] "friend" after visitor question → Tier 3 re-injects (not-switch signal)
- [ ] "also what's the wifi?" → topic switch detected, cache cleared
- [ ] Low-confidence ambiguous message → Tier 2 fires Haiku call
- [ ] "I smell gas!" → escalation enrichment detects safety_emergency
- [ ] Langfuse traces show tier, topSimilarity, escalationSignals
