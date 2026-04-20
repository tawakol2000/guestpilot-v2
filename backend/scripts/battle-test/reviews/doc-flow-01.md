# Document Checklist Flow — Battle Test Review

**Date:** 2026-03-30 (executed 2026-04-01)
**Persona:** [TEST] Ahmed & Fatima | Egyptian | Married couple + 1 child (3 guests)
**ConversationId:** cmnfzay1w0005yo3mkiu6dvwp
**ReservationId:** cmnfzaxy00003yo3maw2ehb06
**Channel:** WHATSAPP
**Verdict:** FAIL — critical bug blocks entire document checklist flow

---

## Executive Summary

The document checklist flow is **completely broken** in production via the `sendAiNow` code path (used by battle tests and the manual "Send AI Now" button in the dashboard). The root cause is a **missing `reservationId` field** in the `sendAiNow` controller's context object, which causes `create_document_checklist` to fail with "No reservation linked" during screening. This cascading failure means:

1. No checklist is ever created
2. `mark_document_received` tool is never made available (it's conditional on checklist existing)
3. AI cannot track document submissions — just escalates everything to manager
4. The entire document flow falls back to manual manager work

The debounce job and BullMQ worker paths DO pass `reservationId` correctly, so this bug only affects the `sendAiNow` endpoint.

---

## Bug Found & Fixed (Local Only)

**File:** `src/controllers/conversations.controller.ts` (line ~349-367)

**Bug:** The `sendAiNow` handler builds the `AiReplyContext` object but omits three fields that the debounce job and worker both include:
- `reservationId` (CRITICAL — blocks document checklist tools)
- `screeningAnswers` (CRITICAL — blocks checklist data injection into prompt)
- `aiMode` (minor — defaults work)
- `listing.doorSecurityCode`, `listing.wifiUsername`, `listing.wifiPassword` (moderate — WiFi/door code unavailable)

**Fix applied locally:** Added all missing fields to match the debounce job's context shape. Needs deployment to Railway to take effect.

---

## Turn-by-Turn Results

### Phase 1: INQUIRY — Screening + Checklist Creation

| Turn | Guest Message | AI Response | Tool Called | Tool Result | Status |
|------|--------------|-------------|-------------|-------------|--------|
| 1 | "I want to book an apartment" | Asked for nationality + party composition | None | N/A | PASS |
| 2 | "Egyptian, me and wife and small son" | "I'll check with manager" | `create_document_checklist` | **FAILED**: `{"error":"No reservation linked","created":false}` | **FAIL** |
| 3 | "When can we send passports?" | "After booking is accepted" | `create_document_checklist` (retry) | **FAILED**: same error | **FAIL** |
| 4 | "How much per night?" | "I'll check with manager" | `get_sop` -> pricing-negotiation | Escalated correctly | PASS |
| 5 | Manager actions | Resolved 3 tasks, status -> CONFIRMED | N/A | N/A | PASS |

**Turn 2 Detail — create_document_checklist:**
```json
{
  "toolName": "create_document_checklist",
  "toolInput": {
    "reason": "Egyptian married couple with one child, 3 guests",
    "passports_needed": 3,
    "marriage_certificate_needed": true
  },
  "toolResults": {
    "error": "No reservation linked",
    "created": false
  }
}
```
The AI correctly identified the need for 3 passports + marriage cert. The tool input was perfect. The failure is purely in the controller not passing `context.reservationId`.

### Phase 2: CONFIRMED — Document Submission

| Turn | Guest Message | AI Response | Tool Called | mark_document_received? | Status |
|------|--------------|-------------|-------------|------------------------|--------|
| 6 | "Where do I send passports?" | "I'll check and get back to you" | `get_sop` -> pre-arrival + visitor-policy | NO | **FAIL** |
| 7 | "This is Ahmed's passport" + image | "I'm checking this now" | `get_sop` -> visitor-policy | NO | **FAIL** |
| 9 | "This is Fatima's passport" + image | "Noted Fatima's passport" | `get_sop` -> visitor-policy | NO | **FAIL** |
| 10 | "This is the child's passport" + image | "Noted son's passport" | `get_sop` -> visitor-policy | NO | **FAIL** |
| 11 | "This is the marriage certificate" + image | "Noted marriage certificate" | None (no tool) | NO | **FAIL** |

**Why mark_document_received never fires:** The tool is conditionally included only when `checklistPending` is true (line 1491 of ai.service.ts). Since the checklist was never created, `checklistPending` is always false, and the tool is filtered out of the available tools. The AI never even has the option to call it.

**SOP Gap:** The visitor-policy SOP correctly says "If the guest is asking about their OWN booking documents (passport, marriage cert, ID), this does not apply — escalate as info_request instead." The AI follows this and escalates, but it shouldn't need to — the document checklist flow should handle this automatically.

### Phase 3: CHECKED_IN — General Questions

| Turn | Guest Message | AI Response | Tool Called | Status |
|------|--------------|-------------|-------------|--------|
| 14 | "We arrived, thanks" | Empty response (timeout) | None | **BUG** — empty `guest_message` causes no AI message to be saved |
| 15 | "Did you receive all documents?" | "I'll confirm with manager" | None | PASS (given no checklist exists) |
| 16 | "WiFi password?" | "I'll check" | `get_sop` -> wifi-doorcode | PASS (escalated — no WiFi in context) |
| 17 | "Cleaning tomorrow?" | "Between 10am-5pm, what time?" | `get_sop` -> sop-cleaning | PASS |
| 18 | "When is checkout?" | "11am, late checkout 2 days before" | `get_sop` -> sop-late-checkout | PASS |

---

## Agent Switching Verification

| Phase | Status | Agent Type | System Prompt Prefix |
|-------|--------|-----------|---------------------|
| Phase 1 | INQUIRY | Screening | "OMAR -- Guest Screening Assistant" |
| Phase 2 | CONFIRMED | Coordinator | "OMAR -- Lead Guest Coordinator" |
| Phase 3 | CHECKED_IN | Coordinator | "OMAR -- Lead Guest Coordinator" |

Agent switching works correctly based on reservation status.

---

## Additional Bug: Empty AI Response (Turn 14)

When the guest sent "We arrived, thanks" the AI returned:
```json
{"guest_message":"","escalation":null,"resolveTaskId":null,"updateTaskId":null}
```

An empty `guest_message` means no AI message is saved to the database, causing the battle test poll to time out after 2 minutes. The pipeline should either:
1. Force a minimum response when `guest_message` is empty (e.g., a welcome message)
2. Save a "no response needed" marker so the poll doesn't hang

---

## Cost Summary

| Turn | Input Tokens | Output Tokens | Reasoning Tokens | Cost (USD) | Duration (ms) |
|------|-------------|---------------|-----------------|------------|---------------|
| 1 | 2,545 | 242 | 190 | $0.0039 | 2,590 |
| 2 | 1,730 | 494 | 417 | $0.0054 | 6,326 |
| 3 | 1,686 | 462 | 358 | $0.0050 | 5,527 |
| 4 | 1,818 | 422 | 338 | $0.0048 | 5,036 |
| 6 | 2,123 | 467 | 384 | $0.0054 | 7,257 |
| 7 | 2,913 | 468 | 346 | $0.0058 | 8,466 |
| 9 | 2,833 | 581 | 516 | $0.0062 | 7,670 |
| 10 | 2,776 | 489 | 372 | $0.0051 | 6,080 |
| 11 | 3,231 | 581 | 516 | $0.0060 | 4,022 |
| 14 | 2,702 | 122 | 89 | $0.0016 | 1,508 |
| 15 | 2,712 | 621 | 482 | $0.0053 | 4,717 |
| 16 | 2,097 | 319 | 234 | $0.0041 | 4,194 |
| 17 | 2,204 | 147 | 86 | $0.0018 | 2,979 |
| 18 | 2,428 | 154 | 91 | $0.0029 | 4,945 |
| **Total** | **33,798** | **5,569** | **4,419** | **$0.0633** | **71,317** |

---

## What Works

1. **Screening flow** — correctly asks for nationality + party composition, identifies eligible Arab family
2. **Agent switching** — screening agent (INQUIRY) -> coordinator agent (CONFIRMED/CHECKED_IN)
3. **SOP tool** — `get_sop` correctly routes to relevant SOPs for cleaning, checkout, pricing, WiFi
4. **Escalation** — creates tasks with correct titles and notes
5. **Task updates** — AI correctly updates existing tasks instead of creating duplicates
6. **create_document_checklist input** — AI generates correct tool input (3 passports, marriage cert needed)

## What's Broken

1. **CRITICAL: `sendAiNow` missing `reservationId`** — blocks entire checklist flow
2. **CRITICAL: `sendAiNow` missing `screeningAnswers`** — even if checklist were created, it wouldn't be injected into prompt
3. **CRITICAL: `sendAiNow` missing listing credentials** — WiFi/door code unavailable via this path
4. **MODERATE: Empty AI response causes timeout** — no fallback when `guest_message` is empty
5. **MINOR: No SOP for "send documents through chat"** — AI doesn't know to tell guests to send docs via WhatsApp

## Required Fixes (Priority Order)

1. **Deploy the `sendAiNow` controller fix** — add `reservationId`, `screeningAnswers`, `aiMode`, and full listing fields (DONE locally, needs deploy)
2. **Handle empty `guest_message`** — save a "no response needed" marker or generate minimum response
3. **Add document submission SOP** — tell guests to send passports/marriage certs through the chat after confirmation

## Checklist State After Test

No checklist exists. All document tracking failed. The reservation has no `screeningAnswers.documentChecklist` data because `create_document_checklist` never succeeded.
