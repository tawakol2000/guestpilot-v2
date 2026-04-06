# Implementation Plan: Perfect AI Mix

**Branch**: `037-perfect-ai-mix` | **Date**: 2026-04-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/037-perfect-ai-mix/spec.md`

## Summary

Restore the old system's schema simplicity (4 fields coordinator, 2 fields screening) and XML-structured prompt design while keeping v4's infrastructure improvements (pre-computed context, deferred tool schema enforcement, screening state tracking, conversation summary injection, pre-response sync, FAQ tool, dynamic reasoning effort). Add a new code-tracked screening state service that replaces the unreliable model self-report booleans with deterministic GATHER/DECIDE/POST_DECISION phases.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, OpenAI SDK (Responses API), Prisma ORM, Next.js 16 + React 19
**Storage**: PostgreSQL + Prisma ORM, Redis (optional — BullMQ)
**Testing**: Battle test scripts (scripts/battle-test/), Sandbox endpoint
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (backend API) + web application (frontend)
**Performance Goals**: Response time within 20% of pre-v4 system, token cost within 15%
**Constraints**: Must not break main guest messaging flow (Constitution §I), must preserve credential gating (Constitution §III)
**Scale/Scope**: Single tenant in production, ~20 properties, ~100 active conversations

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | All new features (screening state, pre-computed context, summary) fail silently. Pipeline continues if any component errors. |
| §II Multi-Tenant Isolation | PASS | No changes to tenant scoping. Screening state queries are conversation-scoped. |
| §III Guest Safety & Access Control | PASS | Restores deterministic credential gating via status-specific SOP variants. Removes v4's probabilistic model-filtering of access codes. |
| §IV Structured AI Output | PASS | Keeps strict JSON schema enforcement. Schema fields reduced (4 coordinator, 2 screening) but all required fields preserved. `guest_message` rename is a minor schema change. |
| §V Escalate When In Doubt | PASS | Escalation triggers simplified to 3 rules but coverage is equivalent. Urgency derivation from title preserves proper categorization. |
| §VI Observability by Default | PASS | Action and sop_step derived in code and stored in ragContext. Screening state logged. Reasoning from API parameter available in logs. |
| §VII Tool-Based Architecture | PASS | Keeps get_sop tool-first pattern. Adds get_faq. Deferred schema enforcement enables proper tool chaining. Removes search_available_properties from INQUIRY scope (narrows, doesn't violate). |
| §VIII FAQ Knowledge Loop | PASS | get_faq tool enables FAQ retrieval. No changes to FAQ suggest pipeline. |

**Gate Result: ALL PASS. No violations. Proceeding to Phase 0.**

## Project Structure

### Documentation (this feature)

```text
specs/037-perfect-ai-mix/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts              # Schema, prompts, pipeline changes (MAIN FILE)
│   │   ├── screening-state.service.ts # NEW: code-tracked screening state
│   │   ├── sop.service.ts             # SOP content + variant updates
│   │   ├── template-variable.service.ts # Register new variables
│   │   └── tool-definition.service.ts # Tool scope changes
│   └── routes/
│       └── sandbox.ts                 # Sandbox parity updates
├── prisma/
│   └── schema.prisma                  # showAiReasoning field
└── scripts/
    └── battle-test/                   # Testing infrastructure

frontend/
├── components/
│   ├── inbox-v5.tsx                   # Reasoning display
│   ├── configure-ai-v5.tsx            # Reasoning toggle, BLOCK_VARIABLES
│   └── sandbox-chat-v5.tsx            # Sandbox meta forwarding
└── lib/
    └── api.ts                         # Type updates
```

**Structure Decision**: Existing web application structure (backend/ + frontend/). New file: `screening-state.service.ts`. All other changes are modifications to existing files.

## Complexity Tracking

No constitution violations. No complexity justifications needed.
