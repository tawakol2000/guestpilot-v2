# Research: Prompt Template Variables

## Decision 1: Variable Syntax

**Decision**: Use `{VARIABLE_NAME}` (single curly braces, uppercase, underscores)
**Rationale**: Already established by `{PROPERTY_AMENITIES}` in sop.service.ts. Consistent with user expectation. Simple regex `\{([A-Z_]+)\}` for matching.
**Alternatives considered**:
- `{{VARIABLE}}` (double curly braces) — Jinja/Handlebars style, more complex, existing code uses single braces
- `$VARIABLE` — shell style, could conflict with dollar signs in prompt text
- `%VARIABLE%` — batch style, uncommon in web

## Decision 2: Content Block Ordering

**Decision**: Variables resolve as user message content blocks in the order they appear in the system prompt text. The system prompt itself stays static (cacheable).
**Rationale**: OpenAI's prompt caching works on static prefix matching. If dynamic data is inlined into the system prompt, the cache is busted on every message. Keeping the system prompt static and putting dynamic data in user messages preserves caching (~50% cost reduction on repeated calls).
**Alternatives considered**:
- Inline variable replacement in system prompt — breaks caching, simpler implementation
- Fixed block order regardless of prompt — less flexible, defeats the purpose

## Decision 3: Essential Variable Fallback

**Decision**: Three essential variables (`CURRENT_MESSAGES`, `PROPERTY_GUEST_INFO`, `CONVERSATION_HISTORY`) are auto-appended as content blocks if not found in the system prompt text.
**Rationale**: Without `CURRENT_MESSAGES`, the AI has nothing to respond to. Without `PROPERTY_GUEST_INFO`, the AI invents property data. Without `CONVERSATION_HISTORY`, the AI repeats questions. These three are non-negotiable for a functional conversation.
**Alternatives considered**:
- Block save if essentials missing — too restrictive, operator may be experimenting
- Auto-append ALL variables — defeats the purpose of removing unwanted ones

## Decision 4: Per-Listing Storage

**Decision**: Store per-listing variable overrides in `customKnowledgeBase.variableOverrides` JSON field on Property model.
**Rationale**: Reuses existing JSON field, no schema migration needed. Already has preservation logic for Hostaway resyncs via `USER_MANAGED_KEYS`. Consistent with how amenityClassifications and summarizedDescription are stored.
**Alternatives considered**:
- New Prisma model `PropertyVariableOverride` — unnecessary schema migration for a simple key-value store
- Separate JSON column on Property — adds schema migration for marginal benefit

## Decision 5: SOP Variable Rename

**Decision**: Rename `{PROPERTY_AMENITIES}` to `{ON_REQUEST_AMENITIES}` in SOP system with backward-compatible alias.
**Rationale**: The variable specifically contains on-request amenities (not all amenities). Renaming makes intent clear. Alias prevents breaking existing SOP content that uses the old name.
**Alternatives considered**:
- Keep old name — confusing, doesn't match actual content
- Hard rename with no alias — breaks existing SOP definitions in DB
