# Research: Status-Aware SOP Variants

## Decision 1: Storage — Database per Tenant

**Decision**: Store SOPs in PostgreSQL via Prisma with 3 models: SopDefinition, SopVariant, SopPropertyOverride.

**Rationale**: Operators need to edit SOPs without code deploys. Database gives us per-tenant isolation, persistence across restarts, and CRUD via API.

**Alternatives considered**: JSON config file (no multi-tenant), env vars (too complex), hardcoded with override table (partial — chose full DB).

## Decision 2: Variant Resolution — App-Level, Not AI-Level

**Decision**: The application selects the correct SOP variant based on booking status BEFORE passing content to the AI. The AI receives one clear procedure with no conditional branching.

**Rationale**: AI fumbles conditional branches. App code knows the booking status deterministically. Zero ambiguity for the AI.

**Resolution order**: Property override → Tenant variant → Tenant default → Empty.

## Decision 3: Classification Unchanged — 22 Categories

**Decision**: The get_sop tool enum stays at 22. Variants only affect the CONTENT returned, not the classification categories.

**Rationale**: Adding status-suffixed categories (60+ values) degrades classification accuracy. The AI only needs to identify WHAT the guest wants, not which booking status they have — the app already knows that.

## Decision 4: Dynamic Tool Schema

**Decision**: Tool descriptions loaded from DB and cached per tenant (5-minute TTL). When operators edit descriptions, the cache expires and the next message uses the updated schema.

**Rationale**: Operators may refine descriptions to improve classification accuracy. Hardcoded descriptions can't be tuned without code changes.

**Cache invalidation**: On description save, invalidate the tenant's cached tool schema. Next message rebuilds from DB.

## Decision 5: Seed Data Strategy

**Decision**: On first access, if a tenant has no SopDefinition records, seed from the current hardcoded SOP_CONTENT map and SOP_TOOL_DEFINITION descriptions. This is a one-time migration.

**Rationale**: Existing tenants shouldn't lose their SOPs. New tenants get sensible defaults. The hardcoded content becomes the seed template.

## Decision 6: SOPs Needing Variants

**Decision**: 8 of 20 operational SOPs get status-specific variants. The other 12 use DEFAULT only.

**Variants needed**:
1. `sop-amenity-request` — availability (INQUIRY) vs assurance (CONFIRMED) vs delivery (CHECKED_IN)
2. `sop-early-checkin` — N/A (INQUIRY) vs can we come early (CONFIRMED)
3. `sop-late-checkout` — N/A (INQUIRY) vs leaving late (CHECKED_IN)
4. `sop-cleaning` — N/A (INQUIRY/CONFIRMED) vs schedule cleaning (CHECKED_IN)
5. `sop-wifi-doorcode` — don't share (INQUIRY) vs share codes (CONFIRMED/CHECKED_IN)
6. `sop-visitor-policy` — policy info (INQUIRY) vs visitor coming (CHECKED_IN)
7. `sop-booking-modification` — pre-booking change (INQUIRY) vs date change (CONFIRMED) vs extend stay (CHECKED_IN)
8. `pre-arrival-logistics` — N/A (INQUIRY) vs coordinate arrival (CONFIRMED)

## Decision 7: Frontend Design — Table with Inline Editing

**Decision**: Full-page table with:
- Property dropdown (Global + per-property)
- Each row: SOP name badge, tool description (editable), content area with status tabs (DEFAULT/INQUIRY/CONFIRMED/CHECKED_IN)
- Enable/disable toggle per variant
- Inline text editing with save button
- Visual indicator for which SOPs have custom variants

**Rationale**: Matches the user's request for "interactive SOP page" with editing, variants, and property selection.

## Decision 8: getSopContent() Becomes Async

**Decision**: `getSopContent()` changes from a synchronous map lookup to an async DB query. Cache the results per tenant+category for 5 minutes.

**Rationale**: DB access is async. Caching prevents a DB hit on every message. 5-minute TTL matches tool schema cache.

**Impact**: All callers (ai.service.ts, sandbox.ts) need to `await` the call.
