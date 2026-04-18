# Implementation Plan: Translation Toggle in Inbox

**Branch**: `042-translation-toggle` | **Date**: 2026-04-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/042-translation-toggle/spec.md`

## Summary

Wire the existing inbox Translate toggle (currently only a client-side `useState` boolean) to a working read-side translation flow. When on, every inbound guest message bubble shows its English translation directly below the original, de-emphasized. Translations are computed server-side once per message, **persisted on the `Message` row**, and served identically to the web inbox and iOS app. Outbound translation is explicitly not part of this feature — the guest's own platform (Airbnb/Booking.com) handles that.

**Technical approach**:
1. Add `contentTranslationEn String?` (nullable) to `Message` in Prisma.
2. Extract the current inline translate call (free Google endpoint) into a new `backend/src/services/translation.service.ts` with a `TranslationProvider` interface and a `GoogleFreeTranslationProvider` default implementation — so swapping providers later is a one-file change.
3. Replace the ad-hoc `POST /api/conversations/:id/translate-message` (takes raw content, returns translation, stores nothing) with a message-scoped `POST /api/messages/:messageId/translate` that reads the message, returns cached translation if `contentTranslationEn` is already set, else calls the provider, persists the result on the Message row, and returns it. Tenant-scoped via JWT per Constitution §II.
4. Frontend: when the Translate toggle flips on for a conversation, request translations for every inbound (`GUEST` role) message that lacks `contentTranslationEn`. When a new inbound message arrives via Socket.IO while the toggle is on, request its translation on arrival. Render original + translation inline in the bubble.
5. Persist toggle state per-conversation in `localStorage` keyed `gp-translate-on:{conversationId}`.
6. The existing `translateAndSend` controller (outbound AI rewrite) is orthogonal and remains untouched — not reachable from the Translate toggle.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, axios (backend); React 19, Tailwind 4, existing inbox-v5 bubble rendering (frontend)
**Storage**: PostgreSQL via Prisma — one new nullable column `Message.contentTranslationEn String?`. Applied with `npx prisma db push` per constitution §Development Workflow. No migration of existing rows required (null = not yet translated, lazily filled).
**Testing**: Manual verification via the dev preview (start backend + frontend, open a conversation with non-English messages, toggle on). Backend: no formal unit test framework is in use for this style of change; quickstart.md covers the verification steps.
**Target Platform**: Web inbox (Next.js) + iOS app (consumes the same `/messages/:id/translate` endpoint and the `contentTranslationEn` field returned by the existing message-fetch endpoints).
**Project Type**: Web application (backend + frontend) — existing structure.
**Performance Goals**:
- Toggle visual feedback < 200ms (FR-015).
- On first toggle-on for a conversation with N untranslated inbound messages, translations load progressively without blocking initial paint (FR-016); N parallel requests capped at 4 in-flight at a time to avoid hammering the free Google endpoint.
- A given message id is translated at most once in its lifetime across all managers/devices/sessions (SC-005).
**Constraints**:
- Graceful degradation (Constitution §I): translation failure for any message must not block message display or affect unrelated features. The translate endpoint catches all errors and returns 502 with a structured body the client renders as an inline "Translation unavailable + retry" chip (FR-008).
- Multi-tenant isolation (Constitution §II): the translate endpoint MUST resolve `Message` via `{ id, tenantId }` — never by id alone.
- Never break messaging flow (Constitution §I): translate writes update a nullable column; if the DB update fails after the provider returned text, we still return the translation to the client (best-effort persist).
- No guest-facing exposure: translations are advisory for managers; they are never sent to the guest, never included in outbound content, and not shown on the guest's platform.
**Scale/Scope**: Inbox-level feature. Active conversations per manager ≈ tens to low hundreds; inbound messages per long conversation ≈ 50–200. Translation provider calls are bounded by `COUNT(inbound guest messages lacking a translation)` — capped once per message forever.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Compliance |
|---|---|---|
| **I. Graceful Degradation (NON-NEGOTIABLE)** | Yes | ✅ Translation is advisory. Provider failures are caught, returned as structured errors, rendered as non-blocking inline retry chips per message (FR-007, FR-008). Best-effort persistence: if `prisma.update` fails, client still gets the translated text. The Translate toggle does not alter any other code path, so the main messaging flow is unaffected whether on or off. |
| **II. Multi-Tenant Isolation (NON-NEGOTIABLE)** | Yes | ✅ `POST /api/messages/:messageId/translate` resolves the message via `prisma.message.findFirst({ where: { id, tenantId } })`. The new column `Message.contentTranslationEn` is part of the already tenant-scoped `Message` model (cascades via conversation → tenant). No cross-tenant reads or writes possible. |
| **III. Guest Safety & Access Control (NON-NEGOTIABLE)** | Yes | ✅ Translations are computed from already-delivered guest messages and shown only to the authenticated manager. They are never sent to the guest, never rendered in outbound content, and never affect access-code gating (status-based gating is entirely in the send path, which this feature does not touch). |
| **IV. Structured AI Output** | No | N/A — the inbound translation provider is not an OpenAI call; it returns plain text from a translation API. |
| **V. Escalate When In Doubt** | No | N/A — feature does not alter escalation logic. |
| **VI. Observability by Default** | Yes | ✅ Translate endpoint logs one line per call with `{ messageId, tenantId, ms, cached: boolean, ok: boolean }` via the existing logger. It does NOT write to `AiApiLog` because this is not an AI call. Rationale: `AiApiLog` is already large; translation calls are high-volume, low-signal, and a one-line structured log is the right weight. |
| **VII. Tool-Based Architecture** | No | N/A — translation is a read-side UI affordance, not an AI tool. |
| **VIII. FAQ Knowledge Loop** | No | N/A. |
| **Security & Data Protection** | Yes | ✅ No new secrets. The free Google endpoint needs no API key. If/when the provider is swapped to Google Cloud Translation, the plan is to add `GOOGLE_TRANSLATE_API_KEY` as an optional env var and have `translation.service.ts` silently fall back to the free provider if unset (mirrors the Redis/Langfuse pattern). |
| **Development Workflow** | Yes | ✅ Schema change applied via `npx prisma db push`. Direct merge of feature branch to `main` per branch strategy. New nullable column is non-destructive; no data migration. |

**Gate result**: PASS — no violations, no `NEEDS CLARIFICATION` markers. Complexity Tracking section omitted.

## Project Structure

### Documentation (this feature)

```text
specs/042-translation-toggle/
├── plan.md              # This file
├── spec.md              # Feature specification (complete)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── translate-message.md   # POST /api/messages/:id/translate contract
├── checklists/
│   └── requirements.md  # Spec-quality checklist (from /speckit.specify)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/
├── prisma/
│   └── schema.prisma                    # MODIFIED: add Message.contentTranslationEn
├── src/
│   ├── controllers/
│   │   └── messages.controller.ts       # MODIFIED: replace translateMessage with messageTranslate (message-scoped, caches)
│   ├── routes/
│   │   ├── conversations.ts             # MODIFIED: remove POST /:id/translate-message route
│   │   └── messages.ts                  # MODIFIED (or NEW route file if missing): add POST /:messageId/translate
│   └── services/
│       └── translation.service.ts       # NEW: TranslationProvider interface + GoogleFreeTranslationProvider

frontend/
├── components/
│   └── inbox-v5.tsx                     # MODIFIED: wire translateActive toggle; render original + translation stacked; persist per-conversation toggle state
└── lib/
    └── api.ts                           # MODIFIED: replace apiSendThroughAI with apiTranslateMessage({ messageId }) → { translated }
```

**Structure Decision**: Web application (existing structure). Backend adds one service file and one nullable Prisma field; backend controller and routes swap one endpoint for a message-scoped equivalent. Frontend changes are confined to `inbox-v5.tsx` (rendering + toggle-on side-effect) and `lib/api.ts` (API client helper). The existing `translateAndSend` controller/route for outbound AI rewrite is deliberately NOT touched — per spec, it is orthogonal and not part of this feature.

## Complexity Tracking

*Constitution Check passed with no violations — section intentionally empty.*
