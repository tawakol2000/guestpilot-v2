# Sprint 02 — Taxonomy + Diagnostic Pipeline (report)

> **Branch:** `feat/041-conversational-tuning` (9 commits on top of sprint 01's 5, unpushed).
> **Author:** sprint 02 Claude Code session (fresh, no prior-feature context beyond the spec docs and sprint-01 report).
> **Date:** 2026-04-15.

## 1. What shipped

- ✅ **§1 Taxonomy Prisma enum + TuningSuggestion extensions.** New `TuningDiagnosticCategory` enum with the 8 required values; `TuningSuggestion` gained `diagnosticCategory`, `diagnosticSubLabel`, `triggerType` (reusing the sprint-01 enum), and `evidenceBundleId` FK — all nullable. Index added on `(tenantId, diagnosticCategory)` to keep the sprint-03 velocity dashboard queries fast. `TuningActionType` is untouched.
- ✅ **§2 Preprocessing helpers.** `backend/src/services/tuning/diff.service.ts` exports `computeMyersDiff` (word-level Myers via the `diff` npm pkg), `semanticSimilarity` (deterministic Jaccard over unigrams + bigrams with case-folded, punctuation-stripped tokens — no embeddings), and `classifyEditMagnitude` (`MINOR`/`MODERATE`/`MAJOR`/`WHOLESALE`). Thresholds documented in code comments. Nine unit tests pass via node's built-in test runner.
- ✅ **§3 Diagnostic service.** `backend/src/services/tuning/diagnostic.service.ts` exports `runDiagnostic`. Flow: assemble bundle → persist bundle → diff+magnitude → one OpenAI Responses-API call with `gpt-5.4-mini-2026-03-17`, `reasoning.effort: 'high'`, strict `json_schema` structured output. System prompt hoists the 8-category taxonomy definitions as a `const` for prompt-cache efficiency and includes the anti-sycophancy + direct-refusal clauses ("If no artifact change is warranted, return NO_FIX — do not invent a fix"). Degrades silently on missing `OPENAI_API_KEY`. Nested span via `startAiSpan`.
- ✅ **§4 Suggestion writer.** `backend/src/services/tuning/suggestion-writer.service.ts` exports `writeSuggestionFromDiagnostic`. `NO_FIX` → return null, write nothing. `MISSING_CAPABILITY` → create `CapabilityRequest`, no suggestion. Everything else → create `TuningSuggestion` with the new taxonomy fields plus legacy-compat fields (`actionType` mapped via category→action-type table; `sopCategory`/`faqEntryId`/`systemPromptVariant` populated when a target id was knowable). 48h cooldown on same `(diagnosticCategory, target id)` prevents duplicate writes after a recent ACCEPTED suggestion. Five unit tests pass.
- ✅ **§5 Trigger wiring (all four).**
  - Trigger 1 (edited copilot send) + Trigger 2 (rejected draft): wired at the former `TODO sprint-02` site in `shadow-preview.controller.ts`. After a successful Hostaway send on an edited preview, the new pipeline fires fire-and-forget; `REJECT_TRIGGERED` when `semanticSimilarity < 0.3`, else `EDIT_TRIGGERED`. The `analyzerQueued` flag on the HTTP response now honestly reflects whether the pipeline was queued — fixing sprint-01's flagged dishonesty.
  - Trigger 3 (manager complaint): `POST /api/tuning/complaints` via new `tuning-complaint.controller.ts`.
  - Trigger 4 (thumbs-down on unedited send): `POST /api/messages/:id/thumbs-down`. Persists the rating via the existing `MessageRating` table (`rating='negative'`) for audit.
  - All four share a single in-memory 60s dedup keyed by `(triggerType, messageId)` via `trigger-dedup.service.ts`.
- ✅ **§6 Per-category EMA + read endpoint.** New `TuningCategoryStats` table (unique on `(tenantId, category)`). `updateCategoryStatsOnAccept`/`updateCategoryStatsOnReject` are called after `/accept` and `/reject` respectively with `α=0.3`. Read endpoint at `GET /api/tuning/category-stats`. EMA math unit-tested: first accept → 0.3, first reject → 0, accept-then-reject → 0.21.
- ✅ **§7 Schema audit** — see §3 below.
- ✅ **§8 Smoke tests** — see §9 below.

## 2. What deviated

- **Commit sequencing.** The brief suggested 11 commits; I shipped 9 (listed in §11). The `TuningCategoryStats` table landed in the same commit as the enum + suggestion-extensions (commit 1) rather than a separate commit — the three are one Prisma schema diff and splitting them would have produced a broken intermediate state. The diff-helpers + tests were committed together, and the stats-service + its read endpoint were committed together. Per-logical-unit discipline preserved; not squashed.
- **No ESLint / Prettier passes.** Neither is configured in the repo; the diff is standard TypeScript that `tsc` accepts strictly.
- **`smoke-diagnostic.ts` stamps `smoke-` into the sub-label** so the cleanup SQL in its docstring unambiguously matches only script-inserted rows. The model's original sub-label is preserved as a suffix (`smoke-${original}`). This is a deviation from "pass the result through unchanged", done so cleanup is safe.
- **Thumbs-down created net-new rather than extended `/rate`.** The existing `POST /api/messages/:id/rate` endpoint accepts `{ rating: 'positive' | 'negative' }` but is not specifically a thumbs-down trigger. The sprint brief said "extend vs create — if none exists, create". I created a dedicated `/thumbs-down` endpoint to keep the trigger semantics explicit (the rating endpoint is also called on positive ratings, which should NOT fire the diagnostic). The `/rate` endpoint still works; I added a regression assertion in `test-041-routes.ts`.
- **Soft commit amend.** Commit `5446db2` (thumbs-down trigger) was amended once to fix a TypeScript type error in the route handler signature — the original commit failed `tsc`. No published/pushed history was rewritten (the branch is unpushed). Flagging for transparency.

## 3. Schema audit

| Rule | Result |
|---|---|
| Every new column on an existing table is nullable | **yes** — `diagnosticCategory`, `diagnosticSubLabel`, `triggerType`, `evidenceBundleId` on `TuningSuggestion` all nullable |
| No columns renamed | **yes** |
| No columns dropped | **yes** |
| No type changes on existing columns | **yes** |
| No new `NOT NULL` added to existing columns | **yes** |
| `TuningActionType` untouched | **yes** — verified in schema.prisma, no edits |
| New enums added | **1** — `TuningDiagnosticCategory` |
| New tables added | **1** — `TuningCategoryStats` (unique `(tenantId, category)`) |

### `npx prisma db push` output

```
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "railway", schema "public" at "shinkansen.proxy.rlwy.net:27405"

🚀  Your database is now in sync with your Prisma schema. Done in 3.42s

Running generate... (Use --skip-generate to skip the generators)
✔ Generated Prisma Client (v5.22.0) to ./node_modules/@prisma/client in 256ms
```

### Post-push verification (live Railway DB)

```
TuningSuggestion (new cols):
 diagnosticCategory | USER-DEFINED (TuningDiagnosticCategory) | nullable
 diagnosticSubLabel | text                                    | nullable
 evidenceBundleId   | text                                    | nullable
 triggerType        | USER-DEFINED (TuningConversationTrigger…)| nullable

TuningDiagnosticCategory values:
 ['SOP_CONTENT','SOP_ROUTING','FAQ','SYSTEM_PROMPT',
  'TOOL_CONFIG','MISSING_CAPABILITY','PROPERTY_OVERRIDE','NO_FIX']

TuningCategoryStats:
 id, tenantId, category, acceptRateEma, acceptCount,
 rejectCount, lastUpdatedAt, createdAt   — all NOT NULL (safe; new table)

Row counts: evidenceBundles=2 (from two smoke-diagnostic runs);
           tuningCategoryStats=0; suggestions with diagnosticCategory=0.
```

The two `EvidenceBundle` rows are from the smoke script runs against the live DB. No `TuningSuggestion` rows written yet because `OPENAI_API_KEY` is not set in my local env — the pipeline degraded silently as designed.

## 4. DB coexistence check

The live `main` branch runs against the same Postgres. This sprint's changes remain safe:

- **New columns on `TuningSuggestion`:** all four nullable. Old-branch inserts that omit them succeed (Prisma fills NULL). Old-branch reads see NULL for the new columns. ✅
- **New enum `TuningDiagnosticCategory`:** only read by new-branch code. Old-branch Prisma client does not reference it. Old-branch will never read a row that was filtered by a new-enum value (that's new-branch-only query shape), so the "Prisma throws when it sees an enum value it doesn't know" hazard cannot fire here. ✅
- **New table `TuningCategoryStats`:** only read/written by new-branch `/api/tuning/category-stats` + the accept/reject EMA update. Old-branch code never queries it. ✅
- **`EvidenceBundle.suggestions` back-relation:** client-side metadata only; no DB shape change. ✅
- **Existing `/api/tuning-suggestions/:id/accept` + `/reject` endpoints:** extended to update category stats *after* the suggestion status transition completes, inside a try/catch that swallows stats errors — so old-branch suggestions (no `diagnosticCategory`) produce a no-op stats update rather than breaking the accept flow. Regression: `/rate` endpoint still registered (verified by `scripts/test-041-routes.ts`).

Net: the old `main` branch continues to read/write the DB with no behavioral change. Old accept/reject flows still write `status='ACCEPTED'` / `'REJECTED'` as before; the only new side-effect is a no-op stats upsert.

## 5. Taxonomy / prompt decisions

- **Sub-label strategy: free-form** as specified in vision.md §Principles #5 ("Rigid backbone, fluid labels"). The system prompt tells the model to keep sub-labels to 1–4 words and suggests examples (`parking-info-missing`, `checkin-time-tone`, `extend-stay-tool-unclear`); the schema accepts any string. A future sprint can cluster sub-labels for the velocity dashboard without having to re-run the pipeline.
- **Anti-sycophancy wording** (verbatim in `diagnostic.service.ts`):
  - *"Anti-sycophancy: if no artifact change is warranted, return NO_FIX. Do not invent a fix to satisfy the request."*
  - *"Refuse directly without lecturing. If the manager's edit reflects a personal style tic that should not be trained into the system, return NO_FIX with a short rationale explaining why it does not generalize."*
- **Diff library:** `diff` (npm). Chosen because it's the canonical Myers implementation for Node, has types via `@types/diff`, and exposes both `diffWordsWithSpace` (for insertion/deletion runs) and `createPatch` (for a unified-format string we pass straight to the LLM). Avoids hand-rolling Myers per the brief.
- **Similarity heuristic:** **Jaccard over unigrams + bigrams with punctuation stripping**, averaged. Picked over normalized Levenshtein because bigram Jaccard handles word-order changes gracefully and is O(n) after tokenization. On the 50–800-char copilot replies, unigram-only Jaccard gave false MAJOR/WHOLESALE labels for typo fixes (because a single added word drops the coefficient sharply); unigram+bigram average is robust for that case and keeps `< 0.3` a meaningful "wholesale rewrite" threshold. No embeddings — follows roadmap D10 rule.
- **Evidence-bundle size caps in prompt:** per-message content clamp 600 chars, SOP content 2000, FAQ answer 800, trace JSON 8000. Chosen so the 20-message window + SOPs + FAQ hits + Langfuse trace reliably fits under the `gpt-5.4-mini` input budget even on the longest observed bundles.
- **Category → legacy `TuningActionType` mapping** (documented in `suggestion-writer.service.ts`):

  | New category | Legacy `actionType` |
  |---|---|
  | `SOP_CONTENT` | `EDIT_SOP_CONTENT` |
  | `SOP_ROUTING` | `EDIT_SOP_ROUTING` |
  | `FAQ` | `EDIT_FAQ` |
  | `SYSTEM_PROMPT` | `EDIT_SYSTEM_PROMPT` |
  | `TOOL_CONFIG` | `EDIT_SYSTEM_PROMPT` (least-wrong fallback; legacy enum has no tool-config value) |
  | `PROPERTY_OVERRIDE` | `EDIT_SOP_CONTENT` (a property override IS an SOP content edit) |
  | `MISSING_CAPABILITY` | — (no TuningSuggestion row) |
  | `NO_FIX` | — (no TuningSuggestion row) |

  Sprint 03's new UI will dispatch on `diagnosticCategory` as the primary key; `actionType` becomes legacy.

## 6. Pre-wired but unused

New in this sprint that has no caller yet:

- **`TuningCategoryStats.lastUpdatedAt`** — already populated via `@updatedAt`; sprint-03 dashboard will render trend series from these rows.
- **`TuningSuggestion.diagnosticSubLabel`** — written on every new row; sprint-03 UI surfaces it. Sprint 04 agent can cluster across sub-labels.
- **`TuningSuggestion.triggerType`** — written on every new row; sprint-03 UI can group suggestions by trigger event. Sprint 04 agent reasons about event-type patterns.
- **`EvidenceBundle` rows are now persisted on every diagnostic run.** Sprint 04's tuning agent will call a `fetch_evidence_bundle(triggerId)` tool that reads from this table; sprint 02 writes are the seed data.
- **`CapabilityRequest` rows written for `MISSING_CAPABILITY` outputs** — no UI yet. Sprint 03 dashboard surfaces the manager backlog.

Still dormant from sprint 01, unchanged:

- `TuningSuggestion.editEmbedding`, `TuningSuggestion.appliedAndRetained7d`, `TuningSuggestion.applyMode` (stays null until sprint 03 UI), `TuningSuggestion.conversationId` (sprint 04), `AiConfigVersion.experimentId` / `trafficPercent`, `AgentMemory`, `TuningConversation`, `TuningMessage`, `PreferencePair`, and the pre-wired enum values `CLUSTER_TRIGGERED` / `ESCALATION_TRIGGERED`.

## 7. What's broken / deferred

- **OpenAI key required for suggestion writes.** Locally I do not have `OPENAI_API_KEY` set in `.env`, so the diagnostic degrades silently: it still assembles + persists the evidence bundle, but no `TuningSuggestion` is written. Railway presumably has the key configured already; the first deploy that exercises an edited send will be the first real end-to-end test. The `smoke-diagnostic.ts` script works the same way — sets up the data, calls the pipeline, prints the null result when the key is missing.
- **`TuningActionType` mapping for `TOOL_CONFIG`** maps to `EDIT_SYSTEM_PROMPT` as the least-wrong legacy value. If a manager clicks "Accept" on such a suggestion via the *old* `/api/tuning-suggestions/:id/accept` endpoint, it will try to edit a system prompt with no `systemPromptVariant` and respond `400 MISSING_REQUIRED_FIELDS`. This is expected: these suggestions should be accepted only from sprint-03's new UI that dispatches on `diagnosticCategory`. Sprint 03 needs to add a new accept dispatch for `TOOL_CONFIG` and for `PROPERTY_OVERRIDE` (the legacy accept path handles `sopPropertyId` but we don't know which property at diagnostic time — the UI should prompt).
- **`sopStatus` and `sopPropertyId` not set on sprint-02 writes.** The diagnostic LLM returns the SOP *category* but not the *status* variant to edit or which *property override* to touch. Leaving those fields null means the legacy accept path will also 400 on SOP suggestions — same reasoning as above. Sprint 03's UI should prompt the manager for the status and property before confirming the accept.
- **In-memory 60s dedup is per-process.** A multi-instance deploy can race two diagnostic runs through for the same messageId within 60s. Spec-accepted trade-off (documented in `trigger-dedup.service.ts`); a DB-backed dedup would add cost without meaningfully improving the failure mode since the diagnostic itself is fire-and-forget.
- **No oscillation detection.** 48h cooldown is the only guard against repeat writes. Oscillation ("manager accepted X yesterday, today the new signal would reverse X") is a sprint-04 concern per the roadmap.
- **`analyzerQueued` on the HTTP send response is now honest** but only binary. A future sprint may want to return the triggerType or suggestion id so the frontend can notify the manager immediately; not scoped to V1.
- **Smoke-diagnostic bundle rows are not auto-cleaned.** Two rows written in my test runs (live Railway DB). The script docstring documents a `DELETE FROM "EvidenceBundle" WHERE "createdAt" > NOW() - INTERVAL '1 hour'` cleanup. Left for sprint 03 to delete if desired.

## 8. Files touched

**Created (12):**

- `backend/src/services/tuning/diff.service.ts`
- `backend/src/services/tuning/diagnostic.service.ts`
- `backend/src/services/tuning/suggestion-writer.service.ts`
- `backend/src/services/tuning/trigger-dedup.service.ts`
- `backend/src/services/tuning/category-stats.service.ts`
- `backend/src/services/tuning/__tests__/diff.service.test.ts`
- `backend/src/services/tuning/__tests__/suggestion-writer.service.test.ts`
- `backend/src/services/tuning/__tests__/category-stats.service.test.ts`
- `backend/src/controllers/tuning-complaint.controller.ts`
- `backend/src/controllers/tuning-category-stats.controller.ts`
- `backend/src/routes/tuning-complaint.ts`
- `backend/scripts/smoke-diagnostic.ts`
- `backend/scripts/test-041-routes.ts`
- `specs/041-conversational-tuning/sprint-02-taxonomy-and-diagnostic-pipeline-report.md` (this file)

**Modified (5):**

- `backend/prisma/schema.prisma` — new enum `TuningDiagnosticCategory`, new table `TuningCategoryStats`, 4 new nullable columns + FK + 2 new indexes on `TuningSuggestion`, back-relation on `EvidenceBundle` and on `Tenant`.
- `backend/src/app.ts` — mount `tuningComplaintRouter` under `/api/tuning`.
- `backend/src/controllers/shadow-preview.controller.ts` — replace `TODO sprint-02` with the fire-and-forget EDIT/REJECT dispatch; wire honest `analyzerQueued` flag.
- `backend/src/controllers/tuning-suggestion.controller.ts` — call EMA update on accept + reject.
- `backend/src/routes/messages.ts` — add `POST /:id/thumbs-down`.
- `backend/package.json` — new dep `diff`; new dev-dep `@types/diff`.

**Deleted:** none.

## 9. Smoke test results

| Check | Result | Evidence |
|---|---|---|
| `npx prisma format` | ✅ pass | `Formatted prisma/schema.prisma in 58ms 🚀` |
| `npx prisma validate` | ✅ pass | `The schema at prisma/schema.prisma is valid 🚀` |
| `npx prisma db push` | ✅ pass | `Your database is now in sync ... Done in 3.42s` |
| Post-push column audit | ✅ pass | 4 new `TuningSuggestion` cols all nullable; 8 enum values present; `TuningCategoryStats` cols confirmed |
| `npx tsc --noEmit` | ✅ pass | exit 0 after every commit |
| `npm run build` | ✅ pass | `prisma generate && tsc && cp -r src/config dist/` completes cleanly |
| `node:test` diff.service tests | ✅ 9/9 pass | `tests 9 pass 9 fail 0 duration_ms 315` |
| `node:test` suggestion-writer tests | ✅ 5/5 pass | `tests 5 pass 5 fail 0 duration_ms 374` |
| `node:test` category-stats tests | ✅ 4/4 pass | `tests 4 pass 4 fail 0 duration_ms 325` |
| Full tuning test bundle | ✅ 18/18 pass | `tests 18 pass 18 fail 0 duration_ms 281` |
| `scripts/test-041-routes.ts` | ✅ pass | POST `/api/tuning/complaints`, GET `/api/tuning/category-stats`, POST `/api/messages/:id/thumbs-down` registered; POST `/api/messages/:id/rate` still registered (regression); all service exports load as functions |
| `scripts/test-040-routes.ts` | ✅ pass (regression) | All sprint-01 routes still registered |
| `scripts/smoke-diagnostic.ts` against live Railway DB | ✅ degrades cleanly | `using messageId=cmo0dz6l100d813a9srq3vzdh tenant=cmmth6d1r000a6bhlkb75ku4r ... [Diagnostic] OPENAI_API_KEY missing — returning null; caller should skip suggestion write.` Bundle assembly + persistence succeeded; two `EvidenceBundle` rows on Railway DB after two runs |
| End-to-end LLM call | ⚠️ not run | Local env has no `OPENAI_API_KEY`; same gap as sprint 01 reported. Runtime verification will happen on Railway deploy with the key set. |

### `curl` smokes for new endpoints (shapes only — local env does not have a running backend + valid JWT)

Replace `$JWT` and `$MSG_ID`. Local server must be `JWT_SECRET`- and `OPENAI_API_KEY`-configured.

```
# POST /api/tuning/complaints
curl -sS -X POST http://localhost:3000/api/tuning/complaints \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"messageId":"'"$MSG_ID"'","description":"AI ignored the guest asking about parking."}' | jq

# POST /api/messages/:id/thumbs-down
curl -sS -X POST http://localhost:3000/api/messages/$MSG_ID/thumbs-down \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"note":"wrong tone for an inquiry guest"}' | jq

# GET /api/tuning/category-stats
curl -sS -H "Authorization: Bearer $JWT" http://localhost:3000/api/tuning/category-stats | jq

# Expected shapes:
# complaints / thumbs-down → {"ok":true,"triggerId":"<msgid>","deduped":false}
# category-stats           → {"stats":[{"category":"...","acceptRateEma":0.2,"acceptCount":1,"rejectCount":1,"lastUpdatedAt":"..."}]}
```

I did not run the `curl`s against a live server because my local environment lacks a valid `JWT_SECRET` + an authenticated session. The `scripts/test-041-routes.ts` smoke substitutes by verifying route registration through the app factory.

## 10. Recommended next actions (handoff to sprint 03)

1. **Set `OPENAI_API_KEY` on Railway** (probably already there for the main AI) before the first deploy. Once set, a single edited-preview send produces one `EvidenceBundle` row + optionally one `TuningSuggestion` row with `diagnosticCategory` populated. Confirm via Prisma Studio.
2. **Sprint 03 UI dispatch on `diagnosticCategory`**, not `actionType`. The legacy `actionType` value is a compatibility carrier only.
3. **Sprint 03 accept flows for `TOOL_CONFIG`, `PROPERTY_OVERRIDE`, and any SOP suggestion.** The legacy `/api/tuning-suggestions/:id/accept` handlers need extension to:
   - accept `applyMode` (`IMMEDIATE` | `QUEUED`) from the UI and persist it;
   - prompt for `sopStatus` + optional `sopPropertyId` on SOP suggestions (diagnostic does not fill those fields);
   - dispatch `TOOL_CONFIG` to a new handler that updates `ToolDefinition` rows.
4. **Sprint 03 velocity dashboard** should consume `GET /api/tuning/category-stats` and render the EMA trend per category.
5. **`CapabilityRequest` surface** needs a manager backlog page — one-row-per-request read is enough for V1.
6. **Unit tests for `evidence-bundle.service.ts`** still deferred; sprint 02 added its first real caller (`diagnostic.service.ts`) so a regression harness against a fixture DB would now be useful.
7. **Sprint 04's tuning agent:** the `EvidenceBundle` rows are the handle — `fetch_evidence_bundle(triggerId)` where `triggerId` maps to `EvidenceBundle.id`. Sprint 02 is the seed data.
8. **Clean the smoke-diagnostic EvidenceBundle rows** if you want a clean slate before sprint 03 starts: `DELETE FROM "EvidenceBundle" WHERE "createdAt" < NOW() AND "createdAt" > NOW() - INTERVAL '1 day' AND payload->'trigger'->>'note' = 'sprint-02 smoke-diagnostic';` (or just leave them — they are harmless).

## 11. Commits

```
1701e9b test(041): diagnostic pipeline smoke + route-registration smoke
f1b7be2 feat(041): per-category EMA acceptance-rate tracking + read endpoint
5446db2 feat(041): thumbs-down trigger
ead1ee3 feat(041): complaint endpoint
a1ddd47 feat(041): wire edit + reject triggers at shadow-preview send
173a524 feat(041): suggestion writer with 48h cooldown
da391fd feat(041): diagnostic service (single LLM call)
97a6e93 feat(041): diff + magnitude preprocessing helpers
cf17450 feat(041): add TuningDiagnosticCategory enum and TuningSuggestion extensions
```

`git log --oneline feat/041-conversational-tuning ^advanced-ai-v7` shows these 9 new commits on top of sprint 01's 5. Branch is unpushed per operational-rules §Commits. No squashing.
