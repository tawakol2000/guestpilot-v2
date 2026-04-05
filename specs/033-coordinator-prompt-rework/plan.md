# Implementation Plan: Coordinator Prompt Rework with Reasoning

**Branch**: `033-coordinator-prompt-rework` | **Date**: 2026-04-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/033-coordinator-prompt-rework/spec.md`

## Summary

Rewrite the coordinator system prompt with chain-of-thought reasoning, escalation ladder, structured notes, tone calibration, and conversation repair. Add reasoning to all tool definitions. Add a reasoning effort selector (low/medium). Strip reasoning before Hostaway send, include in SSE broadcast, add settings toggle for chat UI visibility.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)  
**Primary Dependencies**: Express 4.x, OpenAI SDK (Responses API), Prisma ORM, axios (backend); React 19, Tailwind 4, shadcn/ui (frontend)  
**Storage**: PostgreSQL + Prisma ORM (new field on TenantAiConfig)  
**Testing**: Manual testing via Sandbox endpoint + production conversations  
**Target Platform**: Railway (backend), Vercel (frontend)  
**Project Type**: Full-stack (backend prompt/schema/pipeline + frontend settings toggle + inbox display)  
**Performance Goals**: No increase in response latency for simple messages  
**Constraints**: Per-message cost must not increase for simple messages  
**Scale/Scope**: ~100-200 AI messages/day across all tenants

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Reasoning effort selector defaults to "low" on failure. Empty reasoning field doesn't crash pipeline. Reasoning parameter unsupported → skipped silently. |
| §II Multi-Tenant Isolation | PASS | Settings toggle is per-tenant (TenantAiConfig). No cross-tenant data exposure. |
| §III Guest Safety | PASS | Reasoning field stripped before Hostaway send — never exposed to guests. Safety escalation remains top of ladder. |
| §IV Structured AI Output | PASS | Reasoning field added to existing json_schema with strict: true. Schema enforcement preserved. |
| §V Escalate When In Doubt | PASS | Escalation ladder codifies "uncertain → info_request" as the default. Over-escalation preserved. |
| §VI Observability | PASS | Reasoning field logged in AI Logs. Tool call reasoning logged in ragContext. Reasoning effort level logged. |
| §VII Tool-Based Architecture | PASS | Tool definitions enhanced with reasoning + CALL/DO NOT CALL. No new tools. |
| §VIII FAQ Knowledge Loop | N/A | No FAQ changes. |
| Cost Awareness | PASS | Reasoning effort "low" for 90% of messages. "Medium" only for complex turns. |

**All gates pass. No violations.**

## Project Structure

### Documentation (this feature)

```text
specs/033-coordinator-prompt-rework/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: research findings
├── data-model.md        # Phase 1: data model
├── contracts/           # Phase 1: schema contract
├── quickstart.md        # Phase 1: test scenarios
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts                 # EDIT: new prompt, schema, reasoning effort, strip reasoning, SSE broadcast
│   │   └── tool-definition.service.ts    # EDIT: add reasoning to tools, richer descriptions
│   └── routes/
│       └── sandbox.ts                    # EDIT: update schema to include reasoning field
├── prisma/
│   └── schema.prisma                     # EDIT: add showAiReasoning to TenantAiConfig

frontend/
├── components/
│   ├── inbox-v5.tsx                      # EDIT: show reasoning in chat when toggle on
│   └── configure-ai-v5.tsx              # EDIT: add reasoning toggle to settings
```

**Structure Decision**: Full-stack. Backend: 3 files edited + schema. Frontend: 2 components edited.
