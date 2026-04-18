---

description: "Tasks for 042-translation-toggle"
---

# Tasks: Translation Toggle in Inbox

**Input**: Design documents from `/specs/042-translation-toggle/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/translate-message.md](./contracts/translate-message.md)

**Tests**: Not requested. No automated test tasks are generated; verification is via [quickstart.md](./quickstart.md).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2)
- Exact file paths included in every task description

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No new project scaffolding needed — backend and frontend dev envs already exist and are running per CLAUDE.md. This phase only captures the one shared service scaffold.

- [X] T001 [P] Create `backend/src/services/translation.service.ts` with the `TranslationProvider` interface and a `GoogleFreeTranslationProvider` class that wraps the existing unofficial Google Translate call (currently inlined in `translateMessage` at `backend/src/controllers/messages.controller.ts:446`). Export a module-level `translationService` constant bound to the Google provider. Include a one-line structured log per successful call (`[Translation] provider=google ms=<> ok=<>`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema + routing substrate that both user stories depend on. Must complete before any US-labeled task.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Add nullable `contentTranslationEn String? @db.Text` field to the `Message` model in `backend/prisma/schema.prisma` (place it after the existing Feature 041 `confidenceScore` field, with a short comment labelling it Feature 042). Do NOT add an index.
- [X] T003 Apply the schema change locally: run `cd backend && npx prisma db push` and then `npx prisma generate` so the Prisma client types reflect the new column. Verify in Prisma Studio that the `Message` table shows the new column and existing rows are `null`.
- [X] T004 Register a new Express route file for message-scoped endpoints: create `backend/src/routes/messages.ts` exporting a router mounted at `/api/messages`, and wire it into the app bootstrap in `backend/src/index.ts` (or wherever routes are currently mounted, matching the pattern used by `conversations.ts`). Router body initially empty; the US1 task adds the translate route.

**Checkpoint**: DB has the new column; `/api/messages` router is mounted and returns 404 on any path (since no routes are declared yet). User Story 1 can now begin.

---

## Phase 3: User Story 1 — Read guest messages in English on demand (Priority: P1) 🎯 MVP

**Goal**: Manager flips the Translate toggle in a conversation header; every inbound guest message shows its English translation directly below the original inside the same bubble. Translations are computed server-side once per message and persisted on the `Message` row.

**Independent Test**: Open a conversation with non-English guest messages, click the Translate button, verify each bubble shows original + de-emphasized English translation below it. Reload the page and verify translations render instantly from cache. Open the same conversation in a second browser session — translations render instantly there too (served from the persisted column). Stop here and the feature is usable on its own; no other story needs to ship for this to deliver value.

### Backend

- [X] T005 [US1] In `backend/src/controllers/messages.controller.ts`, add a new controller method `translateMessageById(req, res)`. It MUST: (a) read `messageId` from `req.params`; (b) resolve the message via `prisma.message.findFirst({ where: { id: messageId, tenantId: req.tenantId } })` returning 404 if absent (generic error message, no tenant leakage); (c) return 400 if `message.role !== 'GUEST'` or `!message.content?.trim()`; (d) if `message.contentTranslationEn` is non-null, respond 200 with `{ messageId, translated: message.contentTranslationEn, cached: true }`; (e) else call `translationService.translate(message.content, { targetLang: 'en' })`, persist via `prisma.message.update({ where: { id: messageId }, data: { contentTranslationEn: translated } })` (best-effort — if the update throws, log and still return the translation), respond 200 with `{ messageId, translated, cached: false, sourceLanguage }`; (f) on provider error, log and return 502 `{ error: 'Translation provider unavailable' }`; (g) emit one log line per call per the observability section of `contracts/translate-message.md`.
- [X] T006 [US1] In `backend/src/routes/messages.ts`, register `router.post('/:messageId/translate', ((req, res) => msgCtrl.translateMessageById(req as unknown as AuthenticatedRequest, res)) as RequestHandler)`. Reuse the `messageSendLimiter` rate-limit middleware already applied to existing message routes so the free Google endpoint cannot be pounded from a single client.
- [X] T007 [P] [US1] In `backend/src/controllers/messages.controller.ts`, delete the old `translateMessage` controller method (currently at lines ~446–464 — the one that accepts raw `{ content }` in the request body) since it is superseded by the new message-scoped endpoint. Also remove the Google-Translate axios call from this file; the only remaining caller is now `translation.service.ts`.
- [X] T008 [P] [US1] In `backend/src/routes/conversations.ts`, delete the `router.post('/:id/translate-message', ...)` line (currently at ~line 28). The replacement route lives under `/api/messages` (T006).
- [X] T009 [US1] Ensure the existing message-fetch endpoints include `contentTranslationEn` in their response shape. Audit `backend/src/controllers/messages.controller.ts` (message list endpoint) and `backend/src/controllers/conversations.controller.ts` (conversation detail endpoint) — if they use explicit Prisma `select`, add `contentTranslationEn: true`. If they return the full Message object, no change required. Confirm the field shows up in the Network tab of the web app when opening a conversation.

### Frontend — API client

- [X] T010 [P] [US1] In `frontend/lib/api.ts`: replace the misleadingly-named `apiSendThroughAI` export (currently posts to `/conversations/:id/messages/translate`, ~line 838) with a new `apiTranslateMessage(messageId: string)` that does `POST /api/messages/:messageId/translate` and returns `{ messageId: string; translated: string; cached: boolean; sourceLanguage?: string }`. Update the `ApiMessage` type (same file) to include an optional `contentTranslationEn?: string | null` field mirroring the backend.

### Frontend — rendering + wiring

- [X] T011 [US1] In `frontend/components/inbox-v5.tsx`: introduce local state keyed by conversation for translation lifecycle — `translations: Record<messageId, { text: string; status: 'idle' | 'loading' | 'error' }>`. Seed it from `message.contentTranslationEn` when the conversation loads. Do NOT persist this map (the server is the source of truth via `contentTranslationEn`).
- [X] T012 [US1] In `frontend/components/inbox-v5.tsx`: replace the existing `translateActive` state (currently `useState(false)` at ~line 1464) with a per-conversation hook that reads/writes `localStorage['gp-translate-on:' + selectedConv.id]`. When a different conversation becomes `selectedConv`, re-read the key; default off if absent. The existing Translate button click handler (~line 3690) flips the flag and writes `localStorage` accordingly. The existing active-state styling (accent color, border) stays as-is.
- [X] T013 [US1] In `frontend/components/inbox-v5.tsx`: when `translateActive` is true for the current conversation, drive a side-effect that, for each inbound message (`message.role === 'GUEST'`) whose `contentTranslationEn` is null AND whose entry in `translations` is `idle` (or absent), call `apiTranslateMessage(message.id)` with a concurrency cap of 4 in-flight (simple semaphore — track count in a ref; dequeue newest-first from a stack keyed on message `sentAt` desc). On success, update the `translations` map and the in-memory message object's `contentTranslationEn` so subsequent re-renders skip re-fetch. On failure, mark the entry `error`.
- [X] T014 [US1] In `frontend/components/inbox-v5.tsx`: modify the inbound guest message bubble renderer so that when `translateActive === true` AND `message.role === 'GUEST'` AND a translation is available, the bubble renders the original on top followed by a thin divider (1px, `T.border.default`, 6px vertical gap) and the English translation below in de-emphasized styling (same font family, `fontSize: 13` if original is 14, `color: T.text.secondary`, `fontStyle: 'normal'`). Preserve `whiteSpace: 'pre-wrap'` on the translation so paragraph breaks show. CRITICAL: if `translated.trim().toLowerCase() === message.content.trim().toLowerCase()` the translation block is SKIPPED entirely (already-English case, FR-006).
- [X] T015 [US1] In `frontend/components/inbox-v5.tsx`: when a translation request is in-flight for a message AND the toggle is on, show a subtle shimmer/loading dot at the translation-block position (8px tall, de-emphasized color) so the user sees progress. When the request fails, show a small chip reading "Translation unavailable · Retry" that, on click, re-enqueues the translation for that message (flips its `translations` entry back to `idle` and lets T013's side-effect pick it up). Errors must be scoped per-message — other bubbles keep rendering.
- [X] T016 [US1] In `frontend/components/inbox-v5.tsx`: hook into the existing Socket.IO `new_message` handler (search for where inbound messages are appended to the current conversation on a real-time event). If `translateActive` is true for that conversation AND the arriving message's `role === 'GUEST'` AND it has no `contentTranslationEn`, enqueue a translate call immediately via the same mechanism as T013. Re-uses the 4-in-flight semaphore.

**Checkpoint**: User Story 1 is fully functional and deliverable. Skip to "Implementation Strategy" below if shipping MVP-only.

---

## Phase 4: User Story 2 — Toggle state persists while the manager works (Priority: P2)

**Goal**: Once a manager enables Translate for a conversation, reopening the same conversation within the same browser session (including after a page reload) keeps it on. A different conversation the manager has never toggled stays off.

**Independent Test**: Turn Translate on for Conversation A. Reload the page. Reopen Conversation A — Translate is still on, translations render from cache. Open Conversation B (never toggled) — Translate is off by default.

**Note**: The core persistence mechanism is already implemented in T012 (the per-conversation `localStorage` read/write). This phase adds only the polish + resilience items that strictly belong to story 2.

- [X] T017 [US2] In `frontend/components/inbox-v5.tsx`: verify the `localStorage` read in T012 handles the SSR path in Next.js safely — guard with `typeof window !== 'undefined'` so server-rendered inbox markup doesn't crash. If this is already handled project-wide via a hook, reuse that pattern rather than open-coding it.
- [X] T018 [US2] In `frontend/components/inbox-v5.tsx`: when the user toggles OFF for a conversation, remove the `localStorage` key (rather than writing `'0'`), keeping the store clean. Rationale: absent key == off, matches the default-off semantics in US1.
- [X] T019 [US2] In `frontend/components/inbox-v5.tsx`: add a tiny migration cleanup that prunes `gp-translate-on:*` keys for conversation ids that no longer exist in the user's conversation list on inbox mount. One-liner that iterates the current list's ids, compares to `localStorage` keys with the prefix, removes orphans. Prevents unbounded growth for managers who use the app for months.

**Checkpoint**: Both user stories work. Story 2 is strictly additive to Story 1 — no existing behavior changes.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, documentation, and the end-to-end verification pass.

- [X] T020 [P] In `CLAUDE.md`, add a one-line entry under "Key Services" for `translation.service.ts` so future agents discover it. Format: `| translation.service.ts | Inbound message translation to English (cached on Message.contentTranslationEn). Provider-abstracted for easy swap. |`.
- [X] T021 [P] In `frontend/lib/api.ts`, grep for any lingering call-sites of the removed `apiSendThroughAI` name and delete them if present (there should be none after T010; this is a safety sweep).
- [ ] T022 Run the full verification flow in [quickstart.md](./quickstart.md) against a local dev environment with a real non-English conversation. Specifically validate: golden-path render, second-browser cache sharing (SC-005), already-English skip (FR-006), forced-error retry chip (FR-008), send-path unchanged (FR-010). **Requires login credentials — left for the user to run interactively.**
- [X] T023 Manually confirm the orphaned `translateAndSend` controller and its route (`POST /api/conversations/:id/messages/translate` in `backend/src/routes/conversations.ts` line 27, and `translateAndSend` method in `backend/src/controllers/messages.controller.ts`) still build and are still reachable — they are intentionally NOT touched by this feature per plan.md "Structure Decision". Do NOT delete them.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 has no dependencies and can start immediately; however, the frontend and backend tasks that import from `translation.service.ts` (T005) require T001 to be merged first.
- **Foundational (Phase 2)**: T002 → T003 → T004 run strictly in order. T003 depends on T002 (Prisma needs the edited schema); T004 is editing a different file but the `AuthenticatedRequest` typing may need the generated types from T003 if it imports shared helpers — keep it sequential for safety.
- **User Story 1 (Phase 3)**: Depends on Phase 1 and Phase 2 being complete.
- **User Story 2 (Phase 4)**: Depends on T012 from US1 being done (it extends that code). The story cannot be done independently in code because it is polish on top of the same file; it CAN be validated independently once US1 is in.
- **Polish (Phase 5)**: Depends on US1 at minimum (for T022 to have anything to verify).

### Within User Story 1

- T005 depends on T001 (uses `translationService`) and T003 (uses the new column).
- T006 depends on T005 (registers the controller method) and T004 (router exists).
- T007 + T008 [P] are cleanup — can run in parallel and can start anytime after T005+T006 are merged.
- T009 can run in parallel with T010 after T003 is done (different codebases).
- T010 depends on T006 being merged (endpoint must exist before the client calls it in dev).
- T011 → T012 → T013 → T014 → T015 → T016 are all edits to `frontend/components/inbox-v5.tsx`. Do them sequentially to avoid merge conflicts. Order matters (state shape → toggle persistence → side effect → render → loading/error → socket hook).

### Parallel Opportunities

- **Phase 1**: T001 is the only task; parallelism N/A.
- **Phase 2**: sequential by design.
- **Phase 3 US1**:
  - Backend cleanup pair: T007 + T008 in parallel (different files).
  - Backend-vs-frontend split: T009 (backend audit) and T010 (frontend client) can run in parallel.
  - Frontend rendering (T011–T016) must be sequential within the single file.
- **Phase 5**: T020 + T021 in parallel.

---

## Parallel Example: User Story 1 cleanup + API client

```bash
# After T005 and T006 land, launch in parallel:
Task: "Delete legacy translateMessage controller method in backend/src/controllers/messages.controller.ts (T007)"
Task: "Delete legacy /translate-message route in backend/src/routes/conversations.ts (T008)"
Task: "Replace apiSendThroughAI with apiTranslateMessage in frontend/lib/api.ts (T010)"
Task: "Audit message response shape to include contentTranslationEn in backend/src/controllers/*.ts (T009)"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 (T001) → Phase 2 (T002–T004) → Phase 3 (T005–T016).
2. **STOP and validate** using [quickstart.md](./quickstart.md) golden-path, cache-sharing, and already-English sections.
3. Ship. US2 is strictly additive polish.

### Incremental Delivery

1. **Ship 1**: Setup + Foundational + US1 → manager can translate inbound messages, cache persists server-side, second browser / iOS benefits automatically.
2. **Ship 2**: US2 → toggle state survives reloads; no functional regression.
3. **Ship 3** (optional, future feature): add the batch translate endpoint or swap provider to Google Cloud Translation — out of scope for this feature.

### Solo-developer Strategy

- Single developer works top-to-bottom. No parallelism gain worth the coordination overhead. The [P] markers exist for clarity and for a reviewer to understand what is independent, not because the work warrants a team.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps task to specific user story for traceability.
- Every task has an exact file path.
- No automated tests generated — verification is manual per [quickstart.md](./quickstart.md).
- The existing `translateAndSend` controller + route are intentionally left in place (orthogonal to this feature).
- Database change is non-destructive: one new nullable column, no data migration, no index.
