# Data Model: Status-Aware SOP Variants

## New Prisma Models

### SopDefinition

One record per SOP category per tenant. Owns the tool description and variant collection.

| Field | Type | Notes |
|-------|------|-------|
| id | String (UUID) | Primary key |
| tenantId | String | FK to Tenant |
| category | String | e.g., "sop-amenity-request" (unique per tenant) |
| toolDescription | String (Text) | Lean description for AI classification tool schema |
| enabled | Boolean | Whether this SOP category is active (default: true) |
| createdAt | DateTime | |
| updatedAt | DateTime | Auto-updated |

**Constraints**: `@@unique([tenantId, category])`, `@@index([tenantId])`

### SopVariant

Status-specific content for an SOP. Up to 4 variants per SOP (DEFAULT + 3 statuses).

| Field | Type | Notes |
|-------|------|-------|
| id | String (UUID) | Primary key |
| sopDefinitionId | String | FK to SopDefinition |
| status | String | 'DEFAULT', 'INQUIRY', 'CONFIRMED', or 'CHECKED_IN' |
| content | String (Text) | The procedure text for this variant |
| enabled | Boolean | Whether this variant is active (default: true) |
| createdAt | DateTime | |
| updatedAt | DateTime | |

**Constraints**: `@@unique([sopDefinitionId, status])`

### SopPropertyOverride

Property-level override for an SOP variant. Takes precedence over the tenant's global variant.

| Field | Type | Notes |
|-------|------|-------|
| id | String (UUID) | Primary key |
| sopDefinitionId | String | FK to SopDefinition |
| propertyId | String | FK to Property |
| status | String | 'DEFAULT', 'INQUIRY', 'CONFIRMED', or 'CHECKED_IN' |
| content | String (Text) | Property-specific procedure text |
| enabled | Boolean | |
| createdAt | DateTime | |
| updatedAt | DateTime | |

**Constraints**: `@@unique([sopDefinitionId, propertyId, status])`

## Resolution Logic

```
getSopContent(tenantId, category, reservationStatus, propertyId?):
  1. Check SopPropertyOverride(sopDefId, propertyId, status) → if enabled, return content
  2. Check SopPropertyOverride(sopDefId, propertyId, 'DEFAULT') → if enabled, return content
  3. Check SopVariant(sopDefId, status) → if enabled, return content
  4. Check SopVariant(sopDefId, 'DEFAULT') → if enabled, return content
  5. Return '' (empty — AI responds from general knowledge)
```

## Seed Data

22 SopDefinition records created per tenant on first access:
- 20 operational SOPs + none + escalate
- Tool descriptions from current SOP_TOOL_DEFINITION enum descriptions
- DEFAULT variant seeded with current SOP_CONTENT for each category
- 8 SOPs get additional INQUIRY/CONFIRMED/CHECKED_IN variants with differentiated content
- 12 SOPs get DEFAULT only (same content for all statuses)

## No Schema Changes to Existing Models

AiApiLog.ragContext gets one additional field: `sopVariantStatus: string` (which variant was actually used).
