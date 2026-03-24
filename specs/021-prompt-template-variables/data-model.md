# Data Model: Prompt Template Variables

## No Schema Changes Required

This feature uses existing data structures. No Prisma migration needed.

## Existing Models Used

### TenantAiConfig (existing)

Stores system prompts that will now contain `{VARIABLE}` references:
- `systemPromptCoordinator: String` — coordinator prompt with variable placeholders
- `systemPromptScreening: String` — screening prompt with variable placeholders
- `systemPromptVersion: Int` — bumped on migration

### Property (existing)

Stores per-listing variable overrides in existing JSON field:
- `customKnowledgeBase: Json` — existing field, gains new key:

```json
{
  "variableOverrides": {
    "PROPERTY_GUEST_INFO": {
      "customTitle": "Palm Residence - Unit 101",
      "notes": "VIP unit — always offer welcome basket"
    },
    "AVAILABLE_AMENITIES": {
      "customTitle": "What This Apartment Has"
    }
  },
  "amenityClassifications": { ... },
  "summarizedDescription": "...",
  "originalDescription": "..."
}
```

## New Code-Level Entities

### TemplateVariable (in-memory registry, not a DB model)

```
{
  name: string              // e.g., "CONVERSATION_HISTORY"
  description: string       // "All prior guest/agent messages"
  essential: boolean        // true = auto-appended if missing
  agentScope: string[]      // ["coordinator", "screening"] or subset
  propertyBound: boolean    // true = supports per-listing customization
}
```

### Variable Registry (8 variables)

| Name | Essential | Agent Scope | Property Bound |
|------|-----------|-------------|----------------|
| CONVERSATION_HISTORY | yes | both | no |
| PROPERTY_GUEST_INFO | yes | both | yes |
| AVAILABLE_AMENITIES | no | both | yes |
| ON_REQUEST_AMENITIES | no | both | yes |
| OPEN_TASKS | no | coordinator | no |
| CURRENT_MESSAGES | yes | both | no |
| CURRENT_LOCAL_TIME | no | both | no |
| DOCUMENT_CHECKLIST | no | coordinator | yes |

### Empty State Defaults

| Variable | Empty State Text |
|----------|-----------------|
| CONVERSATION_HISTORY | "No previous messages." |
| PROPERTY_GUEST_INFO | "No property data available." |
| AVAILABLE_AMENITIES | (omit block entirely — no header, no content) |
| ON_REQUEST_AMENITIES | (omit block entirely) |
| OPEN_TASKS | "No open tasks." |
| CURRENT_MESSAGES | (never empty — always has at least one message) |
| CURRENT_LOCAL_TIME | (never empty — always computed) |
| DOCUMENT_CHECKLIST | (omit block entirely — only shown when checklist exists) |

### Preserved Keys for Hostaway Resync

Add `variableOverrides` to the `USER_MANAGED_KEYS` array in both:
- `backend/src/services/import.service.ts`
- `backend/src/routes/properties.ts`
