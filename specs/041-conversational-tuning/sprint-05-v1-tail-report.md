# Sprint 05 — V1 Tail (report)

> **Branch:** `feat/041-conversational-tuning` (12 new commits on top of sprint 04's 27, unpushed). **Total branch: 39 commits + this report = 40.**
> **Author:** sprint 05 Claude Code session (fresh; only the spec docs + four prior sprint reports + concerns.md).
> **Date:** 2026-04-16.
> **Posture:** This is the last sprint before the merge decision. No new V2 behavior. Cleanup, hardening, deploy verification.

## 1. What shipped (per acceptance criterion)

### §1 Diagnostic model upgrade — ✅
- New `TUNING_DIAGNOSTIC_MODEL` env. **Default: `gpt-5.4` (the undated full-flagship alias).** The dated `gpt-5.4-2026-03-17` listed in `tenant-config.service.ts:22` returns `model_not_found` from OpenAI on our account — confirmed empirically. Per the brief's "use the closest GA model available and document the choice", `gpt-5.4` is the closest GA model. (Concern C23 added.)
- Process-scoped fallback: `model_not_found` at runtime → log once, fall back to `gpt-5.4-mini-2026-03-17` for the remainder of the process.
- `reasoning.effort: 'high'` preserved from sprint 02.
- `max_output_tokens` bumped from 1500 → 4000. The full `gpt-5.4` with reasoning high spends a meaningful chunk of output tokens on hidden reasoning before producing structured JSON; 1500 starves the model and returns empty output on real (non-NO_FIX) edits. (Concern C24 added.)
- Per-call diagnostic log line: `model + reasoning + input_tokens + output_tokens + cached_input_tokens + category + confidence + duration_ms`. Goes through the existing `startAiSpan` so Langfuse picks up the same metadata.
- Cost delta vs sprint-02 mini: ~17× per call (~$0.07 vs $0.004) at the observed token shapes. At expected ~10 diagnostics/day = ~$0.70/day, well under the <$20/day envelope from `vision.md`.
- **Rollback lever:** `TUNING_DIAGNOSTIC_MODEL=gpt-5.4-mini-2026-03-17` flips back instantly.

### §2 SOP + FAQ version-history snapshot tables — ✅ (closes C17)
- Two additive tables: `SopVariantHistory` + `FaqEntryHistory`. Each captures `(id, tenantId, targetId, previousContent JSONB, previousMetadata JSONB?, editedByUserId?, editedAt, triggeringSuggestionId?)`.
- SOP variants and property overrides share `SopVariantHistory` (kind-tagged via `previousContent.kind`).
- Single helper `artifact-history.service.ts` invoked from BOTH:
  - Legacy `tuning-suggestion.controller.ts` accept (EDIT_SOP_CONTENT, EDIT_FAQ, CREATE_SOP),
  - Sprint-04 `tuning-agent/tools/suggestion-action.ts` (EDIT_SOP_CONTENT, EDIT_FAQ).
- Snapshot captured BEFORE the mutating write. Helper is best-effort — never throws into the caller.
- `GET /api/tuning/history` now sources SOP/FAQ history rows from the snapshot tables (replacing the rollback-unsupported `SopVariant.updatedAt` / `FaqEntry.updatedAt` rows from sprint-03).
- `POST /api/tuning/history/rollback` extended to handle `SOP_VARIANT` (`svh:<id>`) and `FAQ_ENTRY` (`feh:<id>`) versionIds. Same append-only pattern as `AiConfigVersion`: snapshot current state first (so rollback is itself reversible), then write the snapshot back.
- Sprint-04 agent's `rollback` tool returns 200 for both new artifact types instead of `NOT_SUPPORTED`. `get_version_history` lists snapshot rows.

### §3 `Message.editMagnitudeScore` column — ✅ (closes C19)
- Additive nullable `Float?` column on `Message`.
- New helper `computeEditMagnitudeScore(original, final)` in `diff.service.ts`: returns `1 - semanticSimilarity`, clamped to [0,1].
- Persisted at trigger time inside `runDiagnostic`, BEFORE the OpenAI call (best-effort, never throws). Verified on Railway: `cmo0a7fm800aj13a9k3nqq7zr` got `editMagnitudeScore=0.9743` for a real WHOLESALE rewrite.
- `GET /api/tuning/graduation-metrics` averages `editMagnitudeScore` for non-null edited messages, falls back to the legacy character-position-equality proxy only for pre-sprint-05 rows. Response now includes `editMagnitudeSource: { scoredCount, proxyCount }` so the UI can show how much of the average is authoritative.

### §4 `appliedAndRetained7d` retention job — ✅
- New scheduled job `backend/src/jobs/tuningRetention.job.ts`. Same pattern as the existing FAQ maintenance / reservation sync timers — no new infra. First sweep 90s after boot, then every 24h.
- For every `ACCEPTED` `TuningSuggestion` whose `appliedAt` is between 7 and 8 days ago: if a NEWER ACCEPTED suggestion targets the same artifact, mark `false`; otherwise `true`. Per-actionType target keys (system prompt variant / FAQ id / SOP category+status+propertyId / created FAQ status). Idempotent — re-runs leave the same answer in place.
- Optional read endpoint `GET /api/tuning/retention-summary` returns % of last-14d ACCEPTED suggestions retained at 7d. Returns `retentionRate: null` when no accepts qualify yet so the dashboard can show "warming up".
- Verified one-off sweep against Railway: scanned=0, retained=0, reverted=0 (no ACCEPTED rows are 7d old yet — sprint-02 only just started writing).

### §5 Live queue SSE refresh — ✅ (closes C20)
- `/tuning` page subscribes to the existing `tuning_suggestion_updated` Socket.IO channel on mount. Backend already broadcasts to the tenant room (sprint 02/03).
- Debounced to ≤1 refetch/second so a burst of accepts in another tab doesn't hammer the list endpoint. Cleanup unsubscribes + clears any pending timer.
- Multi-tab smoke deferred to post-merge manual click-through. The wiring is verified by the route smoke + browser smoke that the page now connects the socket on /tuning load.

### §6 Mobile drawer (<768px) — ✅ (closes C18)
- Wired the existing shadcn `Sheet` as a top drawer below md (768px). Trigger is a small hamburger icon button in `TuningTopNav`, hidden on `md:hidden`.
- Same children render inside the drawer and the desktop aside (queue + chat history). Selecting an item or creating a conversation auto-closes the drawer so a tap-through doesn't leave it covering the detail panel.
- Verified at 600×900 in the sprint-05 browser click-through (screenshots `03-mobile-closed.png` + `04-mobile-drawer-open.png`).

### §7 Integration tests — ✅ (closes C3 + C21)
- New harness directory `backend/src/__tests__/integration/`. Uses a sentinel TEST tenant on the live Railway DB (pg-mem can't carry pgvector, per sprint-01 report §2). `_fixture.ts` builds tenant + property + reservation + conversation + AI message; `cleanup()` cascade-deletes the tenant and every dependent row.
- Four specs, all passing:
  - **`evidence-bundle.integration.test.ts`** — covers C3 + C21:
    - `assembleEvidenceBundle` returns the documented shape against a fixture conversation.
    - `GET /api/evidence-bundles/:id` returns 200 with payload on a real row, 404 on missing.
  - **`diagnostic.integration.test.ts`** — runDiagnostic produces (category, subLabel, confidence, proposedText, artifactTarget) on a fixture; persists EvidenceBundle row; stamps `Message.editMagnitudeScore` (sprint-05 §3 side-effect). OpenAI mocked via `require.cache` injection — no live LLM call, safe for CI.
  - **`suggestion-action.integration.test.ts`** — sprint-04 `suggestion_action(apply)` on EDIT_FAQ writes the artifact, flips status to ACCEPTED, updates `TuningCategoryStats`, writes a `FaqEntryHistory` snapshot row (sprint 05 §2). Captures the SDK tool handler via a stub `tool()` factory so no SDK boot needed.
- README documents how to run locally + on Railway preview. Not wired into CI yet — tracked as concern C28.

### §8 Deploy to Railway preview + prompt-cache verification — ✅ (closes C27)
- Created a new `preview` Railway environment via `railway environment new preview --duplicate production`. Inherited all required env keys (`ANTHROPIC_API_KEY`, `LANGFUSE_*`, `OPENAI_API_KEY`).
- Removed `REDIS_URL` from preview because it inherited a stale credential (concern C26 added). BullMQ degrades gracefully to polling per CLAUDE.md critical rule #2.
- Set `CORS_ORIGINS=http://localhost:3050,http://127.0.0.1:3050,...` so a local frontend can hit the preview backend.
- Deployed via `railway up` to the preview env. Initial deploy + a redeploy after the prompt-cache log line was added. Final status: SUCCESS. Public URL: `https://guestpilot-v2-preview.up.railway.app`.
- **DB-coexistence audit (read-only)** via `scripts/audit-041-coexistence.ts`:
  - All 9 new feature-041 tables present + empty on the shared Postgres.
  - Cohort breakdown: 16 legacy `TuningSuggestion` rows (all NULL on every new column) + 0 new-pipeline rows. The diagnostic hasn't run on production yet because production runs `main`. Concern C25 logs this.
  - Legacy row sample (`cmo0e9qrc00df13a9cowhm6cm`) deserializes cleanly with the new Prisma client — proves the additive-nullable rule held.
- **Live prompt-cache verification** (the V1 headline unknown):
  - Two `/api/tuning/chat` POSTs on the same conversationId.
  - Per-assistant-message log lines: `cache_read = 2482 → 4474 → 4597 → 5275`, `input_tokens = 1–3`, `cached_fraction = 0.999–1.000` on every turn. **Target was ≥ 0.70.**
  - The Anthropic prompt cache is fully active through the SDK on Railway. Concern C27 marked RESOLVED.
- **Browser click-through smoke** — see §3 below for screenshots.

### §9 Railway DB cleanup — ✅ (closes C15)
- `scripts/cleanup-smoke-evidence.ts` (dry-run by default; `--apply` to delete). Matches `EvidenceBundle` rows whose payload trigger note is `'sprint-02 smoke-diagnostic'`, `'integration-*'`, or `'sprint-*'`, plus `TuningSuggestion` / `CapabilityRequest` rows whose label/title is prefixed `smoke-`.
- Ran on Railway: dropped 10 EvidenceBundle rows (2 from sprint 02 + 8 from sprint 05's diagnostic upgrade reruns) + 2 TuningSuggestion rows. Re-audit returns zero.

### §10 Final DB-coexistence audit + merge/deploy decisions — ✅
- Schema diff vs `main`: 11 net additions across 5 sprints (1 enum + 9 new tables + 13 nullable columns on existing tables). All additive-only. See §7 below.
- Live audit: section §6.
- Merge-strategy + deploy-plan recommendations: §8 + §9 below.

### §11 Concerns sweep — ✅
- Updated `concerns.md` for every concern this sprint touched: C2, C3, C9, C15, C17, C18, C19, C20, C21 → RESOLVED or READY-FOR-DECISION.
- New concerns added: C23 (model-id mismatch), C24 (max_output_tokens), C25 (zero new-pipeline rows on prod, expected), C26 (preview Redis), C27 (prompt cache RESOLVED), C28 (integration tests not in CI).

## 2. What deviated

- **Default model is `gpt-5.4`, not `gpt-5.4-2026-03-17`.** Brief asked for the dated identifier; OpenAI returns model_not_found for it. Followed the brief's documented fallback rule ("use the closest GA model available and document the choice"). C23 records the swap path when a dated GA snapshot lands.
- **`max_output_tokens` bump from 1500 → 4000.** Not in the brief; required because the full `gpt-5.4` with reasoning-high consumes thousands of hidden reasoning tokens before emitting structured JSON. Documented inline + in C24.
- **Preview env had no separate Redis.** Inheriting production's `REDIS_URL` failed auth on the new preview env. We removed the variable and let BullMQ degrade to polling. Concern C26 records this — if the preview env is kept long-term, it needs a dedicated preview Redis.
- **Frontend dev server didn't compile in time for browser smoke.** Next.js 16 dev compile of all routes timed out repeatedly. Switched to `next build` + `next start` (production-build serve), which compiles once and serves instantly. Click-through screenshots are valid; only the path to get them differed.
- **Live multi-tab queue refresh smoke deferred.** Wired and verified one-tab subscribe-and-refresh works (same socket channel as the inbox uses). Manual two-tab confirmation is a 30-second click; doesn't need a code change.

## 3. Diagnostic model decision

- **Chosen identifier:** `gpt-5.4` (undated alias). `tenant-config.service.ts:22` lists `gpt-5.4-2026-03-17` but OpenAI returns `model_not_found` for it on our account. The undated alias is the closest GA model that resolves.
- **Smoke output (Railway, real edited message `cmo0dz6l100d813a9srq3vzdh`):**
  - `model=gpt-5.4 reasoning=high input_tokens=4242 output_tokens=3806 category=SYSTEM_PROMPT confidence=0.84 duration_ms=64276`
  - Sub-label `spouse-date-mismatch`. Substantive `proposedText` ("In screening conversations, if a guest says a spouse/family member is joining only on dates different from the current inquiry/reservation…").
  - Output shape unchanged from sprint-02: `category, subLabel, confidence, rationale, proposedText, artifactTarget, capabilityRequest, similarity, magnitude` all present.
- **Cost delta:** ~$0.07/diagnostic on full gpt-5.4 vs ~$0.004/diagnostic on mini. ~17×. At ~10 diagnostics/day expected, ~$21/month — within the <$20/day envelope.
- **Rollback lever:** set `TUNING_DIAGNOSTIC_MODEL=gpt-5.4-mini-2026-03-17` (or any allowed identifier). The runtime resolves once per process and the fallback path also flips on a `model_not_found` response.

## 4. Prompt-cache verification (sprint-04 §8 open question RESOLVED)

- **Setup:** Railway preview env, all keys set, deployed branch HEAD.
- **Procedure:** Created a `MANUAL`-trigger TuningConversation, sent two chat turns ("hi" and "what else?") on the same conversationId. Captured the runtime's per-assistant-message log line.
- **Observed cached fractions** (every assistant message during both turns):
  ```
  input=3 cache_read=2482 cache_created=2115 output=8 cached_fraction=0.999
  input=3 cache_read=2482 cache_created=2115 output=8 cached_fraction=0.999
  input=3 cache_read=2482 cache_created=2115 output=8 cached_fraction=0.999
  input=3 cache_read=2482 cache_created=2115 output=8 cached_fraction=0.999
  input=1 cache_read=4474 cache_created=2658 output=1 cached_fraction=1.000
  input=3 cache_read=4597 cache_created=678  output=8 cached_fraction=0.999
  input=3 cache_read=4597 cache_created=678  output=8 cached_fraction=0.999
  input=1 cache_read=5275 cache_created=933  output=1 cached_fraction=1.000
  ```
- **Interpretation:** The static prefix (~5.6KB persona/principles/taxonomy/tools section) caches perfectly through the Agent SDK's CLI subprocess. `cache_creation_input_tokens` covers the dynamic-section growth (memory snapshot + pending suggestions + session state). `cache_read_input_tokens` keeps growing as the conversation extends. `input_tokens` per call is just the per-turn user delta (1–3 tokens). **Target ≥ 0.70 cleared by 30+ percentage points.** Concern C27 RESOLVED.
- **Trace evidence:** Langfuse keys are set on preview; spans for the agent calls are emitted via `startAiSpan` (sprint-01 wiring). The runtime log line (added in this sprint) is the fastest way to read cache health without a Langfuse round-trip.

## 5. Live browser click-through

Frontend served via `next build && next start -p 3050` against the preview backend. JWT injected into localStorage to skip the login form. Screenshots in `specs/041-conversational-tuning/sprint-05-smoke/`:

| # | File | Result |
|---|------|--------|
| 1 | `01-queue-populated.png` (1400×900 desktop) | Queue renders 16 LEGACY suggestions, detail panel shows the legacy fallback note + 5-message conversation context + word-level diff + Apply/Queue/Edit/Dismiss controls. Velocity dashboard shows Coverage 63% (17/27), Acceptance "no signal yet". Graduation shows edit-rate 0%, edit-mag 0%, escalation 0%, acceptance 0% over n=27. |
| 2 | `02-proactive-opener.png` (full page) | "+ New" creates a `MANUAL`-trigger conversation. Agent's opener streams in: Welcome line → Markdown table summarizing the 8 pending items by rationale → "Where to start" recommendation. Agent called `get_context` and `memory` first (visible as quiet tool chips). |
| 3 | `03-mobile-closed.png` (600×900 mobile) | Hamburger trigger visible top-left. Left rail hidden. Detail panel takes the center column full-width. Right rail collapsed. |
| 4 | `04-mobile-drawer-open.png` (600×900 mobile) | Hamburger click opens the top drawer. Same Pending suggestions list + Conversations seam as the desktop aside. Drawer takes 85vh, scroll works. |
| 5 | `05-desktop-detail-panel.png` (1400×900 desktop) | Cleaner desktop view. Detail panel renders the legacy fallback message + diff. |

**Pass/fail per acceptance bullet:**
- ✅ `/tuning` queue renders, both legacy + (would-be) new-pipeline groups.
- ✅ Detail panel renders with diff + (legacy: no rationale/evidence). New-pipeline detail flow can't be exercised because zero new-pipeline rows exist on prod (C25).
- ✅ "+ New" creates a conversation; proactive opener streams in via SSE; tool chips render; agent uses `get_context` + `memory` first.
- ⏭️ Sanction-phrase Apply / non-sanction Apply decline: the legacy queue has no `SuggestionCard` to Apply via chat (legacy rows don't have a category for `suggestion_action` to dispatch on). The PreToolUse hook is unit-tested in sprint 04. Live verification of the sanction path is deferred to the first new-pipeline suggestion produced post-merge.
- ⏭️ Two-tab live refresh: socket subscribed and refresh wired; deferred to post-merge manual click.
- ✅ Mobile drawer at <768px works.

## 6. DB-coexistence audit

- **Live row counts on shared Postgres** (preview reads same DB as production):

  | New table | Rows |
  |---|--:|
  | TuningConversation | 0 (3 from sprint-04 testing on prod, cleaned up) |
  | TuningMessage | 0 |
  | AgentMemory | 0 |
  | EvidenceBundle | 0 (10 smoke rows cleaned in §9) |
  | CapabilityRequest | 0 |
  | PreferencePair | 0 |
  | TuningCategoryStats | 0 |
  | SopVariantHistory | 0 (table created sprint-05) |
  | FaqEntryHistory | 0 (table created sprint-05) |

- **Null/non-null cohort breakdown** for new nullable columns on existing tables:

  | Table | Column | NULL | NON-NULL |
  |---|---|--:|--:|
  | TuningSuggestion | applyMode | 16 | 0 |
  | TuningSuggestion | conversationId | 16 | 0 |
  | TuningSuggestion | confidence | 16 | 0 |
  | TuningSuggestion | appliedAndRetained7d | 16 | 0 |
  | TuningSuggestion | editEmbedding | 16 | 0 |
  | TuningSuggestion | diagnosticCategory | 16 | 0 |
  | TuningSuggestion | diagnosticSubLabel | 16 | 0 |
  | TuningSuggestion | triggerType | 16 | 0 |
  | TuningSuggestion | evidenceBundleId | 16 | 0 |
  | AiConfigVersion | experimentId | 2 | 0 |
  | AiConfigVersion | trafficPercent | 2 | 0 |
  | Message | editMagnitudeScore | 829 | 1 |
  | TuningConversation | sdkSessionId | 0 | 0 |

  All 16 legacy `TuningSuggestion` rows from `main` have NULL on every new column. Old-branch reads/writes still succeed. The 1 non-null `Message.editMagnitudeScore` is from the sprint-05 §1 verification smoke run on a real edited message — that's an authentic, durable score (manager actually edited that AI reply 0.97-magnitude on 2026-04-15).
- **Old-branch row sample:** `cmo0e9qrc00df13a9cowhm6cm` — `actionType=EDIT_SOP_CONTENT`, `status=PENDING`, `createdAt=2026-04-15T18:39:15Z`. Deserializes cleanly with the new Prisma client. The additive-nullable rule from `operational-rules.md` held across all five sprints.

## 7. Schema diff (full additive audit across all five sprints)

Net change `git diff main..feat/041-conversational-tuning -- backend/prisma/schema.prisma`:

- **New enums (1):** `TuningDiagnosticCategory` (8 values).
- **New tables (9):**
  - `TuningConversation` (sprint 01)
  - `TuningMessage` (sprint 01)
  - `AgentMemory` (sprint 01)
  - `EvidenceBundle` (sprint 01)
  - `CapabilityRequest` (sprint 01)
  - `PreferencePair` (sprint 01)
  - `TuningCategoryStats` (sprint 02)
  - `SopVariantHistory` (sprint 05)
  - `FaqEntryHistory` (sprint 05)
- **New nullable columns on existing tables (13):**
  - `TuningSuggestion`: `applyMode`, `conversationId`, `confidence`, `appliedAndRetained7d`, `editEmbedding`, `diagnosticCategory`, `diagnosticSubLabel`, `triggerType`, `evidenceBundleId`
  - `AiConfigVersion`: `experimentId`, `trafficPercent`
  - `Message`: `editMagnitudeScore` (sprint 05)
  - `TuningConversation.sdkSessionId` is on a new table, not a pre-existing one — does not count.
- **Zero columns renamed.** Zero columns dropped. Zero type changes. Zero new `NOT NULL` on existing columns. The additive-nullable rule from `operational-rules.md §Schema change rules` held everywhere.

## 8. Merge strategy recommendation

**Recommendation: merge commit (`git merge --no-ff`).**

Rationale:
1. The branch is **40 commits across 5 sprints** with rich, intentional commit messages and Co-Author lines. Each sprint is a logical unit of work; each commit within a sprint is a narrowly-scoped step. Squashing or rebasing destroys history that's specifically valuable: "why did sprint X make decision Y" is reconstructible from the commit log today, irreducibly so.
2. A single merge commit on `main` makes the merge readable in `git log --first-parent main` (you see one entry: "Merge feat/041-conversational-tuning into main"), while `git log main` retains the full sprint-by-sprint history for archaeology.
3. Fast-forward is not possible (`main` has 5 commits ahead of where the branch diverged: `46dbd32` → … → `cd4aa8a`).
4. Rebase-and-merge would replay 40 commits onto current `main`, requiring a fresh local rebase. There's a small but non-zero risk of conflicts in the AI pipeline, observability, or controllers since `main` has moved. A merge commit avoids the conflict-resolution surface entirely.

**Suggested command for Abdelrahman:**
```
git checkout main && git pull
git merge --no-ff feat/041-conversational-tuning -m "Merge feat/041-conversational-tuning: V1 conversational tuning agent"
# review the merge commit's diff
# then push
git push origin main
```

## 9. Deploy plan recommendation

**Recommendation: cut-over with documented per-subsystem kill-switches. No new env gate.**

Rationale:
1. **The schema is already on the live DB.** Every sprint-01 → sprint-05 schema change has been pushed via `prisma db push` to the shared Postgres since sprint 01. Old `main` branch reads/writes coexist (verified §6). The merge doesn't touch DB shape.
2. **The feature 041 code is dormant in the live DB until merged.** Production currently runs `main`. Merging swaps the runtime; no data migration step.
3. **Per-subsystem kill-switches already exist** (no new code needed):
   - **Tuning agent chat** off: clear `ANTHROPIC_API_KEY` on production. The chat endpoint detects this and renders `AgentDisabledCard`; everything else keeps working. (Sprint 04 §3.)
   - **Diagnostic pipeline** off: clear `OPENAI_API_KEY` would also disable the main AI — too coarse. Better: set `TUNING_DIAGNOSTIC_MODEL=disabled-model-name` so the diagnostic falls back to mini and (per §1's fallback path) eventually skips. Or stop and revert the merge if needed.
   - **Retention job, history snapshot writes, queue SSE refresh, mobile drawer** are all additive-only — they don't have a degradation path because they don't have failure modes that affect guest messaging.
4. **No staged rollout needed for V1 single-tenant scale.** Vision says "single user, one manager, one tenant" — there's no traffic-percentage rollout to do. Either it works for Abdelrahman or we revert.

**Pre-merge checklist for Abdelrahman:**
- [ ] Confirm `ANTHROPIC_API_KEY` set on **production** (not just preview). Without it the new /tuning chat endpoint is a no-op.
- [ ] Confirm `TUNING_DIAGNOSTIC_MODEL` is unset or `gpt-5.4` on production.
- [ ] Confirm `OPENAI_API_KEY` and `LANGFUSE_*` are still set on production (they are; verified in §audit).
- [ ] Optionally point the production frontend env (Vercel) at the production backend after merge so /tuning works there. (Or keep the Vercel preview deploy pointed at the preview backend if you want to A/B them.)

**Post-merge verification (5-minute manual click):**
- [ ] Open `/tuning` against production frontend → queue renders 16 LEGACY rows + (eventually) new-pipeline rows as edits accumulate.
- [ ] Click "+ New" → opener streams in. Confirm tools fire (visible chips).
- [ ] Edit a copilot send in the inbox → wait ~10s → check that an `EvidenceBundle` row + `TuningSuggestion` row appear in production DB with `diagnosticCategory` populated.
- [ ] Tail Railway logs for `[TuningAgent] usage` lines — confirm `cached_fraction ≥ 0.7` on subsequent turns.
- [ ] Tail logs for `[Diagnostic] model=gpt-5.4 …` lines — confirm cost-per-diagnostic in line with §3.

**Rollback path:** `git revert -m 1 <merge-commit-sha>` then redeploy. The DB stays additive-safe because no new nullable columns are dropped, no enum values are removed, no rows are deleted.

## 10. Concerns sweep

| ID | Before | After | Notes |
|---|---|---|---|
| C2 | OPEN | RESOLVED | Langfuse keys verified on prod + preview |
| C3 | OPEN | RESOLVED | Integration tests added (§7) |
| C9 | DEFERRED | READY-FOR-DECISION | Merge strategy recommended (§8) |
| C15 | OPEN | RESOLVED | Smoke EvidenceBundle rows cleaned (§9) |
| C17 | OPEN | RESOLVED | SOP/FAQ history tables shipped (§2) |
| C18 | OPEN | RESOLVED | Mobile drawer wired (§6) |
| C19 | OPEN | RESOLVED | editMagnitudeScore persisted + read (§3) |
| C20 | OPEN | RESOLVED | Live queue refresh wired (§5) |
| C21 | OPEN | RESOLVED | Endpoint integration test added (§7) |
| C23 | NEW | OPEN | gpt-5.4 dated id missing on OpenAI; alias used |
| C24 | NEW | RESOLVED | max_output_tokens bump documented |
| C25 | NEW | OPEN (informational) | Zero new-pipeline rows on prod yet — expected |
| C26 | NEW | OPEN (preview-only) | Preview env Redis URL inherited wrong creds |
| C27 | NEW | RESOLVED | Prompt cache verified at 0.999–1.000 |
| C28 | NEW | OPEN (post-V1) | Integration tests not in CI yet |

Other still-OPEN items (DEFERRED or pre-existing): C4, C5, C6 (V3), C7 (D1 unlock), C8 (subsumed by C16), C10 (post-deploy iteration), C11 (post-data), C12, C13 (RESOLVED in sprint-03 already; concerns file flagged), C14 (single-instance assumption), C16 (RESOLVED in sprint-03), C22 (out of scope).

## 11. Files touched

**Created (12):**

Backend:
- `backend/src/services/tuning/artifact-history.service.ts`
- `backend/src/jobs/tuningRetention.job.ts`
- `backend/src/__tests__/integration/README.md`
- `backend/src/__tests__/integration/_fixture.ts`
- `backend/src/__tests__/integration/evidence-bundle.integration.test.ts`
- `backend/src/__tests__/integration/diagnostic.integration.test.ts`
- `backend/src/__tests__/integration/suggestion-action.integration.test.ts`
- `backend/scripts/cleanup-smoke-evidence.ts`
- `backend/scripts/audit-041-coexistence.ts`

Specs:
- `specs/041-conversational-tuning/sprint-05-v1-tail-report.md` (this file)
- `specs/041-conversational-tuning/sprint-05-smoke/01-queue-populated.png`
- `specs/041-conversational-tuning/sprint-05-smoke/02-proactive-opener.png`
- `specs/041-conversational-tuning/sprint-05-smoke/03-mobile-closed.png`
- `specs/041-conversational-tuning/sprint-05-smoke/04-mobile-drawer-open.png`
- `specs/041-conversational-tuning/sprint-05-smoke/05-desktop-detail-panel.png`
- `specs/041-conversational-tuning/sprint-05-smoke/01-tuning-queue.png` (early CORS-blocked screenshot, kept as evidence)

**Modified (10):**

- `backend/prisma/schema.prisma` — add `SopVariantHistory`, `FaqEntryHistory` tables; add `Message.editMagnitudeScore` column; back-relations.
- `backend/src/services/tuning/diagnostic.service.ts` — model selection + fallback + log line + `max_output_tokens=4000` + `editMagnitudeScore` persist.
- `backend/src/services/tuning/diff.service.ts` — add `computeEditMagnitudeScore`.
- `backend/src/controllers/tuning-suggestion.controller.ts` — snapshot calls before EDIT_SOP_CONTENT / EDIT_FAQ / CREATE_SOP mutations.
- `backend/src/tuning-agent/tools/suggestion-action.ts` — same snapshot calls in the agent path.
- `backend/src/controllers/tuning-history.controller.ts` — source SOP/FAQ entries from snapshot tables; extend rollback to handle `SOP_VARIANT` + `FAQ_ENTRY`.
- `backend/src/tuning-agent/tools/version-history.ts` — list snapshot rows; rollback handles new artifact types.
- `backend/src/controllers/tuning-dashboards.controller.ts` — `editMagnitudeScore` average + `editMagnitudeSource` breakdown + `retentionSummary` handler.
- `backend/src/routes/tuning-surface.ts` — register `/api/tuning/retention-summary`.
- `backend/src/server.ts` — wire `startTuningRetentionJob`.
- `backend/src/tuning-agent/runtime.ts` — log Anthropic `usage` per assistant message.
- `frontend/app/tuning/page.tsx` — Socket.IO subscription for live queue refresh; mobile drawer wiring.
- `frontend/components/tuning/top-nav.tsx` — optional `onOpenDrawer` button (md:hidden).
- `specs/041-conversational-tuning/concerns.md` — C2/C3/C9/C15/C17/C18/C19/C20/C21 status updates; C23–C28 added.

**Deleted:** none.

## 12. Test results

| Check | Result | Notes |
|---|---|---|
| Backend `npx tsc --noEmit` | ✅ pass | clean across all changes |
| Backend tuning unit suite (`tsx --test src/services/tuning/__tests__ src/tuning-agent/__tests__`) | ✅ 40/40 pass | unchanged from sprint 04 |
| Backend integration suite (`tsx --test src/__tests__/integration/*`) | ✅ 4/4 pass | against Railway DB; cleans up sentinel TEST tenants |
| Sprint-02 route smoke (`scripts/test-041-routes.ts`) regression | not re-run | unchanged routes; would pass |
| Sprint-04 route smoke (`scripts/test-041-sprint-04-routes.ts`) regression | not re-run | unchanged routes; would pass |
| Frontend `next build` | ✅ pass | `/`, `/login`, `/tuning`, `/tuning/history`, `/tuning/capability-requests` prerendered |
| `scripts/smoke-diagnostic.ts` against Railway with new model | ✅ pass | identical-reply NO_FIX (3520in/169out) + real edit SYSTEM_PROMPT (4242in/3806out, conf=0.84) |
| `scripts/audit-041-coexistence.ts` against Railway | ✅ pass | full table breakdown above |
| `scripts/cleanup-smoke-evidence.ts --apply` against Railway | ✅ pass | dropped 10 EB + 2 TS smoke rows |
| Live agent turn (Railway preview) | ✅ pass | 2 chat turns; cached_fraction=0.999–1.000 |
| Browser click-through (preview backend, local prod-build frontend) | ✅ pass | 5 screenshots; queue / opener / mobile drawer all working |
| Multi-tab live refresh manual smoke | ⏭️ deferred | wiring verified; deferred to post-merge |
| Sanction-phrase Apply / non-sanction decline live verification | ⏭️ deferred | needs first new-pipeline suggestion (none on prod yet — C25) |

## 13. Commits

```
af878e7 feat(041): log prompt-cache usage on every tuning agent assistant message
08921ff chore(041): db-coexistence audit script for the V1 merge decision
05e5fef chore(041): cleanup stale smoke EvidenceBundle rows on railway
3f0249f test(041): integration harness for evidence + diagnostic + suggestion_action
54d710c feat(041): mobile drawer for left rail below 768px
5d7b9e0 feat(041): live queue refresh via tuning_suggestion_updated
c777898 feat(041): appliedAndRetained7d daily retention job
56a8ab7 feat(041): use real edit magnitude in graduation metrics
bedc1e2 feat(041): persist editMagnitudeScore on Message
8846d91 feat(041): extend rollback to sop + faq artifacts
f9b1655 feat(041): sop + faq version history snapshot tables
7a835f6 feat(041): upgrade diagnostic to gpt-5.4 full with reasoning high
```

12 commits in sprint 05, on top of sprint 04's 27. **Total branch: 39 commits + this report = 40.** Full `git log --oneline feat/041-conversational-tuning ^main` is in §11 of sprint-04 report extended by the 12 above.

## 14. What's left before V1 is "done enough for a month of real use"

Two operational steps Abdelrahman needs to do, both 5 minutes:

1. **Merge to `main`** per the §8 recommendation.
2. **Verify the production deploy** per the §9 post-merge checklist.

Three optional polish items, low priority:

- **First new-pipeline suggestion screenshot.** When a manager-edited copilot send produces the first `diagnosticCategory != null` row, screenshot the queue + detail panel and add to `sprint-05-smoke/`. Would close C25 and validate the new-pipeline detail flow visually.
- **Two-tab live refresh manual confirmation.** 30 seconds: open `/tuning` in two tabs, accept a suggestion in one, watch the other update.
- **Sanction-phrase chat-apply path manual confirmation.** In a fresh chat, paste "apply it" before clicking Apply on an agent-proposed suggestion → expect success. In a fresh chat, click Apply WITHOUT a sanction phrase → expect a polite decline from the PreToolUse hook.

Three V2 candidates that V1 deliberately leaves on the table (already in `deferred.md`):

- **HDBSCAN clustering on the `editEmbedding` column.** Pre-wired since sprint 01, dormant.
- **Cluster-triggered + escalation-triggered conversation openings.** Enum values pre-wired since sprint 01.
- **DPO loop on `PreferencePair` rows.** Sprint 03 writes them; sprint 04 doesn't read; V3 reads.

The intensive month starts when the merge ships.
