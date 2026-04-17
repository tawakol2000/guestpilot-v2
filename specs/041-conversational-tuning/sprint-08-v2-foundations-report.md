# Sprint 08 — V2 Foundations — Report

## 1. Goal recap

Ship the buildable V2 foundation features that need zero production data:

1. Retention surface (consume the daily `appliedAndRetained7d` job).
2. Escalation-triggered tuning events (wire the pre-existing
   `ESCALATION_TRIGGERED` enum into the real resolution flow).
3. Preference pair viewer (expose the D2 DPO-signal table).
4. Graduation metric hardening (critical failures, conversation count,
   per-category gating).
5. Per-category confidence gating enforcement in the diagnostic pipeline.

All five are on `feat/041-conversational-tuning`, commits on top of the
prior 88, no merge, no push.

## 2. What was built

### §1 — Retention summary endpoint + dashboard card

- [x] `GET /api/tuning/retention-summary` returns the canonical sprint-08
  shape `{ retained, reverted, pending, retentionRate, windowDays }`.
  `retentionRate` is `null` when `retained + reverted === 0`. Legacy-shape
  fields (`retainedAccepts`, `evaluatedAccepts`, `eligibleAccepts`,
  `retentionWindow`) are kept additive so any in-flight callers don't break.
- [x] Auth: existing JWT middleware, tenant-scoped.
- [x] Dashboard card rendered in `/tuning` right rail between Velocity and
  Graduation, using `TUNING_COLORS.surfaceRaised` with the same box-shadow
  as the other cards. Big number "XX% retained at 7d"; subtext `N retained
  · M reverted`, `P pending · 14d`; native tooltip explains the 7d-after-
  apply measurement.
- [x] Empty state ("No accepted suggestions yet") uses the iconified
  pattern from `SessionsEmptyState` — `PackageCheck` icon in
  `accentSoft` circle, title + one-line hint.
- [x] Null-rate handling renders "—" without division-by-zero.

### §2 — Escalation-triggered tuning events (D6)

- [x] Identified the resolution endpoint: `PATCH /api/tasks/:id` with
  `{ status: 'completed' }` — no standalone "resolve escalation"
  endpoint exists; Task with `type: 'ESCALATION'` closing is the signal.
- [x] New service `backend/src/services/tuning/escalation-trigger.service.ts`
  owns the logic. `task.controller.ts#update` invokes
  `maybeFireEscalationTrigger(...)` fire-and-forget after a successful
  status change.
- [x] Fires only when:
  - Task type is `ESCALATION`.
  - Status transitions `≠ 'completed'` → `'completed'`.
  - Task has a `conversationId`.
  - Tenant has `shadowModeEnabled === true` (see C29 for the follow-up on
    a dedicated `tuningEnabled` flag).
  - A prior AI reply exists in the conversation (the "disputed message").
  - A host / manager-private reply was sent after the escalation was
    opened (the "resolution that changed the AI output" signal).
  - The 60s per-process dedup doesn't reject.
- [x] Evidence bundle is the existing one produced by
  `assembleEvidenceBundle` on the disputed AI message — it already
  captures conversation context (which includes the resolution reply),
  SOPs in effect, Hostaway entities, and prior corrections. The
  `note` field carries the escalation task title + timestamps for the
  diagnostic LLM to reason over.
- [x] Respects the 48h `suggestion-writer` cooldown downstream without
  extra work here.
- [x] Unit tests in
  `backend/src/services/tuning/__tests__/escalation-trigger.service.test.ts`
  cover every guard (wrong type, already-completed, non-completed new
  status, missing conversationId, shadowMode off, no AI message, no
  resolution reply) plus the dedup idempotency. All 8 pass.
- [x] `concerns.md` — D6 now tracked as C29 (gated on `shadowModeEnabled`
  as a proxy until we add a dedicated flag).

### §3 — Preference pair viewer

- [x] `GET /api/tuning/preference-pairs?limit=20&cursor=…` — paginated
  (default 20, max 100). Returns `{ id, category, contextExcerpt,
  rejectedExcerpt, acceptedExcerpt, createdAt }` per row. Excerpts are
  200 chars, extracted preferentially from `{text,content,answer}` keys
  in the underlying JSON.
- [x] `GET /api/tuning/preference-pairs/:id` — full JSON triple.
- [x] `GET /api/tuning/preference-pairs/stats` — `{ total, byCategory,
  oldestAt, newestAt }`. All 8 diagnostic categories plus `LEGACY` are
  initialised to 0 so the dashboard layout is stable.
- [x] Route order is `/preference-pairs` → `/preference-pairs/stats` →
  `/preference-pairs/:id` so the literal `/stats` route isn't shadowed.
- [x] Frontend: `/tuning/pairs` page built to match the
  `/tuning/history` + `/tuning/capability-requests` pattern — same
  `TuningTopNav`, same loading / error / empty / list states, same
  `max-w-4xl` center column.
  - Stats banner up top: total + per-category pill counts (only non-zero
    categories shown; color palette from `CATEGORY_STYLES`).
  - List row is a 5-col grid (category pill / context excerpt / rejected
    excerpt / accepted excerpt / timestamp + chevron). Click to expand
    and render the full `DiffViewer` between rejected and accepted plus
    the context as a sunken JSON block.
  - Iconified empty state uses `ArrowLeftRight`, heading "No preference
    pairs yet", description mirrors the brief verbatim.
- [x] `"Pairs"` added to `TuningTopNav` between History and Capability
  requests.
- [x] `TUNING_COLORS` tokens used throughout; sentence case, shadows not
  borders, no serif fonts.

### §4 — Graduation metric hardening

- [x] Schema: `TuningSuggestion.criticalFailure Boolean @default(false)`
  (additive, default false — old rows coexist).
- [x] Suggestion writer now sets `criticalFailure = true` iff
  `category ∈ {SOP_CONTENT, SOP_ROUTING, SYSTEM_PROMPT}` AND
  `confidence >= 0.85` AND `magnitude === 'WHOLESALE'`.
- [x] `GET /api/tuning/graduation-metrics` extended with:
  - `criticalFailures30d` + `criticalFailuresTarget` (target 0).
  - `conversationCount30d` + `conversationCountTarget` (target 200).
  - `categoryConfidenceGating` — per-category `{ acceptanceRate,
    sampleSize, gated }`. Gated iff `acceptanceRate < 0.3` AND
    `sampleSize >= 5` in the last 30d. Emitted for all 8 categories
    even when zero so the dashboard layout is stable.
  - `categoryGatingThreshold` (0.3) echoed back so the UI doesn't
    hard-code it.
- [x] Graduation dashboard card in `/tuning` right rail: traffic-light
  icons (`CheckCircle2` green, `AlertTriangle` amber, `XCircle` red)
  on Edit rate / Escalation rate / Critical failures / Conversations;
  hint text shows the threshold ("target: 0 · 30d", "target: 200 · 30d").
- [x] Low-acceptance inline banner rendered on `DetailPanel` when the
  current suggestion's category is gated: "Low acceptance — consider
  reviewing diagnostic quality for [category]. 30d rate: X% over N
  decisions." Sourced from the same `categoryConfidenceGating` map.

### §5 — Per-category confidence gating

- [x] `getCategoryAcceptance30d(prisma, tenantId, category)` added to
  `category-stats.service.ts` — computes acceptance rate from raw
  `TuningSuggestion` groupBy over the last 30 days (status ∈
  {ACCEPTED,REJECTED}). Returns `{ acceptanceRate, sampleSize }`.
  Identical window to the graduation endpoint so the "gated" signal is
  consistent across surfaces.
- [x] `suggestion-writer.service.ts` consults it on every write. When
  `acceptanceRate < 0.3`, `sampleSize >= 5`, AND `result.confidence <
  0.75`, status is `'AUTO_SUPPRESSED'` instead of `'PENDING'`. The row
  is still written (DPO signal kept) with the full diagnostic payload.
  Log line includes the gating reason so operator diagnosis is easy.
- [x] Queue list (`GET /api/tuning-suggestions`):
  - `status=ALL` now excludes `AUTO_SUPPRESSED` (previously returned
    every row).
  - `status=AUTO_SUPPRESSED` is now a valid filter value so the
    "Show suppressed" toggle can fetch them explicitly.
- [x] `/tuning` page fetches PENDING + AUTO_SUPPRESSED in parallel and
  shows a "Show suppressed (N)" toggle in the left rail header when any
  exist. Active state is purple (`#6C5CE7`); title tooltip explains the
  gating rule.
- [x] Suppressed rows render with `opacity: 0.6` and a `suppressed`
  sunken chip next to the category pill, so they're visible but
  unambiguously not in the active queue.
- [x] Agent tool `search_corrections` gains:
  - `AUTO_SUPPRESSED` in the status enum.
  - `includeSuppressed: boolean` parameter (default false: hides
    suppressed rows to match the manager's view).
  - `suppressed: true` hint on each returned row when status is
    `AUTO_SUPPRESSED`, so the agent can surface `[suppressed]` in its
    rationale when asked "why didn't you suggest X?".
- [x] Unit tests in `suggestion-writer.service.test.ts`:
  - `criticalFailure` flag set / not set (3 cases).
  - `AUTO_SUPPRESSED` fired / skipped on high-conf / skipped on small
    sample (3 cases).
  All 11 tests in the file pass.

## 3. What was deferred / descoped

Nothing within the sprint's stated scope. §1–§5 all landed.

Items called out in the brief as non-goals remained deferred: HDBSCAN
clustering (D1), DPO pipeline (D2), shadow evaluation (D3), autonomous
agent openings (D5), Thompson Sampling (D7), inline-in-inbox (D9),
multi-agent (D12), A/B testing (D4), agent tool refactor, chat protocol
changes, pre-existing v5 TS errors (C22).

## 4. Schema changes (exact Prisma diff)

```diff
 enum TuningSuggestionStatus {
   PENDING
   ACCEPTED
   REJECTED
+  // Feature 041 sprint 08 §5 — per-category confidence gating.
+  // Written when the diagnostic pipeline produces a suggestion in a category
+  // whose 30-day acceptance rate is < 30% AND the suggestion's confidence is
+  // below the elevated gating threshold (0.75). The row is retained for
+  // record-keeping / DPO signal but is hidden from the default queue. Old-
+  // branch code never produces this value; code that reads TuningSuggestion
+  // must fall through to "treat as non-pending" rather than crash.
+  AUTO_SUPPRESSED
 }

 model TuningSuggestion {
   ...
   triggerType        TuningConversationTriggerType?
   evidenceBundleId   String?
+
+  // ─── Feature 041 sprint 08 §4 — critical-failure flag (additive, default false) ───
+  // Set by the diagnostic pipeline when a suggestion is high-confidence (>=0.85)
+  // AND high-magnitude (WHOLESALE) AND in a content-affecting category
+  // (SOP_CONTENT, SOP_ROUTING, SYSTEM_PROMPT). Graduation blocks on any
+  // criticalFailure = true in the last 30 days. Old rows default to false;
+  // old-branch writes omit the column (default applies). Safe to coexist.
+  criticalFailure Boolean @default(false)
 }
```

Applied via `npx prisma db push` against the shared Railway Postgres.
Both additive; live `main` branch continues to write without either
field and reads rows produced by the new branch without deserialization
errors (old code ignores `AUTO_SUPPRESSED` because it filters by
`status=PENDING|ACCEPTED|REJECTED` or doesn't filter at all — in which
case Prisma handles the new enum value transparently as the enum is
declared in the schema both branches share).

## 5. New routes / endpoints

- `GET /api/tuning/retention-summary` — shape evolved; old fields kept.
- `GET /api/tuning/preference-pairs`
- `GET /api/tuning/preference-pairs/stats`
- `GET /api/tuning/preference-pairs/:id`

Extended:

- `GET /api/tuning/graduation-metrics` — additive fields only.
- `GET /api/tuning-suggestions?status=AUTO_SUPPRESSED` — new filter value.
- `PATCH /api/tasks/:id` — side-effect only; contractual shape unchanged.

## 6. Frontend changes

- `frontend/lib/api.ts` — new types + clients: `TuningRetentionSummary`
  (+ `apiTuningRetentionSummary`), `TuningPreferencePairSummary /Detail
  /Stats` (+ three `api*PreferencePair*` clients), extended
  `TuningGraduationMetrics` (optional sprint-08 fields), extended
  `TuningSuggestionStatus` (`AUTO_SUPPRESSED`).
- `frontend/components/tuning/dashboards.tsx` — new
  `RetentionDashboard`; `GraduationDashboard` hardened with traffic-light
  `ThresholdStat`, critical-failures + conversations stats, gated-category
  banner. `DashboardsPanel` now renders `Velocity → Retention →
  Graduation`.
- `frontend/components/tuning/queue.tsx` — rows render muted + chip when
  `status === 'AUTO_SUPPRESSED'`.
- `frontend/components/tuning/detail-panel.tsx` — inline "Low
  acceptance" warning banner when the current suggestion's category is
  gated, driven by `/api/tuning/graduation-metrics`.
- `frontend/components/tuning/top-nav.tsx` — "Pairs" entry between
  History and Capability requests.
- `frontend/app/tuning/page.tsx` — parallel fetch of PENDING +
  AUTO_SUPPRESSED, "Show suppressed (N)" toggle in left-rail header,
  union list feeds the queue when toggled on.
- `frontend/app/tuning/pairs/page.tsx` — new page.

All new UI uses `TUNING_COLORS` tokens exclusively. No new
dependencies. No changes to v5 components (C22 remains out of scope).

## 7. Concerns surfaced or resolved

Added to `concerns.md`:

- **C29 — D6 escalation trigger gated on `shadowModeEnabled` as a proxy.**
  The brief asked for a `tuningEnabled (or equivalent)` flag; no such
  field exists on `TenantAiConfig`, so `shadowModeEnabled` is the
  nearest proxy. Status: OPEN. Follow-up: introduce a dedicated flag
  and swap the gate in one line.

No concerns resolved in this sprint (the sprint-08 scope didn't touch
the open concerns C4, C5, C10, C14, C22, C23, C25, C26, C27, C28).

## 8. Commit log

```
10a9856 feat(041): sprint 08 schema — AUTO_SUPPRESSED + criticalFailure
b4544a8 feat(041): sprint 08 §1 — retention dashboard card
731cd1a feat(041): sprint 08 §2 — wire ESCALATION_TRIGGERED on task resolution
8ec4729 feat(041): sprint 08 §3 — preference pair viewer (D2 signal)
7cd8152 feat(041): sprint 08 §4 + §5 — graduation hardening + confidence gating
```

5 commits, per-unit, co-authored. No squash, no push, no merge.

## 9. Handoff notes for next sprint

- The retention card and graduation hardening both consume data that
  accumulates over real calendar time. Expect the first week post-deploy
  to show `retentionRate: null` (no accepts have settled to 7d yet) and
  `criticalFailures30d: 0` (the flag only starts being written on new
  suggestions from this deploy forward). That's the correct behavior —
  don't confuse it with "endpoints broken".
- AUTO_SUPPRESSED has zero rows on Railway until a category actually
  under-performs for 5+ decisions. The "Show suppressed (N)" toggle
  self-hides when `suppressed.length === 0`, so no empty-state plumbing
  is needed.
- The escalation trigger is the first dependency we've placed on
  `TenantAiConfig.shadowModeEnabled` outside the shadow-mode flow. If a
  dedicated `tuningEnabled` flag ships later, flip C29 by swapping the
  config lookup in `escalation-trigger.service.ts` and remove the
  concern entry.
- `PreferencePair` rows from sprint 03 onward have `category` set from
  the suggestion's `diagnosticCategory`; older rows (pre-sprint-03) may
  have `category: null` and surface in the stats banner under "Legacy".
  If that bucket grows large post-merge, the fix is a one-time SQL
  backfill joining back to the source `TuningSuggestion`.
- V2 items still waiting on data: HDBSCAN clustering (D1, 200+ edits),
  DPO (D2, 500+ preference pairs — this sprint exposed the viewer so we
  can visually track the buildup), shadow evaluation (D3, needs golden
  set), autonomous openings (D5, depends on D1), Thompson Sampling (D7,
  100+ suggestions/category), inline-in-inbox (D9, needs steady usage).
  None unblock next sprint; all depend on production data accumulating.
- Backend `npx tsc --noEmit` is clean. Frontend has only the
  pre-existing v5 errors tracked as C22 — no new-sprint errors.
