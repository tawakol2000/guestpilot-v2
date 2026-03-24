# Implementation Plan: Listings Management Page

**Branch**: `020-listings-management` | **Date**: 2026-03-24 | **Spec**: [spec.md](./spec.md)

## Summary

New Listings page with property cards showing all Hostaway data. Editable fields, per-listing Hostaway resync, amenity classification (Default/Available/On Request), AI-powered description summarization, and injection of classified amenities into AI context. Remove old Settings knowledge base editor.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: OpenAI Node.js SDK (summarization), Express 4.x, Prisma ORM
**Storage**: PostgreSQL + Prisma ORM (no schema changes — uses existing `customKnowledgeBase` JSON + `listingDescription`)
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (backend + frontend)
**Constraints**: Zero DB migrations. Amenity classifications stored in existing JSON. Summarization uses GPT-5.4 Mini.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Summarization failure → keeps original. Resync failure → toast, keeps data. |
| §II Multi-Tenant Isolation | PASS | Properties already tenant-scoped. |
| §III Guest Safety & Access | PASS | Door codes/WiFi editable but still gated by reservation status in AI pipeline. |
| §IV Structured AI Output | N/A | |
| §V Escalate When In Doubt | PASS | Unchanged. |
| §VI Observability | PASS | Summarization logged. |
| §VII Self-Improvement | N/A | |
| Security | PASS | No new auth. Sensitive fields (codes, passwords) displayed same as before. |

No violations.

## Implementation Details

### Data Model — No Schema Change

Amenity classifications stored in `customKnowledgeBase` JSON:

```json
{
  "amenities": "Swimming pool, Extra towels, Air conditioning, Baby crib",
  "amenityClassifications": {
    "Swimming pool": "available",
    "Extra towels": "on_request",
    "Air conditioning": "available",
    "Baby crib": "on_request"
  },
  // ... existing fields unchanged
}
```

Summarized description stored as new field in `customKnowledgeBase`:

```json
{
  "summarizedDescription": "Concise 100-word summary...",
  "originalDescription": "Full 500-word marketing text..." // copied from listingDescription on first summarize
}
```

### AI Context Injection

**Current behavior** (`ai.service.ts` `buildPropertyInfo`):
- Injects `amenities` as a flat string into property context
- Injects `listingDescription` as-is

**New behavior**:
1. Parse `amenityClassifications` from `customKnowledgeBase`
2. Split amenities into two lists:
   - **Available**: amenities classified as "available" or "default" (unclassified) → injected into property context as "Available Amenities: pool, AC, internet, ..."
   - **On Request**: amenities classified as "on_request" → injected into amenity request SOP via `{PROPERTY_AMENITIES}` template variable (already exists in sop.service.ts)
3. Use `summarizedDescription` if it exists, otherwise fall back to `listingDescription`

### SOP Amenity Integration

The `sop-amenity-request` SOP already has a `{PROPERTY_AMENITIES}` placeholder that gets replaced with the property's amenities string. Currently it's the full flat list. Change it to only include "on request" items — the ones the guest needs to ask for.

The "available" items go into the property context (PROPERTY & GUEST INFO section) so the AI knows about permanent features.

### New Files

```text
frontend/components/listings-v5.tsx           # Full Listings page
backend/src/routes/listings.ts                # Summarize endpoint
```

### Modified Files

```text
backend/src/services/ai.service.ts            # buildPropertyInfo: split amenities, use summary
backend/src/services/sop.service.ts           # {PROPERTY_AMENITIES} → on-request items only
backend/src/routes/properties.ts              # Add summarize endpoint
backend/src/app.ts                            # Register listings router (or reuse properties)
frontend/components/inbox-v5.tsx              # Add "Listings" nav tab
frontend/components/settings-v5.tsx           # Remove PropertyInfoEditor
frontend/lib/api.ts                           # New API types/functions
```

### Phase 1: Backend — Amenity Classification + Summarization

**Amenity classification**: Already stored via existing `PUT /api/properties/:id/knowledge-base` endpoint. Frontend sends updated `customKnowledgeBase` with `amenityClassifications` field. No new endpoint needed.

**Summarization endpoint**: `POST /api/properties/:id/summarize`
- Reads `listingDescription` from the property
- Calls GPT-5.4 Mini with a short prompt: "Summarize this property listing into a concise, factual paragraph (~100 words) for an AI assistant. Keep: location, nearby landmarks, transport, key features, capacity. Remove: marketing language, superlatives, booking calls-to-action."
- Saves result to `customKnowledgeBase.summarizedDescription`
- Returns the summary

**Batch summarize**: `POST /api/properties/summarize-all`
- Loops through all tenant properties
- Returns progress/count

### Phase 2: Backend — AI Context Changes

**`buildPropertyInfo`** in ai.service.ts:
- Parse `amenityClassifications` from `customKnowledgeBase`
- Split amenities: available vs on-request
- Inject "Available amenities: ..." into property info section
- Use `summarizedDescription` instead of `listingDescription` when available

**`getSopContent`** in sop.service.ts:
- When replacing `{PROPERTY_AMENITIES}`, use only "on request" amenities
- Fall back to full list if no classifications exist (backward compatible)

### Phase 3: Frontend — Listings Page

**`listings-v5.tsx`**: Full page with:
- Property cards in a grid/list (like SOP page style)
- Each card:
  - Header: property name + address
  - Editable fields: door code, WiFi name/password, check-in/out times, house rules, capacity, bed types, cleaning fee, URLs
  - Amenities section: each amenity as a pill with 3-way toggle (Default/Available/On Request)
  - Description section: show summarized (if exists) with expand for original. Summarize button.
  - Resync button (with overwrite warning)
- Top bar: "Summarize All" button
- Save button per card

### Phase 4: Frontend — Cleanup

- Remove `PropertyInfoEditor` from `settings-v5.tsx`
- Add "Listings" tab to inbox navigation
- Remove old knowledge base references

### What Stays Unchanged

- Property model in Prisma — no migration
- Hostaway resync endpoint — already exists at `POST /api/properties/:id/resync`
- Knowledge base update endpoint — already exists at `PUT /api/properties/:id/knowledge-base`
- RAG/embedding system — still works on the same data
