# Sprint 05 — V1 Tail (cleanup, hardening, deploy verification)

> **You are a fresh Claude Code session with no memory of prior work.** Read the files listed below, plus all four prior sprint reports, before writing code.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md`
2. `specs/041-conversational-tuning/vision.md`
3. `specs/041-conversational-tuning/roadmap.md`
4. `specs/041-conversational-tuning/deferred.md`
5. `specs/041-conversational-tuning/glossary.md`
6. `specs/041-conversational-tuning/sprint-01-evidence-and-schema-report.md`
7. `specs/041-conversational-tuning/sprint-02-taxonomy-and-diagnostic-pipeline-report.md`
8. `specs/041-conversational-tuning/sprint-03-tuning-surface-report.md`
9. `specs/041-conversational-tuning/sprint-04-conversational-agent-report.md` — **read every section.** §8 (prompt-caching), §12 (broken/deferred), §15 (handoff) are this sprint's agenda.
10. `specs/041-conversational-tuning/concerns.md` — C3, C15, C17, C18, C19, C20, C21, C22 are this sprint's candidates.
11. `CLAUDE.md` (repo root).

## Branch

`feat/041-conversational-tuning`. Commit on top of the existing 27 commits. **This sprint is the last before the merge decision.** Do not merge. Do not push unless explicitly sanctioned in the report's final section.

## Goal

Close the V1 gap between "sprint 04 shipped" and "V1 is ready for a month of real daily use." Five buckets:

1. **Verify the agent works on Railway** — prompt caching, live LLM turn, browser click-through.
2. **Upgrade the diagnostic model** — quality bump for the sprint-02 single-shot classifier.
3. **Close sprint-03 / sprint-04 deferred items** that V1 users will feel: SOP/FAQ rollback, edit magnitude persistence, live queue refresh, mobile drawer.
4. **Harden** — integration tests against a fixture DB, retention cron, cleanup of clutter on Railway.
5. **Decide on merge + deploy** — final DB-coexistence check, merge strategy, deploy plan.

## Non-goals (do NOT do in this sprint)

- **Do NOT add V2 behavior.** No HDBSCAN clustering, no shadow evaluation, no autonomous agent opening conversations on its own, no preference-pair reader / DPO, no Mem0/Zep, no Managed Agents migration. All still deferred.
- **Do NOT rework the tuning agent's tool layer.** 8 tools is correct for V1. Tool Search registration stays empty.
- **Do NOT touch the sprint-04 chat stream protocol.** It works; don't poke it.
- **Do NOT refactor pre-existing TS errors in `*-v5` components.** Out of scope per concern C22; surface to Abdelrahman separately if they block the merge.
- **Do NOT ship multi-user affordances** (still D15).

## Acceptance criteria

### 1. Diagnostic model upgrade

- [ ] Add `TUNING_DIAGNOSTIC_MODEL` env var. Default to **`gpt-5.4-2026-xx-xx`** (the full 5.4 flagship, NOT mini) with `reasoning.effort: 'high'`. Fallback to `gpt-5.4-mini-2026-03-17` if the full model isn't resolvable at runtime (log once, don't crash).
- [ ] Resolve the exact full-model identifier before writing. Read `backend/src/config/model-pricing.ts` or the OpenAI model registry in the repo. If the exact string is ambiguous, use the closest GA model available and document the choice.
- [ ] Update `backend/src/services/tuning/diagnostic.service.ts` to read the env var, pass `reasoning.effort: 'high'` to OpenAI Responses API.
- [ ] Add a one-line diagnostic log per call: model + prompt-token count + completion-token count + `reasoning.effort`. Go through the existing `startAiSpan` path so Langfuse picks it up.
- [ ] Regenerate the sprint-02 smoke (`scripts/smoke-diagnostic.ts`) against a known fixture. Confirm the output shape is unchanged (category + sub-label + confidence + proposedText + rationale). Cost delta noted in the report.
- [ ] Document the rollback lever in the report: flip `TUNING_DIAGNOSTIC_MODEL` back to mini if quality regresses or cost spikes.

### 2. SOP + FAQ version-history snapshot tables (C17)

Additive-only. No destructive changes.

- [ ] New tables: `SopVariantHistory` + `FaqEntryHistory`. Each captures `(id, tenantId, targetId, previousContent JSONB, previousMetadata JSONB, editedByUserId?, editedAt, triggeringSuggestionId?)`.
- [ ] Write a history row at the point of every accept/apply path that mutates a `SopVariant` or `FaqEntry` — both the legacy `/accept` controller and the sprint-04 `suggestion_action` tool path. Reuse a single helper.
- [ ] Extend `GET /api/tuning/history` (sprint-03) to include SOP + FAQ edits sourced from these tables alongside the existing SystemPrompt + ToolDefinition history.
- [ ] Extend the `POST /api/tuning-suggestions/:id/rollback` controller + the sprint-04 `rollback` tool to support `SOP_VARIANT` + `FAQ_ENTRY` target types. Rollback creates a NEW history row (never destroys), same pattern as `AiConfigVersion`.
- [ ] Concern C17 moves to RESOLVED in `concerns.md`.

### 3. `Message.editMagnitudeScore` column (C19)

- [ ] Additive nullable column `editMagnitudeScore Float?` on `Message`.
- [ ] Write the score at trigger time — wherever sprint-02's `classifyEditMagnitude` runs on a manager-edited copilot send, persist the result on the `Message` row.
- [ ] Update `GET /api/tuning/graduation-metrics` to use `AVG(editMagnitudeScore)` instead of the character-position-equality proxy. Old rows with NULL are excluded from the average.
- [ ] C19 moves to RESOLVED.

### 4. `appliedAndRetained7d` retention job

Pre-wired column from sprint 01, never written. Close the loop.

- [ ] New scheduled job `backend/src/jobs/tuning-retention.job.ts`. Runs once a day (reuse the existing scheduler pattern; no new infra).
- [ ] For every `TuningSuggestion` with `status: 'ACCEPTED'` and `acceptedAt` between 7 and 8 days ago: check whether the resulting artifact edit has been rolled back, overwritten, or reverted within the 7d window. If retained, set `appliedAndRetained7d = true`. If reverted, set `false`. Idempotent.
- [ ] Optional: expose a small read surface `GET /api/tuning/retention-summary` for the right-rail dashboards — % of last-14d accepts that retained at 7d. Calm stat card, same style as sprint-03's graduation dashboard.

### 5. Live queue SSE refresh (C20)

- [ ] The Socket.IO broadcast `tuning_suggestion_updated` already fires (sprint-02/03). Wire the `/tuning` queue component to subscribe and refetch (or merge) on receipt.
- [ ] Scope the subscription per tenant. Don't over-refetch on every single event — debounce to ≤1 refetch/second.
- [ ] Manual multi-tab smoke: accept in tab A, watch tab B's queue update without manual refresh.
- [ ] C20 moves to RESOLVED.

### 6. Mobile drawer (<768px) (C18)

- [ ] Wire the existing shadcn `Sheet` to expose the left rail as a top drawer below 768px. Trigger is a small icon button in the top bar.
- [ ] Chat panel below 768px takes the center column full-width; right rail dashboards stay collapsed.
- [ ] Do NOT redesign for touch. This is a "doesn't break on a phone in the field" affordance, not a mobile-first experience.
- [ ] C18 moves to RESOLVED.

### 7. Integration tests against fixture DB (C3, C21)

- [ ] New test harness `backend/src/__tests__/integration/` with a fixture Postgres database (use `pg-mem` if the Prisma version allows, otherwise a throwaway schema on the live DB with `TEST_` prefix — document which).
- [ ] Integration tests:
  - Evidence-bundle assembly (C3): build a bundle from fixture conversation + message + tool-call rows; assert the JSON shape.
  - `GET /api/evidence-bundles/:id` (C21): 200 on real row, 404 on missing.
  - Diagnostic pipeline single-shot: fixture edited message → diagnostic call → assert `(category, confidence, proposedText)` produced. Uses a mocked OpenAI response — no live LLM call in CI.
  - Sprint-04 `suggestion_action(apply)` on a fixture suggestion: writes artifact + updates category stats + writes preference pair when applicable.
- [ ] These DO NOT need to run in CI. Document how to run locally and on a Railway preview. Future sprint can wire into CI.
- [ ] C3 + C21 move to RESOLVED (or a follow-up "add to CI" concern).

### 8. Deploy to Railway preview + prompt-cache verification

This is the big one. Sprint 04's report §8 leaves this explicitly open.

- [ ] Confirm `ANTHROPIC_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `OPENAI_API_KEY` are set on the Railway preview environment. If any are missing, stop and ask Abdelrahman to add them.
- [ ] Deploy the branch to Railway preview (do NOT merge to `main`).
- [ ] **DB coexistence check on the preview DB:** confirm old-shape rows from the live `main` branch's writes coexist with new-pipeline rows. The preview points at the same Postgres. Run a read-only audit script that counts: (a) `TuningSuggestion` rows with null `diagnosticCategory`, (b) rows with non-null. Expect both > 0. No crash on read from either cohort.
- [ ] **Live LLM turn:** follow the documented command in sprint-04 report §8. Two `/api/tuning/chat` POSTs on the same `conversationId`. Capture the Langfuse trace.
- [ ] **Cached-fraction target:** turn-2 `cache_read_input_tokens / (input_tokens + cache_read_input_tokens)` ≥ 0.70. Document the observed number.
  - If < 0.70: do NOT rearchitect in this sprint. Document the failure mode (likely the SDK's CLI subprocess doesn't forward `cache_control` markers) and add a concern C27: "prompt-cache missed on SDK's subprocess path; revisit once SDK exposes explicit cache-control or we lift to Managed Agents (D16)."
- [ ] **Browser click-through smoke:**
  - `/tuning` → queue renders, both new-pipeline and legacy rows appear in correct groups.
  - Select a new-pipeline suggestion → detail panel renders with diff + rationale + evidence.
  - Click "+ New" in left rail → new conversation created → proactive opener streams in → `EvidenceInline` renders.
  - In the opener response, paste a sanction phrase ("apply it") → SuggestionCard's Apply button succeeds → PreToolUse hook allows.
  - In a fresh opener, click Apply WITHOUT typing sanction → PreToolUse hook politely declines → no write.
  - Accept in one tab, watch another tab's queue update (C20 wiring).
  - Resize to <768px → mobile drawer works (C18).
  - Screenshot each step into `specs/041-conversational-tuning/sprint-05-smoke/` (new folder).

### 9. Railway DB cleanup (C15)

- [ ] Run the documented cleanup SQL from sprint-02 report §10.8 to remove the two stale smoke-run `EvidenceBundle` rows. Verify it's only those two rows. Do this as a one-line `npx tsx scripts/...` not a raw SQL session.
- [ ] C15 moves to RESOLVED.

### 10. Final DB-coexistence audit + merge decision

- [ ] Schema diff: `git diff main -- backend/prisma/schema.prisma` across all five sprints. Confirm every change is additive-nullable (columns) or additive-new (tables, enums). Zero breaking.
- [ ] Live-branch audit on the shared Postgres (preview and production both read/write the same DB): run a small script that, for each new table, counts rows; for each new column, counts null-vs-non-null. Attach to the report.
- [ ] Propose a merge strategy in the report: merge commit (preserves sprint-by-sprint history), rebase-and-merge (clean linear), or fast-forward (not possible — main has moved). Recommend one with reasoning. Do NOT execute the merge — Abdelrahman decides.
- [ ] Propose a deploy plan in the report: staged rollout (Railway preview first, full production flip behind an env gate like `TUNING_V1_ENABLED=true`), or cut-over. Recommend one with reasoning.

### 11. Concerns file sweep

- [ ] Update `concerns.md` statuses for every concern this sprint touches.
- [ ] Add any new concerns surfaced during the sprint (e.g. C23 for diagnostic-accuracy audit post-deploy, C27 if prompt cache misses).
- [ ] Leave OPEN only the items that genuinely belong post-V1.

## Process notes

- **Use the frontend `Sheet` primitive from shadcn.** Don't invent a drawer.
- **Use the existing scheduler pattern** for the retention job. Don't introduce a new infra dependency.
- **Keep the diagnostic model swap tiny.** One env var, one log line, one smoke rerun.
- **Do not spawn a design subagent.** Sprint 03 already set the visual language; this sprint reuses it.
- **Ask before any destructive DB operation** beyond the sprint-02 cleanup SQL that's already documented.

## Commits

Commit per logical unit, no squashing. Suggested sequence:

1. `feat(041): upgrade diagnostic to gpt-5.4 full with reasoning high`
2. `feat(041): sop + faq version history snapshot tables`
3. `feat(041): extend rollback to sop + faq artifacts`
4. `feat(041): persist editMagnitudeScore on Message`
5. `feat(041): use real edit magnitude in graduation metrics`
6. `feat(041): appliedAndRetained7d daily retention job`
7. `feat(041): live queue refresh via tuning_suggestion_updated`
8. `feat(041): mobile drawer for left rail below 768px`
9. `test(041): integration harness for evidence + diagnostic + suggestion_action`
10. `chore(041): cleanup stale smoke EvidenceBundle rows on railway`
11. `docs(041): sprint-05 report + merge + deploy recommendations`

## What to report back

Write `specs/041-conversational-tuning/sprint-05-v1-tail-report.md`:

1. What shipped (per acceptance criterion).
2. What deviated.
3. **Diagnostic model decision** — exact model identifier chosen, smoke output, cost delta.
4. **Prompt-cache verification** — observed `cache_read_input_tokens` ratio, trace links, interpretation. If < 0.70, the failure mode and the concern you added.
5. **Live browser click-through** — screenshots + pass/fail per acceptance bullet.
6. **DB-coexistence audit** — row counts, null-fraction per new column, confirmation old-branch writes still succeed.
7. **Schema diff** — full additive audit across all five sprints.
8. **Merge strategy recommendation + rationale.**
9. **Deploy plan recommendation + rationale.**
10. **Concerns sweep** — every concern touched, with before/after status.
11. Files touched (created / modified / deleted).
12. Test results — unit, integration, smoke, browser.
13. Commits — `git log --oneline feat/041-conversational-tuning ^main`.
14. What's left before calling V1 "done enough for a month of real use."

## When to ask vs when to just decide

Ask (via AskUserQuestion or stop and write the report early) when:
- A schema change appears non-additive (a column rename, a type change, a NOT NULL addition to an existing table).
- The exact `gpt-5.4` full model identifier cannot be determined from the repo / docs without external lookup (hit the OpenAI models list first; only ask if still ambiguous).
- Prompt cache misses on Railway and the root cause implies rearchitecting the SDK integration.
- A required env key is missing on Railway preview.
- The DB-coexistence audit reveals a row that would break an old-branch reader.

Do NOT ask for:
- Diagnostic model exact log format.
- History table column naming.
- Mobile drawer breakpoint tuning.
- Screenshot framing.
- Test fixture shapes.
