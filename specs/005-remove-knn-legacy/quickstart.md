# Quickstart: Remove KNN Legacy & Complete LR Migration

**Branch**: `005-remove-knn-legacy`
**Date**: 2026-03-19

---

## What this does

1. Fixes two bugs where KNN cosine similarity was used for decisions instead of LR confidence
2. Updates all comments, labels, and UI defaults from "KNN" to "LR"
3. Adds centroid-based semantic topic switch detection to catch silent topic changes

## Local Development

```bash
cd backend
npm run dev
```

No new dependencies. No schema migration. No Python changes.

## Testing the Bug Fixes

Send a message where LR and KNN diverge:
1. Open the pipeline visualization dashboard
2. Find a message where Tier 1 shows HIGH LR confidence but LOW KNN similarity
3. Verify the tier routing used LR (HIGH → single SOP), not KNN

## Testing Centroid Topic Switch

1. Start a conversation about cleaning (trigger "sop-cleaning")
2. Wait for the topic cache to store "sop-cleaning"
3. Send a follow-up like "what's the WiFi password?" (no switch keywords)
4. Check the pipeline — should show "Topic switch detected (centroid distance)" instead of re-injecting cleaning SOP
5. Verify "sop-wifi-doorcode" is classified correctly

## Testing Keyword Fallback

1. Remove or rename `classifier-weights.json` temporarily (no centroids available)
2. Repeat the same test — topic switch should fall back to keyword-only detection
3. Send "by the way, what's the WiFi?" — should detect switch via keyword "by the way"
4. Send "what's the WiFi?" (no keyword) — should re-inject old topic (no centroid available)
5. Restore `classifier-weights.json`

## Deployment

Standard push to Railway — no migration, no environment variable changes, no retraining needed.
