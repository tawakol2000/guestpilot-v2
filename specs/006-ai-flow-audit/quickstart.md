# Quickstart: AI Flow System Audit & Fix

**Branch**: `006-ai-flow-audit`
**Date**: 2026-03-20

---

## What this fixes

Comprehensive fix of 40+ bugs across the entire AI pipeline — from webhook entry to AI response delivery to frontend display. Organized by pipeline stage.

## Prerequisites

- `guestpilot-v2` Railway service is the ONLY active backend (old `backend-advanced-ai` deleted)
- Hostaway webhook URL points to `guestpilot-v2-production.up.railway.app`
- Vercel `NEXT_PUBLIC_API_URL` points to guestpilot-v2 URL
- LR classifier trained (classifier-weights.json exists)

## Testing by Category

### 1. Duplicate SOP Fix
Send a message that triggers both Tier 1 and Tier 2 with the same SOP (e.g., a low-confidence early check-in request). Check pipeline display — chunks should show 1, not 2.

### 2. Host Reply Cancellation
1. Send a guest message (triggers AI typing indicator)
2. Before the 30s debounce expires, send a host reply
3. Verify the AI does NOT send a second response after the host

### 3. Escalation Signal Injection
Send a message containing "refund" — check the Claude prompt in logs for "SYSTEM SIGNAL: refund_request detected" in the content blocks.

### 4. Topic Switch (Centroid)
1. Start a conversation about cleaning
2. Send "what's the WiFi password?" (no switch keywords)
3. Check pipeline — should show "centroid switch" with numeric similarity score
4. Verify correct SOP (`sop-wifi-doorcode`) is retrieved

### 5. Property Amenities
Send an amenity request for a property that has amenities configured. Check the SOP content in logs — should show actual amenities list, not "No amenities data available."

### 6. Poll Job Atomic Claim
This is only testable when Redis is enabled (both poll job and BullMQ active). Check logs for any "already claimed" messages indicating the guard is working.

### 7. Pipeline Display
Open the pipeline page after a message is processed:
- Tier 1 should show LR confidence %, tier badge, labels
- Tier 3 should show centroid similarity score when applicable
- No empty sections

### 8. Full ragContext Logging
Query an AiApiLog entry — ragContext.chunks should contain full SOP text, not truncated to 200 chars.

## Deployment

Standard push to Railway + Vercel. One schema migration needed (hostawayMessageId unique constraint).

**Migration order:**
1. Deploy code changes first (handle P2002 for message dedup)
2. Clean up existing empty hostawayMessageId records
3. Apply schema migration
