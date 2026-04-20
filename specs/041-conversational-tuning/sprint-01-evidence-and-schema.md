# Sprint 01 — Evidence Infrastructure + Schema + Teardown

> **You are a fresh Claude Code session with no memory of prior work on this feature.** Read the files listed below before writing any code. The spec docs are the source of truth; this sprint prompt is scoped instructions, not the full picture.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md` — **non-negotiable**. Branch rules, DB coexistence constraints, commit/push rules. Read this first.
2. `specs/041-conversational-tuning/vision.md` — what we're ultimately building.
3. `specs/041-conversational-tuning/roadmap.md` — V1 day-by-day. This sprint covers days 1-3.
4. `specs/041-conversational-tuning/deferred.md` — what we are *not* building now, and what pre-wiring to include anyway.
5. `specs/041-conversational-tuning/glossary.md` — vocabulary. Use these terms consistently.
6. `CLAUDE.md` (repo root) — tech stack, critical rules, build commands.
7. `backend/prisma/schema.prisma` — current schema. You will extend this.
8. `backend/src/services/tuning-analyzer.service.ts` — existing two-step analyzer. You will delete this at the end of the sprint.
9. `backend/src/services/shadow-preview.service.ts` — preview lifecycle helper. **Do not delete**; it will be reused.
10. `backend/src/controllers/shadow-preview.controller.ts` — currently triggers `tuning-analyzer.service`. You will rewire the trigger point.
11. `backend/src/controllers/tuning-suggestion.controller.ts` — current suggestion CRUD. Keep; it will be extended in a later sprint.
12. `frontend/components/tuning-review-v5.tsx` — existing flat-queue UI. You will delete this at the end of the sprint.

## Branch

- You are working on `feat/041-conversational-tuning`.
- If the branch does not exist, create it from `main` as your first action: `git checkout -b feat/041-conversational-tuning`.
- All commits go on this branch. Do not merge to `main`. Do not push unless the sprint report explicitly says to.

## Goal

Stand up the foundation that everything else in feature 041 builds on: (a) the observability pipeline that lets the future tuning agent see what the main AI actually did, (b) the evidence-bundle assembler that packages trigger events into a JSON snapshot the agent will consume, (c) the Prisma schema additions for all feature-041 entities (safe to coexist with live production on the same DB), and (d) a clean teardown of the existing v5 tuning UI and two-step analyzer so the next sprint starts from a blank slate.

## Non-goals (do NOT do in this sprint)

- **Do NOT build the new `/tuning` frontend.** That is sprint 03.
- **Do NOT build the diagnostic pipeline / taxonomy.** That is sprint 02.
- **Do NOT integrate Claude Agent SDK or build the conversational agent.** That is sprint 04.
- **Do NOT populate any of the pre-wiring columns** (`editEmbedding`, `experimentId`, `CLUSTER_TRIGGERED`/`ESCALATION_TRIGGERED` enum usage, `PreferencePair` writes). The columns/tables exist; they stay empty this sprint.
- **Do NOT write migration files.** Per `operational-rules.md` §7, use `npx prisma db push`.
- **Do NOT delete any data** from the live DB. This sprint is code-only teardown. The rows the old analyzer wrote stay in place.

## Acceptance criteria

### 1. Langfuse observability for the main AI

- [ ] Langfuse Cloud project exists (you will need `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` env vars; they may already be set — check `.env` and `backend/src/config/`).
- [ ] Main-AI pipeline in `backend/src/services/ai.service.ts` emits OpenInference-compatible spans on every run. One trace per `generateAndSendAiReply` invocation; nested spans for:
  - SOP classification call
  - Each tool call (with full params and return value)
  - Structured output call
  - Summary call (fire-and-forget, still traced)
  - Task-manager dedup call
- [ ] Span attributes include: `tenantId`, `conversationId`, `reservationId` (if present), `messageId`, `systemPromptVersion`, `model`, `inputTokens`, `outputTokens`, `cost`, `retrievalContext` (SOP fetched, FAQ hits), `classifierDecision` (category + alternatives if available).
- [ ] Degrades silently if Langfuse env vars are missing — per CLAUDE.md critical rule #2.
- [ ] A single live Hostaway-triggered main-AI run produces a visible trace in Langfuse Cloud (smoke-tested by you via `DRY_RUN` on a known conversation ID, or by documenting the commands so the next session or Abdelrahman can).

### 2. Evidence bundle assembler service

- [ ] New file: `backend/src/services/evidence-bundle.service.ts`.
- [ ] Exports `assembleEvidenceBundle(triggerEvent)` returning a typed JSON structure containing:
  - Full Langfuse trace for the main-AI run that produced the disputed message (look up by `messageId` or `traceId`)
  - Conversation context (last N messages, default 20)
  - Hostaway entity metadata (reservation, property, guest) via `hostaway.service.ts`
  - Active SOP variants + property overrides that were in effect
  - FAQ entries retrieved in that run (from the trace)
  - Prior `TuningSuggestion` history for the same property/category (last 90 days)
  - System prompt version + any conditional branch tags
- [ ] A TypeScript `EvidenceBundle` type mirrors the JSON shape and is exported for consumers.
- [ ] No caller yet — the function exists but is unused until sprint 02 wires it into the diagnostic pipeline.
- [ ] Unit test or smoke script invoking `assembleEvidenceBundle` against a real recent `Message` ID and logging the output to stdout for visual inspection.

### 3. Prisma schema additions (ADDITIVE ONLY — re-read `operational-rules.md` §Schema change rules)

All of the following ship in one `prisma db push`. Every new column on an existing table is **nullable**. No renames. No drops.

**New models:**

- [ ] `TuningConversation`
  - `id String @id @default(cuid())`
  - `tenantId String` (FK to Tenant)
  - `userId String?` (FK to User; nullable for future agent-initiated conversations per D5 pre-wiring)
  - `title String?`
  - `triggerType TuningConversationTriggerType` — enum with `MANUAL`, `EDIT_TRIGGERED`, `REJECT_TRIGGERED`, `COMPLAINT_TRIGGERED`, `THUMBS_DOWN_TRIGGERED`, `CLUSTER_TRIGGERED` (D5 pre-wire, unused), `ESCALATION_TRIGGERED` (D6 pre-wire, unused)
  - `anchorMessageId String?` (FK to Message; nullable)
  - `sdkSessionId String?` (Claude Agent SDK session id — sprint 04 will populate)
  - `status String @default("OPEN")` (plain string, not enum, to allow future values without migration)
  - `createdAt`, `updatedAt`
  - Indexes on `tenantId`, `anchorMessageId`
- [ ] `TuningMessage`
  - `id String @id @default(cuid())`
  - `conversationId String` (FK to TuningConversation, onDelete: Cascade)
  - `role String` (`user` | `assistant` | `tool` | `system`)
  - `parts Json` — Vercel AI SDK `parts[]` shape (text, tool-call, tool-result, reasoning, data-* parts)
  - `createdAt`
  - Index on `conversationId`
- [ ] `AgentMemory`
  - `id String @id @default(cuid())`
  - `tenantId String`
  - `key String` (e.g. `preferences/tone`, `facts/luxury-properties`)
  - `value Json`
  - `source String?` (which conversation / suggestion created this memory)
  - `createdAt`, `updatedAt`
  - `@@unique([tenantId, key])`
- [ ] `EvidenceBundle`
  - `id String @id @default(cuid())`
  - `tenantId String`
  - `messageId String?` (FK to Message; nullable so non-message-triggered bundles are possible later)
  - `triggerType TuningConversationTriggerType`
  - `payload Json` — the assembled bundle from §2
  - `createdAt`
  - Index on `messageId`
- [ ] `CapabilityRequest`
  - `id String @id @default(cuid())`
  - `tenantId String`
  - `title String`
  - `description String`
  - `rationale String?`
  - `sourceConversationId String?`
  - `status String @default("OPEN")`
  - `createdAt`, `updatedAt`
- [ ] `PreferencePair` (D2 pre-wire; nothing writes here in V1)
  - `id String @id @default(cuid())`
  - `tenantId String`
  - `context Json`
  - `rejectedSuggestion Json`
  - `preferredFinal Json`
  - `category String?`
  - `createdAt`

**Extensions to existing `TuningSuggestion` table** (all nullable, all safe for old-branch code):

- [ ] `applyMode String?` — expected values `IMMEDIATE` | `QUEUED`; string not enum to allow future values
- [ ] `conversationId String?` (FK to TuningConversation, SetNull on delete)
- [ ] `confidence Float?` — 0.0 to 1.0, verbalized confidence
- [ ] `appliedAndRetained7d Boolean?` — nullable tri-state: null=unknown/too-soon, true/false once checked
- [ ] `editEmbedding Unsupported("vector(1536)")?` OR plain `Bytes?` / `Json?` if pgvector is not installed. **Check first:** inspect `backend/prisma/schema.prisma` and the Postgres instance for pgvector. If absent, use `Json?` and note in the sprint report — per D1 pre-wire, the column just needs to exist.

**New enum:** `TuningConversationTriggerType` as listed above.

**Extension to `AiConfigVersion`** (D4 pre-wire):
- [ ] `experimentId String?`
- [ ] `trafficPercent Int?`

**Schema audit checklist** (include in the sprint report):
- Every new column on an existing table is nullable: yes / no
- No columns renamed: yes / no
- No columns dropped: yes / no
- No type changes on existing columns: yes / no
- No new `NOT NULL` added to existing columns: yes / no
- `npx prisma db push` output pasted

### 4. Teardown of old code (new branch only)

- [ ] Delete `frontend/components/tuning-review-v5.tsx`.
- [ ] Delete any frontend routes/imports that reference `tuning-review-v5` (search `tuning-review-v5` across `frontend/`).
- [ ] Delete `backend/src/services/tuning-analyzer.service.ts`.
- [ ] Remove the trigger call from `backend/src/controllers/shadow-preview.controller.ts` that invokes the old analyzer. Replace it with a TODO comment: `// TODO sprint-02: trigger new diagnostic pipeline here`. **Do not trigger anything yet.**
- [ ] Remove any unused imports / dead code left behind.
- [ ] **Do NOT** delete rows from `TuningSuggestion`. **Do NOT** drop the old enum values. The live `main` branch still writes to this table with old semantics; we coexist.
- [ ] `backend` and `frontend` both compile (`npm run build` in each).

### 5. Smoke test

- [ ] Start backend and frontend locally. Confirm:
  - Main AI pipeline still runs end-to-end on a test conversation (use `DRY_RUN`).
  - Langfuse trace appears.
  - No 500s from the shadow-preview send path (even though it no longer triggers tuning).
  - Old `/tuning` route either 404s cleanly or redirects to a placeholder — pick one and document.
  - `prisma studio` shows the new tables exist and are empty.

## Commits

Commit per logical unit. Suggested sequence:

1. `feat(041): create feat/041-conversational-tuning branch` (if branch creation is the first commit; otherwise skip)
2. `feat(041): add Langfuse OpenInference spans to main AI pipeline`
3. `feat(041): add evidence bundle assembler service`
4. `feat(041): Prisma schema additions for tuning v2 (additive, nullable)`
5. `chore(041): tear out old tuning-review-v5 UI`
6. `chore(041): tear out old two-step tuning analyzer`
7. `chore(041): remove analyzer trigger from shadow-preview controller`

Use the existing project commit-message convention (imperative subject, co-author line per `operational-rules.md` §Commits). Do NOT squash. Do NOT push.

## What to report back

Write `specs/041-conversational-tuning/sprint-01-evidence-and-schema-report.md` with these sections:

1. **What shipped** — bullet list of delivered acceptance criteria.
2. **What deviated** — anywhere the implementation differs from this prompt, with reason.
3. **Schema audit** — the checklist from §3 filled in, plus the `prisma db push` output.
4. **DB coexistence check** — confirm (with reasoning) that the live `main` branch's code can still read/write against the DB after these changes.
5. **Pre-wired but unused** — explicit list of what was added in §3 but has no caller yet (so sprint 02+ knows where to hook in).
6. **What's broken / deferred** — known issues, TODO comments left behind, anything the next sprint must handle.
7. **Files touched** — full list of created/modified/deleted files.
8. **Smoke test results** — pass/fail on each item in §5, with output where useful.
9. **Recommended next actions** — handoff notes for sprint 02.
10. **Commits** — `git log --oneline feat/041-conversational-tuning ^main` output.

## When to ask vs when to just implement

Per `operational-rules.md` §When to ask — stop and use AskUserQuestion (or stop and write the report early) if:

- pgvector is not installed and you're unsure whether to use `Json?` vs installing the extension (installing is a DB-wide change; ask).
- The existing `TuningSuggestion` rows have data shapes that conflict with the new nullable columns in a way this prompt didn't anticipate.
- `backend/src/services/ai.service.ts` already has partial Langfuse instrumentation that contradicts §1.
- Any DB-safety rule from `operational-rules.md` would be violated by the obvious implementation.

Do NOT ask for stylistic choices (file layout within a service, exact span attribute names beyond what's listed, commit message wording). Just pick something reasonable and note it in the report.
