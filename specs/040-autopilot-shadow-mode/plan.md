# Implementation Plan: Autopilot Shadow Mode for AI Tuning

**Branch**: `040-autopilot-shadow-mode` | **Date**: 2026-04-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/040-autopilot-shadow-mode/spec.md`

## Summary

Shadow Mode is a tenant-wide toggle that replaces the **copilot** suggestion-card UI with **in-chat preview bubbles** during a tuning period. When the toggle is ON, copilot-generated AI replies appear inside the inbox chat as preview bubbles marked "Not sent to guest" — the most recent preview per conversation exposes Send and Edit actions; older previews become inert. When an edited preview is sent, a fire-and-forget **tuning analyzer** (`gpt-5.4-mini` with `reasoning: "high"`) compares the original AI draft against the final text in the context of the system prompt, SOPs consulted, FAQ entries, and tool-call trace — producing concrete EDIT or CREATE suggestions across system prompts, SOPs, SOP routing, and FAQs. Suggestions surface in a new **Tuning tab** inside AI settings where the admin can accept, reject, or edit-then-accept. When the toggle is OFF, copilot reverts to its existing suggestion-card flow unchanged. **Autopilot is completely out of scope** — Shadow Mode does not intercept autopilot because the message is already delivered to the guest by the time the feature could act. The feature is explicitly scoped as a short-lived diagnostic utility and is designed for clean retirement (new fields are nullable, new tables are additive, legacy copilot flow is preserved untouched).

**Technical approach**: piggyback on the existing `Message` model by adding four nullable columns (`previewState`, `originalAiText`, `editedByUserId`, `aiApiLogId`) rather than introducing a separate preview table. This keeps inbox rendering on a single query path and makes retirement trivial (drop the columns). Interception happens **inside the existing copilot branch** in `ai.service.ts` (around line 2099-2108): if `tenantConfig.shadowModeEnabled === true`, create the Message with `previewState=PREVIEW_PENDING`, broadcast it over the extended `'message'` socket event, emit `'shadow_preview_locked'` for any older pending previews, and return without invoking the legacy `PendingAiReply.suggestion` + `ai_suggestion` path. If the toggle is off, fall through to the existing copilot logic unchanged. Sending a preview is a new dedicated endpoint that atomically flips state and reuses the existing `hostawayService.sendMessageToConversation`. The analyzer is a new fire-and-forget service backed by `gpt-5.4-mini-2026-03-17` with `reasoning: "high"` and a `json_schema` structured output that maps 1:1 onto the `TuningSuggestion` action-type union from the spec.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, OpenAI SDK (Responses API), Socket.IO, BullMQ (optional); React 19, Tailwind 4, shadcn/ui
**Storage**: PostgreSQL via Prisma. Schema changes applied with `npx prisma db push` per constitution §Development Workflow.
**Testing**: Manual verification via sandbox + inbox + playwright against a scratch tenant; backend integration scripts under `backend/scripts/battle-test/` when useful. No formal test framework mandated.
**Target Platform**: Railway (backend), Vercel (frontend), modern browsers
**Project Type**: Web application (backend + frontend, existing monorepo layout)
**Performance Goals**: Preview rendering ≤5s after copilot AI generation completes (reuses the existing broadcast pathway); Send ≤5s end-to-end; tuning suggestion creation ≤30s after edited-Send
**Constraints**: Must not modify main guest messaging flow semantics; MUST NOT touch autopilot delivery; analyzer must be fire-and-forget (§I Graceful Degradation); all new models scoped by `tenantId` (§II); new Message columns must be nullable to allow clean retirement; must not alter escalation pathway (FR-004); legacy copilot suggestion-card flow must be preserved for toggle-off state (FR-003a)
**Scale/Scope**: Per-tenant, expected handful of active tenants using this feature simultaneously during tuning periods. Preview volume bounded by natural guest message rate (tens to low-hundreds per tenant per day).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| **I. Graceful Degradation** | Analyzer is a new fire-and-forget service (like `faq-suggest.service.ts`, `summary.service.ts`). Analyzer failures catch internally and never block Send. Preview rendering reuses the existing `'message'` socket event — if Socket.IO is down, the preview still lands in the DB and appears on next inbox fetch. Toggle is silent on failure. | ✅ Pass |
| **II. Multi-Tenant Isolation** | `TenantAiConfig.shadowModeEnabled` and the new `TuningSuggestion` table are per-tenant. Every new query filters by `tenantId` from JWT. Send endpoint verifies the preview's `tenantId` matches the caller's. Socket.IO broadcasts use `broadcastCritical(tenantId, ...)` — identical to the existing AI message path. | ✅ Pass |
| **III. Guest Safety & Access Control** | Shadow Mode *enhances* guest safety by adding the tuning analyzer on top of the existing copilot manual-approval gate. Autopilot behavior is untouched. Access-code redaction and screening rules are unchanged — they happen inside the AI generation step before any branching. | ✅ Pass (enhances) |
| **IV. Structured AI Output** | The tuning analyzer uses OpenAI `json_schema` with `strict: true` matching the `TuningSuggestion` action-type union. The main AI pipeline output format is unchanged. | ✅ Pass |
| **V. Escalate When In Doubt** | Escalation detection, task creation, and push notifications fire before the delivery branch and are untouched. FR-004 locks this in. The shadow-mode branch does not short-circuit any escalation code. | ✅ Pass |
| **VI. Observability by Default** | Preview generation already creates an `AiApiLog` entry via the existing AI call (the new branch is purely a delivery diversion, not a pipeline short-circuit). New `Message.aiApiLogId` column makes the log↔preview link explicit for the analyzer. Analyzer runs themselves create their own `AiApiLog` entry. Send events log success/failure to console with structured context. | ✅ Pass |
| **VII. Tool-Based Architecture** | Neutral — no tool-definition changes. The analyzer is a direct model call, not a tool call (it's post-hoc introspection, not runtime guest-reply generation). | ✅ Pass (neutral) |
| **VIII. FAQ Knowledge Loop** | **Architecturally isolated by construction**: the existing FAQ auto-suggest trigger lives in `messages.controller.ts` and runs only on manager replies posted via the manual send endpoint AND only when an open `info_request` task exists. The new Send endpoint for shadow previews is a separate route that does not call `processFaqSuggestion`. No suppression flag or conditional is needed — the two flows simply don't share code. **CREATE_FAQ accept path**: tuning-accepted FAQ entries are created with `source='MANUAL'` (not `AUTO_SUGGESTED`) and `status='ACTIVE'` because the admin has explicitly approved via the Tuning tab. This satisfies Principle VIII's literal rule ("auto-suggested entries MUST have status=SUGGESTED") since tuning-accepted entries are not "auto-suggested" in the `source` enum sense — they are manually reviewed and approved. | ✅ Pass |

**Verdict**: No violations. No Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/040-autopilot-shadow-mode/
├── plan.md              # This file
├── research.md          # Phase 0 output — key design decisions
├── data-model.md        # Phase 1 output — Prisma schema changes + new models
├── quickstart.md        # Phase 1 output — how to enable and use the feature
├── contracts/
│   ├── rest-api.md              # New HTTP endpoints
│   └── socket-events.md         # Extended + new Socket.IO events
├── checklists/
│   └── requirements.md  # (already present from /speckit.specify)
└── tasks.md             # Created by /speckit.tasks — NOT by this command
```

### Source Code (repository root)

```text
backend/
├── prisma/
│   └── schema.prisma                           # [MODIFIED] +4 fields on Message,
│                                               #  +shadowModeEnabled on TenantAiConfig,
│                                               #  +TuningSuggestion model + enums
├── src/
│   ├── services/
│   │   ├── ai.service.ts                       # [MODIFIED] modify the existing copilot
│   │   │                                       #  branch at ~line 2099: if shadowModeEnabled
│   │   │                                       #  run preview flow, else fall through to
│   │   │                                       #  legacy suggestion-card flow unchanged
│   │   ├── shadow-preview.service.ts           # [NEW] lock older previews helper,
│   │   │                                       #  send-preview orchestration,
│   │   │                                       #  fire-and-forget analyzer trigger
│   │   └── tuning-analyzer.service.ts          # [NEW] fire-and-forget analyzer:
│   │                                           #  builds context (AiApiLog lookup),
│   │                                           #  calls OpenAI with json_schema,
│   │                                           #  persists TuningSuggestion rows
│   ├── controllers/
│   │   ├── shadow-preview.controller.ts        # [NEW] POST /send endpoint
│   │   ├── tuning-suggestion.controller.ts     # [NEW] list, accept, reject endpoints
│   │   └── tenant-config.controller.ts         # [MODIFIED] extend update payload with
│   │                                           #  shadowModeEnabled
│   └── routes/
│       ├── shadow-preview.routes.ts            # [NEW]
│       └── tuning-suggestion.routes.ts         # [NEW]
└── scripts/
    └── (no new scripts needed)

frontend/
├── components/
│   ├── inbox-v5.tsx                            # [MODIFIED] render preview bubbles,
│   │                                           #  Send/Edit buttons on latest preview,
│   │                                           #  handle 'shadow_preview_locked' event,
│   │                                           #  discard in-progress edit on new preview
│   ├── configure-ai-v5.tsx                     # [MODIFIED] add Shadow Mode toggle row
│   ├── tuning-review-v5.tsx                    # [NEW] new tab: list + accept/reject/edit
│   │                                           #  suggestions grouped by source preview
│   └── [settings tab wrapper]                  # [MODIFIED] register new Tuning tab
└── lib/
    ├── api.ts                                  # [MODIFIED] apiSendShadowPreview,
    │                                           #  apiListTuningSuggestions,
    │                                           #  apiAcceptTuningSuggestion,
    │                                           #  apiRejectTuningSuggestion
    └── socket.ts                               # [MODIFIED] handle new socket events
```

**Structure Decision**: Standard GuestPilot web-application layout — no new top-level projects. All backend changes land in the existing `backend/src/{services,controllers,routes}` tree, and all frontend changes land in `frontend/components` and `frontend/lib`. Shadow Mode retirement = drop the 4 new Message columns, drop the `TuningSuggestion` table, drop `shadowModeEnabled`, and delete the 4 new backend files + 1 new frontend component + the modifications to 3 existing files. Zero orphaned behavior.

## Complexity Tracking

*No Constitution Check violations — section intentionally empty.*
