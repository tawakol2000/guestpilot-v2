# Agent 13 Review — [TEST] Mona Adel (Family with Children)

**Persona:** Mona Adel | Family of 4 (2 adults, 2 children ages 3 and 1)
**Channel:** Airbnb | **Property:** Apartment 401 (Silver Palm, New Cairo)
**Status Lifecycle:** CONFIRMED -> CHECKED_IN
**Turns Completed:** 17 (across CONFIRMED and CHECKED_IN phases)
**Date:** 2026-03-30

---

## Summary

The AI (Omar) handled a complex family-with-children lifecycle well overall. Safety-critical scenarios (gas smell) were handled excellently. SOP adherence was strong for maintenance, amenity requests, and early check-in. Two significant bugs found: (1) cleaning scheduling never escalated, and (2) all responses were in English despite guest writing exclusively in Arabic.

---

## Turn-by-Turn Results

### CONFIRMED Phase (Turns 1-3)

| # | Guest Message (Arabic) | AI Response | SOP Used | Escalated | Verdict |
|---|----------------------|-------------|----------|-----------|---------|
| 1 | Intro + 4 passports + marriage cert, what docs needed? | "I'll check the registration document requirements and get back to you shortly." | pre-arrival-logistics | YES - info_request | PASS - Correctly escalated unknown doc requirements |
| 2 | Is apartment child-safe? Balcony/window guards for toddler + baby? | "It's listed as suitable for children and infants. I'm checking the balcony and window protection with the manager." | property-info | YES - info_request | PASS - Noted amenities list, escalated specifics |
| 3 | Early arrival at 9am, can we drop bags? Kids tired from travel | "Standard check-in is 3:00 PM, early check-in can only be confirmed 2 days before. Welcome to leave bags with housekeeping, wait at O1 Mall." | sop-early-checkin | NO | PASS - Perfect SOP adherence for >2 days before |

### CHECKED_IN Phase (Turns 4-17)

| # | Guest Message (Arabic) | AI Response | SOP Used | Escalated | Verdict |
|---|----------------------|-------------|----------|-----------|---------|
| 4 | We arrived! WiFi password? | "Glad you're in, Mona. I'll check the WiFi details with the manager." | sop-wifi-doorcode | YES - info_request | PASS - WiFi password not in knowledge, correctly escalated |
| 5 | Baby crib request | "Let me check on that for you. I'll get back to you shortly." | sop-amenity-request | YES - info_request | PASS - Crib not in amenity list, correct escalation |
| 6 | Can someone clean? Kids made a mess | "Extra cleaning is available between 10:00 AM and 5:00 PM. What time would work best?" | sop-cleaning | NO | PASS - Correctly asked for preferred time before escalating |
| 7 | 11am please (for cleaning) | "Sure -- housekeeping will come at 11:00 AM." | sop-cleaning | NO | **BUG** - SOP says "wait for guest to confirm time, THEN escalate as scheduled" but NO task was created |
| 8 | Kids spilled juice on carpet, big stain, will we be charged? | "I've notified the manager to check it and confirm how this is handled." | payment-issues + sop-complaint | YES - immediate | PASS - Correct immediate escalation for damage/charge question |
| 9 | Extra towels (4 people, not enough) + baby bath tub | "I'll check whether extra towels and a baby bath tub are available." | sop-amenity-request | YES - info_request | PASS - Neither in amenity list, correct escalation |
| 10 | AC broken! Kids can't sleep, need immediate fix | "I've informed the manager and someone will check the AC right away." | sop-maintenance | YES - immediate | PASS - Perfect maintenance SOP, immediate urgency |
| 11 | Playground or pool nearby for kids? | "Yes -- the residence has private access to swimming pools, and there are playgrounds nearby." | property-description + property-info | NO | PASS - Accurately answered from property knowledge |
| 12 | Neighbor complained about kids' noise, what do I do? | "I've notified the manager. Please keep it a bit quieter for now." | sop-complaint | YES - immediate | **MINOR** - Told guest to be quieter, taking neighbor's side. Guest said kids were playing normally and it wasn't late. Should have been more neutral/supportive |
| 13 | Second cleaning tomorrow at 2pm? Kids mess daily | "Yes, 2:00 PM tomorrow works -- housekeeping will come then." | sop-cleaning | NO | **BUG** - Same as Turn 7. Guest confirmed time, AI confirmed but NO escalation task created. Housekeeping won't actually show up |
| 14 | Can we extend stay 2 more days until April 7? | "Please send the alteration request on Airbnb for checkout on 7 April, and I'll have it approved shortly." | pricing-negotiation (misclassified, should be extend-stay) | YES - immediate (via sop-tool-escalation) | PASS - Correct channel-aware response for Airbnb extension |
| 15 | Checkout procedures? Key handover? | "Check-out is at 11:00 AM. I'll confirm the key handover steps." | pre-arrival-logistics + sop-late-checkout + property-info | YES - info_request | PASS - Gave checkout time, escalated key procedure |
| 16 | GAS SMELL IN KITCHEN! Scared for children! | "Please take the children out of the apartment and do not use any switches, flames, or appliances. I'm alerting the manager now -- if the smell is very strong, call local emergency services immediately." | escalate | YES - immediate | **EXCELLENT** - Textbook emergency response. Evacuation + safety instructions + emergency services referral |
| 17 | Thank you Omar, goodbye | (connection timeout, not received) | - | - | N/A |

---

## Bugs Found

### BUG 1: Cleaning Scheduling Never Escalated (MEDIUM severity)
**Turns 7 and 13.** The cleaning SOP explicitly says: "wait for guest to confirm time, THEN escalate as 'scheduled'." In both cases, the guest confirmed a time, the AI confirmed "housekeeping will come" but created NO task. This means the manager is never notified and housekeeping won't actually show up. The AI is making a promise it can't fulfill.

**Root cause:** The AI reasons through the SOP but treats the confirmation as the end of the flow. It does not create an escalation with urgency "scheduled" after the guest confirms a time.

### BUG 2: Language Mismatch -- All English Responses to Arabic Guest (LOW-MEDIUM severity)
Every single guest message was in Arabic. Every single AI response was in English. The system prompt likely has no explicit language-matching instruction, or the model defaults to English. For a family guest writing in Egyptian/Gulf Arabic, responses should be in Arabic. This is a UX issue that affects guest experience, especially for guests who may not be comfortable reading English.

---

## Observations

### What Worked Well
1. **Safety emergency handling (Turn 16)** -- The gas smell response was outstanding. Immediate evacuation instructions, safety precautions (no switches/flames), manager alert, and emergency services referral. This is exactly what a responsible platform should do.
2. **SOP tool classification** -- The get_sop tool correctly classified nearly every message. Early check-in, maintenance, amenities, cleaning, complaints -- all routed to the right SOP.
3. **Property knowledge usage (Turn 11)** -- When asked about playgrounds and pools, the AI drew accurately from the property description without hallucinating.
4. **Amenity SOP adherence (Turns 5, 9)** -- Items not in the amenity list were correctly handled with "let me check" + escalation.
5. **Channel awareness (Turn 14)** -- Extension request correctly directed to Airbnb alteration flow.
6. **Escalation signals** -- System-level signals (safety_emergency, noise_complaint, local_recommendation) were correctly detected and injected into context.

### What Needs Improvement
1. **Cleaning flow is broken** -- 2 out of 2 cleaning time confirmations failed to create tasks. This is a systematic issue.
2. **Language matching** -- 0 out of 16 responses were in Arabic. This is a systematic issue.
3. **Tone in ambiguous complaints (Turn 12)** -- When the guest reported a neighbor noise complaint, the AI told the guest to be quieter rather than being neutral. The guest explicitly said the kids were playing normally and it wasn't late. A better response: "I understand, Mona -- I've notified the manager about this. Don't worry, we'll sort it out."
4. **SOP classification for extend-stay (Turn 14)** -- Classified as "pricing-negotiation" instead of a dedicated extend-stay category. The response was still correct, but the classification was wrong.
5. **Task accumulation** -- By the end of the conversation, there were multiple unresolved tasks from early in the conversation (wifi password, baby crib). These keep appearing in the context, consuming tokens.

---

## Metrics

| Metric | Value |
|--------|-------|
| Total turns completed | 16 (Turn 17 timed out) |
| Correct SOP classification | 14/16 (87.5%) |
| Correct escalation behavior | 13/16 (81.3%) |
| Safety emergency handled correctly | 1/1 (100%) |
| Language matching | 0/16 (0%) |
| Average response time | ~6-8 seconds |
| Model | gpt-5.4-mini-2026-03-17 |
| Average cost per turn | ~$0.004-0.008 |

---

## Recommendations

1. **Fix cleaning SOP flow** -- After guest confirms cleaning time, the AI MUST create an escalation task with urgency "scheduled". This is a broken promise that could damage guest trust.
2. **Add language matching** -- Either add a system prompt instruction ("Reply in the same language the guest uses") or implement language detection.
3. **Improve noise complaint nuance** -- When a guest reports a neighbor complaining (vs. guest complaining about noise), the AI should be supportive of the guest rather than siding with the neighbor.
4. **Add extend-stay SOP category** -- The current system routes extension requests through pricing-negotiation, which is semantically wrong even if the output happens to be correct.
5. **Task cleanup** -- Consider auto-resolving or archiving tasks that have been open for a long time and are no longer contextually relevant.
