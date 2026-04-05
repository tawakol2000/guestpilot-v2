# Contract: search_available_properties Tool Output

## Tool Interface (unchanged from AI's perspective)

The AI calls the tool with the same interface as before:

```json
{
  "amenities": ["garden", "fast internet", "gated compound", "play area", "washer"],
  "min_capacity": 3,
  "reason": "Guest requested specific amenities and 3BR+"
}
```

## Tool Output (new format)

```json
{
  "found": true,
  "count": 2,
  "properties": [
    {
      "name": "3-Bedroom Apartment, Silver Palm",
      "capacity": 5,
      "bedrooms": 3,
      "score": 9,
      "is_current_property": true,
      "label": "This is the property the guest is viewing",
      "met": ["garden", "fast internet", "gated compound", "play area", "washer", "3BR+", "near malls"],
      "unmet": ["dryer"],
      "note": "Strong match — gated compound with garden, playgrounds, near O1 Mall",
      "booking_link": null
    },
    {
      "name": "2-Bedroom Apartment, Lake View",
      "capacity": 4,
      "bedrooms": 2,
      "score": 5,
      "is_current_property": false,
      "label": null,
      "met": ["garden", "fast internet", "washer"],
      "unmet": ["gated compound", "play area", "3BR+", "near malls", "dryer"],
      "note": "Has garden and internet but only 2BR, not in a compound",
      "booking_link": "https://www.airbnb.com/rooms/1491201981720445611"
    }
  ],
  "dates_checked": "2026-04-15 to 2026-05-14",
  "city": "New Cairo",
  "current_property_matched": true
}
```

## Error Output

```json
{
  "found": false,
  "count": 0,
  "properties": [],
  "error": "Property scoring temporarily unavailable. Please answer from the property information above.",
  "should_escalate": false
}
```

## Key Differences from Previous Format

| Field | Before | After |
|-------|--------|-------|
| `score` | Not present | 0-10 semantic match score |
| `met` / `unmet` | Not present | Explicit requirement breakdown |
| `note` | Not present | Human-readable summary |
| `is_current_property` | Not present | Boolean flag |
| `label` | Not present | "This is the property the guest is viewing" for current |
| `booking_link` | Always present | null for current property |
| `amenities_matched` | Substring matches | Removed (replaced by `met`) |
| `suggested_message` | Pre-formatted AI response | Removed (AI crafts its own based on scores) |
| `highlights` | Top 4 amenities from CSV | Removed (replaced by `note`) |

## Nano Scoring Schema (internal — not exposed to AI)

The json_schema enforced on the nano scoring call:

```json
{
  "type": "object",
  "properties": {
    "scores": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": { "type": "integer" },
          "score": { "type": "integer" },
          "met": { "type": "array", "items": { "type": "string" } },
          "unmet": { "type": "array", "items": { "type": "string" } },
          "note": { "type": "string" }
        },
        "required": ["index", "score", "met", "unmet", "note"]
      }
    }
  },
  "required": ["scores"]
}
```
