# Concerns — Internal Tracking

> **Internal file. Not for sprint sessions.** This is the planning chat's running list of things we noticed but didn't act on yet, open questions, and things we must not forget. Claude updates this file as concerns surface across sprints.
>
> **Rule:** Don't let a concern disappear into chat history. If it's worth remembering, it belongs here.

## Format

Each entry:
- **ID** — short tag
- **Surfaced** — when/where it came up
- **Concern** — what it is
- **Status** — `OPEN` / `DEFERRED` / `RESOLVED`
- **Action** — what we plan to do, or "none, just flagged"

---

## Active concerns

### C1 — `analyzerQueued` flag honesty
- **Surfaced:** sprint-01 report, §6.
- **Concern:** The HTTP response from shadow-preview send returns `analyzerQueued: true` on edited sends even though sprint-01 removed the analyzer. Temporary frontend dishonesty.
- **Status:** RESOLVED in sprint-02 — flag now honestly reflects whether pipeline was queued.

### C2 — Langfuse keys not set locally
- **Surfaced:** sprint-01 report, §6.
- **Concern:** `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY` missing in local `.env`. Main-AI tracing invisible locally. Assumed present on Railway, not verified.
- **Status:** RESOLVED in sprint-05 — verified all three Langfuse keys present on Railway production AND preview. Sprint-05 deploy verification confirmed traces flow.

### C3 — Evidence bundle has no automated tests
- **Surfaced:** sprint-01 report, §6.
- **Concern:** `evidence-bundle.service.ts` only has a visual smoke script. No assertion harness.
- **Status:** RESOLVED in sprint-05 §7 — `evidence-bundle.integration.test.ts` asserts the documented bundle shape against a fixture conversation. Suite passes against Railway DB.

### C4 — Drafting strategy: sprint-by-sprint vs upfront
- **Surfaced:** planning chat, 2026-04-15.
- **Concern:** Sprints drafted one at a time, each informed by the prior sprint's report. Trade-off: briefs reflect reality but Abdelrahman can't see the full V1 arc on paper until it's done.
- **Status:** OPEN — decision stands for now (drafting as we go), revisit after sprint-02.
- **Action:** if Abdelrahman wants full V1 visibility, draft sprint-03 and sprint-04 speculatively after sprint-02 lands.

### C5 — Prisma schema diff churn from `prisma format`
- **Surfaced:** sprint-01 report, §2 + §6.
- **Concern:** `npx prisma format` reformats the whole schema, inflating diffs (+353/-226 on the substantive change). Future sprints' schema diffs will look bigger than they are.
- **Status:** OPEN, flagged.
- **Action:** none — just run `prisma format` consistently per sprint, use `--word-diff` when reviewing.

### C6 — `TuningSuggestion.userId` has no FK
- **Surfaced:** sprint-01 report, §2.
- **Concern:** Repo has no `User` Prisma model; `userId` fields are plain nullable strings by convention. D15 multi-user pre-wiring still holds, but when we productize we'll need a real `User` model and a migration to add the FK.
- **Status:** DEFERRED to V3 / D15 unlock.
- **Action:** note at D15 unlock time.

### C7 — pgvector installed, `editEmbedding` uses `Unsupported(vector(1536))`
- **Surfaced:** sprint-01 report, §2.
- **Concern:** Inserts to `editEmbedding` require raw SQL (`$executeRaw`) because Prisma can't type `Unsupported` columns. D1 when unlocked must handle this.
- **Status:** DEFERRED to D1 unlock.
- **Action:** flag in D1's unlock spec.

### C8 — Old `TuningSuggestion` rows coexist with new-schema rows
- **Surfaced:** sprint-01 operational-rules §6.
- **Concern:** Live `main` branch keeps writing old-shape rows (new fields NULL). Sprint-03 UI and sprint-04 agent must gracefully handle rows where `diagnosticCategory`, `confidence`, etc. are all null — treat them as legacy, don't crash, don't include in new-pipeline metrics.
- **Status:** OPEN — must be addressed in sprint-03 brief.
- **Action:** add explicit "handle legacy rows" acceptance criterion to sprint-03.

### C9 — Branch merge strategy when V1 is done
- **Surfaced:** operational-rules.md §Branch.
- **Concern:** `feat/041-conversational-tuning` will be ~30+ commits by the end of sprint-04. Merge to `main` is explicit-approval-only per the rule. Need to decide at that point: merge commit, fast-forward, or rebase-and-merge. Also need final DB-coexistence verification since the new branch has been deployed to preview multiple times by then.
- **Status:** READY FOR DECISION — sprint 05 §10 audit complete. Recommendation in sprint-05 report §8: **merge commit** (preserves sprint-by-sprint history).
- **Action:** Abdelrahman executes the merge per recommendation.

### C10 — Diagnostic prompt wording is undecided
- **Surfaced:** sprint-02 brief, §3.
- **Concern:** The 8-category taxonomy definitions + anti-sycophancy clause are written into the diagnostic service system prompt by the sprint-02 session on its own judgment. First-pass wording will almost certainly need iteration once we see real suggestions.
- **Status:** OPEN — expected to surface as a concern after sprint-02.
- **Action:** review sprint-02's chosen prompt in its report; schedule a prompt-iteration pass before sprint-03 if the categories feel mis-targeted.

### C11 — Cooldown is artifact-target-based, not content-based
- **Surfaced:** sprint-02 brief, §4.
- **Concern:** 48h cooldown blocks new suggestions for the same artifact target, regardless of content. If a suggestion proposes a substantially different edit to the same SOP, it's still blocked. Oscillation detection deferred to later.
- **Status:** DEFERRED.
- **Action:** revisit after seeing real acceptance data — may need content-diff-aware cooldown.

---

### C12 — Diagnostic leaves `sopStatus` and `sopPropertyId` null
- **Surfaced:** sprint-02 report §7.
- **Concern:** The diagnostic LLM returns SOP *category* but not which status variant or property override to edit. Legacy `/api/tuning-suggestions/:id/accept` returns 400 on SOP suggestions without these fields.
- **Status:** OPEN — must be addressed in sprint-03 UI.
- **Action:** sprint-03 accept flow prompts the manager for status + optional propertyId before confirming. Brief contains this as an acceptance criterion.

### C13 — `TOOL_CONFIG → EDIT_SYSTEM_PROMPT` legacy mapping
- **Surfaced:** sprint-02 report §5 + §7.
- **Concern:** Legacy `TuningActionType` has no `TOOL_CONFIG` value. Sprint-02 maps it to `EDIT_SYSTEM_PROMPT` as a least-wrong fallback. If a manager accepts such a suggestion via the *legacy* endpoint, it 400s because no `systemPromptVariant` is set.
- **Status:** OPEN — sprint-03 UI must dispatch on `diagnosticCategory` and route `TOOL_CONFIG` to a new handler that edits `ToolDefinition` rows.
- **Action:** explicit acceptance criterion in sprint-03 brief.

### C14 — Per-process in-memory trigger dedup
- **Surfaced:** sprint-02 report §7.
- **Concern:** 60s dedup for duplicate triggers is in-memory per Node process. A multi-instance Railway deploy can race two diagnostic runs through for the same messageId. Accepted trade-off for now.
- **Status:** DEFERRED — revisit if we deploy multi-instance.
- **Action:** none; noted.

### C15 — Smoke-diagnostic EvidenceBundle rows on Railway DB
- **Surfaced:** sprint-02 report §7.
- **Concern:** Two smoke-run EvidenceBundle rows exist on live Railway DB. Harmless but clutter.
- **Status:** RESOLVED in sprint-05 §9 — `scripts/cleanup-smoke-evidence.ts` ran on Railway, deleted 10 EvidenceBundle + 2 TuningSuggestion smoke rows. Re-audit returns zero.

### C16 — UI must handle legacy `TuningSuggestion` rows gracefully
- **Surfaced:** planning chat (C8 originally), reinforced by sprint-02's dual-write model.
- **Concern:** Live `main` branch keeps writing old-shape rows.
- **Status:** RESOLVED in sprint-03 — every surface checks nulls and falls back. Legacy group in queue, neutral pill, no rationale/evidence blocks.

### C17 — SOP / FAQ rollback returns 501
- **Surfaced:** sprint-03 report §2, §9.
- **Concern:** Version-history rollback works for `SYSTEM_PROMPT` (history JSON) and `TOOL_DEFINITION` (reset to default) but returns 501 NOT_SUPPORTED for SOP and FAQ because there's no snapshot table. Adding one would require a schema change, which sprint-03 was forbidden from making.
- **Status:** RESOLVED in sprint-05 §2 — `SopVariantHistory` + `FaqEntryHistory` tables shipped. Snapshot helper writes from both legacy `/accept` controller path and sprint-04 `suggestion_action` tool path. Rollback endpoint + agent `rollback` tool now return 200 for SOP_VARIANT and FAQ_ENTRY.

### C18 — Mobile drawer (<768px) not implemented
- **Surfaced:** sprint-03 report §2, §9.
- **Concern:** Left rail is hidden below 768px with no top-drawer trigger. Desktop-primary per brief; this is a small shadcn Sheet wiring task.
- **Status:** RESOLVED in sprint-05 §6 — shadcn `Sheet` wired as a top drawer below md, hamburger trigger in `TuningTopNav`, auto-closes on selection. Verified at 600×900 in sprint-05 click-through (screenshots `04-mobile-drawer-open.png`).

### C19 — Graduation dashboard uses magnitude proxy
- **Surfaced:** sprint-03 report §2, §9.
- **Concern:** `classifyEditMagnitude` from sprint-02 is authoritative, but the score isn't persisted on `Message`, so `graduation-metrics` endpoint uses a character-position-equality proxy. Easy fix: additive nullable `Message.editMagnitudeScore` column written at trigger time.
- **Status:** RESOLVED in sprint-05 §3 — additive `Message.editMagnitudeScore Float?` column shipped. Diagnostic pipeline persists the score at trigger time (verified on Railway: 0.97 on a real WHOLESALE rewrite). graduation-metrics averages it; legacy rows stay on the proxy.

### C20 — Queue doesn't live-refresh when another tab accepts
- **Surfaced:** sprint-03 report §9.
- **Concern:** Accept in one tab doesn't update another tab. Manual refresh needed. Acceptable for V1 single-manager use.
- **Status:** RESOLVED in sprint-05 §5 — `/tuning` page subscribes to the existing `tuning_suggestion_updated` Socket.IO channel and refetches the queue on receipt, debounced to ≤1/s. Manual two-tab smoke deferred to post-merge.

### C21 — Evidence-bundle endpoint has no integration test
- **Surfaced:** sprint-03 report §9.
- **Concern:** `GET /api/evidence-bundles/:id` works against real rows but has no automated assertion.
- **Status:** RESOLVED in sprint-05 §7 — `evidence-bundle.integration.test.ts` asserts 200 + payload on a real row and 404 on a missing one. Suite passes against Railway DB.

### C22 — Pre-existing TypeScript errors in unchanged files
- **Surfaced:** sprint-03 report §9.
- **Concern:** `calendar-v5`, `configure-ai-v5`, `inbox-v5`, `listings-v5`, `sandbox-chat-v5`, `tools-v5` have pre-existing TS errors. `next build` passes with `Skipping validation of types` (project default). Not sprint-041's doing but worth flagging.
- **Status:** OPEN, not ours to fix in this feature.
- **Action:** surface to Abdelrahman; separate cleanup pass outside feature 041.

### C23 — `gpt-5.4-2026-03-17` is not on OpenAI's API
- **Surfaced:** sprint-05 §1.
- **Concern:** `tenant-config.service.ts:22` lists `gpt-5.4-2026-03-17` in ALLOWED_MODELS, but the OpenAI Responses API returns `model_not_found` for it on our account. Sprint 05 verified the undated alias `gpt-5.4` works and made it the default for `TUNING_DIAGNOSTIC_MODEL`. The dated identifier in the allowed-models list is aspirational / a future-snapshot placeholder.
- **Status:** OPEN, low priority.
- **Action:** when a dated `gpt-5.4-2026-xx-xx` GA snapshot lands, swap the default. The fallback path in `diagnostic.service.ts` handles `model_not_found` gracefully so this never crashes.

### C24 — Diagnostic on full gpt-5.4 needs ~4000 max_output_tokens
- **Surfaced:** sprint-05 §1 verification.
- **Concern:** With `reasoning.effort: 'high'` on the full `gpt-5.4`, hidden reasoning tokens can consume the entire output budget if `max_output_tokens` is left at sprint-02's 1500. Real edits returned empty output until bumped to 4000. At ~$0.07 per call (4.2K input + ~3.8K output × $15/M), the cost-per-diagnostic is ~17× sprint-02 mini's $0.004 but well under the <$20/day envelope at the expected ~10 diagnostics/day.
- **Status:** RESOLVED in sprint-05 — limit bumped to 4000. Documented in `diagnostic.service.ts` comment.
- **Action:** none, just monitor cost in Langfuse for the first week of production.

### C25 — Production has zero new-pipeline TuningSuggestion rows
- **Surfaced:** sprint-05 §10 audit.
- **Concern:** All 16 TuningSuggestion rows on the shared Postgres are LEGACY (no `diagnosticCategory`/`triggerType`/`confidence`). The new diagnostic pipeline has only run during sprint 02/05 smokes; production traffic running on `main` doesn't trigger the new pipeline. Net: post-merge, the queue will still be 100% LEGACY for the first edited send that goes through the new pipeline.
- **Status:** OPEN — informational, expected.
- **Action:** post-merge, the first manager-edited copilot send produces the first new-pipeline row. Worth a screenshot when it happens.

### C26 — Preview env Redis-URL inherited a wrong password
- **Surfaced:** sprint-05 §8.
- **Concern:** `railway environment new preview --duplicate production` carried over `REDIS_URL` pointing at production's `Redis-gufZ` instance with a credential the new preview env couldn't authenticate with. Service crashed on boot until the variable was unset (then BullMQ degrades gracefully to polling per CLAUDE.md critical rule #2).
- **Status:** OPEN — preview-specific, not blocking V1.
- **Action:** if the preview env is kept long-term, point it at a dedicated preview Redis. For sprint 05 verification we ran without Redis.

### C27 — Prompt cache verified at >0.99 (sprint-04 §8 open question RESOLVED)
- **Surfaced:** sprint-04 §8 left this as the V1 headline unknown ("does the SDK's CLI subprocess forward `cache_control` markers?").
- **Concern:** The Anthropic Agent SDK's CLI-subprocess execution model could in principle break prompt caching by mangling system-prompt boundaries.
- **Status:** RESOLVED in sprint-05 §8 — runtime now logs the Anthropic usage object on every assistant message. Two `/api/tuning/chat` POSTs on the same `conversationId` against Railway preview produced `cache_read_input_tokens` of 2482 → 4474 → 4597 → 5275 with `input_tokens` of 1–3, yielding `cached_fraction = 0.999–1.000` on every turn. The target was ≥0.70.
- **Action:** none. Cache is healthy. If post-deploy Langfuse traces ever show the fraction collapsing, the runtime log line is the first place to look.

### C29 — D6 escalation trigger gated on `shadowModeEnabled` as a proxy
- **Surfaced:** sprint-08 §2 implementation.
- **Concern:** The sprint brief asked for a "tuningEnabled (or equivalent config flag)" gate on the escalation trigger. The schema has no `tuningEnabled` field, so sprint 08 uses `TenantAiConfig.shadowModeEnabled` as the nearest equivalent — tenants not using shadow mode don't get ESCALATION_TRIGGERED suggestions even when an escalation is closed with a host reply. This is deliberately conservative.
- **Status:** OPEN — revisit when a dedicated tuning-feature-flag is added.
- **Action:** if we introduce `TenantAiConfig.tuningEnabled` in a later sprint, swap the gate in `escalation-trigger.service.ts`.

### C28 — Integration tests not yet wired into CI
- **Surfaced:** sprint-05 §7.
- **Concern:** The four new integration tests (`backend/src/__tests__/integration/`) require `DATABASE_URL` and pass on demand via `npx tsx --test`, but no CI job runs them. CI in this repo has no Postgres provisioned.
- **Status:** OPEN, post-V1.
- **Action:** when CI grows a Postgres (e.g. a Railway-managed test database), add an integration job that runs `tsx --test src/__tests__/integration/*.integration.test.ts` against it.

---

## Resolved / archived

(move items here once fully handled — keeps the active list short)
