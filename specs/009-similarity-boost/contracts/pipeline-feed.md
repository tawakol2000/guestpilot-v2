# Contract: Pipeline Feed Endpoint

**Endpoint**: `GET /api/ai-pipeline/feed?limit=50&offset=0`
**File**: `backend/src/routes/ai-pipeline.ts`

## Changes

The `pipeline` object in each `PipelineFeedEntry` gains new fields for boost and description data. All new fields are optional (absent in historical records).

## Response Schema (updated fields only)

```typescript
interface PipelineFeedEntry {
  pipeline: {
    // ... existing fields unchanged ...

    // Existing (renamed display label, same data)
    classifierTopSim: number | null;      // Now labeled "Similarity Boost" in UI
    classifierMethod: string | null;      // New values: 'lr_boost', 'lr_desc'

    // NEW: Boost decision
    boostApplied: boolean | null;         // true if KNN override activated
    boostSimilarity: number | null;       // KNN top similarity when boost applied
    boostLabels: string[] | null;         // Labels from boost (usually 1)
    originalLrConfidence: number | null;  // LR confidence before boost override
    originalLrLabels: string[] | null;    // LR labels before boost override

    // NEW: Description features
    descriptionFeaturesActive: boolean | null;  // true if augmented weights loaded
    topDescriptionMatches: Array<{              // Top 3 description similarities
      label: string;
      similarity: number;
    }> | null;
  };

  evaluation: {
    // ... existing fields unchanged ...
  };
}
```

## Backward Compatibility

- New fields are `null` for records created before this feature
- Frontend must handle null/undefined for all new fields (existing pattern: optional chaining)
- No breaking changes to existing fields

## New Endpoint: Description Similarity Matrix

**Endpoint**: `GET /api/classifier/description-matrix`
**Auth**: Required (JWT)
**Purpose**: Admin diagnostic — returns cross-class description similarity matrix

### Response

```typescript
interface DescriptionMatrixResponse {
  matrix: Array<{
    category1: string;
    category2: string;
    similarity: number;
    flagged: boolean;       // true if > 0.70
  }>;
  flaggedCount: number;     // pairs exceeding 0.70 threshold
  totalPairs: number;       // C(20,2) = 190 category pairs
  timestamp: string;        // ISO 8601
}
```

### Error States

- `503` — Classifier not initialized or descriptions not loaded
- `401` — Missing/invalid JWT
