# Quickstart: Smart Escalation Logic

**Branch**: `007-smart-escalation`
**Date**: 2026-03-20

---

## What this does

Adds a lightweight Task Manager AI that prevents duplicate escalation tasks. Fires only when Omar creates an escalation, compares against open tasks, and decides: create new / update existing / resolve / skip.

## Testing

### Test 1: Duplicate Prevention (Cleaning)
1. Start a new conversation
2. Guest: "Can I get cleaning done?"
3. Verify: 1 task created (`cleaning-scheduled`)
4. Guest: "10am please"
5. Verify: existing task UPDATED (not a second task created)
6. Check task note: should show `[Original]` + `[Update]` format

### Test 2: Different Topics (Info Requests)
1. Guest: "Where's the nearest pharmacy?"
2. Verify: 1 task created (`info_request`)
3. Guest: "Also, where's the closest mall?"
4. Verify: NEW task created (different topic, not an update)

### Test 3: Follow-up on Same Topic
1. Guest: "Where's the nearest pharmacy?"
2. Verify: 1 task created
3. Guest: "Is it open 24 hours?"
4. Verify: existing task UPDATED (same topic — pharmacy)

### Test 4: Resolution
1. Guest: "Hot water isn't working"
2. Verify: 1 task created (`maintenance-no-hot-water`)
3. Guest: "It's working now"
4. Verify: existing task RESOLVED (status → completed)

### Test 5: Graceful Degradation
1. Temporarily set invalid ANTHROPIC_API_KEY
2. Guest: sends message that triggers escalation
3. Verify: task is created normally (fallback — no crash)
4. Check logs: warning about Task Manager failure

## Deployment

Standard push. No schema migration. No new env vars. Uses existing `ANTHROPIC_API_KEY`.
