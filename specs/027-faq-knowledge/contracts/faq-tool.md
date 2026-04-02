# Tool Contract: get_faq

## Tool Definition

```json
{
  "name": "get_faq",
  "description": "Retrieve FAQ entries for the current property. Call this BEFORE escalating an info_request when a guest asks a factual question about the property, local area, amenities, or policies. If the FAQ has an answer, use it directly instead of escalating.",
  "parameters": {
    "type": "object",
    "properties": {
      "category": {
        "type": "string",
        "enum": [
          "check-in-access", "check-out-departure", "wifi-technology",
          "kitchen-cooking", "appliances-equipment", "house-rules",
          "parking-transportation", "local-recommendations", "attractions-activities",
          "cleaning-housekeeping", "safety-emergencies", "booking-reservation",
          "payment-billing", "amenities-supplies", "property-neighborhood"
        ],
        "description": "FAQ category that best matches the guest's question"
      }
    },
    "required": ["category"]
  }
}
```

## Tool Output (Markdown)

### When entries exist:

```markdown
## FAQ: Local Recommendations

Q: Is there a gym nearby?
A: Yes, O1 Mall has a full gym — 1 minute walk from Building 8. Open 6AM-midnight daily.

Q: What's the nearest pharmacy?
A: Seif Pharmacy, 3 minutes walk from Building 8. Open 24/7.

Q: Any good restaurants nearby?
A: Ovio and Paul are in O1 Mall (1 min walk). For Egyptian food, Zooba is 5 minutes by car.
```

### When no entries exist:

```markdown
## FAQ: Local Recommendations

No FAQ entries for this category. Escalate to the manager if the guest needs this information.
```

## Resolution Logic

1. Fetch ACTIVE entries where `propertyId = current property` AND `category = requested`
2. Fetch ACTIVE entries where `propertyId IS NULL` (global) AND `category = requested`
3. Merge: property-specific entries first, then globals (skip globals that overlap with property entries by similar question text)
4. Format as Markdown Q&A
5. Increment `usageCount` and update `lastUsedAt` for each returned entry

## Side Effects

- Increments `usageCount` on each returned entry
- Updates `lastUsedAt` timestamp
- Logged in AiApiLog as a tool call (existing infrastructure)

---

# Updated Tool Output: get_sop (Markdown)

The existing `get_sop` tool output switches from JSON to Markdown:

### Before (JSON):
```json
{"categories":["early-checkin"],"content":"## Early Check-in\n\nINQUIRY status: Tell the guest..."}
```

### After (Markdown):
```markdown
## SOP: Early Check-in

**INQUIRY status:**
Tell the guest that early check-in can only be confirmed 2 days before arrival since there may be guests checking out...

**CONFIRMED status:**
Ask the guest what time they'd like to arrive. Use the check_extend_availability tool to verify...
```

Data-oriented tools (`check_extend_availability`, `search_available_properties`, `create_document_checklist`, `mark_document_received`) remain JSON.
