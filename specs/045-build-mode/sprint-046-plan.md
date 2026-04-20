# Sprint 046 — Build/Tune Refinement Plan

> Input: `sprint-046-issues.md` (source-of-truth raw issues) + sprint-045
> deploy + four screenshots of the live `/build` surface.
>
> Output of this doc: the committed plan for sprint 046. Every issue in
> the issues file is resolved below or explicitly deferred with
> rationale. No silent drops.
>
> Author: Abdelrahman + agent. Date: 2026-04-20.

---

## 0. TL;DR

Sprint 045 shipped the unified BUILD+TUNE agent backend (it works, it's
cacheable, it's mode-gated). It also shipped a `/build` frontend that
reads as a different product — violet palette, its own ActivityBar, no
main-app chrome, a separate chat surface from the existing `/tuning`
and `/tuning/agent` routes.

Sprint 046 fixes the "it's not integrated" problem on three axes at
once:

1. **Structural.** Collapse `/build`, `/tuning`, `/tuning/agent` into
   one `/studio` surface that lives inside the main GuestPilot shell
   (the `inbox-v5.tsx` tab strip), inherits the main-app palette
   (`#0A0A0A` ink, `#FFFFFF` canvas, `#0070F3` accent), and reuses the
   existing top-nav.
2. **Agent.** Ground the agent in the actual artifact text (not
   counts), enforce a card-first response contract, triage to the
   single highest-leverage finding first, honour rejection memory.
3. **UX.** Suggested fixes render as diff cards with inline accept /
   reject, questions render as choice chips (not prose), audits render
   as compact row-cards with per-row actions, reasoning collapses to a
   single muted line.

Backend is mostly unchanged. The work is concentrated on:

- (a) new `get_current_state` tool + forced first-turn call
- (b) response-contract rewrite in the shared system-prompt prefix
- (c) four new SSE part types + four new React card components
- (d) one main-app tab, one shell deletion (`/build`, `/tuning`,
   `/tuning/agent` all redirect)
- (e) deletion of the 48h cooldown block (demoted to an advisory
   toast — manager-driven editing does not need an autopilot-era
   safety net)

---

## 1. Acceptance criteria (user-outcome terms, not gates)

Sprint 045 was scored on "did we ship card X" — wrong frame. Sprint 046
is scored on whether these four outcomes hold end-to-end, by a real
operator on a real tenant, with nothing open but the main GuestPilot
app:

- **AC-1. Ten-minute greenfield.** A manager on a fresh tenant can
  click the `Studio` tab, type "help me set this up", and reach a
  working system prompt + 3 SOPs + 3 FAQs in under 10 minutes. They
  never leave the main app shell, they never type a question that
  should have been a button, and they never stare at more than 120
  words of prose in one agent turn.
- **AC-2. Brownfield audit → one fix.** On an existing tenant,
  "review my setup" returns (a) a short triage summary naming the
  single highest-leverage fix, (b) a Suggested Fix card with
  before/after diff and accept/reject inline, (c) nothing else until
  the manager asks. No wall of markdown, no numbered list of 18
  recommendations.
- **AC-3. Smart targeting.** Every proposed edit carries a
  machine-readable target (`artifact`, `slot`, `section` or
  `line-range`). The card renders the target as a chip. "Update the
  system prompt" without a target is a lint error caught by a tool
  post-condition, not a UX problem.
- **AC-4. No re-proposing rejected fixes.** If a manager dismisses a
  Suggested Fix in session X, the agent does not re-propose a
  semantically-equivalent fix later in session X. (Cross-session
  memory is deferred to sprint 047; session memory is required.)

Each AC maps to a specific test in `specs/045-build-mode/tests/` (to
be authored alongside the work). Shipping means all four pass on a
dry-run of a staging tenant with a human operator — not on unit
tests alone.

---

## 2. What we keep / retire / rewrite

### Keep as-is

- `backend/src/build-tune-agent/runtime.ts` — SDK session loop, turn
  flags, resume/recovery logic. Solid.
- `backend/src/build-tune-agent/stream-bridge.ts` — SDK message →
  UIMessageChunk mapping. Add four new data-part passthroughs, don't
  rewrite.
- `backend/src/build-tune-agent/tools/plan-build-changes.ts` — works.
  Extend item schema with a `target` field (see §5.3).
- `backend/src/build-tune-agent/tools/build-transaction.ts` — atomic
  rollback machinery. Untouched.
- BuildTransaction rollback UI (`plan-checklist.tsx`) — UX is fine,
  only needs re-tokenised to main-app palette.
- Tenant-state interview progress memory keys
  (`session/{conversationId}/slot/{slotKey}`) — solid mechanic.

### Retire (delete, not rewrite)

- `frontend/app/build/page.tsx` — custom `ActivityBar`, custom
  `LeftRail`, custom header, custom chat. All of it goes. The route
  stays for one sprint as a 302 redirect → `/#studio`, then is
  deleted.
- `frontend/app/tuning/page.tsx` — queue + detail-panel + chat-panel
  combo. Queue moves into `/studio` as a right-rail; detail-panel
  moves into the same shell; chat-panel unified with build chat.
  Route 302s → `/#studio?conversationId=…`.
- `frontend/app/tuning/agent/page.tsx` — direct system-prompt editor
  (OpenAI-platform-style). Operator-facing managers don't need a
  direct editor; they have the conversational agent. Advanced
  developer prompt-editing stays available under
  `/#studio/raw-prompt` (admin-only, hidden toggle), but the top-
  level route dies.
- `backend/src/build-tune-agent/hooks/pre-tool-use.ts` —
  **cooldown block only.** The rest of the hook (rollback
  compliance, oscillation logging) is retained as observability.
  Cooldown itself is removed; oscillation becomes a `data-advisory`
  SSE part (non-blocking warning chip), not a deny.
- `backend/src/build-tune-agent/hooks/shared.ts:COOLDOWN_WINDOW_MS`
  — constant deleted.
- `backend/src/tuning-agent/index.ts` — the back-compat re-export
  shim. Callers migrate; shim deleted in the same sprint.
- `frontend/components/tuning/tokens.ts` — replaced by
  `frontend/components/studio/tokens.ts` (main-app-aligned). Violet
  is gone.

### Rewrite (same file, new contents)

- `backend/src/build-tune-agent/system-prompt.ts` — shared prefix
  gets a new **Response Contract** section (see §4.1). Mode
  addendums get a **Triage Rules** section. The DYNAMIC region
  gets a **\<current_state\>** block backed by `get_current_state`,
  replacing the counts-only `<tenant_state>` block.
- `backend/src/build-tune-agent/tools/get-context.ts` — extended OR
  deprecated in favour of a new `get_current_state` tool (see §5.1).
- `frontend/components/build/build-chat.tsx` → becomes
  `frontend/components/studio/studio-chat.tsx`. Message rendering
  rewritten: no rounded-2xl chat bubbles, no chevron reasoning
  block, no hero-state suggestion tiles. Plain hairline-separated
  rows (Linear/Raycast).
- Card components: `plan-checklist.tsx` stays (re-palette); everything
  else is new (`question-choices.tsx`, `suggested-fix.tsx`,
  `audit-report.tsx`, `state-snapshot.tsx`, `reasoning-line.tsx`).

---

## 3. Structural merge — the `/studio` shell

### 3.1 Where it lives

`/studio` is a tab inside the main app shell. Concretely, in
`frontend/components/inbox-v5.tsx`:

- `NavTab` type grows a new `'studio'` member (replacing `'build'`
  and `'tuning'` entries in the tab strip).
- Tab strip gets a single new button: `{ id: 'studio', label: 'Studio' }`.
- The click handler branches `navTab === 'studio'` to render the
  Studio surface inline — no `router.push`. Main-app chrome (top
  header, tab strip, auth gate) stays on screen, exactly like every
  other tab.

The old `/build`, `/tuning`, and `/tuning/agent` top-level routes
become thin redirect pages that call `router.replace('/?tab=studio')`
(with query preservation for `conversationId`). They survive one
sprint as courtesy; deleted in sprint 047.

### 3.2 Layout inside `/studio`

Three-pane, reusing the visual rhythm of the Inbox tab so the user's
muscle memory carries over:

- **Left rail (240 px):** recent Studio conversations (replaces the
  tuning queue). Each row: conversation title + updated-at + small
  status dot. Same typography as inbox conversation list.
- **Centre pane (flex):** the Studio chat. Card-first rendering.
  Composer pinned to the bottom with the same affordances as the
  rest of the app (no gradient CTA, plain ink button).
- **Right rail (320 px, collapsible):** context panel. Shows the
  current `<state snapshot>` card (system-prompt status, slot
  progress bars, pending-suggestions count with deep link). Mirrors
  the inbox "context" right rail pattern.

No ActivityBar. No extra logo. No second top-nav. The only chrome
above the three panes is the existing GuestPilot top header + tab
strip.

### 3.3 Palette

Adopt main-app tokens verbatim:

```ts
// frontend/components/studio/tokens.ts
export const STUDIO_COLORS = {
  canvas: '#FFFFFF',
  surfaceSunken: '#F2F2F2',
  surfaceRaised: '#FFFFFF',
  hairline: '#E5E5E5',
  hairlineSoft: '#EFEFEF',
  ink: '#0A0A0A',
  inkMuted: '#666666',
  inkSubtle: '#999999',
  accent: '#0070F3',          // only for primary CTAs and focus rings
  accentSoft: '#E6F0FF',
  successFg: '#117A3D',
  dangerFg: '#B42318',
  dangerBg: '#FEE4E2',
  // Category pastels reused from TUNING_COLORS (these are fine —
  // they're for artifact-type pills, not chrome).
  sopBg: '#FEF9C3', sopFg: '#854D0E',
  faqBg: '#CCFBF1', faqFg: '#0F766E',
  promptBg: '#DBEAFE', promptFg: '#1E40AF',
  toolBg: '#EDE9FE', toolFg: '#6D28D9',
};
```

The violet `#6C5CE7` ceases to appear anywhere. The sprint-045 spec
constraint "do not use the main-app palette" (issue #4) is **formally
retracted** in this sprint's spec.

### 3.4 Routing + deep links

- `/studio` is a hash-state tab (`navTab === 'studio'`), not a route.
- Deep links: `/?tab=studio&conversationId=…` — the page reader sets
  `navTab` from the query string on mount.
- The main-app `router.push('/tuning?conversationId=X')` call in
  `inbox-v5.tsx:4641` becomes
  `setNavTab('studio'); setStudioConversationId(X)`. One fewer route
  transition, one less "this is a different app" moment.

---

## 4. Agent quality — system prompt + memory + triage

### 4.1 Response contract (goes into the shared prefix, Region A)

New section added right after "Principles of good editing":

```
## Response contract

1. Every turn, you emit AT MOST ONE of the following structured
   artifacts as an SSE data-part, alongside any prose:
     - build_plan        (data-build-plan)
     - suggested_fix     (data-suggested-fix)
     - question_choices  (data-question-choices)
     - audit_report      (data-audit-report)
     - state_snapshot    (data-state-snapshot)
     - test_pipeline_result (data-test-pipeline-result)
2. Prose is optional and capped at 120 words per turn. Prose
   exists only to contextualise the card, never to replace it.
3. You DO NOT emit markdown tables, numbered lists, or bulleted
   lists of recommendations. If you have more than one item to
   surface, rank them and surface only the top one. The manager
   will ask for more if they want more.
4. When you ask a question, emit question_choices with at least
   two options and a recommended_default. Do not ask an
   open-ended question in prose.
5. When you propose an edit, emit suggested_fix with a
   machine-readable target (`artifact`, `slot`, `section` or
   `line_range`). "Update the system prompt" with no target is
   never acceptable.
6. Emoji status pills (🟢🟡❌) are banned. Status is communicated
   via card colour tokens, not unicode.
7. "Recommended Next Steps" and similar open-ended enumerations
   are banned. If the user's turn was a question, answer it and
   stop. If it was "review my setup", triage and surface the top
   finding only.
```

This block is the single most important change in sprint 046. It is
backed at runtime by a cheap **output linter** (§5.5) that drops or
downgrades any turn that violates rules 1–3 and 7.

### 4.2 Grounding — kill counts, pass full artifacts

Current state: `TenantStateSummary` passes `systemPromptEditCount: 3,
sopsDefined: 5, faqsGlobal: 12, …`. The agent has never seen the
actual prompt text. This is the root cause of issues #5 ("agent can't
see the full current system prompt") and #7 ("no triage — the agent
enumerates everything because it has no grounding to rank by").

Fix:

- **New tool `get_current_state(scope)`**. `scope` is a union:
  `"summary" | "system_prompt" | "sops" | "faqs" | "tools" | "all"`.
  Returns the actual text for the requested scope(s), with per-item
  ids so follow-up edits can target them. `"summary"` is the old
  counts-only payload (cheap, always cached).
- **Forced first-turn call.** The runtime hook injects a synthetic
  assistant message on turn 1 of every conversation that says "I'll
  check the current state first" and forces a `get_current_state({
  scope: "summary" })` call. This is issue #22 ("Forced
  `get_current_state` on first turn is acceptable — small latency hit
  in exchange for grounding") — user already confirmed.
- **Dynamic region updated.** The assembled system prompt's `<state>`
  block carries only the `summary` scope. Full artifact text is
  pulled on demand by the agent via `get_current_state(scope: "…")`
  — this is the point of the tool, and it directly addresses issue
  #9 (context bloat) by keeping heavy state out of the prefix.

Cache impact: `summary` scope has a stable serialisation (numbers +
ids, not free text). The dynamic region's prefix-cache hit rate
should be unchanged.

### 4.3 Triage rules (goes into both mode addendums)

```
## Triage

When the manager asks "review my setup", "audit", or anything
of that shape:

1. Call get_current_state(scope: "all") — one call, not many.
2. Score each finding on (impact × reversibility⁻¹). Pick the top
   ONE.
3. Emit an audit_report card with status rows for every artifact
   you checked (one row per artifact, not one row per finding),
   followed by a single suggested_fix card for the top finding.
4. DO NOT produce an enumerated list of recommendations. The
   manager will ask for the next finding if they want it.
```

Paired with the output linter: any turn that produces more than one
`suggested_fix` card or any markdown-list `suggestions:` field gets
downgraded to the top-1 automatically.

### 4.4 Rejection memory (session-scoped)

Every `suggested_fix` dismissal writes to
`session/{conversationId}/rejected/{fixHash}` where `fixHash` is a
SHA-1 of `(artifactId, target, semanticIntent)`. Before emitting a
new `suggested_fix`, the agent is instructed (and the runtime
pre-emits a memory read) to check that no matching fixHash exists.

Cross-session memory — "manager hated this fix in last week's
session, don't propose it again" — is **deferred to sprint 047**.
Rationale: durable preference storage needs a Prisma model, not
just a memory key, and scoping that correctly is its own design
exercise. The issue doc (#8) says "same session"; that's what we
ship.

### 4.5 Tool-use correctness

Issue #12 ("agent doesn't use tools correctly") is anecdotal. Sprint
046 treats it as a monitoring problem, not a design one:

- Add a lightweight trace logger: every tool call writes a row to a
  new `BuildToolCallLog` table (tenantId, conversationId, tool,
  params-hash, duration, success). One-row-per-call, kept 30 days.
- Build an admin-only "Tool-use traces" view inside `/studio` under
  a hidden flag. No end-user UI.
- After one week of production traces, audit for patterns (over-
  calling `plan_build_changes` without `get_current_state`, calling
  `create_faq` for content that belongs in an SOP, etc.) and fold
  the findings into a sprint-047 prompt update.

Shipping without this monitoring would repeat the sprint-045
mistake of guessing at agent quality issues.

---

## 5. Backend changes

### 5.1 New tool: `get_current_state`

```ts
// backend/src/build-tune-agent/tools/get-current-state.ts
export const getCurrentStateTool: ToolDefinition = {
  name: 'get_current_state',
  description:
    'Return the actual content of the tenant\'s configured artifacts. ' +
    'Use scope=summary for counts/ids only (cheap); use other scopes ' +
    'only when you need to propose an edit to that artifact.',
  input: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['summary', 'system_prompt', 'sops', 'faqs', 'tools', 'all'],
      },
    },
    required: ['scope'],
  },
  // returns a typed payload per scope — see types.ts additions
}
```

Returned payload shape:

```ts
type CurrentStatePayload =
  | { scope: 'summary'; summary: TenantStateSummary }
  | { scope: 'system_prompt'; text: string; sections: Array<{ id, title, range: [number,number] }> }
  | { scope: 'sops'; items: Array<{ id, category, status, content, propertyOverrides: Array<...> }> }
  | { scope: 'faqs'; items: Array<{ id, category, scope, question, answer }> }
  | { scope: 'tools'; items: Array<{ id, name, schema, isCustom }> }
  | { scope: 'all'; /* union of all above */ };
```

The `sections` array in the `system_prompt` scope is the grounding
for issue #10 ("no targeting in proposed edits"). Agent can now say
`target: { artifact: 'system_prompt', sectionId: 'checkout_time' }`
instead of "update the system prompt".

### 5.2 Removed: 48h cooldown

Delete from `hooks/pre-tool-use.ts` the block that enforces
`COOLDOWN_WINDOW_MS` on `suggestion_action` apply-intent. Delete
`COOLDOWN_WINDOW_MS` from `hooks/shared.ts`.

Replace with a **soft advisory**: when the agent is about to edit
an artifact that was edited in the last 48h, it emits (via
`emitDataPart`) a `data-advisory` part with kind `'recent-edit'`
and the previous edit's timestamp. The frontend renders a muted
one-liner above the Suggested Fix card: "This artifact was last
edited 6 hours ago." No deny, no wait, no autopilot framing.

Oscillation detection (issue — same edit toggled 14 days apart)
likewise becomes an advisory, not a deny. The confidence boost on
second-same-edit stays as agent-side input but no longer gates the
apply.

### 5.3 Extended: `plan-build-changes` item schema

```ts
type BuildPlanItem = {
  type: 'sop' | 'faq' | 'system_prompt' | 'tool_definition';
  name: string;
  rationale: string;
  // NEW:
  target?: {
    artifactId?: string;     // for edit-existing
    sectionId?: string;      // for system-prompt sections
    slotKey?: string;        // for interview-slot edits
    lineRange?: [number, number];
  };
  // NEW:
  previewDiff?: { before: string; after: string };
}
```

The frontend `PlanChecklist` renders `target` as a chip on each item
row, and renders `previewDiff` in an expandable disclosure
(collapsed by default — the plan card stays compact).

### 5.4 New SSE part types

Each is a typed `emitDataPart` sink plus a matching `stream-bridge`
pass-through.

| Part id                     | Payload                                          | Emitted by                       |
| --------------------------- | ------------------------------------------------ | -------------------------------- |
| `data-suggested-fix`        | `{ id, target, before, after, rationale, impact }` | `propose_suggestion` (renamed)   |
| `data-question-choices`     | `{ question, options: [{id, label, recommended?}], allowCustomInput }` | new `ask_manager` tool |
| `data-audit-report`         | `{ rows: [{artifact, status, note}], topFindingId }` | new `emit_audit` tool        |
| `data-state-snapshot`       | `{ systemPrompt, slotProgress, pendingCount, … }` | runtime, after first-turn `get_current_state` |
| `data-advisory`             | `{ kind: 'recent-edit' \| 'oscillation', context }` | pre-tool-use hook             |
| *(existing)* `data-build-plan`, `data-test-pipeline-result` | — | — |

The `ask_manager` and `emit_audit` tools are thin wrappers around
`emitDataPart` — they exist so the agent is forced to commit to a
card-shaped payload at tool-call time, which is what makes the
Response Contract enforceable.

### 5.5 Output linter

A cheap post-turn pass over the assistant's output, living in the
runtime after the SDK turn completes. Rules:

- If turn emitted zero data-parts AND prose > 120 words → truncate
  prose, append "(card truncated — agent would benefit from a
  structured part here; please rephrase)" advisory.
- If turn emitted more than one `data-suggested-fix` → keep the
  first, drop the rest, emit a `data-advisory` noting the drop.
- If turn includes markdown-list syntax (`^\s*[-*]\s` more than 2
  lines or `^\s*\d+\.\s` more than 2 lines) in a `text` part →
  flag for review (logged, not user-visible yet).

This is a belt-and-braces enforcement. The system-prompt rules are
the belt; the linter is the braces, for the inevitable turns where
the agent still defaults to prose.

---

## 6. Frontend changes

### 6.1 New card components (all under `frontend/components/studio/`)

- **`suggested-fix.tsx`** — diff viewer (before/after), target chip,
  inline Accept / Reject / "Open in editor" buttons. Palette: the
  artifact-type pill uses category pastels; the rest is main-app
  black-and-white with a single `#0070F3` accent on Accept.
- **`question-choices.tsx`** — question headline + 2–5 choice
  buttons. Recommended-default option is the only one styled as
  primary (filled ink); others are ghost buttons. "Or type
  something else…" row if `allowCustomInput` is true.
- **`audit-report.tsx`** — compact rows (one per artifact
  checked), each with a status dot (gray/green/amber/red — colour
  tokens, never emoji), a 1-line note, and a "View" button for
  drill-down. The top finding gets a "Fix" primary button on its
  row that scrolls to the paired Suggested Fix card.
- **`state-snapshot.tsx`** — renders in the right rail. System
  prompt card (status, last edited, edit count), slot progress bar
  (6 load-bearing, 14 non-load-bearing), pending suggestions count
  with deep link. Updates live when the agent writes an artifact.
- **`reasoning-line.tsx`** — replaces the chevron block. One-line,
  `#999999` ink, italic: "Thought for 4s · …" inline, with a click
  target that expands into a scrollable drawer (not an in-place
  accordion that shifts the layout).
- **`plan-checklist.tsx`** — already exists, only re-palette and
  add `target` chip + `previewDiff` disclosure.

### 6.2 Retired UI elements

- `BuildHero` — the hero-state grid with fixed suggestion chips. The
  greenfield path is driven by the first agent turn emitting a
  `question_choices` card, not by static frontend tiles.
- Emoji status pills (🟢🟡❌) everywhere they appear in
  `chat-parts.tsx`, `detail-panel.tsx`, and anywhere else. Replaced
  by coloured dots using `currentColor` with a token.
- Rounded-2xl chat bubbles — messages render as hairline-separated
  rows (`1px solid #E5E5E5`), no drop shadows, no background fill on
  user messages either.
- Gradient CTA buttons — any `linear-gradient` background in the
  build/tuning tree is replaced with the flat `#0A0A0A` ink
  button.
- The ChevronDown reasoning disclosure — replaced by
  `reasoning-line.tsx`.

### 6.3 `studio-chat.tsx` (replaces `build-chat.tsx`)

Main differences from `build-chat.tsx`:

- `<MessageRow>` renders text as plain text in a row, not in a
  rounded-2xl bubble.
- `StandalonePart` gains cases for every new data-part in §5.4.
  Unknown parts render as a muted "(unsupported card: <type>)" line,
  never as raw JSON.
- Input composer uses a single `#0A0A0A` Send button. No gradient.
  "Start fresh" resets conversation state, same as today.

### 6.4 Routing

- New hash-state: `/?tab=studio` and `/?tab=studio&conversationId=…`.
- `inbox-v5.tsx` handles `studio` in the NavTab union, renders the
  `<Studio/>` surface when `navTab === 'studio'`.
- The three old routes (`/build`, `/tuning`, `/tuning/agent`) ship
  one last time as 302 pages:
  - `/build` → `/?tab=studio` (preserve any `conversationId`).
  - `/tuning` → `/?tab=studio` (preserve any `conversationId`).
  - `/tuning/agent` → `/?tab=studio/raw-prompt` (admin-only
    mini-surface under the right rail; see §6.5).
- All deep-linking within `inbox-v5.tsx` that currently does
  `router.push('/tuning?conversationId=X')` is changed to in-place
  tab switches.

### 6.5 The "advanced" raw-prompt editor

`/tuning/agent` was a genuinely useful tool for power users. We don't
throw it away; we demote it. Inside `/studio`, behind a gear menu, a
`Raw prompt editor` toggle opens the same editor in a right-side
drawer (not a full page). Feature-flagged off by default for
non-admin roles.

---

## 7. Migration plan for existing `/tuning` features

`/tuning` was not just a chat — it was a queue of pending shadow-mode
suggestions with per-item approve/reject, a conversation-level detail
panel, and a dashboards view. Each of those has a defined landing
spot in `/studio`:

| Legacy feature                                  | New home                                      |
| ----------------------------------------------- | --------------------------------------------- |
| Pending-suggestions queue (`queue.tsx`)         | Left rail, tab switch between "Conversations" and "Pending" |
| Conversation detail panel (`detail-panel.tsx`)  | Right rail when a queue item is selected     |
| Chat panel (`chat-panel.tsx`)                   | Centre pane — becomes `studio-chat.tsx`      |
| Dashboards (`dashboards.tsx`)                   | Kept as a separate main-app tab `Dashboards` (or re-absorbed into Analytics — deferred to sprint 047) |
| Diff viewer (`diff-viewer.tsx`)                 | Reused inside `suggested-fix.tsx`            |
| Accept controls (`accept-controls.tsx`)         | Reused inside `suggested-fix.tsx`            |
| Evidence pane (`evidence-pane.tsx`)             | Right rail context card (replaces old detail panel) |
| Category pill (`category-pill.tsx`)             | Reused as-is (already tokenised correctly once we swap tokens) |
| Top nav (`top-nav.tsx`)                         | **Deleted.** Main-app top nav replaces it.   |

Components marked "reused" keep their file names and exports; they
just import from `studio/tokens.ts` instead of `tuning/tokens.ts`.

---

## 8. Phased build order

Four phases, each ending in a demo-able state. Total estimate is
5–7 working days, same scale as sprint 045.

### Phase A — Backend grounding + contract (1.5 days)

Scope:
- New `get_current_state` tool + types + tests.
- Forced first-turn call in runtime.
- Response-contract section added to shared system prefix.
- Triage rules added to mode addendums.
- Output linter scaffolding (no user-visible enforcement yet — logs
  only).
- `BuildToolCallLog` Prisma model + insertion.

Ships: nothing visible to end users; unit-tested on staging.

Phase A acceptance: agent, given a brand-new staging tenant, calls
`get_current_state({scope: 'summary'})` on turn 1 and emits a
`question_choices` payload on turn 2 of a greenfield start.

### Phase B — Cards + SSE parts (2 days)

Scope:
- Four new SSE part types plumbed in stream-bridge.
- `ask_manager` + `emit_audit` tools backend-side.
- Frontend card components: `suggested-fix`, `question-choices`,
  `audit-report`, `state-snapshot`, `reasoning-line`, `data-advisory`
  toast.
- All cards tokenised to new `studio/tokens.ts` (main-app palette).

Ships: still behind the studio tab flag; dogfoodable on staging
under the existing `/build` route (updated in place while we
finish phase C).

Phase B acceptance: AC-2 and AC-3 pass on a staging tenant — audit
returns a compact card + one Suggested Fix, every Suggested Fix has
a target chip, no markdown walls.

### Phase C — Shell merge (1.5 days)

Scope:
- Add `studio` to `NavTab` in `inbox-v5.tsx`.
- `<Studio/>` component that wires up `studio-chat`, the left rail
  conversation list (migrated from `/tuning`), and the right rail
  state-snapshot card.
- 302 pages for old routes.
- Kill `frontend/components/tuning/tokens.ts` (file kept as re-
  export shim for one sprint).
- Remove the custom ActivityBar + LeftRail from `frontend/app/build/`.

Ships: `/studio` tab live in main app shell on production tenants
that opt in.

Phase C acceptance: AC-1 passes (10-min greenfield, never leaving
the main app shell).

### Phase D — Cooldown removal + rejection memory + cleanup (1 day)

Scope:
- Delete cooldown block from `hooks/pre-tool-use.ts` +
  `COOLDOWN_WINDOW_MS` constant.
- `data-advisory` recent-edit soft warning.
- Rejection-memory session key wiring + agent instruction.
- Output linter user-visible enforcement (drop-not-log for rule
  violations).
- Delete `backend/src/tuning-agent/index.ts` shim.
- Delete `frontend/app/tuning/agent/page.tsx` (raw editor ported to
  `/studio` drawer).
- Add `BuildToolCallLog` admin view.

Ships: sprint 046 closes. All ACs pass end-to-end.

---

## 9. Explicit deferrals (not in sprint 046)

- **Cross-session rejection memory** (issue #8, partial). Session-
  scoped memory is shipped; durable cross-session preferences wait
  for sprint 047 with a proper Prisma model.
- **Cache-hit live capture** (inherited from sprint 045 `NEXT.md`).
  Still deferred — sprint 046 preserves the three-region boundary
  markers, doesn't regress them.
- **Live BUILD-mode cooldown/oscillation semantics** (inherited
  from sprint 045 `NEXT.md`). Now explicitly retired (§5.2) rather
  than deferred.
- **Agent tool-use correctness deep-dive** (issue #12). Sprint 046
  ships observability (`BuildToolCallLog`); a prompt-revision sprint
  follows if traces reveal patterns.
- **Dashboards merge** into the main Analytics tab (from §7). Kept
  as its own tab for now, re-absorbed later if the overlap proves
  high.

---

## 10. Issues-doc coverage check

Every numbered issue in `sprint-046-issues.md` maps to a section
above. Mapping:

| Issue | Resolved by                                  |
| ----- | -------------------------------------------- |
| 1     | §3 shell merge                               |
| 2     | §3 shell merge (main app shell + tab)        |
| 3     | §3 + §7 `/tuning` migration                  |
| 4     | §3.3 palette (constraint formally retracted) |
| 5     | §4.2 grounding — full artifacts via tool     |
| 6     | §4.1 response contract + §5.5 output linter  |
| 7     | §4.3 triage rules                            |
| 8     | §4.4 session-scoped memory (cross-session deferred, §9) |
| 9     | §5.1 `get_current_state` pull-not-push       |
| 10    | §5.3 `target` on plan items + §5.4 `suggested_fix` payload |
| 11    | §5.4 `question_choices` SSE part + §6.1 component |
| 12    | §4.5 trace monitoring (deferred deep-dive, §9) |
| 13    | §5.2 cooldown removal                        |
| 14    | §7 migration matrix                          |
| 15    | §6.2 retired UI elements + §3.3 palette      |
| 16    | §6.1 `suggested-fix.tsx` diff viewer         |
| 17    | §6.1 `audit-report.tsx` compact row card     |
| 18    | §6.1 `state-snapshot.tsx` right-rail pending-count chip |
| 19    | §6.1 `reasoning-line.tsx`                    |
| 20    | §3 whole section (Option B committed)        |
| 21    | §3.3 + §6.2 (Linear/Raycast restraint)       |
| 22    | §4.2 forced first-turn call                  |
| 23    | §4.1 + §4.3 (priority ranking implicit in triage rules + card catalogue) |

No silent drops.

---

## 11. Risk + rollback

- **Output linter false positives.** The rule-3 markdown-list check
  may flag legitimate short lists. Mitigation: log-only in phase A,
  user-visible only in phase D, and even then downgrade rather than
  block.
- **Forced first-turn tool call breaks cache hits.** The `summary`
  scope serialisation is stable (numbers + ids). Staging cache-hit
  dashboard must confirm before enabling in prod.
- **Shell merge breaks the existing `/tuning` queue workflow.** Roll
  out `/studio` under a feature flag keyed on tenantId; keep
  `/tuning` live but 302'd for one sprint so we can revert fast by
  flipping the flag.
- **Rejection memory writes under heavy chat** could bloat the
  memory store. Bound: one row per dismissed fix, keyed by hash —
  at most a few hundred rows per long session. Acceptable.

Rollback path for each phase is a single feature-flag flip, not a
code revert. Phase A + B can ship dark; phase C is the flag flip;
phase D cleans up.

---

## 12. Open questions (to resolve at kick-off, not during build)

1. Do we want `studio` to own the top-level route `/studio` as well,
   or strictly hash-state? (Current plan: hash-state for parity with
   all other main-app tabs. Argued: a URL makes sharing easier.
   Small decision; revisit if operators complain.)
2. Should the raw-prompt editor (§6.5) be admin-only from day one,
   or available to all operator roles behind a "show advanced"
   toggle? (Current plan: admin-only — preserves the "conversational
   agent is the primary surface" intent.)
3. Category pastel palette (SOP yellow, FAQ teal, etc.): retain as-
   is, or muted down for Linear/Raycast restraint? (Current plan:
   retain — they're artifact-type pills, they should read as
   categorical labels, not chrome. Only chrome gets ink-and-grey.)

These don't block work. Pre-phase-A 30-min decision.
