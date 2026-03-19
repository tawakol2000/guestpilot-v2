# Quickstart: AI Engine Fix Verification

**Date**: 2026-03-19
**Feature**: 003-ai-engine-fix

## Prerequisites

- New Railway service (`backend-new-ai`) deployed from `003-ai-engine-fix`
- Sharing same Postgres + Redis as `backend-advanced-ai`
- Cohere API key set in new service env vars
- Python 3 + sklearn available in Docker image
- Test tenant webhook pointed at new service URL

## 0. Verify Deployment

```bash
# Check new service is running
curl https://backend-new-ai-production.up.railway.app/health

# Check engine type
curl -s https://backend-new-ai-production.up.railway.app/api/knowledge/classifier-status \
  -H "Authorization: Bearer TOKEN" | jq '.classifierType'
# Expected: "lr"
```

## 1. Initial LR Training

```bash
curl -X POST https://backend/api/knowledge/retrain-classifier \
  -H "Authorization: Bearer TOKEN"
```

Expected: JSON with accuracy, example count, threshold. Verify
`classifier-weights.json` is created with coefficients + centroids.

## 2. Verify Classification Method Changed

```bash
curl -X POST https://backend/api/knowledge/test-classify \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"can I get extra towels?"}'
```

Expected: response shows `method: "lr_softmax"` and a confidence
score (not topSimilarity from KNN). Should classify as
`sop-amenity-request` with high confidence.

## 3. Verify Empty-Label Rate Improved

```bash
curl -X POST https://backend/api/knowledge/batch-classify \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      "What is the name of the compound?",
      "can I get extra towels?",
      "the AC is broken",
      "شكرا",
      "Terrace?",
      "how much for a month?",
      "ok thanks",
      "I need cleaning tomorrow",
      "ممكن فوط اضافية",
      "WiFi?"
    ]
  }'
```

Expected: fewer than 2/10 return empty labels (< 20%).

## 4. Verify Topic Switch Detection

Send messages in this order to a test conversation:
1. "How much for a week?" → should classify as pricing-negotiation
2. "Pool?" → should detect topic switch (not re-inject pricing)
   and classify as property-description or similar
3. "ok sounds good" → should re-inject the most recent topic

## 5. Verify Pipeline Dashboard

Open the pipeline page. Verify:
- Accuracy cards show LR confidence (not KNN topSimilarity)
- Feed entries show both LR decision and KNN neighbors
- "Retrain Classifier" button visible in settings
- Classifier status shows "lr" type with accuracy %

## 6. Verify KNN Diagnostic Data

In the pipeline feed, click on any entry. Verify:
- LR classification result (primary): category + confidence
- KNN neighbors (diagnostic): top 3 neighbors with similarity
- Both visible side by side for debugging

## 7. Verify Rebalancing (after US3)

Check training data distribution:
- No category > 25 examples
- No category < 10 examples
- Arabic examples >= 40% of total
