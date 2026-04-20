# Sprint 02 — Taxonomy + Diagnostic Pipeline

> **You are a fresh Claude Code session with no memory of prior work.** Read the files listed below before writing any code. The spec docs and the sprint-01 report are the source of truth.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md` — branch, DB-coexistence, commit rules. Non-negotiable.
2. `specs/041-conversational-tuning/vision.md` — product vision.
3. `specs/041-conversational-tuning/roadmap.md` — V1 day-by-day. This sprint covers **days 4-6**.
4. `specs/041-conversational-tuning/deferred.md` — what's deferred and what pre-wiring exists.
5. `specs/041-conversational-tuning/glossary.md` — vocabulary.
6. `specs/041-conversational-tuning/sprint-01-evidence-and-schema-report.md` — **read this carefully.** What's in place, what's pre-wired, `TODO sprint-02` hooks.
7. `CLAUDE.md` (repo root).
8. `backend/prisma/schema.prisma` — current schema, including the sprint-01 additions.
9. `backend/src/services/evidence-bundle.service.ts` — your input source.
10. `backend/scripts/smoke-evidence-bundle.ts` — shows the shape of an assembled bundle.
11. `backend/src/controllers/shadow-preview.controller.ts` — contains the `TODO sprint-02` comment block you must wire into.
12. `backend/src/controllers/tuning-suggestion.controller.ts` — existing suggestion CRUD. Reject/accept endpoints live here; extend them for acceptance-rate tracking.
13. `backend/src/services/ai.service.ts` — shows how the existing main-AI pipeline calls OpenAI via the Responses API (`callOpenAI`). Match that pattern for the diagnostic LLM call.
14. `backend/src/services/observability.service.ts` — sprint 01's instrumentation primitives (`runWithAiTrace`, `startAiSpan`). Use them for diagnostic spans.

## Branch

- `feat/041-conversational-tuning` already exists with sprint 01's 5 commits. Check it out; commit on top.
- Never commit to `main`. Never push.

## Goal

Build the backend diagnostic pipeline that turns a trigger event into zero or more `TuningSuggestion` records, each tagged with the 8-category taxonomy, a verbalized confidence, a rationale, and a proposed diff. Hook it up at the `TODO sprint-02` site in `shadow-preview.controller.ts` (edited-copilot-send trigger) and wire the remaining three triggers. Instrument per-category acceptance-rate tracking (EMA α=0.3) and a 48h cooldown registry.

## Non-goals (do NOT do in this sprint)

- **Do NOT build the new `/tuning` frontend.** Sprint 03.
- **Do NOT integrate Claude Agent SDK or build the conversational agent.** Sprint 04.
- **Do NOT populate `TuningSuggestion.applyMode`.** It stays null until sprint 03's UI writes it. The lifecycle for now is: new suggestion created → status `PENDING` (existing `TuningSuggestionStatus` value) → waits for UI.
- **Do NOT populate `conversationId`.** Sprint 04 sets this when a suggestion is proposed from within a chat.
- **Do NOT populate `appliedAndRetained7d`.** That is a periodic-job concern covered later in V1.
- **Do NOT populate `editEmbedding`.** D1 pre-wire only; stays null.
- **Do NOT alter `TuningActionType`.** It's in use by old-branch code. The new taxonomy is a *new* enum.
- **Do NOT implement HDBSCAN clustering or any nightly job.** D1 deferred.
- **Do NOT shadow-evaluate suggestions before surfacing.** D3 deferred.
- **Do NOT write to `PreferencePair`.** D2 pre-wire only.

## Acceptance criteria

### 1. Taxonomy Prisma enum

- [ ] Add new Prisma enum `TuningDiagnosticCategory` (do NOT touch existing `TuningActionType`):
  - `SOP_CONTENT`
  - `SOP_ROUTING`
  - `FAQ`
  - `SYSTEM_PROMPT`
  - `TOOL_CONFIG`
  - `MISSING_CAPABILITY`
  - `PROPERTY_OVERRIDE`
  - `NO_FIX`
- [ ] Extend `TuningSuggestion` with nullable `diagnosticCategory TuningDiagnosticCategory?` and nullable `diagnosticSubLabel String?` (free-form model-generated sub-label). Old-branch writes that don't set these fields must still succeed — nullable is mandatory.
- [ ] Add nullable `TuningSuggestion.triggerType TuningConversationTriggerType?` so a suggestion links back to its originating trigger event. (Yes, reusing the enum from sprint 01 is deliberate — trigger types are shared.)
- [ ] Add nullable `TuningSuggestion.evidenceBundleId String?` FK (SetNull on delete) linking a suggestion to its `EvidenceBundle` row.
- [ ] `npx prisma db push` clean. Schema audit included in the report per sprint-01 precedent.

### 2. Preprocessing helpers (pure code, no LLM calls)

- [ ] `backend/src/services/tuning/diff.service.ts` exporting:
  - `computeMyersDiff(original: string, final: string): { insertions: string[]; deletions: string[]; unified: string }` — Myers diff; use an existing npm library (`diff` or similar) rather than hand-rolling.
  - `semanticSimilarity(a: string, b: string): number` — lightweight 0-1 similarity. **No embeddings.** Use a deterministic heuristic (Jaccard over token shingles, or normalized Levenshtein distance). Document which one you chose and why in the sprint report. Per D10 we're explicitly avoiding embeddings for dynamic text; this function runs on copilot-drafted vs manager-edited text, which is close enough to that case to warrant the rule.
  - `classifyEditMagnitude(original: string, final: string): 'MINOR' | 'MODERATE' | 'MAJOR' | 'WHOLESALE'` — heuristic based on (a) similarity, (b) length delta, (c) sentence-level preservation. Thresholds documented in code comments.
- [ ] Unit tests for each function in `backend/src/services/tuning/__tests__/diff.service.test.ts`. At minimum: identical-string → similarity 1.0, disjoint-string → similarity ≤ 0.3, wholesale rewrite → `WHOLESALE`.

### 3. Diagnostic service (single LLM call)

- [ ] `backend/src/services/tuning/diagnostic.service.ts` exporting `runDiagnostic(triggerEvent): Promise<DiagnosticResult>` where `DiagnosticResult` is a typed union / object containing:
  - `category: TuningDiagnosticCategory`
  - `subLabel: string`
  - `confidence: number` (0..1, model-verbalized)
  - `rationale: string`
  - `proposedText: string | null` (null when category is `NO_FIX` or `MISSING_CAPABILITY`)
  - `artifactTarget: { type: 'SOP' | 'FAQ' | 'SYSTEM_PROMPT' | 'TOOL' | 'PROPERTY_OVERRIDE' | 'NONE'; id: string | null }`
  - `capabilityRequest: { title: string; description: string; rationale: string } | null` — populated only when category is `MISSING_CAPABILITY`.
- [ ] Flow inside `runDiagnostic`:
  1. Call `assembleEvidenceBundle(triggerEvent, prisma)` (sprint 01).
  2. Persist the bundle to `EvidenceBundle` and capture the row id.
  3. Run diff + magnitude classification on the original vs final text.
  4. Single OpenAI call via the Responses API with structured JSON output enforced by `json_schema`. Model: `gpt-5.4-mini-2026-03-17` (matches main pipeline). Reasoning effort: `high`.
  5. Return the `DiagnosticResult`.
- [ ] The LLM prompt must include: full evidence bundle (trimmed if oversize), original vs final text, diff summary, magnitude classification, prior correction history for the same property+category (from bundle), and the 8-category taxonomy definitions (stable — put in a const at top of the file, not re-constructed per call).
- [ ] The LLM call is traced as a nested span under the existing root trace when inside one (using `startAiSpan`); otherwise a standalone trace via `traceAiCall` (follow sprint 01's pattern).
- [ ] Degrades silently if OpenAI key missing — logs and returns null. Caller must handle null.
- [ ] Add an explicit anti-sycophancy + direct-refusal clause to the diagnostic system prompt: "If no artifact change is warranted, return `NO_FIX` — do not invent a fix to satisfy the request." Sub-labels are free-form, not a closed set.

### 4. Suggestion persistence

- [ ] `backend/src/services/tuning/suggestion-writer.service.ts` exporting `writeSuggestionFromDiagnostic(result, context): Promise<TuningSuggestion | null>`:
  - Returns null and writes nothing when `result.category === 'NO_FIX'`.
  - Creates a `TuningSuggestion` row with: `diagnosticCategory`, `diagnosticSubLabel`, `confidence`, `rationale`, `proposedText`, `triggerType`, `evidenceBundleId`, existing required fields populated sensibly, `status: PENDING`, `applyMode: null` (UI sets later).
  - When `result.category === 'MISSING_CAPABILITY'`, creates a `CapabilityRequest` row (no `TuningSuggestion`) — the manager backlog, not the artifact queue.
  - Enforces the **48h cooldown**: if a `TuningSuggestion` already exists for the same `artifactTarget` (type+id) with status `APPLIED` in the last 48 hours, do not create a new suggestion for that target. Log + increment a counter. **No oscillation detection in this sprint** — just the simple cooldown.

### 5. Trigger wiring (all four V1 triggers)

The sprint-01 report left a `TODO sprint-02` in `shadow-preview.controller.ts`. This is trigger #1. Wire all four:

- [ ] **Trigger 1 — Edited copilot send.** In `shadow-preview.controller.ts` where the `TODO sprint-02` block lives, after an edited preview is sent (original ≠ final text), call `runDiagnostic({ triggerType: 'EDIT_TRIGGERED', ...ctx })` fire-and-forget (don't block the HTTP response), then `writeSuggestionFromDiagnostic`. Also update the `analyzerQueued` response flag to accurately reflect whether the new pipeline was queued (sprint-01 report flagged this as a temporary dishonesty).
- [ ] **Trigger 2 — Rejected draft.** An edited-preview send counts as "rejected" when `semanticSimilarity(original, final) < 0.3` (i.e. wholesale replacement). Same entry point as trigger 1, but the `triggerType` is `REJECT_TRIGGERED` and the diagnostic prompt is tuned to treat it as "the AI got this fundamentally wrong" rather than "the AI got the details wrong." One code path, two labels.
- [ ] **Trigger 3 — Manager-initiated complaint.** New endpoint `POST /api/tuning/complaints` with body `{ messageId, description }`. Controller: `backend/src/controllers/tuning-complaint.controller.ts`. Validates the messageId, constructs the trigger event, calls `runDiagnostic` with `triggerType: 'COMPLAINT_TRIGGERED'`. Returns `{ triggerId }` immediately; diagnostic runs async.
- [ ] **Trigger 4 — Thumbs-down on unedited send.** Extend the existing thumbs-down endpoint (search `thumbsDown` / `feedback` in `backend/src/controllers/`; if none exists, create `POST /api/messages/:id/thumbs-down`). Fire `runDiagnostic` with `triggerType: 'THUMBS_DOWN_TRIGGERED'`.

All four triggers must be idempotent-safe: if the same trigger fires twice within 60 seconds for the same `messageId`, the second invocation is a no-op (dedup via an in-memory Set or a simple DB check — document choice).

### 6. Acceptance-rate EMA + metrics

- [ ] New table `TuningCategoryStats` (additive, new table, safe):
  - `id`, `tenantId`, `category TuningDiagnosticCategory`, `acceptRateEma Float @default(0.0)`, `acceptCount Int @default(0)`, `rejectCount Int @default(0)`, `lastUpdatedAt DateTime @updatedAt`
  - `@@unique([tenantId, category])`
- [ ] Extend `backend/src/controllers/tuning-suggestion.controller.ts` Accept and Reject endpoints to update the corresponding `TuningCategoryStats` row using EMA α=0.3: `newEma = 0.3 * (accepted ? 1 : 0) + 0.7 * oldEma`. Counts increment every time.
- [ ] New read-only endpoint `GET /api/tuning/category-stats` returning all `TuningCategoryStats` rows for the current tenant. Sprint 03's dashboard will consume this. No UI yet.

### 7. Schema audit checklist (include in the sprint report)

- Every new column on an existing table is nullable: yes / no
- No columns renamed: yes / no
- No columns dropped: yes / no
- No type changes on existing columns: yes / no
- No new `NOT NULL` added to existing columns: yes / no
- `TuningActionType` untouched: yes / no
- `npx prisma db push` output pasted

### 8. Smoke tests

- [ ] `backend/scripts/smoke-diagnostic.ts` — end-to-end script: pick a recent edited `ShadowPreview` from the DB, run the full pipeline against it, log the resulting `DiagnosticResult`, persisted `TuningSuggestion`, and `EvidenceBundle` id. Must work against the live Railway DB in a read-then-insert-one-test-row mode. Document the test-row cleanup command in the script.
- [ ] Unit tests pass: `diff.service.test.ts`, plus at least one test for `suggestion-writer.service.ts` (cooldown enforcement) and one for the category-stats EMA update.
- [ ] `npm run build` clean for backend.
- [ ] `curl`-able smoke of the new endpoints (complaint, thumbs-down, category-stats) — log the `curl` invocations in the report.

## Commits

Commit per logical unit. Suggested sequence:

1. `feat(041): add TuningDiagnosticCategory enum and TuningSuggestion extensions`
2. `feat(041): add TuningCategoryStats table`
3. `feat(041): diff + magnitude preprocessing helpers`
4. `feat(041): diagnostic service (single LLM call)`
5. `feat(041): suggestion writer with 48h cooldown`
6. `feat(041): wire edit + reject triggers at shadow-preview send`
7. `feat(041): complaint endpoint`
8. `feat(041): thumbs-down trigger`
9. `feat(041): per-category EMA acceptance-rate tracking`
10. `feat(041): category-stats read endpoint`
11. `test(041): diagnostic pipeline smoke + unit tests`

Do not squash. Do not push.

## What to report back

Write `specs/041-conversational-tuning/sprint-02-taxonomy-and-diagnostic-pipeline-report.md` with these sections:

1. **What shipped** — delivered acceptance criteria.
2. **What deviated** — differences from this brief, with reason.
3. **Schema audit** — checklist from §7 + `prisma db push` output.
4. **DB coexistence check** — confirm old-branch code still reads/writes happily.
5. **Taxonomy/prompt decisions** — what sub-label strategy you used, what anti-sycophancy wording, which diff library, which similarity heuristic (and why).
6. **Pre-wired but unused** — anything added in this sprint that has no caller yet (so sprint 03+ knows where to hook in).
7. **What's broken / deferred** — TODOs, known issues, anything sprint 03 must handle.
8. **Files touched** — created / modified / deleted.
9. **Smoke test results** — pass/fail per item in §8 with command output.
10. **Recommended next actions** — handoff notes for sprint 03 (the UI).
11. **Commits** — `git log --oneline feat/041-conversational-tuning ^main`.

## When to ask vs when to just implement

Stop and use AskUserQuestion (or stop and write the report early) when:

- Evidence bundle shape from sprint 01 does not have a field the diagnostic call needs — decide whether to extend the bundle (preferred: additive change) or pull from source directly.
- Existing thumbs-down / feedback endpoint exists in a non-obvious place and the choice between extending vs creating a new one isn't clear.
- The LLM diagnostic call's structured-output schema needs a design decision that will lock future sprints into a shape (e.g. whether sub-label is free-form or from a fixed list — brief says free-form, confirm if the evidence disagrees).
- Any DB-safety rule from `operational-rules.md` would be violated by the obvious implementation.

Do NOT ask for prompt wording, file layout inside a service, commit message style, or anything cosmetic. Pick something reasonable; note it in the report.
