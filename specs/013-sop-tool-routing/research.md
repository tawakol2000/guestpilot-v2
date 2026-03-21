# Research: SOP Tool Routing

## Decision 1: Tool Architecture — Single Tool with Enum

**Decision**: One `get_sop` tool with a `categories` array parameter (22-value enum).

**Rationale**: Anthropic docs recommend consolidating related operations into fewer tools with an action/category parameter. Paragon benchmark showed accuracy jumped from 67.6% to 75.8% when tool count was reduced. Single tool with `tool_choice: forced` eliminates the tool selection problem entirely — Claude only decides the enum value.

**Alternatives considered**:
- 22 separate tools (one per SOP) — rejected: 22-way tool selection problem, can't use forced tool choice
- Grouped tools (get_booking_sop, get_property_sop) — rejected: ambiguous boundaries, two-level decision, prevents clean forced tool choice
- No tool (inject all SOPs in prompt) — rejected: wastes tokens, no structured classification output

## Decision 2: Tool Choice — Forced, Not Auto

**Decision**: `tool_choice: {"type": "tool", "name": "get_sop"}` on the classification call.

**Rationale**: With `auto`, Haiku might skip the tool for greetings (losing observability) or call it unnecessarily in different ways. Forced choice guarantees every message gets a structured classification. The `"none"` enum value handles messages that don't need SOP guidance.

**Alternatives considered**:
- `tool_choice: "auto"` — rejected: nondeterministic, loses observability for non-actionable messages
- `tool_choice: "any"` — rejected: same issues as auto for this use case

**Limitation**: Forced tool choice does not support extended thinking. If needed later, switch to `auto` with strong system prompt instructions.

## Decision 3: Schema Design — Array Categories with Reasoning

**Decision**: `categories` as array (minItems: 1, maxItems: 3), `reasoning` string before categories, `confidence` enum (high/medium/low). `strict: true`.

**Rationale**: Array handles multi-intent messages ("towels AND wifi password") — more reliable than parallel tool calls. `reasoning` before `categories` triggers chain-of-thought, improving classification. `strict: true` guarantees valid enum values.

**Schema structure**:
```json
{
  "name": "get_sop",
  "strict": true,
  "input_schema": {
    "properties": {
      "reasoning": { "type": "string" },
      "categories": { "type": "array", "items": { "enum": [...] }, "minItems": 1, "maxItems": 3 },
      "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
    },
    "required": ["reasoning", "categories", "confidence"]
  }
}
```

## Decision 4: Enum Values — 22 Categories

**Decision**: 20 operational SOPs + `none` + `escalate` = 22 total.

**Current 20 SOPs** (from classifier-data.ts SOP_CONTENT map):
1. sop-cleaning
2. sop-amenity-request
3. sop-maintenance
4. sop-wifi-doorcode
5. sop-visitor-policy
6. sop-early-checkin
7. sop-late-checkout
8. sop-complaint
9. sop-booking-inquiry
10. pricing-negotiation
11. sop-booking-modification
12. sop-booking-confirmation
13. sop-booking-cancellation
14. payment-issues
15. sop-long-term-rental
16. property-info
17. property-description
18. pre-arrival-logistics
19. sop-property-viewing
20. post-stay-issues

**Removed from enum** (handled differently):
- `non-actionable` → replaced by `none`
- `contextual` → removed entirely (Claude handles follow-ups naturally with conversation context)

**Added**:
- `none` — greetings, thanks, simple acknowledgments, questions fully covered by system prompt
- `escalate` — safety concerns, billing disputes, angry guests, anything needing human intervention

## Decision 5: Description Style — Lean with Negative Boundaries

**Decision**: ~20 tokens per category description. What it covers + "NOT for X". No inline examples. 3-5 `input_examples` at the tool level for hardest disambiguation cases.

**Rationale**: User preference for lean descriptions. Enum names are already descriptive. Negative boundaries handle the confusing edges. Tool-level examples target specific ambiguity points (cleaning vs maintenance, amenity vs property description).

**Token budget**: ~480 tokens for all 22 descriptions + ~100 tokens for input_examples = ~580 tokens. With system prompt (~1,500 tokens), total cached prefix is ~2,080 tokens + ~313 tool overhead = ~2,393 tokens. Below Haiku 4,096 minimum for caching — need to ensure system prompt pushes total above 4,096.

**Mitigation**: Place `cache_control: {"type": "ephemeral"}` on the last system message block. If still under 4,096, the system prompt + conversation context will exceed it.

## Decision 6: Two-Call Flow

**Decision**: Call 1 forces `get_sop` classification. Call 2 sends tool_result with SOP content + other tools with `auto`.

**Flow**:
```
API Call 1:
  tools: [get_sop]
  tool_choice: forced get_sop
  → Response: {categories: ["maintenance"], reasoning: "...", confidence: "high"}

App: retrieve SOP content for "maintenance"

API Call 2:
  tools: [search_properties | extend_stay]  // get_sop REMOVED
  tool_choice: auto
  messages: [..., assistant tool_use, user tool_result with SOP content]
  → Response: text (or another tool_use for property search / extend stay)
```

**Key detail**: Remove `get_sop` from tools on Call 2+ so Claude doesn't re-classify.

## Decision 7: SOP Content Storage

**Decision**: Move SOP_CONTENT from classifier-data.ts to a new `sop.service.ts`.

**Current state**: SOP content is hardcoded in `classifier-data.ts` (lines 458-534) as a `SOP_CONTENT` map with 22 keys. NOT separate files.

**New state**: `sop.service.ts` exports:
- `getSopContent(category: string, propertyAmenities?: string): string` — same signature as current
- `SOP_CATEGORIES` — the enum values array for tool schema
- `SOP_DESCRIPTIONS` — the lean descriptions for tool schema

**Rationale**: Keeps SOP content in one place. The tool handler calls `getSopContent()`. Amenity template replacement (`{PROPERTY_AMENITIES}`) preserved.

## Decision 8: Cutover Strategy

**Decision**: Big-bang replacement. Remove old, add new, deploy together.

**Rationale**: The old system is on the dev branch (advanced-ai-v7), not production-critical at scale. Research confirms the tool approach is sound. Feature flags add unnecessary complexity.

**Rollback**: Revert the git deploy if issues arise.

## Decision 9: Database Tables

**Decision**: Keep ClassifierExample, ClassifierEvaluation, ClassifierWeights tables read-only.

**Rationale**: Historical data useful for benchmarking new system accuracy. 373 training examples serve as evaluation set. No schema migration needed — just stop writing to these tables.

## Decision 10: Files to Delete vs Modify

**Files to DELETE** (~2,800 lines):
| File | Lines | Purpose |
|------|-------|---------|
| backend/src/services/classifier.service.ts | 1,085 | LR/KNN classifier core |
| backend/src/services/classifier-data.ts | 534 | Training examples + SOP content |
| backend/src/services/classifier-store.service.ts | 45 | DB-backed example store |
| backend/src/services/intent-extractor.service.ts | 157 | Tier 2 Haiku intent extraction |
| backend/src/services/topic-state.service.ts | 270 | Tier 3 topic cache |
| backend/scripts/train_classifier.py | 362 | Python LR training script |
| backend/config/intent_extractor_prompt.md | 348 | Tier 2 prompt template |
| backend/config/topic_state_config.json | 199 | Topic cache config |

**Files to MODIFY** (heavy changes):
| File | Lines | Changes |
|------|-------|---------|
| backend/src/services/ai.service.ts | ~1,850 | Add get_sop tool definition, forced choice on call 1, SOP retrieval in tool handler, remove 3-tier pipeline from processInquiry/processConfirmed |
| backend/src/services/rag.service.ts | ~540 | Remove classifyMessage/extractIntent/getSopContent calls, keep property knowledge retrieval |
| backend/src/routes/knowledge.ts | 809 | Remove ~15 classifier routes, keep KB CRUD, add SOP monitoring endpoint |
| backend/src/controllers/knowledge.controller.ts | 711 | Remove retrain/training/paraphrase methods, keep KB management |
| frontend/components/ai-pipeline-v5.tsx | 2,684 | Remove tier 1/2/3 health cards and feed tier routing, add tool classification display |
| frontend/components/inbox-v5.tsx | ~3,000 | Replace 'classifier' tab reference with 'sop-monitor' |
| frontend/lib/api.ts | ~1,100 | Remove classifier API calls, add monitoring calls |

**Files to DELETE (frontend)**:
| File | Lines | Purpose |
|------|-------|---------|
| frontend/components/classifier-v5.tsx | 1,980 | Entire classifier settings page |

**Files to CREATE**:
| File | Purpose |
|------|---------|
| backend/src/services/sop.service.ts | SOP content store + tool schema definitions |
| frontend/components/sop-monitor-v5.tsx | Classification monitoring dashboard |

## Decision 11: Import Cleanup

**Files importing classifier services** (all need cleanup):

| File | Imports to remove |
|------|------------------|
| ai.service.ts | getSopContent from classifier, updateTopicState/getReinjectedLabels/getCachedTopicLabel from topic-state, extractIntent from intent-extractor |
| rag.service.ts | classifyMessage/getSopContent/initializeClassifier from classifier, BAKED_IN_CHUNKS from classifier-data, extractIntent from intent-extractor |
| judge.service.ts | addExample/getExampleByText from classifier-store, reinitializeClassifier/getMaxSimilarityForLabels from classifier |
| opus.service.ts | SOP_CONTENT from classifier-data, getClassifierStatus/getClassifierThresholds from classifier |
| knowledge.ts (route) | 10+ classifier functions, classifier-store, classifier-data |
| ai-pipeline.ts (route) | getTopicCacheStats from topic-state, getTier2Stats from intent-extractor, getClassifierStatus from classifier |
| knowledge.controller.ts | extractIntent from intent-extractor, reinitializeClassifier/loadLrWeightsMetadata from classifier, TRAINING_EXAMPLES from classifier-data |
| ai-config.controller.ts | getIntentPrompt/reloadIntentPrompt from intent-extractor |
| sandbox.ts (route) | getSopContent from classifier, extractIntent from intent-extractor |
| server.ts | initializeClassifier/setClassifierThresholds/setBoostThreshold from classifier, loadLrWeightsMetadata |

## Decision 12: ragContext Structure Changes

**Fields to REMOVE** from ragContext:
- classifierUsed, classifierLabels, classifierTopSim, classifierMethod, classifierConfidence
- boostApplied, boostSimilarity, boostLabels, originalLrConfidence, originalLrLabels
- descriptionFeaturesActive, topDescriptionMatches
- tier3Reinjected, tier3TopicSwitch, tier3ReinjectedLabels, centroidSimilarity, centroidThreshold, switchMethod
- tier2Output
- tierModes, confidenceTier, originalConfidenceTier, topCandidates

**Fields to ADD**:
- sopToolUsed: boolean
- sopCategories: string[]
- sopConfidence: 'high' | 'medium' | 'low'
- sopReasoning: string

**Fields to KEEP**:
- chunks, totalRetrieved, durationMs, topSimilarity (property knowledge RAG)
- escalationSignals
- toolUsed, toolName, toolInput, toolResults, toolDurationMs (existing tool fields)
