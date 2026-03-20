# Data Model: Similarity Boost + Description-Enhanced Classification

**Date**: 2026-03-20 | **Branch**: `009-similarity-boost`

## Schema Changes

**No Prisma schema changes required.** The `ClassifierWeights.weights` field is `Json` type, which flexibly accommodates the augmented weight format. New ragContext fields are stored in the existing `AiApiLog.ragContext` Json field.

---

## New File: `sop_descriptions.json`

```typescript
// backend/src/config/sop_descriptions.json
interface SopDescriptionsFile {
  version: string;                    // e.g., "1.0.0"
  categories: Record<string, {
    broad: boolean;                   // true → 3 EN + 3 AR descriptions
    descriptions: {
      en: string[];                   // 1 or 3 natural language paragraphs
      ar: string[];                   // 1 or 3 Arabic (MSA) paragraphs
    };
  }>;
}
```

**Constraints**:
- 20 categories (all except `non-actionable` and `contextual`)
- Narrow categories: exactly 1 EN + 1 AR description
- Broad categories (5): exactly 3 EN + 3 AR descriptions
- Each description: 2-4 sentences, natural language
- No negation phrases ("this is NOT about...")
- Cross-class similarity < 0.70 (validated by diagnostic)

---

## Modified Interface: `ClassificationResult`

**File**: `backend/src/services/classifier.service.ts`

```typescript
interface ClassificationResult {
  // LR decision (primary)
  labels: string[];
  confidence: number;
  tier: 'high' | 'medium' | 'low';
  topCandidates: Array<{ label: string; confidence: number }>;
  method: string;                     // 'lr_sigmoid' | 'lr_boost' | 'lr_desc' | 'embedding_failed' | 'classifier_not_initialized'

  // Similarity Boost (renamed from knnDiagnostic)
  similarityBoost: {
    topSimilarity: number;
    method: string;                   // 'similarity_boost'
    labels: string[];
    neighbors: Array<{
      text: string;
      labels: string[];
      similarity: number;
    }>;
  };

  // Boost decision metadata (NEW)
  boostApplied: boolean;              // true if KNN override activated
  boostSimilarity: number;            // KNN top similarity when boost applied (0 otherwise)
  boostLabels: string[];              // KNN labels when boost applied ([] otherwise)
  originalLrConfidence: number;       // LR confidence before any boost override
  originalLrLabels: string[];         // LR labels before boost override

  // Description feature metadata (NEW)
  descriptionFeaturesActive: boolean; // true if augmented weights loaded
  topDescriptionMatches: Array<{      // Top 3 description similarities
    label: string;
    similarity: number;
  }>;

  // Backward-compat surface
  topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
  neighbors: Array<{ labels: string[]; similarity: number }>;
  tokensUsed: number;
  topSimilarity: number;
  queryEmbedding?: number[];
}
```

**Changes from current**:
- `knnDiagnostic` → `similarityBoost` (rename)
- `method` values: added `lr_boost` (boost override), `lr_desc` (description-enhanced LR)
- Added: `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels`
- Added: `descriptionFeaturesActive`, `topDescriptionMatches`

---

## Modified Interface: `ClassifierState`

**File**: `backend/src/services/classifier.service.ts`

```typescript
interface ClassifierState {
  // Existing fields (unchanged)
  examples: TrainingExample[];
  embeddings: number[][];
  initDurationMs: number;
  lrWeights: { classes: string[]; coefficients: number[][]; intercepts: number[] } | null;
  lrThresholds: { global: number; perCategory: Record<string, number> } | null;
  centroids: Record<string, number[]>;
  calibration: { crossValAccuracy: number; perCategoryAccuracy: Record<string, number> } | null;
  trainedAt: string | null;

  // NEW: Description embeddings
  descriptionEmbeddings: Map<string, number[][]> | null;  // category → array of embeddings (EN + AR variants)
  descriptionCategories: string[] | null;                   // Sorted category names (canonical order for feature vector)
  descriptionFeaturesActive: boolean;                       // true if weights match augmented dimension
}
```

---

## Modified: `ragContext` (AiApiLog.ragContext JSON)

**New fields** (additive — old records unaffected):

```typescript
interface RagContext {
  // ... existing fields unchanged ...

  // NEW: Similarity Boost fields
  boostApplied?: boolean;
  boostSimilarity?: number;
  boostLabels?: string[];
  originalLrConfidence?: number;
  originalLrLabels?: string[];

  // NEW: Description feature fields
  descriptionFeaturesActive?: boolean;
  topDescriptionMatches?: Array<{
    label: string;
    similarity: number;
  }>;
}
```

---

## Modified: `ClassifierWeights.weights` JSON

**Augmented format** (backward-compatible — old format still loadable):

```json
{
  "classes": ["pre-arrival-logistics", "pricing-negotiation", "..."],
  "coefficients": [["... 1044 floats per class ..."]],
  "intercepts": [0.123, -0.456, "..."],
  "centroids": { "sop-cleaning": ["... 1024 floats ..."] },
  "thresholds": { "global": 0.5, "perCategory": { "...": 0.45 } },
  "calibration": { "crossValAccuracy": 0.99, "perCategoryAccuracy": {} },
  "trainedAt": "2026-03-20T04:14:00Z",

  "featureSchema": {
    "embeddingDim": 1024,
    "descriptionDim": 20,
    "totalDim": 1044,
    "descriptionCategories": ["pre-arrival-logistics", "pricing-negotiation", "..."]
  },
  "descriptionEmbeddings": {
    "sop-amenity-request": {
      "en": [["... 1024 floats ..."], ["..."], ["..."]],
      "ar": [["... 1024 floats ..."], ["..."], ["..."]]
    },
    "sop-wifi-doorcode": {
      "en": [["... 1024 floats ..."]],
      "ar": [["... 1024 floats ..."]]
    }
  }
}
```

**New fields**:
- `featureSchema`: Documents the augmented feature vector structure. `descriptionCategories` is the alphabetically sorted list of 20 categories defining the order of the 20-dim description similarity vector.
- `descriptionEmbeddings`: Pre-computed embeddings for all descriptions, organized by category and language. Loaded at startup to avoid re-embedding. ~200KB total.

**Dimension detection** (FR-012b): `coefficients[0].length === 1024` → old weights (plain LR), `=== 1044` → augmented weights (description-enhanced LR).

---

## Modified: `topic_state_config.json` global_settings

**New fields** (additive):

```json
{
  "global_settings": {
    "default_decay_minutes": 30,
    "max_reinject_count": 5,
    "centroid_switch_threshold": 0.60,
    "centroid_min_examples": 3,

    "boost_similarity_threshold": 0.80,
    "boost_min_agreement": 3,
    "lr_hard_cap": 3,
    "lr_gap_filter": 0.10
  }
}
```

---

## Entity Relationship Summary

```
sop_descriptions.json (source text)
  ↓ embedded at startup
ClassifierState.descriptionEmbeddings (runtime memory)
  ↓ stored after training
ClassifierWeights.weights.descriptionEmbeddings (DB persistence)
  ↓ loaded at cold start
ClassifierState.descriptionEmbeddings (restored)

Classification flow:
  Message → embedText() → queryEmbedding (1024-dim)
    → runSimilarityDiagnostic() → similarityBoost (top-3 neighbors)
    → boost check: sim ≥ 0.80 + 3/3 agree? → YES → lr_boost
    → NO → computeDescriptionSimilarities() → 20-dim vector
         → concat [1024, 20] → 1044-dim augmented vector
         → classifyWithLR() → apply gap filter → apply hard cap
         → ClassificationResult
```
