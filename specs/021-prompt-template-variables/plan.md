# Implementation Plan: Prompt Template Variables

**Branch**: `021-prompt-template-variables` | **Date**: 2026-03-24 | **Spec**: [spec.md](./spec.md)

## Summary

Replace all hardcoded dynamic content in the AI system prompt with a template variable system. The system prompt becomes static (cacheable) with `{VARIABLE}` references; actual data resolves as separate user message content blocks at runtime. Operators can rearrange variable order, and customize property-bound variables per listing.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, OpenAI Node.js SDK
**Storage**: PostgreSQL + Prisma ORM (no schema changes — uses existing `customKnowledgeBase` JSON field + `TenantAiConfig`)
**Testing**: Manual verification via Sandbox + AI Logs page
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service + admin dashboard
**Performance Goals**: Variable replacement adds <5ms to prompt build time; system prompt stays cacheable
**Constraints**: Must not break existing guest messaging flow; must not duplicate dynamic content
**Scale/Scope**: 8 template variables, ~20 properties per tenant, 2 agent types (coordinator, screening)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | Variable resolution falls back to auto-append if missing from prompt. Empty variables render sensible defaults. |
| II. Multi-Tenant Isolation | PASS | Variables resolve from per-tenant data (TenantAiConfig, Property, Reservation). No cross-tenant risk. |
| III. Guest Safety & Access Control | PASS | Access code gating is in `buildPropertyInfo()` which feeds `{PROPERTY_GUEST_INFO}` — unchanged. |
| IV. Structured AI Output | PASS | Variable system affects input (prompt), not output schema. |
| V. Escalate When In Doubt | PASS | No impact on escalation logic. |
| VI. Observability by Default | PASS | AiApiLog already captures full prompt — variable-resolved prompt will be logged as before. |
| VII. Self-Improvement with Guardrails | PASS | No impact on classifier/judge pipeline. |

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/021-prompt-template-variables/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts              # MODIFY: variable resolution engine, clean seed prompts, strip hardcoded dynamic blocks
│   │   ├── template-variable.service.ts # NEW: variable registry, resolver, essential-variable fallback
│   │   └── tenant-config.service.ts    # MODIFY: migration logic for existing prompts
│   └── routes/
│       └── properties.ts              # MODIFY: per-listing variable preview endpoint

frontend/
├── components/
│   ├── configure-ai-v5.tsx            # MODIFY: variable reference panel, missing-variable warnings
│   └── listings-v5.tsx                # MODIFY: per-listing variable preview section
```

**Structure Decision**: Standard web app layout. One new service file (`template-variable.service.ts`) for the variable registry and resolution logic. All other changes are modifications to existing files.

## Architecture

### Variable Resolution Flow

```
1. System prompt loaded from TenantAiConfig (static, cacheable)
   Contains: behavioral instructions + {VARIABLE} references

2. Runtime data assembled per-conversation:
   - conversationHistory (from messages)
   - propertyGuestInfo (from buildPropertyInfo)
   - availableAmenities (from classifyAmenities)
   - onRequestAmenities (from classifyAmenities)
   - openTasks (from Task model)
   - currentMessages (from pending messages)
   - currentLocalTime (from timezone)
   - documentChecklist (from screeningAnswers)

3. template-variable.service.ts resolveVariables():
   - Takes system prompt text + runtime data map
   - Scans for {VARIABLE_NAME} patterns
   - Builds ordered content blocks from variable positions
   - Auto-appends essential variables if missing
   - Returns: { systemPrompt (cleaned), contentBlocks[] }

4. Content blocks sent as user message parts (preserves prompt caching)
```

### Variable Registry

Each variable is defined with:
- `name`: e.g., `CONVERSATION_HISTORY`
- `description`: Human-readable for the editor UI
- `essential`: Whether auto-appended if missing (true for CURRENT_MESSAGES, PROPERTY_GUEST_INFO, CONVERSATION_HISTORY)
- `agentScope`: Which agents use this variable (coordinator, screening, both)
- `propertyBound`: Whether per-listing customization is supported (true for PROPERTY_GUEST_INFO, AVAILABLE_AMENITIES, ON_REQUEST_AMENITIES, DOCUMENT_CHECKLIST)

### Seed Prompt Changes

The current seed prompts (~800 lines) contain inline references to dynamic data sections. These need to be:
1. Stripped of all "the following sections will be provided" enumeration
2. `{VARIABLE}` references added where appropriate (e.g., "Refer to {PROPERTY_GUEST_INFO} for all property data")
3. All behavioral instructions preserved exactly

### Migration Strategy

For existing tenants with customized prompts:
1. On first access (lazy migration in `getTenantAiConfig`), detect if prompt lacks any `{VARIABLE}` patterns
2. If no variables found, append a default variable reference block at the end
3. The auto-append fallback ensures all essential data is present even without explicit variables
4. Bump `systemPromptVersion` to flag the migration

### Per-Listing Customization

Property-bound variables can be customized per listing:
- Stored in `customKnowledgeBase.variableOverrides` JSON object
- Keys: variable names (e.g., `PROPERTY_GUEST_INFO`)
- Values: `{ customTitle?: string, notes?: string }`
- At resolution time, overrides are merged into the variable output
- Added to `USER_MANAGED_KEYS` in import/resync to survive Hostaway syncs

### SOP Amenity Variable

`{PROPERTY_AMENITIES}` in `sop.service.ts` is renamed to `{ON_REQUEST_AMENITIES}` with backward-compatible alias. The existing `applyTemplates()` function is updated to recognize both names.
