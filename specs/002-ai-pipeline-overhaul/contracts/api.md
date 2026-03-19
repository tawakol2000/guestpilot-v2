# API Contracts: AI Pipeline Overhaul

## New Endpoints

### GET /api/ai-pipeline/accuracy
**Auth**: Required (JWT)
**Query**: `?period=7d|30d` (default: 30d)
**Response 200**:
```json
{
  "overall": { "correct": 40, "total": 50, "accuracy": 0.80 },
  "emptyLabelRate": 0.08,
  "perCategory": [
    { "category": "sop-maintenance", "correct": 12, "total": 14, "accuracy": 0.857 }
  ],
  "selfImprovement": {
    "totalActive": 87,
    "bySource": { "manual": 10, "llm-judge": 42, "tier2-feedback": 30, "gap-analysis": 5 },
    "addedThisPeriod": 23
  },
  "judgeMode": "evaluate_all",
  "period": "30d"
}
```

### POST /api/knowledge/gap-analysis
**Auth**: Required (JWT)
**Body**: None (uses last 30 days of pipeline data)
**Response 200**:
```json
{
  "emptyLabelMessages": 17,
  "underrepresentedCategories": [
    { "category": "sop-long-term-rental", "count": 5 }
  ],
  "languageDistribution": { "ar": 42, "en": 28, "other": 3 },
  "suggestedExamples": 25,
  "message": "Generated 25 suggested examples. Review in classifier examples UI."
}
```
**Side effect**: Creates ClassifierExample records with
`active: false, source: 'gap-analysis'`

### POST /api/ai-pipeline/snapshot
**Auth**: Required (JWT)
**Body**: None
**Response 200**: `text/markdown` — the snapshot content
**Side effect**: Writes `.specify/memory/pipeline-snapshot.md`

### POST /api/knowledge/classifier-examples/:id/approve
**Auth**: Required (JWT)
**Response 200**: `{ id, active: true }`
**Side effect**: Sets `active: true`, triggers classifier reinit

### POST /api/knowledge/classifier-examples/:id/reject
**Auth**: Required (JWT)
**Response 200**: `{ deleted: true }`
**Side effect**: Deletes the record

### POST /api/knowledge/batch-classify
**Auth**: Required (JWT)
**Body**:
```json
{
  "messages": ["message1", "message2", ...],
  "voteThreshold": 0.25
}
```
**Response 200**:
```json
{
  "results": [
    {
      "message": "message1",
      "labels": ["sop-maintenance"],
      "topSimilarity": 0.82,
      "method": "knn_vote"
    }
  ],
  "threshold": 0.25,
  "emptyLabelCount": 3,
  "totalMessages": 50
}
```

## Modified Endpoints

### PUT /api/tenant-config
**Added field**: `judgeMode: "evaluate_all" | "sampling"`
**Validation**: Must be one of the two values
**Default**: `"evaluate_all"`

### GET /api/ai-pipeline/stats
**No changes** — existing 24h stats endpoint stays as-is

### GET /api/ai-pipeline/feed
**No changes** — existing feed endpoint stays as-is
