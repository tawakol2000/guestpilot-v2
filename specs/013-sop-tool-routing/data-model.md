# Data Model: SOP Tool Routing

## Entity Changes

### No Schema Migration Required

The Prisma schema is NOT modified. Existing classifier tables are kept read-only for historical data. New classification data is stored in the existing `AiApiLog.ragContext` JSON field.

### Existing Tables — Status Change

| Model | Action | Reason |
|-------|--------|--------|
| ClassifierExample | Read-only | 373+ training examples preserved as evaluation benchmark |
| ClassifierEvaluation | Read-only | Historical judge evaluations preserved for comparison |
| ClassifierWeights | Read-only | Trained LR weights preserved (no longer used) |
| TenantAiConfig | Keep writing | tier1Mode/tier2Mode/tier3Mode fields become unused but harmless. Other config fields (model selection, prompts, etc.) still active |

### AiApiLog.ragContext — Field Changes

The `ragContext` JSON field on `AiApiLog` changes structure for new classifications. Old logs retain their original structure (backward compatible — it's a JSON field).

**New ragContext shape** (for tool-based classification):

```typescript
{
  // SOP Tool Classification (NEW)
  sopToolUsed: boolean;           // always true for new logs
  sopCategories: string[];        // ["maintenance"] or ["amenity_request", "wifi"]
  sopConfidence: 'high' | 'medium' | 'low';
  sopReasoning: string;           // "Guest reports broken dishwasher"

  // Property Knowledge RAG (UNCHANGED)
  chunks: Array<{ content, category, similarity, sourceKey, isGlobal }>;
  totalRetrieved: number;
  durationMs: number;
  topSimilarity: number;

  // Escalation (UNCHANGED)
  escalationSignals: string[];

  // Other Tool Usage (UNCHANGED — property search, extend stay)
  toolUsed?: boolean;
  toolName?: string;
  toolInput?: any;
  toolResults?: any;
  toolDurationMs?: number;
}
```

**Removed fields** (only from NEW logs — old logs keep their data):
- classifierUsed, classifierLabels, classifierTopSim, classifierMethod, classifierConfidence
- boostApplied, boostSimilarity, boostLabels, originalLrConfidence, originalLrLabels
- descriptionFeaturesActive, topDescriptionMatches
- tier3Reinjected, tier3TopicSwitch, tier3ReinjectedLabels, centroidSimilarity, centroidThreshold, switchMethod
- tier2Output, tierModes, confidenceTier, originalConfidenceTier, topCandidates

### SOP Category Enum

22 values used in the tool schema and stored in ragContext:

| Category | Description |
|----------|-------------|
| sop-cleaning | Mid-stay cleaning, housekeeping |
| sop-amenity-request | Towels, pillows, supplies, amenity questions |
| sop-maintenance | Broken items, plumbing, HVAC, electrical |
| sop-wifi-doorcode | WiFi, internet, door codes, access |
| sop-visitor-policy | Visitors, guest count, passports, ID |
| sop-early-checkin | Arriving before check-in time |
| sop-late-checkout | Staying past checkout time on last day |
| sop-complaint | Dissatisfaction, review threats |
| sop-booking-inquiry | Availability, new bookings, property search |
| pricing-negotiation | Discounts, rate questions, budget |
| sop-booking-modification | Date changes, extending stay, unit swaps |
| sop-booking-confirmation | Verifying reservation, checking status |
| sop-booking-cancellation | Cancel requests, refund policy |
| payment-issues | Payment failures, refunds, billing |
| sop-long-term-rental | Monthly inquiries, corporate stays |
| property-info | Address, parking, directions, unit details |
| property-description | General property overview, neighborhood |
| pre-arrival-logistics | Arrival coordination, airport transfer |
| sop-property-viewing | Tours, photo/video requests |
| post-stay-issues | Lost items, post-checkout complaints |
| none | Greetings, thanks, no SOP needed |
| escalate | Safety, legal, human intervention required |
