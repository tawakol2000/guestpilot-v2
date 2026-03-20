# Data Model: Remove KNN Legacy & Complete LR Migration

**Branch**: `005-remove-knn-legacy`
**Date**: 2026-03-19

---

## No Schema Changes

This feature does not modify the database schema. All changes are in application code and configuration.

---

## Interface Changes

### ClassificationResult (classifier.service.ts)

No structural changes. The interface already has both LR and KNN fields. The change is in **which fields downstream code uses for decisions**:

| Field | Source | Used for decisions (before) | Used for decisions (after) |
|-------|--------|---------------------------|--------------------------|
| `confidence` | LR sigmoid | Tier routing in rag.service | Tier routing, judge skip, reinforcement |
| `tier` | LR sigmoid | Three-tier routing | Three-tier routing (unchanged) |
| `topSimilarity` | KNN diagnostic | Judge skip, reinforcement, tier compat | Logging/observability ONLY |
| `knnDiagnostic` | KNN diagnostic | Pipeline display | Pipeline display (unchanged) |
| `topK`, `neighbors` | KNN diagnostic | Judge neighbor support | Logging/observability ONLY |

### Topic State Cache (topic-state.service.ts)

**Modified function signature**:

`getReinjectedLabels()` gains an optional `messageEmbedding` parameter:

Before: `getReinjectedLabels(conversationId: string, messageText: string)`
After: `getReinjectedLabels(conversationId: string, messageText: string, messageEmbedding?: number[])`

**New behavior**: When `messageEmbedding` is provided and centroids are available, computes cosine similarity between the embedding and the active topic's centroid. If below threshold → topic switch detected.

### Configuration (topic_state_config.json)

**New field** in `global_settings`:

```json
{
  "global_settings": {
    "centroid_switch_threshold": 0.60,
    "centroid_min_examples": 3
  }
}
```

- `centroid_switch_threshold`: Cosine similarity below which a topic switch is detected (default 0.60)
- `centroid_min_examples`: Minimum training examples per category before trusting centroid distance (default 3)

### Classifier State Access

`topic-state.service.ts` needs read access to centroids from the classifier state. New export from `classifier.service.ts`:

```typescript
export function getCentroids(): Record<string, number[]> | null
```

Returns the current centroids map or null if not loaded.

---

## Data Flow Change: Centroid Topic Switch

```
Guest sends contextual follow-up (e.g., "what's the WiFi?")
    ↓
Tier 1 classifies as "contextual" → triggers Tier 3
    ↓
getReinjectedLabels(convId, "what's the WiFi?", embedding)
    ↓
1. Check keyword switch → no keywords found
2. Check centroid distance:
   - Active topic: "sop-cleaning"
   - Get centroid for "sop-cleaning" from classifier state
   - Compute cosine(embedding, cleaning_centroid)
   - Result: 0.35 (very far from cleaning) → TOPIC SWITCH
3. Clear cache, return empty labels → Tier 1 re-classifies fresh
    ↓
Re-classification: "sop-wifi-doorcode" (correct)
```
