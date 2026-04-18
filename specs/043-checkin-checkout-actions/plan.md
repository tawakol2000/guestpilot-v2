# Implementation Plan: Check-in / Check-out Time Accept-Reject Workflow

**Branch**: `043-checkin-checkout-actions` | **Date**: 2026-04-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/043-checkin-checkout-actions/spec.md`

## Summary

Build a **generalized action-card framework** in the inbox that handles late-checkout and early-check-in time requests as its two first concrete types, with per-tenant editable approval/rejection templates, per-property auto-accept thresholds, and a `Reservation.scheduledCheckInAt` / `scheduledCheckOutAt` override stored as HH:MM strings. The AI proposes scheduled times via a new field in its existing structured JSON output (not a mid-turn tool call — same pattern as `escalation`, `resolveTaskId`, `updateTaskId`). The server-side pipeline reads that field, consults the property threshold, and either (a) auto-writes the override + sends the approval template, or (b) creates a Task of the appropriate type carrying the requested time in a new `Task.metadata` JSON field. The manager's Accept → edit preview → Send path writes through a new controller. The Property details card on the right panel reads the reservation override when present and renders it with a visually-distinct "Modified" treatment. The existing alteration flow moves behind one lane of the same polymorphic renderer without behavior changes.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend) — same as CLAUDE.md.
**Primary Dependencies**: Express 4.x, Prisma ORM, OpenAI SDK (Responses API + strict json_schema), Socket.IO, axios (backend); React 19, Tailwind 4, shadcn/ui, existing `inbox-v5.tsx` Actions-card region (frontend).
**Storage**: PostgreSQL via Prisma. New fields on `Property` (×2), `Tenant` (×2 fallback), `Reservation` (×2 override). Extend `Task` with `metadata Json?` + new values for the existing `type String` column. One new table `AutomatedReplyTemplate`.
**Testing**: Manual verification per [quickstart.md](./quickstart.md). No new automated suite added; the existing alteration-flow test checklist is re-run as a regression gate.
**Target Platform**: Web inbox (Next.js) + backend pipeline running on Railway. iOS app is NOT updated in this feature — the new reservation fields are nullable so the iOS read path is unaffected.
**Project Type**: Web application (backend + frontend).
**Performance Goals**:
- Manager Accept → Send completes within 10s from inbox open (SC-002). Primary cost: single Hostaway outbound send; one Prisma update; one Socket.IO broadcast. No AI call in the Accept path.
- Auto-accept adds zero extra round-trips to the AI turn — the scheduled time arrives in the same JSON output as the reply content; the pipeline handler is in-process.
- Property card "modified" indicator visible in acting session within 1s; other managers within 5s via existing Socket.IO `task_resolved` / new `reservation_scheduled_updated` event (SC-005).
**Constraints**:
- Graceful degradation (§I): if template rendering fails or provider fails, fall back to the manual path; never block the main messaging pipeline. Auto-accept errors silently degrade to escalation.
- Multi-tenant isolation (§II): every query filters by tenantId. New `AutomatedReplyTemplate` table joins to Tenant via `onDelete: Cascade`.
- Guest safety (§III): AI never guarantees service times autonomously; the auto-accept threshold is an explicit operator-configured policy and the AI mirrors it. Outside the policy the AI always escalates. Explicit policy-as-authority carve-out, captured in Decision 1 of `research.md`.
- §IV structured output: new optional field `scheduledTime` added to the coordinator JSON schema via `anyOf` so older schemas continue to validate; strict mode preserved.
- §VI observability: auto-accept and manual accept both write an `AiApiLog.ragContext` entry recording the matched threshold + template id + delivered time.
- No alteration-flow regression (FR-026/FR-031 / SC-003) — existing `BookingAlteration` card renders unchanged behind the new polymorphic renderer's `alteration` lane.
**Scale/Scope**: Per-tenant, per-conversation. Typical tenant has <100 active conversations and maybe 0–5 open escalations at a time. Template reads are cache-friendly (single row per tenant × type × decision).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Compliance |
|---|---|---|
| **I. Graceful Degradation (NON-NEGOTIABLE)** | Yes | ✅ All new paths catch and log errors. Auto-accept is fire-and-forget in the pipeline — if it raises, the AI still produces a normal escalation. The Accept/Reject controller returns 5xx on failure without mutating state (write happens only if the Hostaway send succeeds). |
| **II. Multi-Tenant Isolation (NON-NEGOTIABLE)** | Yes | ✅ `AutomatedReplyTemplate.tenantId` with cascade delete. `POST /api/tasks/:id/accept\|reject` resolves the task via `{ id, tenantId }`. The `scheduledCheckInAt`/`scheduledCheckOutAt` additions live on `Reservation` which is already tenant-scoped. |
| **III. Guest Safety & Access Control (NON-NEGOTIABLE)** | Yes | ✅ Policy-as-authority: auto-accept is only enabled when an operator explicitly configures a threshold. Auto-reject is forbidden (FR-014). Rejection is always a human action. Templates can mention fees as copy but no fee-collection automation. No impact on access-code gating. |
| **IV. Structured AI Output** | Yes | ✅ Coordinator JSON schema extended with optional `scheduledTime: { kind: 'check_in'|'check_out', time: string (HH:MM) } \| null` via an additionalProperties-false object. Strict mode preserved. Schema versioning: old JSON without the field continues to validate since the field is nullable-optional. |
| **V. Escalate When In Doubt** | Yes | ✅ Any ambiguous time parse, any out-of-threshold request, any template render failure, any provider error → escalate to the manager's Actions card (the existing path). Never silently drop or silently auto-reject. |
| **VI. Observability by Default** | Yes | ✅ Every pipeline decision (auto-accept vs escalate) appends a `ragContext.timeRequestDecision = { matchedThreshold, scheduledTime, templateId, delivered }` entry. Manager Accept/Reject writes a separate `TaskActionLog` row mirroring `AlterationActionLog` for audit parity. |
| **VII. Tool-Based Architecture** | No | ✅ Deliberate: we add a *structured-output field*, not a tool. Rationale: a tool would add a mid-turn round-trip and cost for a scalar decision the AI already has at end-of-turn. Matches how `escalation`, `resolveTaskId`, and `updateTaskId` already work. |
| **VIII. FAQ Knowledge Loop** | No | N/A. |
| **Security & Data Protection** | Yes | ✅ No new secrets. Template bodies are tenant-scoped and not PII-heavy (they contain manager-authored copy with guest-name substitution). No new external service. |
| **Development Workflow** | Yes | ✅ Schema change applied via `npx prisma db push`. New fields are all nullable/optional → no data migration required. Feature branch merges directly to `advanced-ai-v7` per branch strategy. |

**Gate result**: PASS with one explicit note on §III (policy-as-authority for auto-accept). `research.md` Decision 1 captures the rationale. No violations, no unresolved clarifications. Complexity Tracking section omitted.

## Project Structure

### Documentation (this feature)

```text
specs/043-checkin-checkout-actions/
├── plan.md                    # This file
├── spec.md                    # Feature specification (complete, clarified)
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
├── contracts/
│   ├── task-actions-api.md    # POST /api/tasks/:id/{accept,reject,preview}
│   └── reply-templates-api.md # GET/PUT /api/tenant-config/reply-templates
├── checklists/
│   └── requirements.md        # Spec-quality checklist (from /speckit.specify)
└── tasks.md                   # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/
├── prisma/
│   └── schema.prisma                           # MODIFIED:
│                                                #  - Property: +autoAcceptLateCheckoutUntil String?, +autoAcceptEarlyCheckinFrom String?
│                                                #  - Tenant:   +autoAcceptLateCheckoutUntil String?, +autoAcceptEarlyCheckinFrom String? (defaults)
│                                                #  - Reservation: +scheduledCheckInAt String?, +scheduledCheckOutAt String?
│                                                #  - Task: +metadata Json?
│                                                #  + new model AutomatedReplyTemplate (tenantId, escalationType, decision, body)
│                                                #  + new model TaskActionLog (audit parity with AlterationActionLog)
├── src/
│   ├── controllers/
│   │   ├── task-actions.controller.ts          # NEW: accept / reject / preview handlers for time-request tasks
│   │   └── reply-templates.controller.ts       # NEW: CRUD for AutomatedReplyTemplate
│   ├── routes/
│   │   └── tasks.ts                            # MODIFIED (or NEW): add POST /api/tasks/:id/accept, /reject, /preview
│   ├── services/
│   │   ├── ai.service.ts                       # MODIFIED: extend coordinator json_schema with scheduledTime; post-parse handler
│   │   ├── scheduled-time.service.ts           # NEW: policy evaluator (threshold lookup, compare, write, send template)
│   │   ├── reply-template.service.ts           # NEW: render body with variable substitution; read tenant row with fallback to system default
│   │   ├── task-manager.service.ts             # MODIFIED: recognize new task types; metadata-aware dedup (update requestedTime on re-request)
│   │   └── template-variable.service.ts        # MODIFIED: resolve {CHECK_IN_TIME}/{CHECK_OUT_TIME} from reservation override → property default
│   └── config/
│       └── reply-template-defaults.ts          # NEW: hardcoded system defaults per (escalationType, decision)

frontend/
├── components/
│   ├── inbox-v5.tsx                            # MODIFIED: Actions card renders polymorphic registry;
│   │                                            #   alteration lane wraps existing code (zero behavior change);
│   │                                            #   new lane for late_checkout_request / early_checkin_request
│   ├── actions/
│   │   ├── action-card-registry.ts             # NEW: type → renderer map
│   │   ├── alteration-action-card.tsx          # NEW: extracted from inbox-v5.tsx (refactor only, no behavior change)
│   │   └── time-request-action-card.tsx       # NEW: Accept/Reject → editable textarea preview → Send/Cancel
│   ├── property-details-card.tsx               # MODIFIED (or inline in inbox-v5.tsx): render scheduledCheckInAt/Out with "Modified" treatment
│   └── settings/
│       └── automated-replies-section.tsx       # NEW: list + edit textareas per (escalationType, decision)
└── lib/
    └── api.ts                                  # MODIFIED: add apiPreviewTaskReply, apiAcceptTask, apiRejectTask,
                                                 #          apiListReplyTemplates, apiUpdateReplyTemplate
```

**Structure Decision**: Web application (existing). The biggest structural change is the frontend refactor — the Actions-card logic currently sits inline in `inbox-v5.tsx` and is tightly coupled to alteration state. We extract it into `components/actions/` with a registry. Backend adds one service file, one controller file, and extends two existing services. Schema change is four nullable additions + one new table + one audit-log table. No destructive migration.

## Complexity Tracking

*Constitution Check passed with no violations — section intentionally empty.*

The §III carve-out (policy-as-authority for auto-accept) is captured as an explicit clarification in the spec and elaborated in `research.md` Decision 1, not a constitutional violation.
