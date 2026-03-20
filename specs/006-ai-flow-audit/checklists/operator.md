# Operator Validation Checklist: AI Flow Audit

**Purpose**: For the user — validate production behavior after deployment
**Created**: 2026-03-20
**Feature**: [spec.md](../spec.md)
**Actor**: Product owner / Operator
**Timing**: After deployment to guestpilot-v2 Railway service

## Message Handling

- [ ] CHK001 Are duplicate messages prevented — does a webhook sent twice with the same ID result in only one message saved? [Completeness, Spec §FR-001 via AUD-001]
- [ ] CHK002 Is the AI reply cancelled when the host sends a message before the debounce window expires? [Completeness, Spec §FR-011]
- [ ] CHK003 Is the "AI typing" indicator NOT shown when aiMode is set to "off" in the dashboard? [Clarity, Research §AUD-003]
- [ ] CHK004 Are all conversations showing the correct guest name (no "New Guest" or "Unknown Guest" for confirmed bookings)? [Completeness, Research §AUD-005]

## Classification & SOP Selection

- [ ] CHK005 Does the pipeline visualization show the LR confidence percentage and tier badge (high/medium/low) for every new message? [Completeness, Spec §FR-004]
- [ ] CHK006 Does the "SOPs Selected" section show each SOP exactly ONCE — no duplicates? [Clarity, Spec §FR-001]
- [ ] CHK007 Are amenity-related SOP responses showing actual property amenities (not "No amenities data available")? [Completeness, Spec §FR-013 via AUD-025]
- [ ] CHK008 Is the classifier method showing "lr_sigmoid" for all new messages (not "knn_rerank")? [Consistency]

## Topic Switch Detection

- [ ] CHK009 Does the pipeline display show a numeric centroid similarity score when a topic switch is detected? [Completeness, Spec §FR-005/FR-006]
- [ ] CHK010 Does a silent topic change (no switch keywords) get detected and trigger a fresh classification? [Coverage, Spec §FR-015]
- [ ] CHK011 Does the topic switch detection work even when Tier 1 is highly confident on the new topic? [Coverage, Spec §FR-009]

## AI Response Quality

- [ ] CHK012 Does the AI correctly apply the "within 2 days" branch of the early check-in SOP when the guest checks in tomorrow? [Clarity, Spec §FR-003]
- [ ] CHK013 Are escalation signals (refund, complaint, emergency) visible in the pipeline log when they fire? [Completeness, Spec §FR-012]
- [ ] CHK014 Does the AI response NOT send a second message after the host already replied? [Completeness, Spec §FR-011]

## Security & Access Codes

- [ ] CHK015 Are door codes and WiFi credentials NEVER shown in responses to INQUIRY or PENDING guests? [Safety, Constitution §III]
- [ ] CHK016 Are door codes and WiFi credentials shown correctly for CONFIRMED and CHECKED_IN guests who ask? [Completeness]

## Pipeline Debugging

- [ ] CHK017 Does clicking on a pipeline log entry show the FULL SOP text (not truncated to 200 chars)? [Completeness, Spec §FR-007]
- [ ] CHK018 Is the LLM override badge visible when the AI overrides the classifier's SOP pick in MEDIUM confidence? [Completeness, Spec §FR-008]

## Infrastructure

- [ ] CHK019 Is the guestpilot-v2 service the ONLY active backend (old backend-advanced-ai deleted)? [Consistency]
- [ ] CHK020 Is the Hostaway webhook URL pointing to guestpilot-v2-production.up.railway.app? [Consistency]

## Notes

- Run this checklist after each deployment
- CHK015 is the highest priority — door code exposure is a physical security risk
- CHK006 (duplicate SOPs) and CHK014 (double-fire) are the most common production bugs
