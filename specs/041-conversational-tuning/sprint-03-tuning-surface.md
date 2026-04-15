# Sprint 03 — Tuning Surface (non-chat parts)

> **You are a fresh Claude Code session with no memory of prior work.** Read the files listed below, plus the prior sprint reports, before writing any code.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md` — branch, DB-coexistence, commit rules.
2. `specs/041-conversational-tuning/vision.md` — product vision, especially UX principles.
3. `specs/041-conversational-tuning/roadmap.md` — this sprint covers **days 7-9** of V1.
4. `specs/041-conversational-tuning/deferred.md` — what's deferred.
5. `specs/041-conversational-tuning/glossary.md` — vocabulary.
6. `specs/041-conversational-tuning/sprint-01-evidence-and-schema-report.md` — foundation.
7. `specs/041-conversational-tuning/sprint-02-taxonomy-and-diagnostic-pipeline-report.md` — **read every section**; it contains three UI-side constraints and the exact API shapes you will consume.
8. `specs/041-conversational-tuning/concerns.md` — open concerns, particularly C12, C13, C16.
9. `CLAUDE.md` (repo root).
10. `frontend/app/` — existing Next.js 16 routing structure.
11. `frontend/components/inbox-v5.tsx` — currently renders the `navTab === 'tuning'` placeholder card that sprint 01 left. You will replace that with navigation to the new surface.
12. `frontend/components/ui/` — shadcn/ui primitives already in the project.
13. `frontend/lib/api.ts` (or equivalent) — existing API client pattern.
14. `backend/src/controllers/tuning-suggestion.controller.ts` — accept / reject endpoints you will extend.
15. `backend/src/controllers/tuning-category-stats.controller.ts` — read endpoint for the velocity dashboard.
16. `backend/prisma/schema.prisma` — the source of truth for data shapes.

## Branch

`feat/041-conversational-tuning`. Commit on top. No merge. No push.

## Goal

Build the `/tuning` surface the manager uses to review, accept, reject, and edit `TuningSuggestion` records — plus the two V1 dashboards (velocity + graduation) and a small `CapabilityRequest` backlog. The surface must render cleanly for both new-pipeline rows (with `diagnosticCategory`, `confidence`, `diagnosticSubLabel`) and legacy rows written by live `main` (those fields null). Design language matches Anthropic's Managed Agents / Claude Console editorial aesthetic — see the system prompt for direction.

Chat panel is **not** in this sprint. Reserve layout space for it; sprint 04 mounts the chat component.

## Non-goals (do NOT do in this sprint)

- **Do NOT build the chat UI** (Vercel AI SDK `useChat`, `@ai-sdk/anthropic`, stream parsing, `<SuggestionCard>` / `<DiffPreview>` inside a chat bubble, anchor-message "discuss in tuning" button). Sprint 04.
- **Do NOT integrate the Claude Agent SDK** or call any agent endpoint.
- **Do NOT schema-change** unless absolutely forced. If you think you need one, stop and ask.
- **Do NOT populate `conversationId` on suggestion writes.** Sprint 04 owns chat-bound suggestions.
- **Do NOT implement HDBSCAN clustering**, shadow evaluation, or any autonomous agent behavior. All deferred.
- **Do NOT build multi-user collaboration affordances.** Single-user UI per D15.

## Acceptance criteria

### 1. `/tuning` route + layout shell

- [ ] New Next.js route at `frontend/app/tuning/page.tsx` (and nested routes as needed).
- [ ] Three-region layout at the top level:
  - **Left rail (narrow):** Queue of pending suggestions + chat history list *placeholder* (an empty well with a hairline border and the label "Conversations — coming soon"). The placeholder reserves the seam for sprint 04.
  - **Center (widest):** Detail panel — the selected suggestion's full view (evidence, diff, rationale, accept controls).
  - **Right rail (narrow, collapsible):** Dashboards pane (velocity + graduation). Collapsible so managers can focus on the diff when reviewing.
- [ ] Remove the placeholder in `inbox-v5.tsx`'s `navTab === 'tuning'` branch and replace with a simple nav link to `/tuning`. Keep the existing nav intact.
- [ ] Route is auth-protected (use the existing JWT auth pattern from other pages).
- [ ] Empty state: when no pending suggestions exist, the center panel shows a calm empty state ("All caught up" with a subtle illustration or a single sentence). Not a giant "No data" banner.

### 2. Queue (left rail)

- [ ] Fetches pending `TuningSuggestion` rows for the current tenant from a new or existing endpoint. If the existing list endpoint doesn't filter or shape correctly, extend it additively.
- [ ] Groups suggestions by **trigger event** (each `triggerType` gets a collapsible section header with a count). Legacy rows (null `triggerType`) go into a "Legacy" group at the bottom.
- [ ] Each queue item shows: category pill (derived from `diagnosticCategory`; shows neutral "Edit" for legacy rows), sub-label as muted micro-copy (omit if null), confidence as a small inline bar or numeric (omit for legacy rows), timestamp relative.
- [ ] Click selects the item → populates the center panel. Selection state persists via URL query param (`?suggestionId=...`) for shareable links and browser-back.
- [ ] Keyboard shortcuts: `j` / `k` to move through the queue, `Enter` to focus the detail panel.

### 3. Detail panel (center)

- [ ] Shows: the guest conversation context (last 5-10 messages from the anchor conversation, readable, threaded), the AI's original message, the manager's edited message (if any), and a **unified diff** between them.
- [ ] Diff uses a monospace font, hairline-separated insertions (green-ish tint, restrained) and deletions (red-ish tint, restrained). No line-number column if that crowds the panel; word-level highlighting preferred.
- [ ] Below the diff: the model's **rationale** (prose block, readable typography) and the **proposed change** to the artifact (SOP content, FAQ text, system-prompt delta, tool config).
- [ ] Evidence section (collapsed by default): links out to the full `EvidenceBundle` JSON (a "View evidence" affordance that opens a slide-over or a monospace viewer). Minimum: keys rendered as a tree, expandable.
- [ ] Accept / Reject / Edit controls (see §4).
- [ ] If the suggestion is legacy (null `diagnosticCategory`): the detail view still works — shows the legacy `actionType`, shows the diff if `originalContent`/`proposedContent` are present, hides the rationale/evidence sections cleanly (they don't exist on legacy rows). Accept/Reject still work via the legacy endpoint.

### 4. Accept / Reject / Edit flow

The sprint-02 report handed off three specific constraints here. Resolve them.

- [ ] **Dispatch on `diagnosticCategory`**, not `actionType`. Map each category to the right accept UX:
  - `SOP_CONTENT` and `SOP_ROUTING` — prompt for `sopStatus` (required; dropdown with the 4 known statuses from `backend/src/config/` or wherever the enum lives) and optional `sopPropertyId` (property picker sourced from the existing properties list). Diagnostic did not fill these fields per sprint-02 §7.
  - `FAQ` — accept straight through; the suggestion already carries `faqEntryId` when known, otherwise ask whether to create a new FAQ entry or edit an existing one (search existing by text match).
  - `SYSTEM_PROMPT` — accept straight through; write to `SystemPromptVariant` / `AiConfigVersion` per the existing prompt-versioning flow.
  - `TOOL_CONFIG` — **new backend handler required.** Additive endpoint (e.g. `POST /api/tuning-suggestions/:id/accept-tool-config`) that updates the targeted `ToolDefinition`. UI prompts for the tool (if not pre-filled in the suggestion), shows the proposed diff against the current tool definition, confirms.
  - `PROPERTY_OVERRIDE` — prompt for the property (picker) then route through the SOP-override path.
  - `MISSING_CAPABILITY` — should not appear in the suggestion queue (it lives in `CapabilityRequest`, see §6). If one does appear as a suggestion due to a bug, surface a quiet notice and link to the backlog.
  - `NO_FIX` — should not appear. If it does, treat as legacy and allow reject only.
- [ ] Accept affordance is a single primary button labeled **Apply now**, with a secondary button **Queue** (writes `applyMode='QUEUED'` and keeps status `PENDING`). Per-suggestion manager choice.
- [ ] Edit-then-accept: a third affordance **Edit proposal** opens the diff in an editable monospace editor; on confirm, saves the edited text into `proposedContent` (or the appropriate field) and immediately applies. This is the preference-pair hot path — per D2 pre-wire, write a row to `PreferencePair` with `(context, rejectedSuggestion=original proposed, preferredFinal=edited text)`. This is the first caller of that table; additive write only.
- [ ] Reject asks for a one-line reason (optional, not required) and marks status `REJECTED`.
- [ ] Every accept / reject / apply-now continues to call the existing EMA stats update (sprint 02 already wired this at the controller level — do not re-implement; just verify your new paths go through those endpoints or call the stats update function directly).
- [ ] **48h cooldown message:** if the backend returns a cooldown-blocked error (sprint 02's suggestion writer enforces this at write time, but a manager trying to trigger a reopen may hit it), show it calmly as a one-line banner — not an error modal.

### 5. Version history + rollback

- [ ] A new page `frontend/app/tuning/history/page.tsx` lists recent `AiConfigVersion` / `SopVariant` / `FaqEntry` / `ToolDefinition` edits (last 50) with: artifact type, who authored, when, which suggestion triggered it (link back to the suggestion), a short diff preview.
- [ ] Each row has a **Rollback** affordance that calls the existing version-rollback endpoint (or a new additive one if none exists for the artifact type). Rollback must create a new version (never destroy the current), per the existing `AiConfigVersion` pattern.
- [ ] Rollback is gated behind a confirm dialog with a clear summary of what will change.

### 6. `CapabilityRequest` backlog

- [ ] A new page `frontend/app/tuning/capability-requests/page.tsx` lists `CapabilityRequest` rows for the tenant. One-row-per-request read is enough for V1.
- [ ] Columns: title, short description, rationale (truncated), linked source conversation, status, created-at.
- [ ] Status editor: manager can toggle `OPEN` / `IN_PROGRESS` / `RESOLVED` / `WONT_FIX` via a small inline control. Additive backend endpoint if one doesn't exist.
- [ ] No edit UI for the request body in V1; just triage.

### 7. Dashboards (right rail)

Two quiet, editorial dashboards. Real data only — no mock series.

- [ ] **Tuning velocity** (roadmap V1 signals):
  - Acceptance rate trend per category — consume `GET /api/tuning/category-stats`. Render as a small inline bar per category (one row per category) showing current EMA + count; ordered by volume desc.
  - New-suggestion-type volume — derived from `TuningSuggestion.createdAt` grouped by `diagnosticCategory` over a 14d rolling window. Small sparkline per category, or a single stacked bar — pick whichever reads calmest.
  - Coverage — % of main-AI replies in the last 14d that were sent unedited by the manager. Requires a derived metric; add a read endpoint (additive) at `GET /api/tuning/coverage` that computes it from `ShadowPreview` + sent messages. Render as a single number + trend arrow.
- [ ] **Graduation dashboard** (per-tenant, 14d rolling):
  - Edit rate (% of copilot previews that were edited before send).
  - Edit magnitude (avg `classifyEditMagnitude` score).
  - Escalation rate.
  - Acceptance rate (composite across categories).
  - Add a read endpoint (additive) at `GET /api/tuning/graduation-metrics`. Render as a quiet stat card group — 4 stats, no gauges, no color thresholds unless a value crosses a critical line (then one subtle amber indicator).
- [ ] Both dashboards share a single collapsible panel. Collapse state persists per user (localStorage is fine; this is a view preference, not data).

### 8. Legacy-row handling (cross-cutting)

- [ ] Every UI surface that renders a `TuningSuggestion` must check for null on the new fields and fallback gracefully. Never assume `diagnosticCategory`, `confidence`, `diagnosticSubLabel`, `triggerType`, `evidenceBundleId` are present.
- [ ] Legacy rows do NOT appear in the velocity dashboard's per-category rows (stats are keyed by `diagnosticCategory`, which is null for legacy). That's correct.
- [ ] Legacy rows DO appear in the queue, under a "Legacy" group.

### 9. Backend additions (additive only)

This sprint should add small read/write endpoints, no schema changes. If you find a schema change is necessary, stop and ask.

Expected new endpoints (exact paths at your discretion, document in the report):
- Category-based accept dispatcher — either a new endpoint per category, or extend the existing `/accept` to branch on body params.
- `POST /api/tuning-suggestions/:id/accept-tool-config` (or similar) for `TOOL_CONFIG`.
- `POST /api/tuning-suggestions/:id/apply-mode` or add `applyMode` to the existing accept body.
- `GET /api/tuning/coverage`
- `GET /api/tuning/graduation-metrics`
- `GET /api/capability-requests`
- `PATCH /api/capability-requests/:id` (status update)
- Version-history list endpoint + per-artifact rollback endpoints if missing.

### 10. Accessibility + responsiveness

- [ ] Keyboard navigable throughout — focus states visible but subtle (matches the editorial aesthetic).
- [ ] Responsive down to 1024px. Below 1024px, the right rail collapses by default; below 768px, the left rail becomes a top drawer. Do not ship a mobile-first design — this is desktop-primary.
- [ ] Color contrast passes WCAG AA on text/background.

### 11. Tests + smoke

- [ ] At least one end-to-end click-through smoke (Playwright, Cypress, or a manual script with screenshots): open `/tuning`, see the queue, click a suggestion, see the detail, accept it, see it leave the queue, see the stats tick.
- [ ] Backend unit tests for any new endpoints (happy path + one error case each).
- [ ] Frontend component test for the diff viewer (renders correctly for a known input).
- [ ] `npm run build` passes on both frontend and backend.

## Process notes

- **Spawn a design subagent first.** Before writing UI code, use the Task / Agent tool to spawn a general-purpose agent with the design-direction prompt from the system prompt. Pull its output into `specs/041-conversational-tuning/sprint-03-design-notes.md` for future reference. Do not let the subagent write code.
- **Use frontend skills proactively.** Before each major component (diff viewer, dashboards, accept modal), check your skill list for anything frontend-relevant (`frontend-skills`, `ui-design`, `shadcn-ui`, etc.) and invoke it via the Skill tool.
- **Use shadcn primitives where they exist** (`button`, `dialog`, `dropdown-menu`, `tabs`, `toast`, `tooltip`, etc.) but restyle via Tailwind to match the editorial direction — hairline borders, warm neutrals, restrained accent.

## Commits

Commit per logical unit. No squashing. Suggested sequence (reorder as sensible):

1. `feat(041): scaffold /tuning route with three-region layout`
2. `feat(041): tuning queue (left rail) with trigger-grouped sections`
3. `feat(041): suggestion detail panel with diff viewer`
4. `feat(041): accept/reject flow with category dispatch`
5. `feat(041): edit-then-accept writes preference pair`
6. `feat(041): TOOL_CONFIG accept handler (backend + UI)`
7. `feat(041): version history + rollback page`
8. `feat(041): capability requests backlog`
9. `feat(041): tuning velocity dashboard`
10. `feat(041): graduation dashboard`
11. `feat(041): coverage + graduation-metrics read endpoints`
12. `test(041): tuning surface smoke + component tests`
13. `chore(041): remove legacy tuning placeholder from inbox-v5`

## What to report back

Write `specs/041-conversational-tuning/sprint-03-tuning-surface-report.md` with:

1. **What shipped** — delivered acceptance criteria.
2. **What deviated** — differences from this brief, with reason.
3. **Design decisions** — palette, typography scale, spacing scale, component strategy, reference links if any. Include the design subagent's output summary.
4. **Backend endpoints added** — list with paths, methods, shapes.
5. **Legacy-row handling** — explicit notes on how legacy rows render in each surface.
6. **Schema audit** — confirm no schema changes (or if one was needed, full audit per sprint-01/02 precedent).
7. **Accessibility + responsiveness notes.**
8. **Pre-wired but unused** — anything added that waits for sprint 04 (seam for chat, `PreferencePair` writes are the first caller but no downstream consumer yet).
9. **What's broken / deferred** — known issues, TODOs, anything sprint 04 must handle.
10. **Files touched** — created / modified / deleted.
11. **Smoke test results** — with screenshots or a recorded click-through if possible.
12. **Recommended next actions** — handoff notes for sprint 04 (chat + agent).
13. **Commits** — `git log --oneline feat/041-conversational-tuning ^main`.

## When to ask vs when to just implement

Stop and use AskUserQuestion (or stop and write the report early) when:
- A schema change appears necessary.
- An existing backend endpoint's shape needs breaking changes (not additive) to fit a UI need.
- Version-history rollback touches the main-AI config lifecycle in non-obvious ways.
- An acceptance criterion cannot be met without expansion into sprint 04.

Do NOT ask for:
- Visual/aesthetic choices — pick, document in the report.
- Component file naming.
- Microcopy — write something tasteful.
- Which shadcn primitive to use.
