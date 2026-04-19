# Implementation Plan: Check-in Document Handoff via WhatsApp

**Branch**: `044-doc-handoff-whatsapp` | **Date**: 2026-04-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/044-doc-handoff-whatsapp/spec.md`

## Summary

Two scheduled, per-reservation WhatsApp sends via WAsender: a text reminder to the manager at `reminderTime` the day before check-in (only if a document checklist exists), and a media-rich handoff to security at `handoffTime` on check-in day (always, with whatever images were captured). A tenant-level settings block stores the two recipient numbers, two times, and on/off toggle. Image references (Hostaway message ID + imageUrl) are captured at the moment a passport or marriage certificate is marked received, stored alongside the existing checklist counts, and forwarded at send time. A per-reservation `DocumentHandoffState` row tracks scheduled/sent/failed state so each message fires exactly once. Sending is done by an in-process polling job on a 2-minute cadence (same pattern as `faqMaintenance.job.ts`) — no new infrastructure, no Redis requirement.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend). Same as CLAUDE.md.
**Primary Dependencies**: Express 4.x, Prisma ORM, axios (backend) + React 19, Tailwind 4, shadcn/ui (frontend). New external dependency: WAsender HTTP API (existing external account, credentials via env).
**Storage**: PostgreSQL via Prisma. Changes: two new columns on `Tenant` (manager recipient, security recipient, reminder HH:MM, handoff HH:MM, feature on/off) — actually four + bool = five fields. Extend `Reservation.screeningAnswers.documentChecklist` JSON structure with per-slot image refs (backward-compatible JSON extension, no schema migration needed for that). One new table `DocumentHandoffState` (reservation-scoped, holds per-message-type scheduled fire time, status, attempt count, last error, provider message ID). Applied with `npx prisma db push` per constitution §Development Workflow.
**Testing**: `npx tsc --noEmit` on both apps (backend + frontend) — parity with existing feature branches. Manual smoke runs via quickstart.md.
**Target Platform**: Railway-hosted backend, Vercel-hosted frontend. No new infra.
**Project Type**: Backend (Express REST + polling job) + frontend (Next.js settings page section).
**Performance Goals**: Each scheduled send delivered within 5 min of fire time at p95 (SC-002). Polling interval 2 min gives worst-case 2 min lag + send time ≈ under 3 min. Backend polling job scans only reservations with open `DocumentHandoffState` rows (indexed by `scheduledFireAt`) — cheap at any reasonable reservation volume.
**Constraints**: Must not crash `POST /webhooks/hostaway/:tenantId` processing nor block the AI pipeline (constitution §I). Must respect tenant isolation in every query (§II). Image references are URLs only — no raw image bytes stored (§Security & Data Protection).
**Scale/Scope**: ~hundreds of reservations/day/tenant at target scale. Polling scans ≤ ~1k rows per tick. No horizontal-scaling concerns for v1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### §I Graceful Degradation (NON-NEGOTIABLE) — **PASS**
- WAsender send failures are caught inside the job. An error bumps `attemptCount` on the handoff-state row; after 3 consecutive failures the row moves to `FAILED` and stops retrying.
- Missing `WASENDER_API_KEY` → the job logs the intended send and marks the row `SKIPPED_NO_PROVIDER` per FR-024 — never crashes.
- The webhook handler and AI pipeline are untouched. Image capture piggybacks on the existing `mark_document_received` and `manualUpdateChecklist` paths — any failure there is caught and logged without affecting the caller (§I fire-and-forget clause).
- The polling job is wrapped in try/catch per tick, matching `faqMaintenance.job.ts`.

### §II Multi-Tenant Isolation (NON-NEGOTIABLE) — **PASS**
- `DocumentHandoffState` carries `tenantId` and is indexed on it. Every query filters by `tenantId`.
- The polling job resolves each row's tenant from the row itself (never from global state).
- Tenant settings live on the existing `Tenant` row; reads go through the existing tenant-scoped request context.
- No cross-tenant broadcast events introduced.

### §III Guest Safety & Access Control (NON-NEGOTIABLE) — **PASS**
- No guest-facing message. FR-023 forbids sending anything to guests as part of this feature. Both recipients are operator-side (manager, security). Out of scope for §III's access-code gating (nothing access-code-adjacent is sent).
- Marriage certificate / passport images are the same PII that already flows through the pipeline today — we are forwarding references, not introducing new guest PII exposure.

### §IV Structured AI Output — **PASS (N/A)**
- This feature adds no new AI-generated content. It consumes the existing document-checklist state (produced by prior AI tool calls + manager overrides).

### §V Escalate When In Doubt — **PASS (N/A)**
- Not an escalation feature. The existing checklist + escalation mechanics are untouched.

### §VI Observability by Default — **PASS**
- Every send attempt writes a row (`DocumentHandoffState` updated with status, attemptCount, lastError, providerMessageId, sentAt). This is the audit trail.
- The polling job logs one line per tick summarising how many sends fired, skipped, failed — matches `[FAQ] Maintenance:` style.
- Sends are not put through `AiApiLog` — they're not AI calls. An operator-visible listing in the settings page (read-only list of recent handoff-state rows for a tenant) satisfies FR-019 without adding a new page.

### §VII Tool-Based Architecture — **PASS (N/A)**
- No new AI tool is added. The existing `mark_document_received` tool is extended only to pass the in-flight message ID through to the checklist update — a small non-behavioral tweak.

### §VIII FAQ Knowledge Loop — **PASS (N/A)**
- Unrelated feature area.

### §Security & Data Protection — **PASS (with note)**
- §Image handling requires: "Images MUST NOT be stored permanently beyond the AI call." We store URL references, NOT image bytes. This matches the spirit of the rule (we do not persist the image itself — the PMS does). The captured `hostawayMessageId` + `imageUrl` are lookups, not archives. User explicitly confirmed this retention posture during /clarify (Q3).
- WAsender credentials are env-only (`WASENDER_API_KEY`, `WASENDER_BASE_URL`). Never logged, never returned in API responses.

### §Development Workflow — **PASS**
- Prisma schema change applied with `npx prisma db push`, no data migration needed (new fields are nullable, new table is empty).
- `WASENDER_API_KEY` is an **optional** env — the feature disables silently if missing, matching the Redis/Langfuse pattern.

**Gate result: PASS. No violations. Complexity Tracking section omitted.**

## Project Structure

### Documentation (this feature)

```text
specs/044-doc-handoff-whatsapp/
├── plan.md              # This file
├── research.md          # WAsender API shape + scheduling-pattern decisions
├── data-model.md        # Entity changes + state machine for DocumentHandoffState
├── quickstart.md        # Manual verification walkthrough
├── contracts/
│   ├── settings-api.md        # GET/PUT /api/tenant-config/doc-handoff
│   ├── wasender-client.md     # Internal service contract for the provider client
│   └── handoff-state-events.md# Socket.IO events (optional, for UI refresh)
└── tasks.md             # (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── config/
│   │   └── doc-handoff-defaults.ts          # NEW — seeded defaults (reminder 22:00, handoff 10:00, phone regex)
│   ├── services/
│   │   ├── wasender.service.ts              # NEW — thin axios client; sendText, sendImage
│   │   ├── doc-handoff.service.ts           # NEW — schedule, evaluate, send, mark sent/failed
│   │   ├── document-checklist.service.ts    # MODIFIED — capture image refs on mark-received + manual-update
│   │   └── ai.service.ts                    # MODIFIED — tiny: pass current message ID through mark_document_received path
│   ├── jobs/
│   │   └── docHandoff.job.ts                # NEW — 2-min polling tick, wired in server.ts
│   ├── routes/
│   │   └── tenant-config.ts                 # MODIFIED — add /doc-handoff sub-routes
│   ├── controllers/
│   │   └── doc-handoff.controller.ts        # NEW — settings GET/PUT + recent-sends list
│   └── server.ts                            # MODIFIED — startDocHandoffJob()
└── prisma/
    └── schema.prisma                        # MODIFIED — Tenant fields + DocumentHandoffState table

frontend/
├── components/
│   └── settings/
│       └── doc-handoff-section.tsx          # NEW — new Settings section (recipients + times + toggle + recent sends log)
├── app/
│   └── settings/page.tsx                    # MODIFIED — mount <DocHandoffSection />
└── lib/
    └── api.ts                               # MODIFIED — apiGetDocHandoffConfig / apiPutDocHandoffConfig / apiListDocHandoffSends
```

**Structure Decision**: Matches the existing feature-043 shape — same backend-service + polling-job + settings-section split. No new directories, no new top-level modules.

## Complexity Tracking

> No constitutional violations. Section intentionally left empty.
