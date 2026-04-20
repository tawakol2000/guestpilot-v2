# Battle Test 025 R2 — Jordanian Family Marriage Certificate Check

**Date:** 2026-04-02
**Conversation ID:** `cmngt2u0o000h12emfxb4ynkm`
**Reservation ID:** `cmngt2tyl000f12emhl64pej3`
**Channel:** WhatsApp
**Model:** gpt-5.4-mini-2026-03-17
**Agent:** Omar (Screening)
**Persona:** Rami & Huda Nasser, Jordanian family with 3 children (ages 12, 8, 4), 5 guests total
**Status:** INQUIRY
**Total Turns:** 6

---

## Purpose

Verify that `create_document_checklist` correctly sets `marriage_certificate_needed=true` for an Arab FAMILY with children. This was broken in a previous round where a Jordanian family got `false`.

---

## Critical Check: Document Checklist (Turn 2)

**PASS** -- `create_document_checklist` was called on Turn 2 with the correct parameters:

```json
{
  "reason": "Jordanian married couple with 3 children, 5 guests total",
  "passports_needed": 5,
  "marriage_certificate_needed": true
}
```

Tool result confirmed:
```json
{
  "created": true,
  "passportsNeeded": 5,
  "marriageCertNeeded": true
}
```

The AI correctly recognized that a Jordanian family with children implies a married couple and set the marriage certificate flag to `true`.

---

## Turn-by-Turn Results

| Turn | Guest Message | AI Response | Tool Used | Tool Input (key fields) | Notes |
|------|--------------|-------------|-----------|------------------------|-------|
| 1 | "Hi, we want to book for a family vacation" | "Thanks -- please confirm the nationality of all guests, and share the party composition for the 5 guests (adults/children, and ages if there are children)." | None | -- | Correct: asked for nationality + party composition |
| 2 | "We're Jordanian. I'm Rami, my wife Huda, and our 3 kids aged 12, 8, and 4. Five of us total" | "Thanks, I've noted the details and will pass this along for manager review." | `create_document_checklist` | passports_needed=5, marriage_certificate_needed=**true** | **PASS**: Critical check succeeded |
| 3 | "How much per night?" | "Thanks -- I'll check the nightly rate with the manager and get back to you." | `create_document_checklist` (spurious re-call) | passports_needed=5, marriage_certificate_needed=**false** | **BUG**: Re-called tool with wrong value (see below) |
| 4 | "What does the apartment look like?" | "It's a fully furnished 3-bedroom, 3-bath apartment in Silver Palm, New Cairo..." | `get_sop` (property-info) | categories=["property-info"] | Correct: used property-info SOP |
| 5 | "Is it close to any malls?" | "I'll check with the manager and get back to you." | `get_faq` (local-recommendations) | category="local-recommendations" | **MINOR BUG**: Should have used get_sop property-info (malls are in property description) |
| 6 | "Can we bring a stroller for the baby?" | "I'll check with the manager and get back to you." | `get_faq` (amenities-supplies) | category="amenities-supplies" | Correct escalation -- stroller policy not in knowledge base |

---

## Bugs Found

### BUG 1: Spurious Re-call of create_document_checklist with Wrong Value (HIGH)

**Severity:** High
**Affected turn:** 3

On turn 3 (pricing question), the AI re-called `create_document_checklist` with `marriage_certificate_needed: false`, overwriting the correct `true` value from turn 2. The tool input was:

```json
{
  "reason": "Jordanian married couple with 3 children, eligible family inquiry",
  "passports_needed": 5,
  "marriage_certificate_needed": false
}
```

This is a two-part problem:
1. **Duplicate call:** The tool should only be called once per screening flow. There is no guard preventing it from being called again on subsequent turns.
2. **Inconsistent value:** Even the `reason` field says "married couple" but `marriage_certificate_needed` is `false`. The screening prompt says "For Arab married couples, you MUST ALWAYS set marriage_certificate_needed to true" but the model still set it to false on the second call.

**Root cause:** The screening prompt at line 838 of `ai.service.ts` only mentions "Arab married couples" -- it does not explicitly state that "Arab families with children" also require a marriage certificate. The tool definition description (line 153-154 of `tool-definition.service.ts`) does include this clarification ("a family with children IS a married couple"), but the model may not always cross-reference the tool description with the system prompt instructions, especially on follow-up turns where reasoning budget is lower.

**Impact:** If the database uses last-write-wins, the checklist now says no marriage certificate is needed for this Jordanian family -- directly contradicting the correct turn-2 result.

**Recommended fix:**
1. Add an idempotency guard in the tool handler -- if a checklist already exists for this reservation, return the existing checklist instead of overwriting.
2. Update the screening prompt (line 838) to explicitly mention families: "For Arab married couples AND Arab families with children, you MUST ALWAYS set marriage_certificate_needed to true -- a family with children implies a married couple."

### BUG 2: Mall Question Not Answered from Property Description (LOW)

**Severity:** Low
**Affected turn:** 5

The guest asked "Is it close to any malls?" The AI used `get_faq` with `local-recommendations` (which returned no results) and escalated. However, the property description (returned by `get_sop property-info` on turn 4) explicitly lists "direct access to O1 Mall, Garden 8 Mall, and Waterway Mall." The AI had this information from the previous turn but did not retain it, and chose the wrong tool on turn 5.

**Impact:** Guest gets a delayed "I'll check" response when the answer was already available. Not a compliance issue but reduces responsiveness.

---

## Escalation Tasks Created

| Task Title | Turn | Urgency | Notes |
|-----------|------|---------|-------|
| eligible-arab-family-pending-docs | 2 | inquiry_decision | Correct: Jordanian family eligible, pending manager confirmation |
| eligible-arab-family-pending-docs | 3 | inquiry_decision | Duplicate escalation with pricing question appended |
| escalation-unknown-answer | 5 | inquiry_decision | Mall proximity question |
| escalation-unknown-answer | 6 | inquiry_decision | Stroller policy question |
| message-delivery-failure | 1, 3, 5, 6 | immediate | Expected: test reservation has no real Hostaway listing |

---

## Cost Analysis

| Turn | Input Tokens | Output Tokens | Reasoning Tokens | Cost (USD) | Duration (ms) |
|------|-------------|---------------|-------------------|------------|---------------|
| 1 | 2,729 | 252 | 191 | $0.00404 | 3,136 |
| 2 | 2,935 | 100 | 9 | $0.00269 | 3,896 |
| 3 | 3,483 | 287 | 167 | $0.00258 | 9,097 |
| 4 | 3,709 | 295 | 213 | $0.00334 | 7,447 |
| 5 | 2,950 | 200 | 117 | $0.00226 | 3,112 |
| 6 | 3,325 | 269 | 181 | $0.00279 | 6,248 |
| **Total** | **19,131** | **1,403** | **878** | **$0.01770** | -- |

Average cost per turn: $0.00295
Average latency: 5.5s

---

## SOP Routing Summary

| Tool | Category | Turn | Correct? |
|------|----------|------|----------|
| (none) | screening | 1 | Yes |
| create_document_checklist | screening | 2 | Yes |
| create_document_checklist | screening (spurious) | 3 | No -- should not have been called again |
| get_sop | property-info | 4 | Yes |
| get_faq | local-recommendations | 5 | No -- should have been property-info |
| get_faq | amenities-supplies | 6 | Acceptable -- escalated correctly |

---

## Overall Assessment

| Category | Rating | Notes |
|----------|--------|-------|
| Marriage Cert (Turn 2) | **PASS** | Correctly set to true for Jordanian family with children |
| Passport Count | **PASS** | Correctly set to 5 (all family members) |
| Screening Flow | **PASS** | Asked nationality + composition, applied Arab family rules |
| Duplicate Tool Call | **FAIL** | Re-called create_document_checklist on turn 3 with wrong value |
| SOP/FAQ Routing | MIXED | 4/6 correct; mall question used wrong tool |
| Escalation Quality | **PASS** | All escalation tasks had accurate context |
| No RAG/Classifier | **PASS** | Pure tool-based routing, no legacy pipeline |

**Final Verdict:** The primary test objective PASSED -- `marriage_certificate_needed` was correctly set to `true` for an Arab family with children on turn 2. However, a significant secondary bug was found: the tool was re-invoked on turn 3 with `marriage_certificate_needed=false`, potentially overwriting the correct value. The tool handler needs an idempotency guard, and the screening prompt should explicitly mention "families with children" alongside "married couples" in the marriage certificate instruction.
