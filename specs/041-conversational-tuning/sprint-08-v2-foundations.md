# Sprint 08 — V2 Foundations (retention surface, escalation triggers, preference visibility, graduation hardening)

> **You are a fresh Claude Code session with no memory of prior work.** Read the files listed below, plus all prior sprint reports, before writing code.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md`
2. `specs/041-conversational-tuning/vision.md`
3. `specs/041-conversational-tuning/roadmap.md`
4. `specs/041-conversational-tuning/deferred.md`
5. `specs/041-conversational-tuning/glossary.md`
6. `specs/041-conversational-tuning/concerns.md`
7. Sprint reports (skim §Goal + §Deliverables of each):
   - `sprint-01-evidence-and-schema-report.md`
   - `sprint-02-taxonomy-and-diagnostic-pipeline-report.md`
   - `sprint-03-tuning-surface-report.md`
   - `sprint-04-conversational-agent-report.md`
   - `sprint-05-v1-tail-report.md`
   - `sprint-07-ui-overhaul-report.md`
   - `sprint-07-expanded-scope-report.md`
8. `CLAUDE.md` (repo root).

## Branch

`feat/041-conversational-tuning`. 88 commits on top of `main`. Commit on top. **Do NOT merge to main. Do NOT push unless explicitly told.**

## Goal

Ship the buildable V2 foundation features that need zero production data. Four workstreams:

1. **Retention summary surface** — the `appliedAndRetained7d` retention job already runs daily but nothing consumes it. Build the API endpoint + dashboard card.
2. **Escalation-triggered tuning events** — the `ESCALATION_TRIGGERED` enum value is pre-wired. Wire the actual trigger into the escalation flow so resolved escalations fire the diagnostic pipeline.
3. **Preference pair visibility** — the `PreferencePair` table records every reject/edit triple. Add a read-only viewer so the manager can see what the agent learned from.
4. **Graduation metric hardening** — V1 shipped 4 of 7 graduation criteria. Add critical-failure tracking, conversation-count threshold gating, and per-category confidence gating.

## Non-goals (do NOT do in this sprint)

- **No HDBSCAN clustering** (D1) — needs 200+ tagged edits. Still deferred.
- **No DPO pipeline** (D2) — needs 500+ preference pairs. Still deferred.
- **No shadow evaluation** (D3) — needs golden set. Still deferred.
- **No autonomous agent openings** (D5) — needs D1. Still deferred.
- **No Thompson Sampling** (D7) — needs 100+ suggestions/category. Still deferred.
- **No inline tuning in inbox** (D9) — needs steady usage. Still deferred.
- **No multi-agent** (D12) — no need yet.
- **No A/B testing** (D4) — no multi-tenant yet.
- **Do NOT refactor the agent tool layer.** 8 tools stays.
- **Do NOT touch the chat stream protocol.** It works.
- **Do NOT fix pre-existing TS errors in `*-v5` components** (C22).

## Acceptance criteria

### 1. Retention summary endpoint + dashboard card

The retention job (`backend/src/jobs/tuningRetention.job.ts`) already writes `appliedAndRetained7d` on accepted suggestions 7-8 days old. Build the read surface.

- [ ] `GET /api/tuning/retention-summary` — returns `{ retained: number, reverted: number, pending: number, retentionRate: number | null, windowDays: 14 }` scoped to the authenticated tenant. `retentionRate` = `retained / (retained + reverted)` (null if denominator is 0). `pending` = accepted suggestions less than 7 days old (no verdict yet).
- [ ] Auth: existing JWT middleware, tenant-scoped.
- [ ] Dashboard card in the right-rail of `/tuning` (page.tsx) — render a calm stat card matching the existing graduation-dashboard style. Show: `XX% retained at 7d` big number, `N retained · M reverted · P pending` subtext, tooltip explaining what "retained" means.
- [ ] Empty state: when no suggestions have been accepted yet, show "No accepted suggestions yet" with the same iconified empty-state pattern used elsewhere (see `SessionsEmptyState` in `sessions/page.tsx` for the pattern).
- [ ] Handle the case where `retentionRate` is null gracefully (no division-by-zero, show "—" instead of a number).

### 2. Escalation-triggered tuning events (D6)

The `ESCALATION_TRIGGERED` enum value exists on `TuningTriggerType`. Wire it into the escalation resolution flow.

- [ ] Identify the escalation resolution endpoint. It's likely in `backend/src/controllers/` or the task-manager service. Read the code to find where a task/escalation is marked resolved.
- [ ] When an escalation is resolved (status → `RESOLVED`), if the resolution includes a manager message or action that changed the AI's output, fire the diagnostic pipeline with `triggerType: 'ESCALATION_TRIGGERED'` and `triggerMessageId` pointing to the resolution message.
- [ ] The evidence bundle should include the original escalation context (what triggered the escalation, the guest message, the AI response that was escalated, and the manager's resolution).
- [ ] Guard: only fire if the tenant has `tuningEnabled` (or equivalent config flag). Degrade silently if not.
- [ ] Guard: respect the existing 48h cooldown and trigger dedup — same rules as all other trigger types.
- [ ] Add a test that verifies the trigger fires on escalation resolution and respects cooldown/dedup.
- [ ] Update `concerns.md` — D6 status note.

### 3. Preference pair viewer

The `PreferencePair` table (`backend/prisma/schema.prisma`) stores `(contextJson, rejectedJson, acceptedJson, category, createdAt)` on every reject or edit-then-accept. Make it visible.

- [ ] `GET /api/tuning/preference-pairs` — paginated (default 20, max 100), sorted by `createdAt DESC`, tenant-scoped. Each row returns: `{ id, category, contextExcerpt (first 200 chars of contextJson), rejectedExcerpt (first 200 chars), acceptedExcerpt (first 200 chars), createdAt }`. Full content available via `GET /api/tuning/preference-pairs/:id`.
- [ ] `GET /api/tuning/preference-pairs/:id` — returns the full triple with all JSON fields.
- [ ] `GET /api/tuning/preference-pairs/stats` — returns `{ total: number, byCategory: Record<TuningDiagnosticCategory, number>, oldestAt: string | null, newestAt: string | null }`. This powers a small summary in the dashboard.
- [ ] Frontend: new `/tuning/pairs` page accessible from the top nav (add between "History" and "Capability requests"). 
  - List view: table with columns Category (pill), Context (truncated), Rejected (truncated), Accepted (truncated), Date (relative time). Click to expand.
  - Detail view: full context, rejected, and accepted JSON rendered in side-by-side diff format (reuse `DiffViewer`).
  - Empty state: iconified, same pattern as other pages. Icon: `GitCompare` or `ArrowLeftRight` from lucide. Heading: "No preference pairs yet". Description: "Reject or edit a suggestion to start building training signal."
  - Stats summary at the top: total pairs, breakdown by category (small pill counts).
- [ ] Follow the existing UI conventions: TUNING_COLORS tokens, cool palette, sentence case, shadows not borders, same font sizing.
- [ ] Add "Pairs" to the top nav in the tuning layout, positioned after "History".

### 4. Graduation metric hardening

V1 shipped 4 of 7 graduation criteria (edit rate, edit magnitude, escalation rate, acceptance rate). Harden with 3 more signals.

- [ ] **Critical-failure tracking**: Add a `criticalFailure Boolean @default(false)` flag on `TuningSuggestion` (additive, nullable OK but default false is cleaner). A suggestion is a critical failure when `diagnosticCategory` is one of `SOP_CONTENT`, `SOP_ROUTING`, or `SYSTEM_PROMPT` AND the diagnostic `confidence` >= 0.85 AND the edit magnitude is `WHOLESALE`. When the diagnostic pipeline writes a suggestion matching this criteria, set the flag.
- [ ] Extend `GET /api/tuning/graduation-metrics` to include:
  - `criticalFailures30d: number` — count of critical failures in the last 30 days. Graduation requires this to be 0.
  - `conversationCount30d: number` — total conversations with at least one AI message in the last 30 days. Graduation requires >= 200.
  - `categoryConfidenceGating: Record<TuningDiagnosticCategory, { acceptanceRate: number, gated: boolean }>` — per-category acceptance rate over the last 30 days. Categories with < 30% acceptance are `gated: true` (meaning suggestions in that category need higher evidence before surfacing — the dashboard shows a warning, the agent is informed).
- [ ] Update the graduation dashboard card in `/tuning` right rail to display the new criteria. Use traffic-light indicators: green check for passing, amber warning for close, red X for failing. Show the threshold next to each value (e.g., "0 critical failures (target: 0)", "187 conversations (target: 200)").
- [ ] If any category is gated (< 30% acceptance), show a small warning banner in the queue for suggestions in that category: "Low acceptance — consider reviewing diagnostic quality for [category]".

### 5. Per-category confidence gating in the diagnostic pipeline

This is the enforcement side of §4's `categoryConfidenceGating`.

- [ ] When the diagnostic pipeline writes a new suggestion, check the category's 30-day acceptance rate via `category-stats.service.ts`.
- [ ] If the category's acceptance rate is < 30%, require `confidence >= 0.75` to surface the suggestion. Below that threshold, still write the row (for record-keeping) but set `status: 'AUTO_SUPPRESSED'` instead of `'PENDING'`.
- [ ] Add `AUTO_SUPPRESSED` to the `TuningSuggestionStatus` enum if it doesn't exist (additive).
- [ ] The queue UI should NOT show `AUTO_SUPPRESSED` suggestions by default. Add a toggle/filter: "Show suppressed (N)" that reveals them in a muted style.
- [ ] The agent should be aware of suppression: when it calls `search_corrections`, include suppressed suggestions with a `[suppressed]` tag so it can explain why a suggestion wasn't surfaced.

## Report

Write a report at `specs/041-conversational-tuning/sprint-08-v2-foundations-report.md` following the same structure as prior sprint reports:

1. Goal recap
2. What was built (per acceptance criterion, checkboxes)
3. What was deferred or descoped within this sprint (if any)
4. Schema changes (exact Prisma diff)
5. New routes / endpoints
6. Frontend changes
7. Concerns surfaced or resolved
8. Commit log
9. Handoff notes for next sprint

## Commit discipline

- One commit per logical unit. Imperative subjects.
- Co-author line on every commit: `Co-Authored-By: Claude <noreply@anthropic.com>`
- No squashing. No force-push.
- **Do not push. Do not merge.**
