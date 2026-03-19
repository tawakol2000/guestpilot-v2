# Research: AI Pipeline Overhaul

**Date**: 2026-03-19
**Feature**: 002-ai-pipeline-overhaul

## R1: Accuracy Metrics Aggregation

**Decision**: Add a new `/api/ai-pipeline/accuracy` endpoint that
aggregates ClassifierEvaluation data into accuracy metrics. Compute
server-side, cache for 60 seconds.

**Rationale**: The frontend already fetches from `/api/ai-pipeline/stats`
and `/api/ai-pipeline/feed`. Adding a third endpoint for accuracy keeps
the existing fast paths unchanged and isolates the heavier aggregation
query.

**Metrics to compute**:
- Overall accuracy: `COUNT(retrievalCorrect=true) / COUNT(*)` over 7d/30d
- Per-category accuracy: group by `judgeCorrectLabels`, count correct
  vs incorrect
- Empty-label rate: `COUNT(classifierLabels=[]) / COUNT(*)` from AiApiLog
  where ragContext shows tier1 classification
- Self-improvement growth: `COUNT(ClassifierExample) GROUP BY source, DATE`
- Training example total by source

**Alternatives considered**:
- Compute in frontend from raw feed data: Too slow with large datasets,
  would require loading all evaluations
- Add to existing `/stats` endpoint: Would slow down the 24h summary
  that currently loads fast

---

## R2: Gap Analysis Implementation

**Decision**: Build a one-time gap analysis as a backend API endpoint
(`POST /api/knowledge/gap-analysis`) that:
1. Queries AiApiLog for messages with empty classifier labels (last 30d)
2. Queries ClassifierExample to count per-category
3. Detects language from messages (simple heuristic: Arabic Unicode
   range check)
4. Returns structured JSON with gaps + suggested examples

**Rationale**: The data already exists in AiApiLog (ragContext field
stores classifier output). The intent extractor can label each gap
message. Results feed into the "Suggested" tab.

**Suggested example generation**:
- For each message that returned empty labels, call the intent extractor
  to get correct labels
- Validate: check similarity > 0.35 against existing examples with
  the same label
- Store as `ClassifierExample` with `source: 'gap-analysis'` and
  `active: false` (pending approval)
- Frontend shows them in "Suggested" tab with approve/reject

**Alternatives considered**:
- CLI script: Would work for one-time but no UI for approve/reject
- Automated continuous: Over-engineering for the current stage

---

## R3: Judge Mode Toggle

**Decision**: Add a `judgeMode` field to `TenantAiConfig` with values
`'evaluate_all'` (default) and `'sampling'`. When `'evaluate_all'`,
the judge skips NO messages. When `'sampling'`, it uses the existing
skip conditions + 30% random sampling of skipped messages.

**Rationale**: Simple toggle in the existing tenant config system.
The operator can see the impact in the dashboard and switch when
confident the training set is mature.

**Implementation**:
- Add `judgeMode String @default("evaluate_all")` to TenantAiConfig
- In judge.service.ts `evaluateAndImprove()`: check mode before
  applying skip conditions
- In the settings UI (classifier-v5.tsx or configure-ai-v5.tsx):
  add a toggle/dropdown for judge mode

---

## R4: Pipeline Snapshot Format

**Decision**: Generate a markdown file at
`.specify/memory/pipeline-snapshot.md` with structured sections that
are both human-readable and AI-parseable.

**Format**:
```markdown
# Pipeline Health Snapshot

**Generated**: 2026-03-19T12:00:00Z
**Period**: Last 30 days

## Accuracy
- Overall: 80% (40/50 correct)
- Empty-label rate: 8%

## Per-Category Accuracy
| Category | Correct | Total | Accuracy |
|----------|---------|-------|----------|
| sop-maintenance | 12 | 14 | 85.7% |
| ... | ... | ... | ... |

## Training Set
- Hardcoded: 450
- DB (active): 87
- By source: manual: 10, llm-judge: 42, tier2-feedback: 30, gap-analysis: 5
- Growth this period: +23

## Thresholds
- Vote: 0.30, Contextual gate: 0.85, Judge: 0.75, Auto-fix: 0.70
- Judge mode: evaluate_all

## Top Misclassifications (last 10)
1. "message text..." — Classifier: [] → Judge: sop-maintenance
...

## Health Summary
[AI-generated plain-English assessment]

## Recommended Actions
1. ...
```

**Generation**: API endpoint `POST /api/ai-pipeline/snapshot` that
queries the DB, assembles the markdown, and writes to the file path.
Also returns the markdown as response body.

---

## R5: Suggested Examples UI Pattern

**Decision**: Add a "Suggested" tab to the existing examples editor
component (`examples-editor-v5.tsx`). Show examples with
`active: false` and `source: 'gap-analysis'`. Each row has
approve (activate) and reject (delete) buttons.

**RTL Support**: Use `dir="auto"` on text cells to let the browser
detect Arabic text direction automatically. This is the standard
approach and requires no additional library.

**Alternatives considered**:
- New standalone page: Unnecessary — the examples editor already has
  the right context (categories, existing examples, test-classify)
- Modal overlay: Too cramped for reviewing text + labels
