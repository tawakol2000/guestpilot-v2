# Feature Specification: AI Pipeline Overhaul

**Feature Branch**: `002-ai-pipeline-overhaul`
**Created**: 2026-03-19
**Status**: Draft
**Input**: Deep audit of AI pipeline effectiveness, self-improvement loop, and classifier accuracy — driven by production data analysis

## Clarifications

### Session 2026-03-19

- Q: How should the judge skip conditions be adjusted? → A: Judge evaluates EVERY AI response until DB training examples reach 300, then switches to sampling. The switch is a manual toggle (not automatic) so the operator can verify quality before relaxing.
- Q: Where should pipeline snapshots be stored? → A: As markdown in `.specify/memory/pipeline-snapshot.md` (git-tracked, readable by future AI sessions).
- Q: Should gap-filling be one-time or ongoing, and where is it reviewed? → A: One-time batch from real guest messages, reviewed in the existing classifier/examples UI via a "Suggested" tab with approve/reject buttons. Self-improvement loop (US3) handles ongoing growth after that.
- Q: Should this spec scope multi-tenant training data? → A: Keep global base + per-tenant DB examples (current architecture). Full per-tenant SOP customization deferred to a product spec.
- Q: Should "evaluate all" judge mode include contextual messages? → A: No — skip messages where Tier 3 re-injected even in evaluate_all mode. Contextual confirmations ("ok thanks") don't improve the training set.
- Q: Is SC-003 target of 550 examples achievable? → A: Keep 550 — achievable with gap-fill generating 80+ examples and self-improvement picking up pace as message volume grows.
- Q: How should the snapshot health summary be generated? → A: LLM-generated via Haiku call with metrics as input (~$0.002 per snapshot). More nuanced than rules-based, can synthesize patterns across categories.
- Q: How should training data, gap analysis, and snapshots be scoped across tenants? → A: Training examples shared globally (all tenants contribute to one classifier). SOP content is per-tenant (toggle on/off or override with custom text). Gap analysis runs across all tenant data for maximum coverage. Snapshots show per-tenant accuracy metrics.

## Current State (from production data, March 2026)

**These metrics justify every user story below:**

- **44.4% classifier accuracy** — 5 of 9 judge evaluations found wrong
  labels. All 5 failures returned EMPTY labels (classifier couldn't
  match anything).
- **4 active DB training examples** — the self-improvement loop has
  generated only 4 examples from tier2-feedback in the entire history.
  The base hardcoded set (~450 examples) carries all the weight.
- **63% empty-label rate** — Tier 1 classifier returned zero labels on
  17 of 27 calls in a single OPUS report window.
- **9 judge evaluations total** — judge fires too rarely due to
  aggressive skip conditions (skip if topSim >= 0.75, skip if majority
  neighbor agreement, skip if Tier 3 re-injected).
- **0 message ratings collected** — no operator feedback loop exists.
- **OPUS report verdict**: "operationally degraded", "RAG effectively
  contributed nothing."

**Note**: AI response rate appears low (62 replies in 30 days) because
the feature was recently enabled — this is expected and not a pipeline
problem. Response volume will grow as more properties enable AI.

**What's already working well:**
- The 3-tier architecture (KNN → Topic Cache → Intent Extractor) is
  fundamentally sound.
- System prompts (coordinator for confirmed guests, screening for
  inquiries) are well-structured with clear rules.
- Baked-in SOPs (scheduling, house rules, escalation) correctly avoid
  classifier routing for always-needed info.
- The pipeline dashboard already shows: tier distribution, live feed
  with full traces, judge stats, cost metrics, classifier health, and
  escalation signals.

## User Scenarios & Testing

### User Story 1 - Enhance Pipeline Dashboard with Accuracy Metrics (Priority: P1)

The existing pipeline page shows individual call logs and 24h summary
stats, but has no accuracy trends, per-category breakdown, or way to
see whether the system is improving over time. An operator (or future
AI session) needs to answer: "Is the classifier getting better? Which
categories are failing? Is self-improvement actually working?"

**Why this priority**: You can't improve what you can't measure. The
live feed exists but there's no aggregate accuracy view.

**Independent Test**: Open the pipeline page and verify that accuracy
trends, per-category breakdowns, and self-improvement growth stats are
visible alongside the existing metrics.

**Acceptance Scenarios**:

1. **Given** the existing pipeline page, **When** an operator views it,
   **Then** they see (in addition to existing 24h stats): overall
   classifier accuracy (% correct from judge evaluations), empty-label
   rate (% of classifications returning no labels), and accuracy trend
   over 7d/30d.
2. **Given** classifier evaluations exist, **When** the dashboard loads
   the per-category section, **Then** it shows a breakdown of which SOP
   categories have the highest miss rate (e.g., "sop-maintenance: 90%
   correct, sop-visitor-policy: 40% correct").
3. **Given** the self-improvement section, **When** the dashboard loads,
   **Then** it shows: DB training examples added over time (by source:
   tier2-feedback, llm-judge, manual), total active examples, and
   auto-fix count trend.

---

### User Story 2 - Fix the Training Data Gap (Priority: P1)

The classifier has ~450 hardcoded examples + only 4 auto-generated ones.
All 5 recent misclassifications returned EMPTY labels because no
training example was close enough. Key gaps: Arabic message coverage,
multi-intent messages, and categories with fewer than 8 examples
(sop-long-term-rental: 5, sop-booking-cancellation: 5,
sop-property-viewing: 5).

**Why this priority**: If Tier 1 returns empty labels, the entire RAG
pipeline injects nothing. The AI then responds with only baked-in SOPs
and generic knowledge — not the targeted procedures for the guest's
actual request. Every downstream improvement depends on Tier 1 working.

**Independent Test**: Run the test-classify endpoint against 50
representative guest messages (English + Arabic mix) and verify that
fewer than 10% return empty labels.

**Acceptance Scenarios**:

1. **Given** the current training data, **When** a gap analysis runs
   against recent guest messages from the pipeline logs, **Then** it
   identifies: (a) messages that returned empty labels, (b) categories
   with fewer than 10 training examples, (c) Arabic/multilingual
   messages underrepresented in training data.
2. **Given** the gap analysis results, **When** new training examples
   are generated (using the intent extractor to label real guest
   messages), **Then** they appear in a "Suggested" tab in the
   existing classifier/examples UI where the operator can approve or
   reject each one before it's added to the DB. Examples MUST include
   Arabic messages (60% of guest traffic) and other languages.
3. **Given** a set of 50 representative test messages, **When**
   classification runs, **Then** fewer than 10% return empty labels
   (down from the current 63%).

---

### User Story 3 - Make Self-Improvement Actually Work (Priority: P1)

The judge has evaluated only 9 messages total and generated only 4
training examples. The skip conditions are too aggressive: it skips
when topSim >= 0.75, when 2/3 neighbors agree, or when Tier 3
re-injected. In practice, this means the system only learns from
messages it was LEAST confident about — and never validates that its
confident answers were actually correct.

**Why this priority**: The architecture was designed for
self-improvement. If the judge barely fires, the system never learns,
and classification accuracy stagnates.

**Independent Test**: After tuning, verify that the judge evaluates at
least 30% of AI responses and that the training example count grows
measurably over a week of normal operation.

**Acceptance Scenarios**:

1. **Given** the judge mode toggle is set to "evaluate all", **When**
   an AI response is sent, **Then** the judge evaluates it regardless
   of topSimilarity or neighbor agreement — except for contextual
   messages where Tier 3 re-injected (these are skipped in all modes).
   When the toggle is switched to "sampling" (manually by operator),
   the judge reverts to evaluating ~30% of responses.
2. **Given** the judge evaluates a message and finds the classifier was
   wrong, **When** it auto-fixes, **Then** the new training example
   is logged in the pipeline dashboard with the guest message, old
   labels, corrected labels, and reasoning.
3. **Given** 7 days of normal operation with the tuned judge, **When**
   the self-improvement stats are checked, **Then** at least 5 new
   training examples have been auto-generated.

---

### User Story 4 - Threshold Tuning (Priority: P2)

The vote threshold (0.30), neighbor agreement requirement (2/3), Tier
1/2 handoff threshold (0.75), and contextual gate (0.85) were set
during development and never tuned against real data. The contextual
category has ~30 training examples (among the largest categories),
which may bias the classifier toward suppressing legitimate short
messages as "contextual follow-ups."

**Why this priority**: Correct thresholds can dramatically improve
accuracy without code changes. But they need data-driven tuning, not
guesswork. Depends on US1 (dashboard) and US2 (training data) first.

**Independent Test**: Run batch classification at different threshold
settings and identify the optimal values from accuracy curves.

**Acceptance Scenarios**:

1. **Given** the classifier and a batch of recent guest messages with
   known correct labels (from judge evaluations), **When** the vote
   threshold is varied (0.15 to 0.50), **Then** the accuracy at each
   threshold is reported.
2. **Given** the contextual training examples, **When** the category
   balance is reviewed, **Then** recommendations are made for whether
   to reduce contextual examples or adjust the contextual gate
   threshold (currently 0.85).
3. **Given** updated thresholds applied via the tenant config UI,
   **When** the change takes effect, **Then** the dashboard shows the
   impact on accuracy within the next evaluation cycle.

---

### User Story 5 - Pipeline Snapshot for Future AI Sessions (Priority: P2)

When an AI coding assistant revisits the pipeline in the future, it
has no way to understand what happened since the last session. It must
re-read all code, re-query the database, and re-derive conclusions.
A persistent "pipeline state snapshot" would capture current health,
recent changes, and outstanding issues — readable by both humans and AI.

**Why this priority**: This makes the system sustainably improvable.
Without it, every AI session starts from zero context.

**Independent Test**: Generate a snapshot, then start a fresh AI
session and ask it to assess pipeline health — it should answer
accurately from the snapshot alone.

**Acceptance Scenarios**:

1. **Given** the pipeline has been running, **When** a snapshot is
   generated (on demand via API or CLI), **Then** it captures:
   classifier accuracy (overall + per-category), training example
   count by source, top 10 misclassified messages, all threshold
   settings, self-improvement stats, and a plain-English summary.
2. **Given** a snapshot file, **When** a new AI coding session reads
   it, **Then** it can accurately describe: current accuracy, which
   categories need improvement, whether self-improvement is working,
   and recommended next actions.
3. **Given** multiple snapshots over time, **When** compared, **Then**
   improvement trends are visible (accuracy up, empty labels down,
   training set growing).

---

### User Story 6 - Operator Feedback Loop (Priority: P3)

Zero message ratings have been collected. The rating UI element may
exist but operators aren't using it. Without human feedback, the system
relies entirely on the judge (also an LLM) — a self-referential loop.

**Why this priority**: Operator feedback is ground truth. But this is
lower priority because getting the classifier and judge working first
will have a bigger immediate impact.

**Independent Test**: Rate 10 AI messages in the inbox UI and verify
ratings appear in the pipeline dashboard.

**Acceptance Scenarios**:

1. **Given** an AI message in the inbox, **When** an operator clicks
   thumbs-up or thumbs-down, **Then** the rating is saved and visible
   in the pipeline dashboard.
2. **Given** a thumbs-down rating with an optional correction note,
   **When** processed, **Then** a corrected training example is
   generated and prioritized over judge-generated examples.
3. **Given** a thumbs-up on a low-confidence classification, **When**
   processed, **Then** a reinforcement example is added to boost
   Tier 1 accuracy for similar messages.

---

### Edge Cases

- What happens when ALL training examples are for one category
  (extreme imbalance)? The classifier MUST still return labels for
  other categories when the message clearly matches.
- What happens when the judge and the operator disagree? Operator
  feedback MUST take precedence over judge corrections.
- What happens when a tenant has zero custom knowledge and zero
  training examples? The system MUST fall through to Tier 2 and still
  produce useful responses from baked-in SOPs.
- What happens when the snapshot generation fails mid-way? Partial
  snapshots MUST be marked incomplete and not overwrite valid ones.
- What happens when the screening AI prompt fires for a confirmed
  guest (or vice versa)? The agent selection (INQUIRY → screening,
  else → coordinator) MUST be verified and never produce a mismatch.

## Requirements

### Functional Requirements

- **FR-001**: The pipeline page MUST be enhanced with: overall
  classifier accuracy (%), per-category accuracy breakdown,
  empty-label rate, self-improvement growth stats, and accuracy
  trend over 7d/30d — alongside the existing 24h stats and live feed.
- **FR-002**: A gap analysis tool MUST identify: messages that returned
  empty labels, categories with fewer than 10 examples, and languages
  underrepresented in training data.
- **FR-003**: The system MUST support generating training examples from
  real guest messages (using the intent extractor for labeling),
  validated against existing examples before being added.
- **FR-004**: A manual "judge mode" toggle MUST be added to the tenant
  config: "evaluate all" (judge fires on every AI response, default
  while training set is small) vs "sampling" (judge evaluates ~30%,
  switched manually by operator when training set is mature).
- **FR-005**: The judge MUST log skip reasons (why it didn't evaluate)
  in a format visible on the pipeline dashboard.
- **FR-006**: A batch classification tool MUST accept a list of
  messages and threshold values and report accuracy at each setting.
- **FR-007**: A pipeline state snapshot MUST be generatable on demand,
  capturing: accuracy metrics, training stats, thresholds, top
  misclassifications, and an LLM-generated health summary (via Haiku
  call with metrics as input, ~$0.002/snapshot). Stored as markdown
  at `.specify/memory/pipeline-snapshot.md`.
- **FR-008**: Snapshots MUST overwrite the previous snapshot (single
  file, always current). Git history provides trend comparison.
- **FR-009**: Operator message ratings (thumbs up/down + optional note)
  MUST be capturable from the inbox UI and visible in the pipeline
  dashboard.
- **FR-010**: Thumbs-down ratings with corrections MUST generate
  training examples prioritized over judge-generated ones.
- **FR-011**: The system prompts (coordinator and screening) MUST be
  reviewed for accuracy and completeness — particularly escalation
  rules, working hours logic, and screening criteria — and any gaps
  documented for correction.
- **FR-012**: The gap-fill workflow MUST add a "Suggested" tab to the
  existing classifier examples UI, showing auto-generated candidates
  with approve/reject buttons. The UI MUST handle Arabic text (RTL)
  and other languages correctly.
- **FR-013**: Gap-fill examples MUST proportionally represent the
  actual guest language distribution (~60% Arabic, remaining English
  and other languages) to ensure the classifier works across
  languages.
- **FR-014**: Training examples MUST be shared globally across all
  tenants (every tenant's guest messages improve the classifier for
  everyone). SOP content MUST be per-tenant — tenants can toggle
  SOPs on/off or override the injected chunk with custom text
  (e.g., "we don't offer cleaning"). Gap analysis MUST run across
  all tenant data for maximum coverage. Snapshots MUST show
  per-tenant accuracy metrics.

### Key Entities

- **PipelineSnapshot**: Point-in-time capture of pipeline health
  metrics, training set stats, threshold settings, and
  recommendations. Stored as a structured file with timestamp.
- **ClassifierEvaluation**: Extended with skip-reason logging and
  linkage to operator ratings when available.
- **MessageRating**: Already exists but unused. Needs connection to
  the self-improvement loop and dashboard visibility.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Classifier accuracy improves from 44% to at least 80%
  within 30 days (measured by judge evaluations).
- **SC-002**: Empty-label rate drops from 63% to below 10%.
- **SC-003**: Training example count grows from ~454 (450 hardcoded +
  4 DB) to at least 550 within 30 days through self-improvement and
  gap filling.
- **SC-004**: Judge evaluates at least 30% of AI responses (up from
  the current ~15%).
- **SC-005**: Pipeline dashboard shows accuracy trends and per-category
  breakdown, loading in under 3 seconds.
- **SC-006**: A new AI coding session can assess pipeline health from
  a snapshot file alone, without database queries, within 2 minutes.
- **SC-007**: At least 20 operator message ratings collected within
  30 days of the feedback feature being available.

## Assumptions

- The ~450 hardcoded training examples in classifier-data.ts are
  directionally correct but have coverage gaps. They will be
  supplemented via the DB, not replaced.
- The 3-tier architecture (KNN → Topic Cache → Intent Extractor) is
  fundamentally sound — it needs better data and tuned thresholds,
  not a redesign.
- Both system prompts (coordinator and screening) are well-structured.
  This spec reviews them for completeness but does not redesign the
  persona or output format.
- The existing pipeline page (ai-pipeline-v5.tsx) is the right place
  to add accuracy metrics — no new page needed.
- Pipeline snapshots stored at `.specify/memory/pipeline-snapshot.md`
  (git-tracked) are sufficient for cross-session continuity.
- The AI response rate will grow naturally as more properties enable
  AI — it is not a pipeline problem.
- ~60% of guests communicate in Arabic. Training data and gap-fill
  must reflect this language distribution.
- The product will be sold to other property management businesses.
  Training examples are shared globally (hospitality language is
  universal). SOP content is per-tenant (each property has different
  services/rules). Tenants customize by toggling SOPs on/off or
  overriding the chunk text injected into the system prompt.
- The Tier 3 topic switch detection (keyword-based) is adequate for
  now. Edge cases where guests switch topics without switch keywords
  are acceptable until Tier 1 accuracy improves.
