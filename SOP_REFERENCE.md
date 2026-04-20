# GuestPilot — Complete SOP Reference

**Generated**: 2026-04-06
**Source**: `sop.service.ts` + `tool-definition.service.ts`

---

## Table of Contents

1. [Tools (Schemas & Descriptions)](#tools)
2. [SOP Categories (Tool Descriptions)](#sop-categories)
3. [SOP Content by Booking Status](#sop-content-by-booking-status)

---

## Tools

### 1. `get_sop` — SOP Classification

**Scope**: INQUIRY, PENDING, CONFIRMED, CHECKED_IN

**Description**: Classifies a guest message to determine which Standard Operating Procedure should guide the response. Call this for EVERY guest message. Returns the SOP category that best matches the guest's primary intent. For simple greetings, acknowledgments, or messages that don't require procedure-based responses, use "none". For messages requiring human intervention, use "escalate".

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "reasoning": {
      "type": "string",
      "description": "Brief reasoning for classification (1 sentence)"
    },
    "categories": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "maxItems": 3,
      "description": "SOP categories matching the guest's intent(s), ordered by priority."
    },
    "confidence": {
      "type": "string",
      "enum": ["high", "medium", "low"],
      "description": "Classification confidence. Use 'low' when ambiguous."
    }
  },
  "required": ["reasoning", "categories", "confidence"]
}
```

---

### 2. `search_available_properties` — Property Search

**Scope**: INQUIRY, PENDING

**Description**: Score this property and alternatives against the guest's requirements. Returns match scores, met/unmet breakdown, and notes. CALL for: guest lists multiple requirements, asks what's available, wants to compare options, asks about amenities. DO NOT call for: single factual property questions, extend/shorten stay.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "reasoning": { "type": "string" },
    "amenities": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Features the guest wants, e.g. ['pool', 'parking', 'sea view']"
    },
    "min_capacity": {
      "type": ["number", "null"],
      "description": "Min guests to accommodate. Only if guest mentioned group size."
    },
    "reason": {
      "type": "string",
      "description": "Brief reason, verbatim from guest."
    }
  },
  "required": ["reasoning", "amenities", "reason", "min_capacity"]
}
```

---

### 3. `create_document_checklist` — Document Checklist

**Scope**: INQUIRY, PENDING

**Description**: Create a document checklist for this booking. Call when guest is eligible and you're about to escalate with acceptance recommendation. Records what documents the guest will need to submit after booking acceptance. Do NOT call when recommending rejection.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "passports_needed": {
      "type": "number",
      "description": "One per guest in the party"
    },
    "marriage_certificate_needed": {
      "type": "boolean",
      "description": "true for Arab married couples AND Arab families with children"
    },
    "reason": {
      "type": "string",
      "description": "e.g. 'Egyptian married couple, 2 guests'"
    }
  },
  "required": ["passports_needed", "marriage_certificate_needed", "reason"]
}
```

---

### 4. `check_extend_availability` — Extend Stay

**Scope**: CONFIRMED, CHECKED_IN

**Description**: Check if the guest's current property is available for extended or modified dates, and calculate pricing. CALL for: extending stay, adding nights, leaving early, shortening stay, changing dates, cost of more nights. DO NOT call for: late checkout under 2 hours beyond standard, unrelated questions.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "reasoning": {
      "type": "string",
      "description": "Why this change and these dates."
    },
    "new_checkout": {
      "type": "string",
      "description": "Requested new checkout in YYYY-MM-DD."
    },
    "new_checkin": {
      "type": ["string", "null"],
      "description": "New check-in if guest wants to arrive earlier/later."
    },
    "reason": {
      "type": "string",
      "description": "Specific reason from guest."
    }
  },
  "required": ["reasoning", "new_checkout", "reason", "new_checkin"]
}
```

---

### 5. `mark_document_received` — Mark Document Received

**Scope**: CONFIRMED, CHECKED_IN

**Description**: Mark a document as received after the guest sends it via chat. CALL for: clear passport, national ID, driver's license, or marriage certificate images when documents are pending. DO NOT call for: unclear/blurry images (escalate), images that aren't documents, or when no documents are pending.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "reasoning": {
      "type": "string",
      "description": "Why you believe this image is this document type."
    },
    "document_type": {
      "type": "string",
      "enum": ["passport", "marriage_certificate"]
    },
    "notes": {
      "type": "string",
      "description": "e.g. 'passport for Mohamed'"
    }
  },
  "required": ["reasoning", "document_type", "notes"]
}
```

---

### 6. `get_faq` — FAQ Lookup

**Scope**: INQUIRY, PENDING, CONFIRMED, CHECKED_IN

**Description**: Search the property FAQ knowledge base for factual answers. Use after get_sop when the SOP doesn't cover a specific factual question.

---

## SOP Categories

| Category | Tool Description |
|----------|-----------------|
| `sop-cleaning` | Mid-stay cleaning or housekeeping requests. NOT for cleanliness complaints on arrival (use sop-complaint). |
| `sop-amenity-request` | Requesting supplies (towels, pillows, hangers) or asking for on-request amenities. NOT for general property description. |
| `sop-maintenance` | Broken items, plumbing, HVAC, electrical, pests, mold, smell. NOT for WiFi issues. |
| `sop-wifi-doorcode` | WiFi password, internet issues, door codes, locked out, building access. |
| `sop-visitor-policy` | Visitor requests, guest count verification, passport submission for visitors. NOT for guest's own documents. |
| `sop-early-checkin` | Arriving before 3PM, early access, bag drop-off. |
| `sop-late-checkout` | Staying past 11AM on checkout day only. NOT for extending stay by days. |
| `sop-complaint` | Guest dissatisfaction, review threats, quality complaints. NOT for specific broken items. |
| `sop-booking-inquiry` | New booking requests, availability checks, property search. |
| `pricing-negotiation` | Discount requests, rate questions, budget concerns. |
| `sop-booking-modification` | Extending stay, changing dates, adding nights, changing guest count, unit swaps. |
| `sop-booking-confirmation` | Verifying reservation exists, checking booking status/details. |
| `sop-booking-cancellation` | Cancel requests, cancellation policy questions. |
| `payment-issues` | Payment failures, refund requests, receipts, billing disputes or an invoice. |
| `sop-long-term-rental` | Monthly rental inquiries, corporate stays, stays over 3 weeks. |
| `property-info` | Property details: bedrooms, bathrooms, floor, parking, pool, gym, address, neighborhood, all standard amenities/features. |
| `pre-arrival-logistics` | Arrival coordination, compound instructions or directions. |
| `sop-property-viewing` | Property tours, photo/video requests, filming permission. |
| `post-stay-issues` | Lost items after checkout, post-stay complaints, damage deposit. |
| `local-recommendations` | Nearby places, restaurants, pharmacy, mall, ATM. |
| `property-description` | Listing narrative only — neighborhood, area vibe, compound overview. |
| `none` | Simple greeting, thank you, acknowledgment. |
| `escalate` | Safety concern, legal issue, billing dispute, anything needing immediate manager attention. |

---

## SOP Content by Booking Status

### `sop-cleaning`

**INQUIRY**:
> Extra cleaning is available during their stay. Don't schedule, their booking has not been accepted yet. Reassure cleaning services are available on request.

**CONFIRMED**:
> Extra cleaning is available during their stay. Don't schedule, guest has not checked in yet. Reassure cleaning services are available on request.

**CHECKED_IN**:
> Extra Cleaning is available during working hours only (10am–5pm). Recurring cleaning is OK. If the guest mentions anything that the unit was not cleaned, apologies and escalate and schedule booking during working hours.

---

### `sop-amenity-request`

**INQUIRY**:
> Guest asks about available amenities or features. Check the amenities listed in your context (AVAILABLE AMENITIES and ON REQUEST AMENITIES blocks). Confirm what is available. Don't discuss delivery or scheduling — the guest is deciding whether to book.
>
> Uses: `{ON_REQUEST_AMENITIES}`

**CONFIRMED**:
> Guest asks about amenities for their upcoming stay. Confirm availability and assure the amenity will be ready for their arrival. Don't schedule delivery — they haven't checked in yet.
>
> Uses: `{ON_REQUEST_AMENITIES}`

**CHECKED_IN**:
> Guest requests an amenity to be delivered. Check the ON REQUEST AMENITIES in your context.
> - Item listed → confirm availability and ask for preferred delivery time during working hours (10am–5pm). Do NOT escalate yet — wait for guest to confirm time, THEN escalate as "scheduled"
> - Item NOT listed → say "Let me check on that" → escalate as "info_request"
>
> Uses: `{ON_REQUEST_AMENITIES}`

---

### `sop-maintenance`

**DEFAULT** (all statuses):
> Broken or malfunctioning items: Acknowledge the problem, assure guest someone will look into it and that you informed the manager, and escalate immediately.
> **All maintenance/technical issues → urgency: "immediate"**

---

### `sop-wifi-doorcode`

**INQUIRY**:
> Confirm WiFi is available at the property. Reassure that access details will be provided after check-in — the guest is not yet booked.

**CONFIRMED**:
> Uses: `{ACCESS_CONNECTIVITY}`
> Confirm WiFi is available at the property, and its self check-in.
> If there is an issue with the door code apologies and escalate immediately, this is a big issue and needs sorting right away.

**CHECKED_IN**:
> Uses: `{ACCESS_CONNECTIVITY}`
> If there is an issue with the Wifi apologies and escalate.
> If there is an issue with the door code apologies and escalate immediately, this is a big issue and needs sorting right away.

---

### `sop-visitor-policy`

**INQUIRY**:
> Family-only property — only immediate family members allowed as visitors. Non-family visitors are not allowed. Share the policy upfront.

**CONFIRMED / CHECKED_IN**:
> - ONLY immediate family members allowed as visitors
> - Guest must send visitor's passport through the chat
> - Family names must match guest's family name
> - Collect passport image → escalate for manager verification
> - Non-family visitors (friends, colleagues, etc.) = NOT allowed
> - Any pushback on this rule → escalate as immediate

---

### `sop-early-checkin`

**INQUIRY**:
> Standard check-in is 3:00 PM. Mention this and note that early check-in availability depends on prior bookings.

**CONFIRMED**:
> Standard check-in: 3:00 PM. Back-to-back bookings mean early check-in can only be confirmed 2 days before.
> - **More than 2 days before check-in:** Do NOT escalate. Tell guest: "We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."
> - **Within 2 days of check-in:** Check the AVAILABILITY CHECK RESULT section. If back-to-back booking detected, tell guest early check-in is not available. If no back-to-back, tell guest you'll check with the manager → escalate as "info_request"
> - **Never confirm early check-in yourself.**

**CHECKED_IN**:
> *(empty — not applicable)*

---

### `sop-late-checkout`

**INQUIRY**:
> Standard checkout is 11:00 AM. Mention this and note that late checkout may be possible depending on next booking.

**CONFIRMED**:
> Standard checkout is 11:00 AM. Can only confirm 2 days before checkout date.

**CHECKED_IN**:
> Standard check-out: 11:00 AM. Back-to-back bookings mean late checkout can only be confirmed 2 days before.
> - **More than 2 days before checkout:** Do NOT escalate. Tell guest: "We can only confirm late checkout 2 days before your date since there may be guests checking in. We'll let you know closer to the date."
> - **Within 2 days of checkout:** Tell guest you'll check → escalate as "info_request"
> - **Never confirm late checkout yourself.**

---

### `sop-complaint`

**DEFAULT** (all statuses):
> Acknowledge the complaint with genuine empathy. Do NOT be defensive or dismissive.
> - Cleanliness complaints → offer immediate cleaning (waive $20 fee) and escalate as immediate
> - Noise complaints → acknowledge and escalate as immediate
> - Review threats or requests to speak to manager → acknowledge frustration, escalate as immediate
> - Property-quality complaints → escalate as immediate with full details
> - General dissatisfaction → empathize, ask for specifics, escalate as immediate
> - Never offer refunds, discounts, or compensation yourself.

---

### `sop-booking-inquiry`

**DEFAULT** (all statuses):
> Ask: dates, number of guests, any preferences. Check availability. If search tool found matching properties, present them with booking links from tool results. If no booking links available, list properties by name and escalate to manager. Never confirm a booking yourself. For urgent same-day requests, escalate as immediate.

---

### `pricing-negotiation`

**DEFAULT** (all statuses):
> NEVER offer discounts, special rates, or price matches yourself. Acknowledge and push back. If guest booked more than 3 weeks, escalate as info_request. Don't apologize for pricing. If you escalate, tell guest "I requested an additional discount from the manager."

---

### `sop-booking-modification`

**INQUIRY**:
> Acknowledge the change request and escalate to manager with new details. Never confirm changes yourself.

**CONFIRMED**:
> Acknowledge the request. NEVER confirm modifications yourself. Escalate as info_request with: current booking details, requested changes, and reason. For date changes within 48 hours of check-in, escalate as immediate.

**CHECKED_IN**:
> Guest wants to extend current stay or change dates. Acknowledge. Check if extend-stay tool is available to check availability and pricing. Escalate to manager with details. Never confirm modifications yourself.

---

### `sop-booking-confirmation`

**DEFAULT** (all statuses):
> Check reservation details and confirm what you can see — dates, unit, guest count. If booking isn't in your system, let them know you'll check with the team. For guests claiming they booked but no record found, escalate as immediate.

---

### `sop-booking-cancellation`

**DEFAULT** (all statuses):
> Acknowledge the request. NEVER cancel bookings yourself. Escalate as booking-cancellation. For cancellation policy questions, escalate as info_request — policies vary by platform. For refund-after-cancellation, also tag with payment-issues.

---

### `payment-issues`

**DEFAULT** (all statuses):
> NEVER process payments, confirm receipt, or authorize refunds. Payment link issues → escalate as immediate. Receipt/invoice requests → escalate as info_request. Billing disputes/refund requests → escalate as immediate. Deposit return questions → escalate as info_request. Inform guest you have notified the manager.

---

### `sop-long-term-rental`

**DEFAULT** (all statuses):
> Ask: duration, move-in date, number of guests, preferences. Share standard nightly rate if known, but note monthly rates need manager approval. Escalate as long-term-rental. Tell guest "I will inform the manager for additional discount." Never quote monthly rates yourself.

---

### `property-info`

**DEFAULT** (all statuses):
> Answer from property description and amenities. When guest lists multiple requirements, also call search_available_properties. If this property is best match, pitch it confidently. Only suggest alternatives if they genuinely offer something this property lacks. If info not in your knowledge, escalate as info_request.
>
> Uses: `{PROPERTY_DESCRIPTION}`, `{AVAILABLE_AMENITIES}`

---

### `pre-arrival-logistics`

**INQUIRY**:
> *(empty — not applicable)*

**CONFIRMED / CHECKED_IN**:
> Share property address and location. If guest asks for compound instructions, tell them to share apartment number, building number, and names with gate security. The property is self check-in.

---

### `sop-property-viewing`

**DEFAULT** (all statuses):
> Recommend that photos are available online. If wants videos, escalate to manager.

---

### `post-stay-issues`

**DEFAULT** (all statuses):
> Lost items: ask for description, escalate as immediate. Damage deposit: escalate as info_request. Post-stay complaints: acknowledge with empathy, escalate as immediate. Never promise items will be found or deposits returned.

---

### `local-recommendations`

**DEFAULT** (all statuses):
> You do NOT have local area knowledge. Do NOT guess locations, distances, or directions. Acknowledge the question, escalate as info_request.

---

### `property-description`

**DEFAULT** (all statuses):
> Uses: `{PROPERTY_DESCRIPTION}`

---

### `none`

> Simple greeting, thank you, acknowledgment, or message fully answered by system knowledge.

---

### `escalate`

> Safety concern, legal issue, billing dispute requiring human, or anything needing immediate manager attention.
