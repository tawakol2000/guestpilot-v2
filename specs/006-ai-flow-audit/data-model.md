# Data Model: AI Flow System Audit & Fix

**Branch**: `006-ai-flow-audit`
**Date**: 2026-03-20

---

## Schema Change 1: Unique Constraint on hostawayMessageId

### Problem
The `Message` model has no unique constraint on `hostawayMessageId`. The dedup check uses `findFirst` (TOCTOU race), and the P2002 catch at line 386 of webhooks.controller.ts is dead code because no constraint exists to violate.

### Before
```prisma
model Message {
  hostawayMessageId  String  @default("")
  // ... no unique constraint
  @@index([conversationId])
  @@index([tenantId])
}
```

### After
```prisma
model Message {
  hostawayMessageId  String  @default("")
  // ...
  @@unique([conversationId, hostawayMessageId])
  @@index([conversationId])
  @@index([tenantId])
}
```

**Note**: The unique constraint is on `(conversationId, hostawayMessageId)` — not just `hostawayMessageId` alone — because empty `hostawayMessageId` values exist across conversations and would violate a simple unique constraint. Messages within the same conversation must have unique Hostaway IDs.

**Pre-migration**: Must handle existing empty `hostawayMessageId` values. Generate unique placeholder values for existing empty records before applying the constraint.

---

## Interface Changes

### getReinjectedLabels() Return Type

**Before:**
```typescript
{
  labels: string[];
  reinjected: boolean;
  topicSwitchDetected: boolean;
}
```

**After:**
```typescript
{
  labels: string[];
  reinjected: boolean;
  topicSwitchDetected: boolean;
  centroidSimilarity: number | null;    // NEW: cosine sim used for switch decision
  centroidThreshold: number | null;     // NEW: threshold that was applied
  switchMethod: 'keyword' | 'centroid' | null; // NEW: which method detected the switch
}
```

### ragContext (stored in AiApiLog)

**New fields added:**
```typescript
{
  // Existing fields...
  escalationSignals: string[];          // Already exists
  escalationSignalsInjected: boolean;   // NEW: whether signals were added to prompt
  centroidSimilarity: number | null;    // NEW: topic switch centroid score
  centroidThreshold: number | null;     // NEW: threshold used
  switchMethod: string | null;          // NEW: 'keyword' | 'centroid' | null
  chunksFull: Array<{                   // NEW: full chunk content (not truncated)
    category: string;
    content: string;                    // Full text, not substring(0, 200)
    similarity: number;
    sourceKey: string;
  }>;
}
```

### Pipeline Feed Response

**New fields in pipeline.ts feed:**
```typescript
{
  pipeline: {
    // Existing fields...
    classifierConfidence: number | null;   // Already added (77a97dc)
    confidenceTier: string | null;         // Already added (77a97dc)
    escalationSignals: string[];           // Already exists
    llmOverride: object | null;            // NEW: LLM override data
    centroidSimilarity: number | null;     // NEW
    centroidThreshold: number | null;      // NEW
    switchMethod: string | null;           // NEW
  }
}
```

---

## No Other Schema Changes

All other fixes are code-only changes (no database migrations beyond the hostawayMessageId constraint).
