# API Contract Changes: SOP Tool Routing

## Endpoints REMOVED

All classifier-specific endpoints from `knowledge.ts` route:

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/knowledge/test-classify | Single message classification test |
| POST | /api/knowledge/classify-test | Detailed classification breakdown |
| POST | /api/knowledge/batch-classify | Batch classification test |
| GET | /api/knowledge/classifier-examples | List training examples |
| POST | /api/knowledge/classifier-examples | Add training example |
| DELETE | /api/knowledge/classifier-examples/:id | Delete training example |
| PATCH | /api/knowledge/classifier-examples/:id | Update example labels |
| POST | /api/knowledge/classifier-examples/:id/approve | Approve pending example |
| POST | /api/knowledge/classifier-examples/:id/reject | Reject example |
| GET | /api/knowledge/all-examples | Combined hardcoded + DB examples |
| POST | /api/knowledge/retrain-classifier | Retrain LR model |
| POST | /api/knowledge/classifier-reinitialize | Re-embed all examples |
| GET | /api/knowledge/training-distribution | Label balance stats |
| POST | /api/knowledge/generate-paraphrases | Synthetic example generation |
| GET | /api/classifier/description-matrix | Cross-class similarity diagnostic |

From `ai-config.ts` route:

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/ai-config/intent-prompt | Get Tier 2 intent extractor prompt |
| PUT | /api/ai-config/intent-prompt | Update Tier 2 prompt |

## Endpoints MODIFIED

### GET /api/knowledge/classifier-status → GET /api/knowledge/sop-status

**Before**:
```json
{
  "initialized": true,
  "exampleCount": 373,
  "sopChunkCount": 22,
  "classifierType": "lr_sigmoid",
  "lrAccuracy": 0.89,
  "tier1Mode": "active",
  "tier2Mode": "active",
  "tier3Mode": "active"
}
```

**After**:
```json
{
  "sopCategories": 22,
  "classificationMethod": "tool_use"
}
```

### GET /api/knowledge/classifier-thresholds → REMOVED

No thresholds to configure with tool-based classification.

### POST /api/knowledge/classifier-thresholds → REMOVED

No thresholds to configure.

### GET /api/knowledge/evaluation-stats → MODIFIED

**Before**:
```json
{
  "total": 500,
  "correct": 420,
  "incorrect": 80,
  "accuracy": 84,
  "judgeCost": 0.45,
  "autoFixed": 35,
  "avgConfidence": 0.72
}
```

**After**:
```json
{
  "total": 500,
  "highConfidence": 400,
  "mediumConfidence": 75,
  "lowConfidence": 25,
  "categoryDistribution": {
    "sop-maintenance": 45,
    "sop-amenity-request": 38,
    "none": 120,
    "...": "..."
  }
}
```

## Endpoints ADDED

### GET /api/knowledge/sop-classifications

Returns recent SOP tool classifications for the monitoring dashboard.

**Query params**: `?limit=50&offset=0&confidence=low`

**Response**:
```json
{
  "classifications": [
    {
      "id": "log-uuid",
      "timestamp": "2026-03-21T10:30:00Z",
      "guestMessage": "the dishwasher is broken",
      "categories": ["sop-maintenance"],
      "confidence": "high",
      "reasoning": "Guest reports broken appliance",
      "conversationId": "conv-uuid"
    }
  ],
  "total": 500
}
```

## Endpoints UNCHANGED

All property knowledge endpoints in `knowledge.ts`:
- GET/PATCH/DELETE /api/knowledge/chunks
- GET /api/knowledge/chunk-stats
- POST /api/knowledge/gap-analysis
- GET /api/knowledge/tool-invocations

All AI config endpoints except intent-prompt:
- GET/PUT /api/ai-config
- POST /api/ai-config/test
- GET /api/ai-config/versions
- POST /api/ai-config/versions/:id/revert
- POST /api/ai-config/sandbox-chat
