# Implementation Plan: AI-Powered Semantic Property Search

**Branch**: `031-ai-property-search` | **Date**: 2026-04-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/031-ai-property-search/spec.md`

## Summary

Replace the naive substring-based amenity matching in `search_available_properties` with a single gpt-5-nano semantic scoring call. Include the current property in search results (flagged, no booking link). Update the property-info SOP to guide the AI toward a dual-layer assessment: self-assess from SOP data, then confirm via search. Delete the synonym map and substring matching entirely.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+  
**Primary Dependencies**: Express 4.x, OpenAI SDK (Responses API), Prisma ORM, axios  
**Storage**: PostgreSQL (existing Property model with `customKnowledgeBase` JSON field, `listingDescription` text field)  
**Testing**: Manual testing via Sandbox endpoint + production inquiry conversations  
**Target Platform**: Railway (backend)  
**Project Type**: Web service (backend-only change — no frontend changes)  
**Performance Goals**: Search completes within 5 seconds for up to 30 properties  
**Constraints**: Per-search cost < $0.01, must not break existing tool interface  
**Scale/Scope**: 5-30 properties per tenant, ~5-10 searches per day

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | If nano scoring fails, search returns graceful error. AI falls back to SOP self-assessment. Fire-and-forget pattern respected. |
| §II Multi-Tenant Isolation | PASS | Property queries already scoped by tenantId. No change to tenant isolation. |
| §III Guest Safety | PASS | No access codes exposed. Search results contain only public property info. Current property has no booking link. |
| §IV Structured AI Output | PASS | Nano scoring uses json_schema enforcement for structured output. |
| §V Escalate When In Doubt | PASS | Empty search results → AI escalates to manager. Scoring failure → error returned. |
| §VI Observability | PASS | Scoring call logged via AiApiLog pattern. Tool call results visible in AI Logs. |
| §VII Tool-Based Architecture | PASS | Enhances existing search_available_properties tool. No new tools needed. Tool scope unchanged (INQUIRY, PENDING). |
| §VIII FAQ Knowledge Loop | N/A | No FAQ changes. |
| Cost Awareness | PASS | gpt-5-nano is the cheapest model ($0.05/1M tokens). One call per search, ~500-2000 tokens input. |

**All gates pass. No violations.**

## Project Structure

### Documentation (this feature)

```text
specs/031-ai-property-search/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: research findings
├── data-model.md        # Phase 1: data model (minimal — no schema changes)
├── contracts/           # Phase 1: tool output contract
├── quickstart.md        # Phase 1: test scenarios
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── property-search.service.ts    # REWRITE: replace substring matching with nano scoring
│   │   └── sop.service.ts               # EDIT: update property-info SOP text
│   └── config/
│       └── amenity-synonyms.json         # DELETE: no longer needed
```

**Structure Decision**: Backend-only change. Two files modified, one file deleted. No new files needed — the scoring logic lives inside the existing property-search service.
