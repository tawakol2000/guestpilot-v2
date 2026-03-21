# Quickstart: Extend Stay Tool

**Feature**: 011-extend-stay
**Date**: 2026-03-21

## Prerequisites

- Feature 010 (tool use infrastructure) deployed and working
- Backend running with Hostaway credentials configured
- At least 1 CONFIRMED reservation on a property

## Quick Validation Steps

### 1. Test extension request via Sandbox

Go to the **Sandbox** tab, select a property with a confirmed reservation, set status to CONFIRMED.

Send: "Can I stay 2 more nights?"

**Expected**:
- AI calls `check_extend_availability` tool
- Returns availability + price + channel-appropriate instructions
- Tool badge visible on the AI response

### 2. Test unavailable dates

Send: "Can I extend until [date when another booking exists]?"

**Expected**: AI says the property is booked and offers the maximum available extension.

### 3. Test price-only query

Send: "How much would 3 extra nights cost?"

**Expected**: AI returns the price without assuming the guest wants to commit.

### 4. Test channel instructions

Test with different channels (AIRBNB, DIRECT, WHATSAPP):
- AIRBNB → "Submit an alteration request through Airbnb"
- DIRECT → "I'll arrange the extension for you" + escalation task
- WHATSAPP → same as DIRECT

### 5. Check pipeline view

Verify tool usage details (dates checked, availability, price quoted) appear in the AI pipeline log.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Tool not called | Status is INQUIRY (tool is guest coordinator only) | Switch to CONFIRMED |
| Price shows as null | Hostaway calculatePrice endpoint unavailable | Check API credentials, falls back to "check with team" |
| Wrong channel instructions | Channel not detected correctly | Check reservation.channel value |
| Calendar check fails | Hostaway API credentials or rate limit | Check tenant hostawayApiKey |
