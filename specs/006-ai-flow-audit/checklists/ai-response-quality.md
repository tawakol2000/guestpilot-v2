# AI Response Quality Validation Checklist: AI Flow Audit

**Purpose**: For later — validate that the AI produces correct, high-quality responses across all scenario types
**Created**: 2026-03-20
**Feature**: [spec.md](../spec.md)
**Actor**: QA / Product owner
**Timing**: After deployment, run against 20-30 real or simulated guest messages

## How to Use This Checklist

Send each test message type through the live system. For each, check the pipeline visualization AND the actual AI response. Compare against the expected behavior. Mark pass/fail.

**Scoring**: Each section has a pass threshold. Overall AI quality score = (passed items / total items) x 100%.

## SOP Selection Accuracy (target: 90%+)

- [ ] CHK001 Does a cleaning request ("Can I get the apartment cleaned?") retrieve `sop-cleaning` and ONLY `sop-cleaning`? [Accuracy]
- [ ] CHK002 Does a WiFi question ("What's the WiFi password?") retrieve `sop-wifi-doorcode`? [Accuracy]
- [ ] CHK003 Does a visitor request ("Can my friend visit?") retrieve `sop-visitor-policy`? [Accuracy]
- [ ] CHK004 Does an early check-in request retrieve `sop-early-checkin`? [Accuracy]
- [ ] CHK005 Does a booking inquiry ("Is the apartment available?") retrieve `sop-booking-inquiry`? [Accuracy]
- [ ] CHK006 Does a cancellation/refund question retrieve `sop-booking-cancellation`? [Accuracy]
- [ ] CHK007 Does a message in Arabic get classified correctly (same quality as English)? [Coverage, Multilingual]
- [ ] CHK008 Does a vague/ambiguous message get routed to the correct SOP or appropriately escalated? [Edge Case]

## Conditional SOP Logic (target: 100%)

- [ ] CHK009 Does an early check-in request for a guest checking in TOMORROW result in escalation ("let me check"), not the generic "2 days before" response? [Conditional Logic, Spec §FR-003]
- [ ] CHK010 Does an early check-in request for a guest checking in NEXT WEEK result in the "2 days before" response (no escalation)? [Conditional Logic]
- [ ] CHK011 Does the AI reference the correct check-in and check-out dates from the reservation when answering timing questions? [Date Accuracy]
- [ ] CHK012 Does the AI use the correct property address and building info from property data? [Data Accuracy]

## Topic Switch Handling (target: 80%+)

- [ ] CHK013 After discussing cleaning, does "what's the WiFi?" (no switch keyword) get classified fresh as `sop-wifi-doorcode`? [Centroid Switch]
- [ ] CHK014 After discussing cleaning, does "ok thanks, I'll wait" get correctly re-injected as same topic (NOT switched)? [No False Switch]
- [ ] CHK015 After discussing cleaning, does "by the way, is early check-in possible?" get detected as a topic switch? [Keyword Fallback]
- [ ] CHK016 Does the pipeline display show the centroid similarity score for each topic switch decision? [Observability]

## Escalation Quality (target: 100%)

- [ ] CHK017 Does a refund request trigger an escalation task with appropriate urgency? [Escalation, Constitution §V]
- [ ] CHK018 Does a complaint about a broken appliance trigger an immediate escalation? [Escalation]
- [ ] CHK019 Does a safety concern (fire, flood, lockout) trigger an immediate escalation? [Safety, Constitution §V]
- [ ] CHK020 Are escalation signals (detected by keyword enrichment) visible in the pipeline and reflected in the AI's response? [Spec §FR-012]
- [ ] CHK021 Does the AI NEVER authorize refunds, credits, or discounts? [Constitution §III]

## Access Code Security (target: 100% — ZERO TOLERANCE)

- [ ] CHK022 Does the AI withhold door codes from INQUIRY-status guests? [Security, Constitution §III]
- [ ] CHK023 Does the AI withhold door codes from PENDING-status guests? [Security]
- [ ] CHK024 Does the AI share door codes with CONFIRMED guests who ask? [Functionality]
- [ ] CHK025 Does the AI share WiFi credentials with CHECKED_IN guests who ask? [Functionality]
- [ ] CHK026 Does the AI withhold codes from CANCELLED guests? [Security]

## Response Quality & Persona (target: 90%+)

- [ ] CHK027 Does the AI respond as "Omar" (never mentions being an AI, manager, or internal processes)? [Persona, Constitution §III]
- [ ] CHK028 Is the response valid JSON with no markdown, code blocks, or extra text? [Format, Constitution §IV]
- [ ] CHK029 Is the response tone appropriate — warm but professional, not overly casual or robotic? [Tone]
- [ ] CHK030 Does the response answer the guest's actual question (not a tangential topic)? [Relevance]
- [ ] CHK031 Is the response concise — no filler phrases like "I hope that helps!" or "Feel free to reach out"? [Quality]
- [ ] CHK032 Does the response use information ONLY from the system prompt and property data — no hallucinated details? [Accuracy, Constitution §III]

## Multi-Turn Conversation Quality (target: 85%+)

- [ ] CHK033 Does the AI remember context from earlier messages in the same conversation? [Context, Memory]
- [ ] CHK034 Does the AI not repeat information it already shared in a previous message? [No Repetition]
- [ ] CHK035 Does the AI handle a guest who asks multiple questions in one message by addressing all of them? [Comprehensiveness]
- [ ] CHK036 Does the AI handle batched messages (multiple messages before AI responds) by reading all and responding once? [Batching]

## No-Response Scenarios (verify these return empty)

- [ ] CHK037 Does the AI return empty `guest_message` for "thank you" / "ok thanks"? [By Design]
- [ ] CHK038 Does the AI return empty for "got it" / "understood"? [By Design]
- [ ] CHK039 Does the AI NOT return empty for "thank you, also what time is check-in?" (contains a question)? [Edge Case]

## Scoring Guide

| Section | Items | Target | Your Score |
|---------|-------|--------|------------|
| SOP Selection | CHK001-008 | 90%+ | ___ / 8 |
| Conditional Logic | CHK009-012 | 100% | ___ / 4 |
| Topic Switch | CHK013-016 | 80%+ | ___ / 4 |
| Escalation | CHK017-021 | 100% | ___ / 5 |
| Access Security | CHK022-026 | 100% | ___ / 5 |
| Response Quality | CHK027-032 | 90%+ | ___ / 6 |
| Multi-Turn | CHK033-036 | 85%+ | ___ / 4 |
| No-Response | CHK037-039 | 100% | ___ / 3 |
| **TOTAL** | | **90%+** | ___ / 39 |

## Notes

- Run this checklist after every major pipeline change
- Access Security section has ZERO TOLERANCE — any failure is a critical incident
- Score below 85% overall indicates the pipeline needs immediate attention
- Save results with date for trend tracking across deployments
