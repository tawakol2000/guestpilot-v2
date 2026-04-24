# Feature Specification: Studio Agent Screen — Design Overhaul

**Feature Branch**: `046-studio-redesign`
**Created**: 2026-04-24
**Status**: Draft
**Input**: User description: "were gonna do a design overhaul of the studio agent screen, i created a design in claude design for u to implement. now i need you to implement that design and rewire everything there in our current code. use ultrathinking and extreme reasoning becuase this needs u to be creative. there are some features not listed in the design doc, u will need to know what features exist in our current code, and redesign and rewire to the new design in the design doc. everything from color, to layout, to design and UI UX elements will be from the design doc. everything from backend, features, will from our current code. really think this through and make sure it works and looks good."

## Clarifications

### Session 2026-04-24

- Q: Publish button semantics — what does the top-bar Publish invoke? → A: Drop the Publish button from scope; keep the existing per-plan Apply button inside the Plan tab.
- Q: Composer action chips — how should paperclip / Reference / Test behave? → A: Drop paperclip. Reference opens an artifact-picker over existing types (SOPs, FAQs, system prompt, tools, property overrides); selecting one inserts a citation chip into the composer. Test runs the current draft through the Preview tab's existing test-pipeline-runner.
- Q: Left-rail footer property row — switcher or read-only? → A: Read-only. Show the current property glyph + name + operator label with no chevron and no click target. "Property switcher" is out of scope (no per-property session scoping exists today).
- Q: Write-ledger placement in the new right panel → A: Add a fourth admin-only tab "Ledger" alongside Plan / Preview / Tests, visible only when `rawPromptEditorEnabled && isAdmin`. Tab list becomes Plan / Preview / Tests for regular operators and Plan / Preview / Tests / Ledger for admins.
- Q: Dark mode trigger → A: Drop dark mode from this release. Studio renders in the light palette only. The dark-mode token table in the handoff is deferred to a later feature; no OS auto-detect, no manual toggle.
- Q: Top-bar breadcrumb first segment — which scope label? → A: Tenant / workspace name (not a property). Sessions are tenant-scoped and have no `propertyId`, so the breadcrumb reads `{tenant} › Reply agent › {session title}`.
- Q: Tests-tab row-click destination — dedicated drawer, or inline? → A: Inline inside the Tests tab. The tab renders the latest `TestPipelineResultData` as a "TEST SUITE" header (`{run label} · {N} cases`) with per-variant rows (status dot + case name + duration on the right, "—" while running or pending). Row click expands in place using the existing `TestPipelineResult` component. No new drawer; artifact drawer is not reused for test results.
- Q: Preview-tab guest-message input — where is it entered? → A: Dedicated inline input at the top of the Preview tab (a single-line text field + "Send test" button to its right). The input lives entirely inside the right panel's Preview tab and is independent from the Studio composer. The composer's "Test" chip (FR-025b) still works by forwarding the composer textarea contents to this same pipeline and focusing the Preview tab.
- Q: Design-screenshot review (2026-04-24) — post-plan refinements from the rendered handoff → A: Four additions fold into this release (FR-033 LATENCY BUDGET eyebrow + amber warn state for over-threshold latency/cost; FR-033 inline code-pill rendering in preview agent bubbles; FR-041 drawer Accept/Reject footer shown for every artifact opened while a pending plan is active, not just diffs; FR-034 per-variant Re-run chevron in the Tests tab). Two richer ideas (session pin/archive in the left rail; Draft-vs-Published toggle inside the artifact drawer) are deferred to follow-up features so this sprint stays a pure visual + IA overhaul.

## Overview

Studio is the chat-based workspace where a property-management operator talks to an AI "build" agent in natural language to configure the reply-agent that answers guests (system prompt, SOPs, FAQs, tool definitions, property overrides). The current implementation is functionally rich but visually ad-hoc. This feature is a **pure visual + information-architecture overhaul**: every existing backend behavior, tool, artifact type, test-pipeline path, admin surface, propagation flow, and session-persistence rule stays intact — only the shell that renders them changes.

The new design (supplied as a high-fidelity HTML handoff in `/Users/at/Downloads/design_handoff_studio`) reorganizes Studio into a calmer, more opinionated three-panel surface built around a single accent color, Inter Tight typography, a restrained neutral palette, and a right-panel that **tabs** between Plan / Preview / Tests instead of stacking cards vertically.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator configures the reply-agent through chat (Priority: P1)

An operator (hotel / serviced-apartment manager, typically non-technical) opens Studio, types a natural-language request such as "tighten our late check-in replies — shorter, warmer, mention the key box code 4829", and watches Studio's assistant reason, call tools, draft changes to the underlying artifacts (system prompt, SOPs, FAQs), and let them preview + publish the result. The redesigned screen must make this primary loop feel fast, calm, and trustworthy: the operator should always know what the agent is doing, what will change, and what has already been written.

**Why this priority**: This is the entire product. If the overhauled screen does not support the full chat → reason → call tool → draft artifact → preview → approve → publish loop at parity with today's Studio, the release is a regression, not an improvement.

**Independent Test**: A new operator lands on Studio, sends a single tuning request, and is able to (a) see the agent think, (b) see tool-calls stream as they happen, (c) click an inline artifact reference and read the draft, (d) send a test message to the preview reply-agent, (e) approve the plan, (f) see the propagation banner confirm the publish. No feature regressions vs. today's Studio.

**Acceptance Scenarios**:

1. **Given** a signed-in operator with at least one property, **When** they open Studio for the first time in a session, **Then** they see the three-panel layout (left rail 260px, center conversation, right panel 340px) with the new design tokens applied (Inter Tight, `#0a5bff` accent, `#fafafa` rails, `#ffffff` canvas) and the right panel defaults to the **Plan** tab.
2. **Given** the operator sends a tuning request, **When** the assistant streams its reply, **Then** a reasoning toggle appears above the body, tool-call rows flip from running → done with duration readouts as events arrive, inline artifact reference cards render, and a blinking cursor + status-text progress indicator is visible until the turn finishes.
3. **Given** an assistant turn includes an inline artifact reference, **When** the operator clicks it, **Then** the artifact drawer slides in from the right over the right-panel tab content, shows the artifact's kind / title / file path / body (or diff), and focus returns to the clicked card when the drawer closes.
4. **Given** the operator clicks the per-plan Apply button inside the Plan tab while a draft plan exists, **When** the apply completes, **Then** the propagation banner appears above the conversation and the Plan tab reflects the new applied state. (The design's top-bar Publish button is out of scope — see Clarifications.)

---

### User Story 2 - Operator follows agent progress in the right panel (Priority: P1)

The right panel replaces today's stacked vertical rails (state snapshot + session artifacts + recent test + write ledger + admin gear buttons) with a **tabbed** surface: **Plan**, **Preview**, **Tests**. The operator uses the Plan tab to watch the live task checklist for the current agent turn, the Preview tab to send a one-off test message through the draft reply-pipeline and see the produced reply (with latency / tokens / cost readouts), and the Tests tab to see the last test-pipeline-runner results. All three tabs must be reachable without scrolling, and the panel must collapse to a 40px strip on narrow viewports.

**Why this priority**: The existing right rail has grown into a scroll-bloated stack that operators miss. The tabbed layout is the single biggest information-architecture improvement in this overhaul; without it, the redesign's promise of "calmer and more trustworthy" is not delivered.

**Independent Test**: An operator runs one tuning turn. The Plan tab progress bar animates as tasks complete. They click Preview, send a test guest message, and see the reply-agent bubble render with latency/tokens/cost. They click Tests and see the latest run rendered as a test suite with per-variant case rows (status dot + case name + duration + Re-run chevron). They collapse the panel and re-expand it; state is preserved.

**Acceptance Scenarios**:

1. **Given** an in-flight agent turn, **When** tasks are emitted / completed, **Then** the Plan tab shows the task checklist with per-row status dots (done / running / pending), a live progress bar ("N/M" + percentage), and a "Context in use" list of the artifact files the agent is currently reading from.
2. **Given** the operator is on the Preview tab, **When** they type a guest message and click "Send test", **Then** a preview conversation renders the guest bubble (right-aligned, surface-2 background) and the draft reply-agent bubble (left-aligned, blue-tint background with the accent border), followed by a latency/tokens/cost 3-card row.
3. **Given** the operator is on the Tests tab, **When** they arrive, **Then** the latest test-pipeline run renders as a test-suite view — a `TEST SUITE` header with the run title and `· {N} cases`, followed by per-variant case rows (status dot + case name + right-aligned duration). Clicking a row expands it inline using the existing `TestPipelineResult` component (pipeline output + judge verdict + rationale).
4. **Given** the panel is expanded at 340px, **When** the operator clicks the collapse chevron, **Then** the panel animates to a 40px strip showing a single expand button, and the center pane flex-grows to absorb the space.

---

### User Story 3 - Operator navigates sessions via the redesigned left rail (Priority: P2)

The left rail (260px) becomes a proper chat-history sidebar rather than a bare session list. Top to bottom: a **brand row** (Studio + model name), a **search input** (filters the list by title substring), a **"New chat" button**, a **grouped list** with section labels ("Recent", "Earlier") and a per-row `{tenant} · {relative updated time}` meta (sessions are tenant-scoped, so the first meta segment is the workspace / tenant name — not a property), and a **read-only footer property row** (hotel glyph + property name + count + operator label; no chevron, no click target). Empty and loading states follow the same visual language.

**Why this priority**: Session discoverability is already a pain point (the current rail hides titles, has no search, and groups nothing). But it does not block the primary tuning loop, so it is P2 behind US1/US2.

**Independent Test**: Operator with 12+ sessions can type a partial title into search and see the list filter live. They click "New chat" and land in an empty session. They see a "Recent" group (last 7 days) and an "Earlier" group below it. The footer property row renders read-only with the correct property name.

**Acceptance Scenarios**:

1. **Given** the operator has 5+ sessions, **When** they open Studio, **Then** the left rail renders a brand row, search input, "New chat" button, and the list is grouped into "Recent" (updated within the last 7 days) and "Earlier", each row showing title / `{tenant} · {relative time}` meta (first segment is the tenant / workspace name; sessions are tenant-scoped and have no `propertyId`), with the active session highlighted (`--surface-2` bg, `--ink` + 500-weight title).
2. **Given** the operator types "late" into the search input, **When** the input debounces, **Then** only sessions whose title contains "late" (case-insensitive) remain visible.
3. **Given** the operator has zero sessions, **When** the rail renders, **Then** an inline empty state is shown ("No sessions yet" + "New chat" CTA) using the design's empty-state treatment.
4. **Given** an empty session is selected, **When** the center pane renders, **Then** the empty-state illustration (48px blue-soft message icon + "Start a new thread" + subtext + ink-filled "Back" button) is centered in the message scroll area.

---

### User Story 4 - Admin and power-user surfaces remain reachable (Priority: P2)

Today's Studio exposes admin-only surfaces (agent-trace drawer, raw-system-prompt drawer, write-ledger card) and a capabilities-gated Apply / Revert flow. None of these are called out in the design doc. The redesign must preserve every one of them — rewired into the new shell so they remain **one click away** for admins and **invisible** for non-admin operators.

**Why this priority**: These surfaces are load-bearing for the internal team but low-frequency for tenants. They must not be removed, but they do not need front-row real estate. Routing them through an admin overflow menu or a utility area of the right panel is acceptable as long as visibility parity holds.

**Independent Test**: Sign in as an admin tenant → every admin surface present today is reachable within two clicks; verdict/rationale still renders in the artifact drawer when opened from the ledger. Sign in as a non-admin tenant → none of these surfaces are visible.

**Acceptance Scenarios**:

1. **Given** a tenant with `isAdmin: true` and `traceViewEnabled: true`, **When** Studio renders, **Then** an "Agent trace" entry point is present (as a utility button within the right panel or an overflow menu) and opens the existing trace drawer.
2. **Given** a tenant with `isAdmin: true` and `rawPromptEditorEnabled: true`, **When** Studio renders, **Then** a "Raw system prompt" entry point is present and opens the existing raw-prompt drawer.
3. **Given** the tenant is an admin, **When** a ledger row is present for the current conversation, **Then** the write-ledger surface is reachable and its rows still drive the artifact drawer's verification/rationale section on click, and the revert flow still runs its two-step preview+confirm.
4. **Given** the tenant is not an admin, **When** Studio renders, **Then** no admin entry points are visible anywhere in the UI.

---

### User Story 5 - Responsive reflow (Priority: P3)

The doc specifies that the right panel collapses fully on narrow viewports and the left rail goes off-canvas below ~900px. Studio is a desktop-first tool — the primary user path is a laptop or external monitor — but the first tablet-sized window should not visually break.

**Why this priority**: No operator is going to configure their reply-agent from a phone, but the surface should still degrade gracefully at ~900px (tablet). Dark mode is out of scope — see Clarifications.

**Independent Test**: Resize the window below 900px → left rail goes off-canvas with a hamburger-style toggle, right panel collapses to 40px strip. Resize up to 1440px+ → all three panels render at spec widths with no horizontal scroll.

**Acceptance Scenarios**:

1. **Given** the viewport is below 900px, **When** Studio renders, **Then** the left rail collapses behind an off-canvas toggle and the right panel defaults to collapsed (40px strip).
2. **Given** the viewport is at 1440px+, **When** Studio renders, **Then** all three panels render at their specified widths (260 / flex / 340) with no horizontal scroll.

---

### Edge Cases

- **Long artifact titles / file paths**: the artifact reference card subtitle and the drawer header title MUST truncate with an ellipsis and expose the full string on hover (title attribute), never wrap into a second line.
- **Very long assistant turns**: the conversation column is capped at 780px; turns with many tool-calls must not push the composer off-screen — the message area MUST scroll, not the whole page.
- **Streaming tool-call that never completes** (timeout, transport drop): the row MUST eventually resolve to its stream-close state as dictated by the existing SSE pipeline — no new client-side watchdog, timeout, or retry affordance ships in this release. A dedicated retry UX is a follow-up feature outside 046's pure-redesign scope.
- **Clarifying question answered, then the turn is retried**: per design, selecting one option locks the others to opacity 0.45 with `cursor: default`. If the turn is discarded and re-run, a fresh clarify card MUST be unlocked again — previous locks must not persist across turns.
- **Session with zero messages older than 1 hour**: continues to be hidden behind the existing "Show empty sessions" toggle in the left-rail footer; the new grouped ("Recent" / "Earlier") structure MUST still respect this filter.
- **Admin flags toggle mid-session**: if `/api/build/capabilities` returns `isAdmin: false` after a page-load that had `true`, the admin entry points MUST hide on next render; no stale drawers should remain open.
- **Artifact drawer opened for a reverted artifact**: MUST still render (read-only) and the rationale card above the diff MUST show the REVERT row's metadata.
<!-- Dark-mode edge case removed — dark mode is out of scope (see Clarifications). -->

## Requirements *(mandatory)*

### Functional Requirements

#### Layout & design system

- **FR-001**: The Studio screen MUST render a three-panel layout matching the design: a 260px fixed left rail, a flex-1 center conversation column, and a 340px fixed right panel (collapsible to 40px). Widths MUST match the design doc exactly.
- **FR-002**: All UI surfaces MUST use the design-token palette from the design doc (canvas `#ffffff`, surface `#fafafa`, surface-2 `#f4f5f7`, surface-3 `#eceef2`, border `#e7e8ec`, border-strong `#d7d9df`, ink `#0a0a0b`, ink-2 `#2a2b30`, muted `#6b6d76`, muted-2 `#9b9ea6`, blue `#0a5bff`, blue-hover `#004fe8`, blue-soft `#eaf1ff`, blue-tint `#f4f7ff`, green `#16a34a`, amber `#d97706`, red `#dc2626`). No ad-hoc hex values outside this palette.
- **FR-003**: The UI MUST use Inter Tight (300/400/500/600/700) for all interface text and JetBrains Mono (400/500) for file paths, diffs, code, and numeric readouts, at a 14px base and 1.5 line-height with `letter-spacing: -0.005em` globally.
- **FR-004**: Border radii, shadows, icon stroke weight, and scrollbar treatment MUST follow the design doc (radii 7/8/10–12/14, shadows small/medium, icon stroke `1.6px` at 16px, 10px scrollbar with `#e2e3e8` thumb).
- **FR-005**: Dark mode is **out of scope** for this release. Studio MUST render in the light palette only. The dark-mode token table from the design handoff is archived for a later feature; no OS auto-detect, no manual toggle, no dark-specific styles ship in this change.

#### Left rail

- **FR-010**: The left rail MUST include, top-to-bottom: brand row (glyph + "Studio" + "Sonnet 4.6" sublabel + "+" icon button), search input, "New chat" ink-filled button, chat list grouped into "Recent" (updated within the last 7 days) and "Earlier" sections, and a footer property row.
- **FR-011**: Each chat row MUST render a title (ellipsized), a meta line `{tenant} · {relative updated time}` (tenant / workspace name as the first meta segment — sessions have no `propertyId`), and reflect active / hover states per the design doc.
- **FR-012**: The search input MUST filter the chat list live (case-insensitive title substring match) with ≤150ms debounce.
- **FR-013**: The "New chat" button MUST create a new Studio session via the existing conversation-create endpoint, select it, and land the operator in an empty-state center pane.
- **FR-014**: The existing "Show empty sessions" toggle MUST continue to hide zero-message sessions older than one hour unless enabled, and MUST live in the rail footer (above the property row or as a small secondary control).
- **FR-015**: The footer property row MUST be a **read-only status row** showing a property glyph (hotel icon on blue-soft square), the current property name (13/500), and a `"{N} properties · operator"` sublabel (11 `--muted`). It MUST NOT render a chevron, MUST NOT be clickable, and MUST NOT open any picker — the design's "property switcher" affordance is out of scope (no per-property session scoping exists).
- **FR-016**: Below 900px viewport width, the left rail MUST collapse behind an off-canvas toggle.

#### Center — conversation

- **FR-020**: The center pane MUST include a top bar (48px) with a breadcrumb `{tenant} › Reply agent › {session title}` (tenant / workspace name as the first segment — sessions are tenant-scoped, not per-property) and a **Draft** environment pill (amber dot + label). The design's top-bar Publish button is explicitly **out of scope** — the existing per-plan Apply button continues to live inside the Plan tab and drives the existing `onPlanApproved` flow + `PropagationBanner` unchanged.
- **FR-021**: The message scroll area MUST center a 780px max-width column with 36/24/24 padding and 28px gap between messages.
- **FR-022**: User messages MUST render as right-aligned ink-filled bubbles (max 85% width, 14px radius with 6px bottom-right "tail", 14.5px white text) with an 11px muted-2 timestamp below.
- **FR-023**: Assistant messages MUST render a header row (24×24 avatar + "Studio" + timestamp) and a body column with 32px left padding.
- **FR-024**: The assistant body MUST support the full block set from the design doc:
  - reasoning toggle (collapsed → "Thought for Ns"; expanded → left-bordered indented steps),
  - body text (15px / 1.6 / --ink-2, 680px max-width),
  - tool-call row (status dot + label + target + running progress track or done duration) with optional expandable I/O block,
  - artifact reference card (clickable, opens the drawer),
  - inline diff card (filename + section + +N/−N counts + colored add/remove/context lines + "Show N more" toggle + "Open full diff →" link),
  - clarifying-question card (radio options, lock-on-select behavior),
  - streaming progress status (blinking 7×14 blue cursor + status text).
- **FR-025**: The composer MUST be a single rounded card (14px radius, 1px `--border-strong`, small shadow) centered at 780px max-width containing: textarea (auto-grow 26→160px), left-side chips (**"Reference"** with file icon, **"Test"** with flask icon — the design's paperclip chip is out of scope, there is no file-attachment pipeline), right-side send button (30×30, blue when active / surface-3 when disabled), and a 11px foot line `"Studio · Sonnet 4.6 · Edits are drafts until you publish"`.
- **FR-025a**: The **Reference** chip MUST open an artifact-picker popover listing the tenant's existing artifacts — SOPs, FAQs, system prompt, tool definitions, and property overrides — filterable by title / id. Selecting an entry MUST insert a citation chip into the textarea at the current cursor position using the existing citation-chip format (reusing `citation-chip.tsx` / `citation-parser.ts`).
- **FR-025b**: The **Test** chip MUST submit the textarea's current contents to the existing Preview tab test-pipeline-runner, switch focus to the Preview tab, and render the result there. It MUST NOT send the message to the assistant; the composer's textarea is preserved unchanged after the test returns.
- **FR-026**: Enter MUST send; Shift+Enter MUST insert a newline. Sending MUST append the user bubble and an assistant scaffold immediately, and auto-scroll to the bottom smoothly.

#### Right panel

- **FR-030**: The right panel MUST be organized as a tab bar (Plan / Preview / Tests — plus a fourth **Ledger** tab for admins only, per FR-036), collapsible to 40px via a `panel-right` icon button in the tab bar. The Ledger tab MUST be visible only when `isAdmin && rawPromptEditorEnabled`; all other tabs are visible to every operator.
- **FR-031**: The **Plan** tab MUST show a `CURRENT PLAN` label, the plan title, an `N/M` fraction + progress bar + percentage, the task list (checkbox + label + optional sub-label + 2-digit step number), a thin divider, and a `CONTEXT IN USE` list of artifact files, all driven by today's plan/checklist data source. The `CONTEXT IN USE` list MUST be derived from `sessionArtifacts` filtered to entries touched during the **current session** (any `action` — created / modified / reverted — since `sessionStartIso`), newest-first, capped at the top N entries (N = 5). The existing `SessionArtifact.action` enum does NOT include a "read" value, so the list surfaces *touched* artifacts; a future feature may add a `read` action if a true read-context view is required.
- **FR-032**: Task checkbox states MUST be done (blue-filled circle, white check), running (blue spinner), or pending (1.5px dashed ring). When a task's status changes (driven by agent SSE events — the operator cannot manually toggle task status), the progress bar MUST re-animate over 400ms ease-out. Completed tasks MUST strike through their label.
- **FR-033**: The **Preview** tab MUST show, top-to-bottom:
  1. A `REPLY AGENT PREVIEW` eyebrow header with the model name + `draft` env tag.
  2. A **dedicated inline test-message input** — a single-line text field (placeholder e.g. *"Type a guest message to test…"*) with a `Send test` button to its right (1px border, play icon). The input lives entirely inside the Preview tab and is independent of the Studio composer; it does NOT share state with the center-pane textarea.
  3. A preview conversation area rendered after a test completes: guest bubble right-aligned in `--surface-2` / 13px `--ink-2`; agent bubble left-aligned in `--blue-tint` with 1px `rgba(10,91,255,0.15)` border. Inline **code pills** MUST render for any `\`backtick-wrapped\`` token the reply contains (e.g. lockbox codes, WiFi passwords, reservation ids) using `--blue` text on `--blue-soft` background, mono 12.5px, 4px radius, `2×5` padding.
  4. A **`LATENCY BUDGET`** eyebrow label (10.5px/600/uppercase/`--muted-2`) above a 3-card readout row: REPLY (latency in s), TOKENS (integer count), COST (dollar amount). Each card is 10×11 padding, 1px border, 8px radius, 15/500 number + 10.5 uppercase label. When a threshold is crossed, the relevant card tints amber (`--amber` foreground, `--warnBg` background) and its aria-label MUST carry the warning — thresholds: `REPLY > 2s`, `COST > $0.01`. No warning state for TOKENS in this release.

  Clicking `Send test` MUST drive the existing test-pipeline-runner service (no new endpoint). The composer's `Test` chip (FR-025b) MUST forward the current composer-textarea contents into this same input, focus the Preview tab, and fire the same pipeline.
- **FR-034**: The **Tests** tab MUST render the latest `TestPipelineResultData` as a **test suite** view:
  - header strip: `TEST SUITE` eyebrow label (10.5px/600/uppercase/`--muted-2`) + run title + `· {N} cases`;
  - one **case row** per variant — compact white card (1px border, 8px radius, `8×10` padding, flex gap 10): status dot (done = blue check circle, running = blue spinner, pending = 1.5px dashed ring) · case name (13px `--ink-2`) · right-aligned duration mono 11.5 (`{n}s` when done, `—` when running or pending) · a **Re-run chevron** icon button (14×14, `--muted` → `--ink` on hover) that MUST be visible only when the row's variant has a verdict (done, passed/failed/errored) and MUST fire a single-variant re-run through the existing `apiRunTestPipeline` with a `{ onlyVariant: id }` argument — reusing the same pipeline, no new endpoint;
  - newest-first ordering.
  Row click MUST expand the row **in place** inside the Tests tab using the existing `TestPipelineResult` component (pipeline output + judge verdict + rationale). The Re-run chevron click MUST NOT toggle the expansion (stop propagation). The artifact drawer MUST NOT be reused for test results, and no new drawer MUST be introduced.
- **FR-035**: Admin-only utility entry points (agent trace, raw system prompt) MUST be reachable from the right panel — either as compact utility buttons pinned to the bottom of the right panel (below the active tab) or through an overflow menu — and MUST be invisible for non-admin tenants.
- **FR-036**: The write-ledger (admin) MUST live in a dedicated **Ledger** tab that appears as the fourth tab in the right-panel tab bar when `isAdmin && rawPromptEditorEnabled`. The Ledger tab MUST render the existing `WriteLedgerCard` (or its redesigned equivalent) with the current row-click → artifact drawer (verification / rationale) and row-revert → two-step preview+confirm interactions preserved byte-for-byte. For non-admin tenants the tab MUST NOT render in the tab bar at all (no disabled stub).

#### Artifact drawer

- **FR-040**: The artifact drawer MUST slide in from the right over the right-panel tab content with a 200ms ease-out translate+fade transition.
- **FR-041**: The drawer MUST include a header (icon + kind label + title + copy + close), a file-path sub-strip in mono, a scrollable body, and a footer with `Reject` (ghost) + `Accept` (blue primary with check icon) buttons. The footer MUST render whenever the drawer is opened **while the current session has at least one unapplied pending change** (regardless of whether the drawer target is a diff or a plain SOP/FAQ/prompt/tool/property view) — this lets the operator accept or reject the pending plan from any artifact lens, matching the handoff screenshots. When no pending change exists for the current session, the footer MUST be hidden (drawer is pure read mode). Accept invokes the existing per-plan apply path; Reject invokes the existing reject path. Both preserve focus return to the opener on close.
- **FR-042**: The drawer MUST render both SOP-kind bodies (headings + paragraphs) and diff-kind bodies (two stacked before/after columns with mono `<pre>` blocks; "After" column uses `--blue-tint` bg).
- **FR-043**: The drawer MUST still support opening with a specific `scrollToSection` (e.g. the existing `"verification"` target used by ledger and test-pipeline-result chips) and still render the rationale card above the diff when opened from a ledger row.
- **FR-044**: Closing the drawer MUST return focus to the element that opened it.

#### Behavioral preservation (existing features the design doc does not call out)

- **FR-050**: Session auto-naming MUST continue to work: first substantive user message auto-renames the session (first-write wins); fallback to first artifact touched; operator edits always take precedence.
- **FR-051**: The streaming reasoning line MUST continue to deduplicate per-turn (no two identical reasoning steps render consecutively).
- **FR-052**: The tenant-state banner (GREENFIELD / BROWNFIELD detection) MUST continue to drive the Plan tab header copy and the composer placeholder in greenfield sessions.
- **FR-053**: The propagation banner MUST continue to render above the conversation on `onPlanApproved` and be dismissible.
- **FR-054**: SSE streaming of reasoning, tool-call status, artifact refs, and clarifying questions MUST be the only source of truth driving the center pane — no hidden polling, no client-side reconstruction from full-response payloads. (The current Studio uses SSE only; an alternative transport is out of scope.)
- **FR-055**: Property / conversation switching MUST preserve the right-panel tab selection and collapse state within a session mount.
- **FR-056**: The existing empty-sessions filter, auto-naming state, and `createdIdsRef` loop-guard behavior MUST remain intact.

#### Accessibility & input

- **FR-060**: All interactive elements MUST be keyboard-reachable, expose aria labels, and respect focus rings (visible focus state on the blue accent or default UA ring).
- **FR-061**: Clarifying-question options MUST be a keyboard-operable radio group (arrow keys move selection; Enter locks).
- **FR-062**: The composer MUST expose `aria-label="Studio chat composer"` and the send button MUST have an `aria-label` that reflects its enabled/disabled state.
- **FR-063**: Tab-bar buttons MUST have `role="tab"` + `aria-selected` semantics and support arrow-key navigation.

### Key Entities *(include if feature involves data)*

- **Studio session (tuning conversation)**: existing `TuningConversation` — left-rail list items, each with a title (auto-named or operator-edited), property context, last-updated timestamp, message count. Unchanged.
- **Message**: existing `TuningConversationMessage` — role + parts; parts drive the block renderers (reasoning / tool / artifact-ref / diff / clarify / text).
- **Tenant state**: existing `BuildTenantState` — drives the Plan tab header, the greenfield / brownfield banner, and the initial state snapshot (system-prompt status, SOP count, FAQ counts, custom-tool count, last build session).
- **Session artifact**: existing `SessionArtifact` — written by the agent during a turn, rehydrated from `/api/build/session-artifacts`. Surfaces both as inline artifact-ref cards in the conversation and as the source of the Plan tab's `CONTEXT IN USE` list.
- **Write ledger row**: existing `BuildArtifactHistoryRow` — admin-only; drives the in-tab admin ledger and the artifact-drawer verification/rationale section on open.
- **Test-pipeline result**: existing `TestPipelineResultData` — drives the Preview tab's latest-result readout and the Tests tab's full history list.
- **Capabilities**: existing `BuildCapabilities` — `isAdmin`, `traceViewEnabled`, `rawPromptEditorEnabled`. Gate every admin surface.

## Assumptions

- **A-1**: "Studio agent screen" refers to `frontend/components/studio/StudioSurface` (mounted inside `inbox-v5.tsx` at `navTab === 'studio'` / `navTab === 'tuning'`). No other screen in the app is in scope.
- **A-2**: "From our current code" means every feature surfaced by today's `StudioSurface`, `StudioChat`, `ArtifactDrawer`, `WriteLedgerCard`, `StateSnapshotCard`, `SessionArtifactsCard`, `TraceDrawer`, `RawPromptDrawer`, and the block renderers in `studio/chat-parts.*`. All of those remain in scope as **component modules** — no files are deleted. Some render sites move: `StateSnapshotCard` data feeds the Plan tab header; `SessionArtifactsCard` is retired from the right rail (artifacts surface as inline artifact-ref cards in the conversation + in the Plan tab's `CONTEXT IN USE`); `WriteLedgerCard` moves into the admin-only Ledger tab. See research.md R9 for the full retirement map.
- **A-3**: The design doc's "Preview" tab maps to the existing test-pipeline-runner service (`backend/src/build-tune-agent/preview/test-pipeline-runner.ts`) — "Send test" sends a single guest message through the draft reply-pipeline (bypassing caches per the existing implementation) and renders its reply.
- **A-4**: The design doc's "Tests" tab renders the latest `TestPipelineResultData` as a single **test suite** (per-variant case rows) — it is NOT a history of past runs. A persistent run-history list is out of scope for 046; a future feature may layer that on top. Mapping reads from the latest entry in the current `testResults` state.
- **A-5**: The design doc's "Plan" tab is backed by today's plan/checklist part events (`data-plan-checklist`-shaped parts + artifact-touched events). `CONTEXT IN USE` is derived from the session-artifacts list filtered to files the agent read from during the current turn.
- **A-6**: The design doc mentions `Sonnet 4.6` as the assistant model label; no model change is part of this feature — the label copy is purely visual.
- **A-7**: Admin-only surfaces (trace / raw prompt / write-ledger) are not redesigned from scratch — they continue to open their existing drawers. Only their entry points are rewired to the new shell.
- **A-8**: Font loading uses `next/font/google` (Inter Tight + JetBrains Mono) — self-hosted at build time, zero runtime network fetch. `display: swap` + system-sans / system-mono fallback stack guarantee no layout shift during load.
- **A-9**: The feature is shipped **in place** — it replaces the current `StudioSurface` render tree rather than living behind a feature flag. If a staged rollout is later desired, a build-time flag can gate the new shell without affecting the spec.
- **A-10**: No schema changes, no backend endpoint changes, no AI-pipeline changes. This is a frontend-only redesign.

## Deferred (intentionally out of scope for 046)

The following ideas surfaced during design-screenshot review and are explicitly deferred to follow-up features so this sprint stays a visual + IA overhaul:

- **Session pinning + archiving** on the left-rail rows. Becomes load-bearing once a tenant accumulates 100+ sessions; not in the current handoff; queue for a follow-up feature together with cross-session search (title + body + artifact).
- **Draft-vs-Published toggle inside the artifact drawer**. The current drawer renders a two-column Before / After on pending diffs (spec FR-042). A true three-way view (live published · draft proposed · currently-staged) is a separate feature and requires additional API work to fetch the published snapshot on demand.
- **Per-property session scoping**. The left rail's row meta currently shows only session age; a future feature can introduce optional `propertyId` on sessions and use the footer property row as a real switcher.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can send a tuning message and see the first assistant token (reasoning header) render within 500ms of stream start — no slower than today's Studio.
- **SC-002**: Zero regressions in the existing Studio behavior matrix: 100% of today's `__tests__/*.test.tsx` in `frontend/components/studio/` and `frontend/components/build/` continue to pass, with only the adaptations required for renamed / moved selectors.
- **SC-003**: Operator task-completion benchmark: a new operator, given a 1-sentence tuning request, can complete the full loop (send → read agent reasoning → open one artifact → run one preview → apply the plan) in under **90 seconds** on a 1440×900 laptop — measured against today's Studio as a baseline and expected to improve by ≥20%. (The design's top-bar "publish" verb is out of scope per Clarifications Q1; "apply" is the per-plan action retained in the Plan tab.)
- **SC-004**: Time-to-find for the last test-pipeline result (opening Studio, locating the most recent test result): under 5 seconds (via the Tests tab), down from the current >15 seconds of scrolling the right rail.
- **SC-005**: Design conformance: a visual audit against the high-fidelity HTML handoff finds no deviations greater than 2px in spacing, 1 step in the design-token palette, or ±1 unit in border-radius / stroke weight — across all seven block types, the tab bar, the drawer, and both rails.
- **SC-006**: Accessibility: axe-core automated scan reports zero WCAG AA violations across Studio's three panels (center, left, right), the artifact drawer, and the composer. Keyboard-only navigation can traverse every interactive surface.
- **SC-007**: The redesigned screen renders without horizontal scroll between 900px and 1920px viewport width, and gracefully reflows (left-rail off-canvas + right-panel collapsed) below 900px.
- **SC-008**: *(dropped — dark mode is out of scope per Clarifications)*
- **SC-009**: Admin-surface visibility: a matrix test across `{isAdmin: true|false} × {traceViewEnabled: true|false} × {rawPromptEditorEnabled: true|false}` confirms every admin entry point is visible iff today's Studio would show it, and invisible otherwise.
- **SC-010**: No feature regression in the AI pipeline: the pre/post redesign comparison for a fixed tuning corpus (10 scripted prompts) produces byte-identical tool-call traces and artifact writes — the redesign is provably pure-frontend.
