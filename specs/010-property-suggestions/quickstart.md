# Quickstart: Cross-Sell Property Suggestions

**Feature**: 010-property-suggestions
**Date**: 2026-03-21

## Prerequisites

- Backend running (`npm run dev` in `backend/`)
- At least 2 properties imported for the same tenant (with different amenities)
- Hostaway API credentials configured (for availability checks)
- At least 1 active reservation on a property

## Quick Validation Steps

### 1. Verify listing URLs are imported

After deploying, re-import properties to capture listing URLs:
```
POST /api/import { listingsOnly: true }
```

Check a property's knowledge base:
```
GET /api/properties/:id
```

Look for `airbnbListingUrl`, `bookingEngineUrl` in `customKnowledgeBase`.

### 2. Test the tool via live conversation

Send a guest message asking about a missing amenity:
```
"Does this apartment have a pool?"
```

**Expected behavior**:
- AI detects the property doesn't have a pool (from property info in context)
- AI calls `search_available_properties` tool with `{ amenities: ["pool"] }`
- Backend searches tenant properties with "pool" in amenities
- Backend checks Hostaway availability for guest's dates
- AI responds with: acknowledgment + 1-3 matching properties with links

### 3. Check the pipeline log

In the dashboard, go to **Pipeline** or **AI Logs** and check the latest entry:
- `ragContext.toolUsed` should be `true`
- `ragContext.toolName` should be `"search_available_properties"`
- `ragContext.toolResults` should show the properties returned

### 4. Test follow-up conversation

After getting suggestions, send:
```
"Do any of those have parking too?"
```

**Expected**: AI refines search or filters previous results.

### 5. Test property switch escalation

Send:
```
"I'd like to switch to the Beach Villa"
```

**Expected**: AI confirms and creates a Task with:
- title: `property-switch-request`
- urgency: `scheduled`
- note containing: guest name, current property, target property, dates

Check in **Tasks** view in the dashboard.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| AI never calls the tool | Tool not added to `createMessage()` params | Check `tools` array is passed in `generateAndSendAiReply()` |
| Tool called but no results | Listing URLs not imported | Re-run import with `listingsOnly: true` |
| Tool returns 0 matches but properties exist | City mismatch or amenity string mismatch | Check `customKnowledgeBase.amenities` on target properties + city parsing |
| Wrong booking link shown | Channel not detected correctly | Check `reservation.channel` value |
| "Could not check availability" | Hostaway API credentials issue or rate limit | Check tenant's `hostawayApiKey` + Hostaway API logs |
| Response takes >5s | Hostaway API latency | Check if availability endpoint is slow; consider caching |
| Tool result not in AI logs | `ragContext` not extended | Check `toolUsed` key is written in `createMessage()` logging |

## Configuration

No new environment variables required. The feature uses existing:
- `ANTHROPIC_API_KEY` — for Claude tool use (same key, same model)
- Hostaway credentials — per-tenant, already in database

### Amenity Synonym Map

Located at `backend/src/config/amenity-synonyms.json`. Edit to add new amenity mappings:
```json
{
  "pool": ["pool", "swimming pool", "outdoor pool"],
  "wifi": ["wifi", "wi-fi", "internet"]
}
```

### Feature Toggle

The tool is always available to Claude but only fires when Claude decides it's relevant (`tool_choice: auto`). To disable cross-sell suggestions entirely:
- Remove the tool from the `tools` array passed to `createMessage()` (code change)
- Or add a tenant config toggle (future enhancement)
