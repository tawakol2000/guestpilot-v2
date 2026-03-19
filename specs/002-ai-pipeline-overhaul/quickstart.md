# Quickstart: AI Pipeline Overhaul Verification

**Date**: 2026-03-19
**Feature**: 002-ai-pipeline-overhaul

## Prerequisites

- Backend running with database connection
- At least some AiApiLog + ClassifierEvaluation data (from normal operation)

## 1. Verify Accuracy Dashboard

Open the pipeline page in the frontend. In addition to existing 24h
stats, verify:
- Overall classifier accuracy % is displayed
- Empty-label rate % is displayed
- Per-category accuracy breakdown is visible
- Self-improvement stats (examples added by source) are shown
- 7d/30d period toggle works

## 2. Verify Judge Mode Toggle

```bash
# Check current judge mode
curl -s https://backend/api/tenant-config \
  -H "Authorization: Bearer TOKEN" | jq '.judgeMode'
# Expected: "evaluate_all"

# Toggle to sampling
curl -X PUT https://backend/api/tenant-config \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"judgeMode":"sampling"}'
```

## 3. Run Gap Analysis

```bash
curl -X POST https://backend/api/knowledge/gap-analysis \
  -H "Authorization: Bearer TOKEN"
```

Expected: JSON with empty-label messages count, underrepresented
categories, language distribution, and suggested examples count.

## 4. Review Suggested Examples

Open the classifier examples page. Verify:
- A "Suggested" tab appears with gap-analysis examples
- Each example shows text + labels + source
- Arabic text renders correctly (RTL)
- Approve/reject buttons work
- Approving triggers classifier reinitialization

## 5. Generate Pipeline Snapshot

```bash
curl -X POST https://backend/api/ai-pipeline/snapshot \
  -H "Authorization: Bearer TOKEN"
```

Verify `.specify/memory/pipeline-snapshot.md` is created/updated with:
- Accuracy metrics
- Per-category breakdown
- Training set stats
- Threshold settings
- Top misclassifications
- Health summary

## 6. Batch Classification Test

```bash
curl -X POST https://backend/api/knowledge/batch-classify \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      "can I get extra towels?",
      "the AC is broken",
      "شكرا",
      "ok thanks",
      "how much for a month?"
    ],
    "voteThreshold": 0.25
  }'
```

Verify: each message gets classified with labels, similarity scores,
and the method used.

## 7. Verify Operator Ratings

In the inbox, find an AI message. Click thumbs-up or thumbs-down.
Verify:
- Rating is saved
- Rating appears in pipeline dashboard
- Thumbs-down with correction generates a training example
