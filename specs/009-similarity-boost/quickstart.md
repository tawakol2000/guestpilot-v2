# Quickstart: Similarity Boost + Description-Enhanced Classification

**Branch**: `009-similarity-boost`

## Prerequisites

```bash
cd backend && npm install    # No new dependencies needed
cd frontend && npm install   # No new dependencies needed
```

Ensure environment variables are set:
- `COHERE_API_KEY` — required for description embedding at startup
- `DATABASE_URL` — required for weight persistence
- `ANTHROPIC_API_KEY` — required for AI pipeline

## Development Flow

### 1. Start with Existing Weights (Phase B — Boost + Cap only)

No retraining needed for the KNN boost and hard cap/gap filter. These work with existing 1024-dim weights.

```bash
cd backend && npm run dev
```

The classifier will:
- Load existing weights (1024-dim) → `descriptionFeaturesActive = false`
- KNN boost will activate on near-exact matches (sim ≥ 0.80, 3/3 agree)
- Hard cap (3) + gap filter (10%) will apply to all LR output
- Log warning: "Description features disabled — weights dimension mismatch"

### 2. Write Descriptions (Phase A)

Edit `backend/src/config/sop_descriptions.json`:

```json
{
  "version": "1.0.0",
  "categories": {
    "sop-amenity-request": {
      "broad": true,
      "descriptions": {
        "en": [
          "Guest is asking for an extra item or amenity...",
          "Guest needs a household appliance or device...",
          "Guest is requesting supplies or consumables..."
        ],
        "ar": [
          "الضيف يطلب عنصرًا إضافيًا أو وسيلة راحة...",
          "الضيف يحتاج إلى جهاز منزلي أو أداة...",
          "الضيف يطلب مستلزمات أو مواد استهلاكية..."
        ]
      }
    }
  }
}
```

### 3. Validate Descriptions (Phase G diagnostic)

After descriptions are written and the server is running:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/classifier/description-matrix
```

Check that no category pair has similarity > 0.70. If flagged, rewrite the similar descriptions.

### 4. Retrain Classifier (Phase D)

Trigger retraining via the admin endpoint:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/knowledge/retrain-classifier
```

This will:
- Embed all descriptions + training examples via Cohere
- Train LR on augmented 1044-dim vectors
- Save weights to `classifier-weights.json` + ClassifierWeights DB
- Auto-reload weights in the running classifier

After retraining:
- `descriptionFeaturesActive = true`
- Classification uses 1044-dim augmented vectors
- Method logged as `lr_desc` (description-enhanced) or `lr_boost` (boost override)

### 5. Verify via Pipeline Display

Open the frontend dashboard → AI Pipeline view:
- Send "I need a pillow" → expect `lr_boost`, HIGH confidence, 1 label
- Send "هل يمكنني الحصول على مخدة؟" → expect improved confidence from description features
- Send an ambiguous message → expect ≤ 3 labels, all within 10% of top score
- Check "Similarity Boost" section shows boost data and description matches

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/config/sop_descriptions.json` | SOP description text (NEW) |
| `backend/config/topic_state_config.json` | Boost/cap/gap thresholds |
| `backend/src/services/classifier.service.ts` | Core classification logic |
| `backend/scripts/train_classifier.py` | Training script (augmented) |
| `frontend/components/ai-pipeline-v5.tsx` | Pipeline display |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Description features disabled" warning | Old weights loaded (1024-dim) | Retrain classifier |
| No boost on exact matches | Threshold too high or neighbors disagree | Check `boost_similarity_threshold` in config |
| Too many labels returned | Gap filter or cap not applied | Verify `lr_hard_cap` and `lr_gap_filter` in config |
| Description similarity all 0 | Descriptions not embedded at startup | Check `COHERE_API_KEY`, check startup logs |
| Cross-class similarity > 0.70 | Descriptions too generic | Rewrite flagged descriptions, re-embed |
