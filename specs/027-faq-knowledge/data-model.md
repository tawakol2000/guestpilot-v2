# Data Model: FAQ Knowledge System

## New Models

### FaqEntry

| Field | Type | Purpose |
|-------|------|---------|
| id | String (CUID) | Primary key |
| tenantId | String | Tenant scope (multi-tenancy) |
| propertyId | String? | null = global FAQ, non-null = property-specific |
| question | String | Canonical question text (5-50 words) |
| answer | String (Text) | Manager-approved answer (1-3 sentences) |
| category | String | One of 15 fixed categories |
| scope | Enum: GLOBAL / PROPERTY | Whether this FAQ applies to all properties or one |
| status | Enum: SUGGESTED / ACTIVE / STALE / ARCHIVED | Lifecycle status |
| source | Enum: MANUAL / AUTO_SUGGESTED | How the entry was created |
| usageCount | Int (default 0) | Times the AI used this entry in a response |
| lastUsedAt | DateTime? | Last time the AI referenced this entry |
| sourceConversationId | String? | Conversation that triggered the auto-suggestion (for context) |
| createdAt | DateTime | When the entry was created |
| updatedAt | DateTime | Last modification |

**Relations:**
- FaqEntry → Tenant (many-to-one, cascade delete)
- FaqEntry → Property (many-to-one, optional — null for global)
- FaqEntry → Conversation (many-to-one, optional — for auto-suggest source tracking)

**Indexes:**
- `@@index([tenantId, propertyId, status])` — main query: active FAQs for a property
- `@@index([tenantId, scope, status])` — global FAQs query
- `@@index([tenantId, category, status])` — category-based retrieval
- `@@unique([tenantId, propertyId, question])` — prevent exact duplicate questions per property

## Enums

```
enum FaqScope { GLOBAL PROPERTY }
enum FaqStatus { SUGGESTED ACTIVE STALE ARCHIVED }
enum FaqSource { MANUAL AUTO_SUGGESTED }
```

## FAQ Categories (Constants, Not DB)

```
FAQ_CATEGORIES = [
  'check-in-access',
  'check-out-departure',
  'wifi-technology',
  'kitchen-cooking',
  'appliances-equipment',
  'house-rules',
  'parking-transportation',
  'local-recommendations',
  'attractions-activities',
  'cleaning-housekeeping',
  'safety-emergencies',
  'booking-reservation',
  'payment-billing',
  'amenities-supplies',
  'property-neighborhood',
]
```

## State Transitions

```
SUGGESTED → ACTIVE      (manager approves)
SUGGESTED → ARCHIVED    (manager rejects)
SUGGESTED → [expired]   (4 weeks without action → auto-delete)
ACTIVE    → STALE       (90 days unused → auto-flag)
ACTIVE    → ARCHIVED    (manager archives)
STALE     → ACTIVE      (manager re-activates)
STALE     → ARCHIVED    (manager archives)
ARCHIVED  → ACTIVE      (manager restores)
```

## Key Queries

### get_faq Tool (AI retrieval)

```
Find all ACTIVE FaqEntries for a property + category:
  1. Property-specific: WHERE tenantId AND propertyId AND category AND status=ACTIVE
  2. Global: WHERE tenantId AND propertyId IS NULL AND category AND status=ACTIVE
  3. Merge: property entries override globals with same question topic
  4. Format as Markdown Q&A
```

### Auto-Suggest Dedup Check

```
Find existing ACTIVE entries with similar question:
  WHERE tenantId AND (propertyId OR propertyId IS NULL) AND status=ACTIVE
  Filter: first 100 chars of question match OR keyword overlap > 50%
```

### Staleness Check (scheduled or on-demand)

```
UPDATE FaqEntry SET status=STALE
  WHERE status=ACTIVE AND lastUsedAt < now() - 90 days
  (OR lastUsedAt IS NULL AND createdAt < now() - 90 days)
```

### Suggestion Expiry

```
DELETE FaqEntry
  WHERE status=SUGGESTED AND createdAt < now() - 28 days
```

## No Schema Changes to Existing Models

The FAQ system is self-contained. No modifications to Message, Conversation, Property, or Tenant models. The `tenantId` and `propertyId` foreign keys reference existing models.
