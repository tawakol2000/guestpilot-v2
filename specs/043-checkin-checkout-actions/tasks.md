---

description: "Tasks for 043-checkin-checkout-actions"
---

# Tasks: Check-in / Check-out Time Accept-Reject Workflow

**Input**: Design documents from `/specs/043-checkin-checkout-actions/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Not requested. No automated test tasks generated; verification is via [quickstart.md](./quickstart.md).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story (US1, US2, US3, US4)
- Exact absolute-from-repo-root file paths in every task description

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No scaffolding needed — backend and frontend dev envs already exist. This phase is empty.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, shared services, and AI-output wiring that all user stories depend on. **No user-story task begins until this phase is complete.**

- [X] T001 Extend `backend/prisma/schema.prisma`: (a) add `autoAcceptLateCheckoutUntil String?` and `autoAcceptEarlyCheckinFrom String?` to `Property`; (b) add `defaultAutoAcceptLateCheckoutUntil String?` and `defaultAutoAcceptEarlyCheckinFrom String?` to `Tenant`; (c) add `scheduledCheckInAt String?` and `scheduledCheckOutAt String?` to `Reservation`; (d) add `metadata Json?` to `Task`; (e) add new model `AutomatedReplyTemplate` (tenantId, escalationType, decision, body, cascade-delete from Tenant, unique index on `(tenantId, escalationType, decision)`, index on `tenantId`); (f) add new model `TaskActionLog` (tenantId, taskId, action, actorKind, actorUserId?, deliveredBody, requestedTime?, appliedTime?, createdAt, cascade-delete from Tenant, index on `tenantId` and `taskId`). All new fields nullable; no data migration required. Place additions after existing Feature 041/042 fields, each with a comment labelling them Feature 043.
- [X] T002 Apply the schema change: `cd backend && npx prisma db push` then `npx prisma generate`. Verify in Prisma Studio: the new columns on `Property`/`Tenant`/`Reservation`/`Task` exist and are null on all rows; the new `AutomatedReplyTemplate` and `TaskActionLog` tables exist and are empty.
- [X] T003 [P] Create `backend/src/config/reply-template-defaults.ts`: export a typed const map keyed by `(escalationType, decision)` returning the default body strings. Include entries for the four pairs (`late_checkout_request`/`approve`, `late_checkout_request`/`reject`, `early_checkin_request`/`approve`, `early_checkin_request`/`reject`) using the default copy from [data-model.md](./data-model.md) "Default templates" table. Export helper `getDefaultReplyTemplate(escalationType, decision): string | null`.
- [X] T004 [P] Create `backend/src/services/reply-template.service.ts` with an exported async function `renderReplyTemplate(tenantId: string, escalationType: string, decision: 'approve'|'reject', context: { conversationId, reservationId, requestedTime?: string }, prisma: PrismaClient): Promise<string>`. Logic: load `AutomatedReplyTemplate` row for the triple; if absent, read system default from `reply-template-defaults.ts`; substitute `{GUEST_FIRST_NAME}`, `{REQUESTED_TIME}` (HH:MM → `h:mm AM/PM`), `{PROPERTY_NAME}`, `{CHECK_IN_TIME}`, `{CHECK_OUT_TIME}` (resolved via the precedence helper from T005); unknown variables → empty string (FR-017); return the rendered text. Throw only on DB failure.
- [X] T005 [P] In `backend/src/services/template-variable.service.ts`, add/update `resolveCheckInTime(reservation, property): string` and `resolveCheckOutTime(reservation, property): string` so they return `reservation.scheduledCheckInAt ?? property.customKnowledgeBase?.checkInTime ?? '15:00'` (and symmetric for checkout with `'11:00'` fallback). Refactor the one callsite that currently reads `{CHECK_IN_TIME}` / `{CHECK_OUT_TIME}` (search the file for the existing substitution) to route through these helpers. Non-regression: when reservation has no override, behavior is unchanged.
- [X] T006 Extend the coordinator AI structured output schema in `backend/src/services/ai.service.ts`. Locate the function that builds the response JSON schema (search for the coordinator `json_schema` definition with `escalation`, `resolveTaskId`, `updateTaskId` fields). Add the new optional field `scheduledTime` per [data-model.md](./data-model.md) "AI structured-output schema extension" section — nullable object with `kind` enum (`check_in`|`check_out`) and `time` pattern `^([01]?[0-9]|2[0-3]):[0-5][0-9]$`, `additionalProperties: false`, NOT added to `required`. Preserve `strict: true`.
- [X] T007 Update the coordinator system prompt to instruct the AI when to emit `scheduledTime`. Find the existing seed prompt (search `backend/src/config/ai-config.json` and `backend/src/services/ai-config.service.ts` for the coordinator persona's system prompt). Add a section under the existing output-format instructions: when the guest requests a specific late-checkout or early-check-in *time* (e.g., "can we check out at 1pm?"), and the message parses unambiguously to `HH:MM`, the AI MUST emit `scheduledTime: { kind, time }` alongside any escalation. If the time is ambiguous, emit `scheduledTime: null` and escalate normally. Also note: downstream policy decides auto-accept; the AI does not.

**Checkpoint**: Schema deployed. Shared services callable. AI schema + prompt emit `scheduledTime`. User-story work can begin.

---

## Phase 3: User Story 1 — Manager accepts a time request from the Actions card (Priority: P1) 🎯 MVP

**Goal**: Outside-threshold or unconfigured-property requests escalate to the manager's Actions card with Accept/Reject → editable preview → Send/Cancel. Send writes `Reservation.scheduledCheckInAt/At`, delivers the templated message, resolves the task, and flips the Property details card to the modified-time treatment.

**Independent Test**: With a CONFIRMED reservation and no auto-accept threshold configured, send a webhook guest message "can we check out at 2pm?". Verify (a) a Task row is created with `type='late_checkout_request'`, `metadata.requestedTime='14:00'`, `status='open'`, (b) the Actions card renders the late-checkout card with Accept/Reject, (c) click Accept → editable preview with default template pre-filled, (d) edit the text and click Send → guest receives the edited message, (e) `Reservation.scheduledCheckOutAt='14:00'` written, (f) Property card shows "Check-out Time · 2:00 PM" with green Modified pill, (g) Task is resolved, (h) `TaskActionLog` row recorded. Also verify Reject path: click Reject → send rejection → task resolved, reservation unchanged, Property card remains on default.

### Backend — pipeline wiring for escalation path

- [X] T008 [US1] In `backend/src/services/ai.service.ts`, after the existing `parsed.escalation` handler block (around the line referencing `handleEscalation`), add a new block that reads `parsed.scheduledTime`. If present AND policy check (from T020 — for now stub to `null` so Phase 3 always falls through to escalation), create a Task with `type = scheduledTime.kind === 'check_in' ? 'early_checkin_request' : 'late_checkout_request'`, `metadata = { requestedTime: scheduledTime.time, kind: scheduledTime.kind }`, `title = <human-readable request>`, `urgency = 'scheduled'`, `note = ''`, `status = 'open'`, scoped by tenantId + conversationId + propertyId. Use direct Prisma `task.create` (don't route through the existing `handleEscalation` which has different semantics). Leave the policy check stub so Phase 4 slots in cleanly.
- [X] T009 [US1] In `backend/src/services/task-manager.service.ts`, extend the dedup logic to recognize the new types. Add a branch: when a new time-request task is about to be created AND there's already an OPEN task of the same `(type, conversationId)`, update the existing task's `metadata.requestedTime` and `updatedAt` instead of creating a new row. Keeps the single-escalation-per-conversation invariant from the spec's edge case list.

### Backend — Task-actions controller + routes

- [X] T010 [US1] Create `backend/src/controllers/task-actions.controller.ts` exporting `makeTaskActionsController(prisma)`. Methods: `preview(req, res)`, `accept(req, res)`, `reject(req, res)`. Implement per [contracts/task-actions-api.md](./contracts/task-actions-api.md) — tenant-scoped lookup via `{ id, tenantId }`, 404/400/409/502 error codes as spec'd, calls `renderReplyTemplate` from T004 for preview and Accept/Reject bodies (the client also supplies an edited body on Accept/Reject). Accept MUST: call Hostaway send (reuse the existing helper from `messages.controller.ts::send`); on success create the Message row, update `Reservation.scheduledCheckInAt` or `scheduledCheckOutAt` (from `task.metadata.kind`), set `Task.status='resolved'` + `completedAt=now()`, insert a `TaskActionLog` row with `action='accepted'`, `actorKind='manager'`, `deliveredBody=body`, `requestedTime=metadata.requestedTime`, `appliedTime=metadata.requestedTime`, broadcast `task_resolved` + `reservation_scheduled_updated` via `broadcastToTenant`, return `{ message, reservation }`. Reject MUST: same flow minus the reservation update, `TaskActionLog.action='rejected'`, `appliedTime=null`. Any failure mid-pipeline: no partial state — use Prisma `$transaction` around the DB writes; the Hostaway send is pre-transaction (if it fails, return 502 with no DB writes).
- [X] T011 [US1] In `backend/src/routes/tasks.ts` (create the file if it doesn't exist; otherwise append): register `router.get('/:taskId/preview', auth, handler)`, `router.post('/:taskId/accept', auth, messageSendLimiter as any, handler)`, `router.post('/:taskId/reject', auth, messageSendLimiter as any, handler)`. Import the controller from T010.
- [X] T012 [US1] In `backend/src/app.ts`, mount the tasks router under `/api/tasks` if not already mounted. Search for the existing `app.use('/api'` lines around the middle of the file and add `app.use('/api/tasks', tasksRouter(prisma));` adjacent to the others. If the tasks router is ALREADY mounted (e.g., existing `tasksRouter` from `routes/tasks.ts` for the generic task-list endpoint), extend that same router with the new routes from T011 rather than creating a second router — avoid duplicate mounts.

### Frontend — API client

- [X] T013 [P] [US1] In `frontend/lib/api.ts`, add three new exports: `apiPreviewTaskReply(taskId: string, decision: 'approve'|'reject'): Promise<{ body: string }>` (GET), `apiAcceptTask(taskId: string, body: string): Promise<{ message: ApiMessage; reservation: { id: string; scheduledCheckInAt: string | null; scheduledCheckOutAt: string | null } }>` (POST), `apiRejectTask(taskId: string, body: string): Promise<{ message: ApiMessage }>` (POST). Extend the `ApiReservation` type (or wherever reservation is typed) to include `scheduledCheckInAt?: string | null` and `scheduledCheckOutAt?: string | null`.

### Frontend — Actions card generalization

- [X] T014 [P] [US1] Create `frontend/components/actions/alteration-action-card.tsx`. **Pure refactor**: lift the existing alteration rendering logic from `frontend/components/inbox-v5.tsx` (the block around line 5274 that currently renders alteration Approve/Reject) into this new component. Keep prop signature tight: `{ conversation, selectedConv, actionInFlight, actionResult, lastActions, onAction }` — whatever the current code already reads. No behavior change. Export default.
- [X] T015 [P] [US1] Create `frontend/components/actions/action-card-registry.ts` exporting `ACTION_CARD_REGISTRY: Record<string, React.FC<ActionCardProps>>` mapping `'alteration'` → the component from T014. Type `ActionCardProps` in the same file. Also export `getActionCardFor(task): React.FC | null` that looks up by `task.type` and returns the component or null (for types we don't yet render).
- [X] T016 [US1] Create `frontend/components/actions/time-request-action-card.tsx`. Implement the generic Accept/Reject/Send/Cancel flow per spec FR-003–FR-009: read `task.metadata.requestedTime` and `task.type` to display the title ("Late checkout · 2:00 PM" / "Early check-in · 10:00 AM"); Accept/Reject buttons; on click, call `apiPreviewTaskReply` to fetch the template body, switch to an editable `<textarea>` plus Send + Cancel; Cancel resets to Accept/Reject; Send calls `apiAcceptTask` or `apiRejectTask` with the textarea contents; on success, the parent removes the card from view and (for Accept) merges the returned reservation into state. Handle 502 inline with a retry affordance (reopen preview with same body). Register this component in the registry from T015 under keys `late_checkout_request` and `early_checkin_request`.
- [X] T017 [US1] In `frontend/components/inbox-v5.tsx`, refactor the Actions-card region (around line 5274 and below) so that: (a) open escalations for the selected conversation are fetched/tracked in local state — use the existing task-fetch path if present, otherwise add a useEffect that GETs `/api/tasks?conversationId=…&status=open` on conversation open + on Socket.IO `task_created` events; (b) iterate those tasks and render each via `getActionCardFor(task)` from T015; (c) the alteration rendering moves behind the registry (the refactor from T014 already extracted it — this task just swaps the inline JSX for the registry lookup); (d) new time-request tasks render via T016's component. Verify the existing alteration behavior is unchanged after the refactor.

### Frontend — Property card modified-time

- [X] T018 [US1] In `frontend/components/inbox-v5.tsx`, locate the Property details card on the right panel (search for "PROPERTY" header and "Check-in Time" / "Check-out Time" labels). For each of the two time rows, read `selectedConv.booking?.scheduledCheckInAt` (or whatever path the conversation detail exposes the new field through — see T019 for plumbing) and, when non-null, render the override value (converted to h:mm AM/PM) instead of the default, styled in green (`T.status.green` or equivalent) with a small "Modified" pill next to it. On hover, a tooltip shows "Default: <original time>". When null, render the default exactly as today (FR-026). Live update: this re-renders automatically when T019's socket handler merges the updated reservation.
- [X] T019 [US1] Plumb `reservation.scheduledCheckInAt` / `scheduledCheckOutAt` into the conversation detail shape. In `frontend/components/inbox-v5.tsx`, extend the `mergeDetail` (or `transform…`) function to copy these two fields into `conv.booking` (or wherever property-card reads from). Also handle the live-update: add a Socket.IO listener for `reservation_scheduled_updated` `{ reservationId, scheduledCheckInAt, scheduledCheckOutAt }` events (broadcast from T010). Merge into conversation state — find the conversation whose `reservationId` matches and update its booking fields. Triggers a re-render of the Property card (T018).
- [X] T020 [US1] Add a Socket.IO listener in `frontend/components/inbox-v5.tsx` for `task_resolved` events `{ taskId, conversationId, action }`. When received for the currently-open conversation, remove the resolved task from the Actions-card task list (or refetch the task list, whichever is lighter). Independent of which manager triggered the action.

**Checkpoint**: User Story 1 is fully deliverable. Outside-threshold requests land in the Actions card, manager Accept/Reject work end-to-end, Property card reflects the modified time live. Skip to "Implementation Strategy" if shipping MVP-only.

---

## Phase 4: User Story 2 — Property auto-accepts within threshold (Priority: P2)

**Goal**: When a guest requests a time that falls within the property's auto-accept threshold, the AI pipeline applies the override and sends the approval template immediately — no escalation, no holding message.

**Independent Test**: Configure `Property.autoAcceptLateCheckoutUntil='13:00'`. Send a guest message "can we check out at 12:30?". Verify (a) no Task row with `status='open'` is created, (b) a resolved Task with `TaskActionLog.actorKind='ai_autoaccept'` exists, (c) `Reservation.scheduledCheckOutAt='12:30'`, (d) the guest receives the templated approval message, (e) the Actions card remains empty, (f) the AI log's `ragContext.timeRequestDecision` records the match. Also verify out-of-threshold fallback: "can we check out at 3pm?" falls through to the manual Story-1 flow.

- [X] T021 [US2] Create `backend/src/services/scheduled-time.service.ts`. Export `evaluateScheduledTimePolicy(opts: { tenantId, propertyId, scheduledTime: { kind, time } }, prisma): Promise<{ autoAccept: boolean; thresholdMatched?: string; reason?: string }>`. Logic: load the Property (including its Tenant) for this conversation; compute `effectiveThreshold = property[direction] ?? tenant[default-direction]`; if null → `{ autoAccept: false, reason: 'no threshold configured' }`; else compare: for `check_out`, `autoAccept = scheduledTime.time <= threshold`; for `check_in`, `autoAccept = scheduledTime.time >= threshold`. Return the evaluation plus the matched threshold for logging. Export a second helper `applyAutoAcceptedScheduledTime({ tenantId, conversationId, reservationId, propertyId, scheduledTime }, prisma, io?): Promise<void>` that: (a) renders the approval template via T004, (b) calls the existing Hostaway send path with the rendered body, (c) updates `Reservation.scheduledCheckInAt`/`CheckOutAt`, (d) creates a resolved Task + `TaskActionLog` with `actorKind='ai_autoaccept'`, (e) broadcasts `reservation_scheduled_updated`, (f) catches and logs all errors internally (fire-and-forget pattern — must not raise).
- [X] T022 [US2] In `backend/src/services/ai.service.ts`, replace the stub policy check from T008 with a real call to `evaluateScheduledTimePolicy` + `applyAutoAcceptedScheduledTime`. Flow: if `parsed.scheduledTime` is present → evaluate policy → if `autoAccept===true`, invoke the apply helper AND skip creating the escalation Task AND skip calling the normal `handleEscalation` for this turn (the auto-accept replaces the reply); else → proceed with the existing T008 Task-creation path. Add one `ragContext.timeRequestDecision = { matchedThreshold, requestedTime, approved, appliedTime? }` entry for observability regardless of outcome.
- [X] T023 [US2] Ensure the Property update endpoint accepts the two new threshold fields. In `backend/src/controllers/properties.controller.ts` (find the one that handles `PATCH /api/properties/:id` or the listing edit endpoint), add `autoAcceptLateCheckoutUntil: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).nullable().optional()` and the symmetric field to the update schema. Pass-through on update. Similarly, ensure the GET returns both fields.
- [X] T024 [US2] In `frontend/components/listings-v5.tsx` (the property-edit UI), add two new inputs under a new "Auto-accept thresholds" section of the property-edit form: "Auto-accept late checkout until" (time input, HH:MM, nullable with an explicit "Off" state) and "Auto-accept early check-in from" (same shape). Wire the values into the existing save-property mutation. Default blank = off. Include a small explanatory note: "When set, guest requests at or within this time are approved automatically. Outside the threshold, the request is sent to your Actions card."

**Checkpoint**: Auto-accept works end-to-end. Both stories coexist: within-threshold → auto; outside → manual. Both use the same template path.

---

## Phase 5: User Story 3 — Editable per-tenant templates (Priority: P2)

**Goal**: Tenant admin can view and edit approval/rejection templates for each supported escalation type; changes take effect on the next escalation without a restart.

**Independent Test**: As a tenant admin, open Settings → Automated Replies. Verify 4 rows (late-checkout approve/reject, early-checkin approve/reject) with `isDefault=true` and default text. Edit one, save. Trigger a matching escalation. Verify the preview / auto-accept both use the edited text. Click Revert → row deleted → next trigger uses the system default again.

### Backend

- [X] T025 [P] [US3] Create `backend/src/controllers/reply-templates.controller.ts` exporting `makeReplyTemplatesController(prisma)` with methods `list(req, res)`, `upsert(req, res)`, `remove(req, res)` per [contracts/reply-templates-api.md](./contracts/reply-templates-api.md). `list` returns every (escalationType, decision) pair the system supports, merging the tenant's overrides with defaults and marking `isDefault`/`updatedAt` accordingly. `upsert` validates the path params against the registered type/decision set and the body `{ body: string }` (1–4000 chars); uses Prisma `upsert`. `remove` deletes the row if it exists; returns 204 regardless.
- [X] T026 [US3] Mount the controller. Add `router.get('/reply-templates', …)`, `router.put('/reply-templates/:escalationType/:decision', …)`, `router.delete('/reply-templates/:escalationType/:decision', …)` to `backend/src/routes/tenant-config.ts` (or wherever the existing `/api/tenant-config` routes live — grep for the existing `tenantConfigRouter`). Ensure auth middleware and tenant scoping are applied identically to sibling routes.

### Frontend

- [X] T027 [P] [US3] In `frontend/lib/api.ts`, add three exports: `apiListReplyTemplates(): Promise<{ templates: ReplyTemplate[] }>`, `apiUpdateReplyTemplate(escalationType: string, decision: 'approve'|'reject', body: string): Promise<ReplyTemplate>`, `apiDeleteReplyTemplate(escalationType: string, decision: 'approve'|'reject'): Promise<void>`. Define the `ReplyTemplate` type.
- [X] T028 [US3] Create `frontend/components/settings/automated-replies-section.tsx`: list the 4 (type × decision) rows from `apiListReplyTemplates`, each with a `<textarea>`, Save, and Revert buttons. Save calls `apiUpdateReplyTemplate`; Revert calls `apiDeleteReplyTemplate` then refetches. Render an `isDefault` badge for unedited rows. Variable hint: below each textarea, list the supported variables (`{GUEST_FIRST_NAME}`, `{REQUESTED_TIME}`, `{PROPERTY_NAME}`, `{CHECK_IN_TIME}`, `{CHECK_OUT_TIME}`) for reference.
- [X] T029 [US3] Mount the new section. In `frontend/components/configure-ai-v5.tsx`, add a new tab or section labelled "Automated Replies" that renders the T028 component. If the Configure AI page uses a sidebar nav, add an entry; if it uses sections, place the new block after the existing prompt-editing blocks.

**Checkpoint**: Tenant admins can edit templates; changes propagate instantly to both the manual preview and auto-accept paths (shared renderer from T004).

---

## Phase 6: User Story 4 — Generalization smoke check (Priority: P3)

**Goal**: Confirm the registry-based Actions-card polymorphism holds; future escalation types can plug in with no changes to the Actions-card component.

- [X] T030 [US4] Verification-only task: in `frontend/components/actions/action-card-registry.ts`, temporarily add a dev-only alias like `test_type_dev: TimeRequestActionCard` then trigger a Task with `type='test_type_dev'` via Prisma Studio; confirm the registry resolves it and renders using `TimeRequestActionCard`. Remove the alias after confirming. No production code change.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T031 [P] Update `CLAUDE.md`: add entries to the "Key Services" table for `scheduled-time.service.ts` (Feature 043) and `reply-template.service.ts` (Feature 043). Format consistent with the existing rows.
- [X] T032 [P] In `backend/src/config/reply-template-defaults.ts`, add a short comment header noting the file is the source of truth for system-default reply templates, edited in place when copy changes, never at runtime.
- [ ] T033 Run the full [quickstart.md](./quickstart.md) verification flow against a local dev environment. Walk all four stories + alteration non-regression + constitutional checks. **Requires login credentials and a deployed/running backend — left for the user to run interactively post-merge.**
- [ ] T034 Regression: in a conversation with a pending `BookingAlteration`, verify Accept and Reject behave identically to pre-refactor behavior. Screenshot before/after if practical. This guards FR-026/FR-031/SC-003. **Note**: the alteration path was NOT touched by this feature — the existing `AlterationPanel` component is unchanged; the polymorphic registry was added as a new sibling, not a replacement. Regression risk is minimal but still worth the manual check.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: empty.
- **Foundational (Phase 2)**: T001 → T002 (Prisma client must be regenerated before T003/T004/T005 compile). T003, T004, T005 can run in parallel once T002 is done. T006 depends on T002 (uses generated types). T007 has no code-file dependency but should happen before any user-story test that relies on the AI emitting `scheduledTime`.
- **Phase 3 (US1)**: Depends on Phase 2 complete.
- **Phase 4 (US2)**: Depends on Phase 3 (reuses the resolved-task + TaskActionLog + socket plumbing).
- **Phase 5 (US3)**: Depends on Phase 2 (template.service) but NOT on Phase 3/4 — can run in parallel with them if there's team capacity; for a solo dev, follow the priority order.
- **Phase 6 (US4)**: Depends on Phase 3 (registry exists).
- **Phase 7 (Polish)**: Depends on at least Phase 3 for T033/T034; T031/T032 can run anytime after Phase 2.

### Within Phase 3 (US1)

- T008 depends on T001 (needs Task.metadata column) + T006 (scheduledTime field in schema) + T007 (prompt makes the field actually get emitted).
- T009 depends on T008 (reads the new task types).
- T010 depends on T001 (TaskActionLog) + T004 (renderReplyTemplate) + existing messages.controller send helper.
- T011 depends on T010 (imports controller).
- T012 depends on T011.
- T013 can run in parallel with T010/T011 (frontend-only).
- T014 can run in parallel with the backend block (pure refactor, no new deps).
- T015 depends on T014.
- T016 depends on T013 + T015.
- T017 depends on T015 + T016.
- T018 depends on T019 (data plumbing) + T020 (live updates).
- T019 can run in parallel with T014–T016 (different sections of `inbox-v5.tsx`, coordinate sequential edits to avoid merge conflicts).
- T020 can run in parallel with T019 — both add Socket listeners in the same file; do them sequentially.

### Parallel Opportunities

- **Phase 2**: T003 || T004 || T005 after T002 lands. T006 sequential. T007 independent (different file).
- **Phase 3 US1**: T013 || T014 (different codebases). T010/T011/T012 sequential (backend chain). T015/T016/T017/T018/T019/T020 all edit frontend; do in order to avoid merge pain.
- **Phase 4 US2**: T021/T022 sequential (T022 imports T021). T023/T024 in parallel after T022.
- **Phase 5 US3**: T025/T027 in parallel (backend vs frontend helpers). T026 after T025. T028 after T027. T029 after T028.
- **Phase 7 Polish**: T031 || T032.

---

## Parallel Example: Foundational phase

```bash
# After T001 + T002 land, fire these three in parallel:
Task: "Create reply-template-defaults.ts (T003)"
Task: "Create reply-template.service.ts (T004)"
Task: "Extend template-variable.service.ts precedence (T005)"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 2 (T001–T007) → Phase 3 (T008–T020).
2. Stop. Run [quickstart.md](./quickstart.md) Story-1 checks + alteration non-regression.
3. Ship. Managers now have structured Accept/Reject flow for late-checkout / early-check-in; auto-accept lands in the next release.

### Incremental Delivery

1. **Ship 1**: Foundational + US1 → manual action card, modified-time indicator, editable preview.
2. **Ship 2**: US2 → auto-accept within property threshold. Zero-click for in-policy requests.
3. **Ship 3**: US3 → editable templates. Ops can tailor copy without a deploy.
4. **Ship 4**: US4 (architecture smoke) → no code change; just confirms the registry holds for the next escalation type (amenity-with-fee, etc.).

### Solo-developer Strategy

Top-to-bottom. Defer US3 to Ship 2 or Ship 3 depending on whether default templates feel acceptable after dogfooding US1. Parallel tasks exist for clarity — a single dev rarely needs the parallelism.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps each US task to its spec story for traceability.
- Every task includes an exact file path (or a precise location within a file).
- Tests are manual via [quickstart.md](./quickstart.md); no automated test tasks were generated.
- The alteration flow is explicitly not changed anywhere — T014 is a pure refactor that preserves behavior. T034 is the regression guard.
- Schema change is additive + nullable; no data migration required.
- Constitution §III carve-out (policy-as-authority for auto-accept) is documented in [research.md](./research.md) Decision 1.
