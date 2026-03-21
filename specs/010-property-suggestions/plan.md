# Implementation Plan: Cross-Sell Property Suggestions (Tool Use)

**Branch**: `010-property-suggestions` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-property-suggestions/spec.md`

## Summary

Add Claude tool use infrastructure to the **screening agent** (INQUIRY-status conversations) so the AI can dynamically search for alternative properties when inquiry guests ask about amenities the inquired property doesn't have. Claude calls a `search_available_properties` tool that queries the tenant's portfolio by amenity match and checks real-time availability via the Hostaway API, returning channel-appropriate booking links. This helps convert inquiries by directing guests to better-matched properties. The guest coordinator (confirmed/checked-in) is unchanged — no tool use. The existing classification architecture (SOP routing) is unchanged. Guest interest generates escalation tasks for manager follow-up. Frontend includes a Tools section for visibility and management.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK (`@anthropic-ai/sdk@^0.30.1`), Hostaway API
**Storage**: PostgreSQL + Prisma ORM + existing `customKnowledgeBase` JSON field (no schema migration)
**Testing**: Manual validation via live test UI + Hostaway API integration
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goals**: <3s additional latency when tool is invoked (SC-005); zero latency impact on messages that don't trigger the tool
**Constraints**: Hostaway API rate limits; Anthropic API cost (~$0.003-0.007 per tool-use round-trip on Haiku)
**Scale/Scope**: 5-50 properties per tenant, 1 new tool definition, 5 backend files modified, 2 new backend files, 1 new frontend component, 1 frontend component modified

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | FR-014: if tool search fails/times out, AI still responds helpfully and escalates. Tool failure never blocks the guest message flow. |
| II. Multi-Tenant Isolation | PASS | Tool handler filters properties by `tenantId`. Hostaway API called with per-tenant credentials. No cross-tenant data leakage. |
| III. Guest Safety & Access Control | PASS | Tool results include property names and booking links only — no access codes, no pricing, no sensitive data. Channel-aware links prevent Airbnb TOS violations. |
| IV. Structured AI Output | PASS | Final response is still the standard JSON format (`guest_message`, `escalation`, etc.). Tool use is an intermediate step; the final output schema is unchanged. |
| V. Escalate When In Doubt | PASS | Property-switch requests create Task records via existing escalation flow. If no matches found, AI offers to escalate manually. |
| VI. Observability by Default | PASS | FR-015: tool usage logged in `ragContext` on AiApiLog (toolUsed, toolName, toolInput, toolResults, toolDurationMs). |
| VII. Self-Improvement with Guardrails | N/A | Tool use doesn't interact with the classifier self-improvement loop. |
| Security & Data Protection | PASS | No new secrets. Hostaway credentials already per-tenant. No access codes exposed in tool results. |
| Development Workflow | PASS | No schema migration needed. Feature branch workflow. |
| Cost Awareness | PASS | Tool use adds ~1 extra Haiku call when triggered (~$0.003). Only fires when Claude decides it's relevant — no cost on normal messages. |

**Post-design re-check**: All gates still pass. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/010-property-suggestions/
├── plan.md              # This file
├── research.md          # Phase 0: research decisions
├── data-model.md        # Phase 1: data model (no new tables)
├── quickstart.md        # Phase 1: validation steps
├── contracts/
│   └── tool-definition.md   # Phase 1: tool schema + response format
├── checklists/
│   └── requirements.md      # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts              # MODIFY: add tool_use loop to createMessage()
│   │   ├── property-search.service.ts # NEW: tool handler — amenity match + availability check
│   │   ├── hostaway.service.ts        # MODIFY: add listAvailableListings() function
│   │   └── import.service.ts          # MODIFY: capture listing URLs during import
│   ├── config/
│   │   └── amenity-synonyms.json      # NEW: amenity synonym mapping
│   └── types/
│       └── index.ts                   # MODIFY: add listing URL fields to HostawayListing
frontend/
├── components/
│   ├── ai-pipeline-v5.tsx             # MODIFY: show tool usage metadata in pipeline view
│   └── tools-v5.tsx                   # NEW: tools management/visibility section
```

**Structure Decision**: Web application (existing backend + frontend). No new directories — all changes fit within existing service/config/types structure. One new service file (`property-search.service.ts`) and one new config file (`amenity-synonyms.json`).

## Implementation Phases

### Phase A: Infrastructure — Tool Use Loop (Backend)

**Goal**: Enable Claude to call tools during message generation.

1. **Extend `createMessage()` in `ai.service.ts`**:
   - Add optional `tools` and `toolChoice` params to the options interface
   - Pass `tools` and `tool_choice` to `anthropic.messages.create()`
   - After response, check `stop_reason === 'tool_use'`
   - If tool_use: extract tool blocks → execute handler → build tool_result message → call Claude again
   - Cap at 1 tool-use loop (no recursion)
   - Log tool usage in ragContext

2. **Create tool handler registry**:
   - Map of `toolName → handler function`
   - Each handler receives tool input + request context → returns tool result string
   - Error handling: if handler throws, return error result to Claude (don't crash)

### Phase B: Property Search Tool (Backend)

**Goal**: Implement the `search_available_properties` tool handler.

1. **Create `property-search.service.ts`**:
   - `searchAvailableProperties(input, context)` function
   - Load all tenant properties from DB
   - Filter by city (parse from current property address)
   - Filter by amenity match using synonym map
   - Exclude current property
   - Filter by min_capacity (if specified)
   - Call Hostaway availability API for matching properties
   - Select channel-appropriate booking link
   - Return top 3 results formatted for Claude

2. **Create `amenity-synonyms.json`**:
   - Static config file with amenity → synonym array mapping
   - Loaded at startup, used by property search

3. **Add `listAvailableListings()` to `hostaway.service.ts`**:
   - `GET /v1/listings?availabilityDateStart=...&availabilityDateEnd=...`
   - Returns listing IDs that are available for the date range
   - Retry logic via existing `retryWithBackoff()`

### Phase C: Listing URL Import (Backend)

**Goal**: Capture booking links from Hostaway during property import.

1. **Update `import.service.ts`**:
   - Capture `listing.airbnbListingUrl` → `kb.airbnbListingUrl`
   - Capture `listing.vrboListingUrl` → `kb.vrboListingUrl`
   - Capture `listing.bookingEngineUrls` → `kb.bookingEngineUrl` (first/primary)

2. **Update HostawayListing type** in `types/index.ts`:
   - Add `airbnbListingUrl?: string`
   - Add `vrboListingUrl?: string`
   - Add `bookingEngineUrls?: unknown`

### Phase D: Wire Tool into Screening Agent (Backend)

**Goal**: Pass the tool definition to Claude only for INQUIRY-status conversations (screening agent).

1. **Update `generateAndSendAiReply()` in `ai.service.ts`**:
   - Define the `search_available_properties` tool schema
   - **Only pass `tools` when using the screening agent** (reservation status === INQUIRY)
   - Guest coordinator calls (CONFIRMED/CHECKED_IN) get NO tools — same as today
   - Screening system prompt addition: brief instruction about the property search tool

2. **Register tool handler**:
   - Map `"search_available_properties"` → `searchAvailableProperties()` from property-search.service
   - Pass reservation context (dates, channel, current property, tenant credentials) to handler

### Phase E: Observability & Pipeline View (Backend + Frontend)

**Goal**: Log tool usage and show it in the pipeline view.

1. **Extend `ragContext` in AiApiLog**:
   - Add `toolUsed`, `toolName`, `toolInput`, `toolResults`, `toolDurationMs`
   - Already logged via existing createMessage() logging path

2. **Update `ai-pipeline-v5.tsx`** (Frontend):
   - Show tool usage section when `ragContext.toolUsed === true`
   - Display: tool name, search criteria, properties returned, duration

### Phase F: Frontend Tools Section

**Goal**: Add a Tools management/visibility section to the dashboard.

1. **Create tools section** (new component or section within existing page):
   - List of available tools: name, description, status (enabled), agent scope (screening only)
   - Recent invocations table: timestamp, conversation link, search criteria, results count, duration
   - Pull data from AiApiLog entries where `ragContext.toolUsed === true`

2. **Add navigation**:
   - New "Tools" tab or section in the appropriate dashboard area

### Phase G: Validation & Edge Cases

**Goal**: Test all user stories and edge cases.

1. Re-import properties to capture listing URLs
2. Test US1: inquiry guest + missing amenity → suggestions with links
3. Test US2: follow-up questions → refined results
4. Test US3: guest interested → escalation task created with lead info
5. Test FR-010: confirmed guest asks same question → NO tool use, normal response
6. Test frontend: tools section shows invocations, pipeline view shows tool details
7. Test edge cases: single property tenant, no matches, tool timeout, missing URLs
