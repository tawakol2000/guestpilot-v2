# API Contracts: AI Engine Fix

## New Endpoints

### POST /api/knowledge/retrain-classifier
**Auth**: Required (JWT)
**Body**: None
**Response 200**:
```json
{
  "success": true,
  "exampleCount": 450,
  "classes": 20,
  "crossValAccuracy": 0.87,
  "globalThreshold": 0.65,
  "trainDurationMs": 12000,
  "message": "Classifier retrained: 450 examples, 20 classes, 87% CV accuracy"
}
```
**Response 500**:
```json
{
  "success": false,
  "error": "Python training failed: [details]"
}
```
**Side effects**:
- Embeds all active examples with Cohere (~10s)
- Runs Python sklearn training (~2s)
- Writes classifier-weights.json
- Atomically swaps ClassifierState

## Modified Endpoints

### GET /api/knowledge/classifier-status
**Added fields**:
```json
{
  "classifierType": "lr",
  "lrAccuracy": 0.87,
  "lastTrainedAt": "2026-03-19T12:00:00Z",
  "retrainAvailable": true,
  "exampleCount": 450,
  "sopChunkCount": 19
}
```

### GET /api/ai-pipeline/feed
**Modified per-entry data**:
- `classifierMethod`: "lr_softmax" (new engine) or "knn_vote"/"knn_rerank" (old engine)
- `classifierConfidence`: softmax confidence 0-1 (new engine) — replaces topSimilarity
- `confidenceTier`: "high" | "medium" | "low" (new engine only)
- `knnNeighbors`: still included for diagnostic display (both engines)
- `topicSwitchMethod`: "centroid" | "keyword" | null (new engine)
- `lmOverride`: { classifierPick, llmPick } if LLM overrode in medium tier (new engine)

### GET /api/knowledge/classifier-status
**Engine detection field** (used by frontend to auto-adapt):
```json
{
  "classifierType": "lr",
  "lrAccuracy": 0.87,
  "lastTrainedAt": "2026-03-19T12:00:00Z",
  "retrainAvailable": true,
  "exampleCount": 450,
  "sopChunkCount": 19,
  "confidenceTiers": {
    "highThreshold": 0.85,
    "lowThreshold": 0.55
  }
}
```
Old engine returns `"classifierType": "knn"` with no LR-specific fields.
Frontend checks this to show/hide LR-specific UI.

### POST /api/knowledge/batch-classify
**Modified response**:
```json
{
  "results": [{
    "message": "...",
    "labels": ["sop-maintenance"],
    "confidence": 0.92,
    "method": "lr_softmax",
    "knnTopSimilarity": 0.78,
    "knnNeighbors": [...]
  }],
  "threshold": 0.65,
  "emptyLabelCount": 2,
  "totalMessages": 50
}
```
