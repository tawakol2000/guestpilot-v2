# UI/UX brainstorm — BUILD / Studio agent page deep-dive

> Surface-specific companion to [`ui-ux-brainstorm-frontend.md`](./ui-ux-brainstorm-frontend.md).
> Primary source: the
> [design-patterns research report](/uploads/Design patterns for AI-first operator apps .md),
> cross-referenced against a code read of
> `frontend/components/studio/*` + `frontend/components/build/*` +
> `backend/src/build-tune-agent/*`.
>
> This surface is different enough from every other page to deserve
> its own file. BUILD is GuestPilot's **Cowork analog**: an agent
> writing rules, SOPs, prompts, and tool configs on behalf of a
> semi-technical operator who does not want to touch a schema editor
> directly. Every recommendation below is grounded in one of three
> questions:
>
> 1. Is the operator's **mental model of the system's current state**
>    trustworthy at any moment?
> 2. Is every write **preview-able, approvable, and revertable** before
>    it hits live guest-facing behaviour?
> 3. Does the surface feel like **collaborative editing of an artifact**,
>    not like chatting with a bot that might or might not have done the
>    thing?
>
> If a proposal doesn't advance at least one of those, it's filler.

---

## §0 Why BUILD is special

BUILD is the only surface in the app where the *product of a session
is persistent configuration that changes future guest-facing
behaviour*. Every other surface (inbox, tuning review, copilot
bubble) is either consumption (reading what the AI or the guest
said) or one-shot action (approve this draft, reject this
suggestion). BUILD writes rules.

That changes three things the design has to take seriously:

- **Blast radius is asymmetric.** A wrong reply to one guest
  inconveniences one guest. A wrong SOP rewrite misreplies to every
  guest in that status for weeks until someone notices. So the
  plan-approve-revert loop isn't UX polish — it's the load-bearing
  safety mechanism and every part of the surface has to treat it
  that way.
- **The operator's model of current state is fragile.** Unlike
  Cowork (where the artifact is a Google Doc the user can open) or
  Cursor (where the artifact is a file the user can `cat`), the
  artifact here is "the composed system prompt + SOP variant graph +
  FAQ corpus + custom tool definitions *as the guest-message
  pipeline will assemble them on the next inbound*." That
  composition is invisible by default. The operator cannot check it
  by eyeballing the DB.
- **The agent's job is to *tell the operator what they have*** as
  often as it is to *change what they have*. Audit-then-change is
  the actual job. Most sessions should end with fewer writes than
  you'd expect and more "here's what your setup looks like right
  now, highlighted against what you described wanting" moments.

Consequence for design: the right-rail state-snapshot is not
secondary chrome. It's the primary artifact on the surface. The
chat is the means of editing it.

---

## §1 Current state (from code read)

Grounding the brainstorm in what exists today so that "ship" vs
"rebuild" calls are honest.

### 1.1 Layout — three panes already

[`studio-surface.tsx:228–285`](../../../frontend/components/studio/studio-surface.tsx)
renders:

- **Left rail, 240px** — session list (title + message count,
  active has left accent bar, "New" button in header).
  Migrated from the old `/tuning` queue surface.
- **Centre** — `<StudioChat>` with hairline-separated message rows
  (no chat bubbles), AI-SDK `useChat` backed by
  `buildTurnEndpoint()` with conversationId body.
- **Right rail, 320px** — `<StateSnapshotCard>` (posture +
  prompt status + counts), plus a slot that shows the last
  `test_pipeline` result inline. Admin-only gear buttons at the
  bottom open the **Trace drawer** + **Raw-prompt drawer** behind
  `capabilities.traceViewEnabled` / `rawPromptEditorEnabled`
  flags.

This matches the canonical Cowork three-pane layout already. The
rebuild thesis for BUILD is **not** a layout change — it's a
density, granularity, and ritual change within the existing frame.

### 1.2 Chat rendering — plain rows, reasoning line, data-part switch

[`studio-chat.tsx:282–364`](../../../frontend/components/studio/studio-chat.tsx):

- Role label is a small caps uppercase 11px tracking-wide header
  above the row — "YOU" in accent, "AGENT" in ink-muted. No
  avatars, no bubble.
- Text parts render as flowing body text with `whitespace-pre-wrap`,
  14px/1.55 leading.
- **Reasoning parts** pass through `<ReasoningLine>` — a
  collapsed summary line that expands on hover/click. This is
  already close to Cowork's "Thinking" disclosure pattern.
- **Data parts** are switched exhaustively via `<StandalonePart>`
  covering: `tool-*`, `data-build-plan`, `data-test-pipeline-result`,
  `data-state-snapshot` (suppressed inline — rendered in right
  rail), `data-suggested-fix`, `data-question-choices`,
  `data-audit-report`, `data-advisory`, `data-agent-disabled`, and a
  legacy `data-suggestion-preview` that's emitter-deprecated.
  Unknown parts fall through to a muted `(unsupported card: <type>)`
  placeholder — no raw JSON leaks.

### 1.3 Tool call rendering — full-pill chips, minimal

[`studio-chat.tsx:590–632`](../../../frontend/components/studio/studio-chat.tsx):
tool call chips render as rounded-full pills with a colored dot
indicating `input-available` (running, accent), `output-available`
(success, green), `output-error` (danger). The tool name is stripped
of the `mcp__*__` prefix and underscore-to-space'd. No arguments
visible inline. No click affordance into tool output.

### 1.4 Write surfaces — plan checklist + suggested fix cards

- `PlanChecklist` ([`plan-checklist.tsx`](../../../frontend/components/build/plan-checklist.tsx),
  365 lines) renders `data-build-plan`: one item per write, with
  target chip (`§sectionId · {slotKey} · L42–L58 · artifactI`),
  optional previewDiff disclosure, Approve / Discard at the plan
  level, and state machine {idle → approving → approved →
  rolling-back → rolled-back | dismissed | error}. Rolled-back
  rollback is confirm-dialog-gated.
- `SuggestedFixCard`
  ([`suggested-fix.tsx`](../../../frontend/components/studio/suggested-fix.tsx),
  290 lines) is the single-line-delta equivalent: before/after
  pair, rationale, category, impact, Accept/Reject. Rejection
  writes to RejectionMemory with cross-session scope keyed on
  `target.artifact`.

### 1.5 Test-pipeline result — inline card + rail echo

[`test-pipeline-result.tsx`](../../../frontend/components/build/test-pipeline-result.tsx)
(113 lines) renders the dry-run output with judge score and latency.
Renders *both* inline in the chat row *and* echoed in the right rail
(only last one surfaces). The inline render is the primary — rail
version is a reference while scrolling.

### 1.6 Forced first turn + state snapshot

[`forced-first-turn.ts`](../../../backend/src/build-tune-agent/forced-first-turn.ts)
forces `get_current_state` as the first agent action every new
session, so the right rail has real data within ~1s of landing on
the page. No "empty state waiting to be hydrated" flicker.

### 1.7 Capability-gated admin drawers

Two admin-only drawers exist but are behind feature flags:

- **Trace drawer** ([`trace-drawer.tsx`](../../../frontend/components/studio/trace-drawer.tsx),
  308 lines) — per-turn tool call ledger for a conversation.
- **Raw-prompt drawer** ([`raw-prompt-drawer.tsx`](../../../frontend/components/studio/raw-prompt-drawer.tsx),
  353 lines) — read-only view of the assembled system prompt
  for the tenant. No edit path today.

Both are triple-gated: env flag + tenant.isAdmin + route-level
guard. Not in the normal operator surface.

### 1.8 Tool inventory (backend/build-tune-agent/tools/)

Twenty tools registered. Rough categorisation for the surface
design:

- **Reads (always safe):** `get_current_state`, `get_context`,
  `fetch_evidence_bundle`, `version_history`, `search_corrections`.
- **Interview / advisory:** `ask_manager`, `emit_audit`,
  `propose_suggestion`.
- **Writes (need plan + approval):** `create_sop`, `create_faq`,
  `create_tool_definition`, `write_system_prompt`, `search_replace`,
  `plan_build_changes`, `build_transaction`.
- **Test / meta:** `test_pipeline`, `suggestion_action`, `memory`.

The write tools all flow through `plan_build_changes` →
`data-build-plan` → operator approval → `build_transaction`. This
is already the right ritual. The surface needs to make it *legible*
and *efficient*, not add a new one.

**Takeaway for this brainstorm.** BUILD already has the structural
skeleton of a Cowork-class surface. What's missing is (a) granular
artifact affordances (plan mode, tool-call drill-in, diff views,
queue, badges), (b) trust-feedback rituals (state snapshot,
test-pipeline, rollback) surfaced as first-class product moments
instead of back-office tooling, and (c) a posture-aware empty state
that teaches operators what the surface is actually for.

---

## §2 Layout proposal — refine, don't rebuild

The three-pane layout is the right answer. Keep it. The
improvements below are all within-pane.

### 2.1 Left rail — session list as task board, not thread list

Current: flat list of sessions, title + message count, most recent
on top. No filtering, no grouping, no status distinction.

Proposal:

- **Sticky "Active" section** at top: sessions where the agent is
  currently mid-turn OR where there's an un-approved plan
  waiting. This is the "come back to this" affordance — an
  operator should never have to hunt for "the plan I was about to
  approve."
- **Grouped below:** Today / Yesterday / This week / Older. One
  Linear-style timebucket header per group.
- **Trigger type badge** on rows where triggerType ≠ MANUAL (e.g.
  MESSAGE_REJECTED, SUGGESTION_DISCUSSED, SHADOW_EDIT) so operator
  can tell "I started this" from "the system opened this for me."
- **Pending-plan indicator** (e.g. red dot + "plan ready") on
  rows whose most recent agent turn emitted a `data-build-plan`
  that's still `idle`/not approved-or-dismissed. Mirrors
  Cowork/Cursor "unread" dot.
- **Search / filter input** at header. Keyboard: `/` focuses.
  Filter tokens: `status:pending`, `trigger:shadow`, `has:plan`.
- **"New" button** stays but gets a dropdown: "New blank" +
  "Start from audit" + "Start from failing reply" — the last two
  pre-seed the first turn.

**Effort.** 1–2 sprint sessions. Entirely frontend. `status`
computation needs a lightweight `GET /api/tuning/conversations`
enrichment (has-unapproved-plan flag) that's already tractable
from the existing `BuildTransaction` table.

**Why.** The session list today is a thread list pretending to be a
workspace. Treating it as a task board (pending / today / done)
aligns with the fact that BUILD sessions are *bounded units of
work*, not ongoing conversations.

### 2.2 Centre pane — anchored "current message" plus scrollback

Current behaviour (`studio-chat.tsx:109–115`): smooth-scroll-to-bottom
on every message change. Fine when the agent is typing. Not fine
when the operator is reading an older turn and the agent emits a new
reasoning chunk — the view yanks.

Proposal:

- **Two-zone scroller.** Top zone = scrollback, bottom zone = "now"
  with a 40px fade. If the user has scrolled up, a "Jump to latest
  ↓ (3 new)" pill appears and no auto-scroll fires until dismissed.
  Mirrors Cowork's active-monitoring pattern.
- **Anchor the last role header.** When the agent is mid-streaming
  a reasoning chain, pin the "AGENT" label + turn index to the top
  of the viewport so the operator always knows which turn they're
  reading. Granola uses a similar pinned-paragraph pattern for long
  meeting notes.
- **Progressive disclosure of reasoning.** Per-turn "show thinking"
  affordance that's collapsed by default on load but auto-expanded
  on the *actively streaming* turn (so the operator watches it
  happen) and collapses again when the turn finishes. Matches
  Cowork's "Thinking" accordion.

**Effort.** Half a sprint session.

### 2.3 Right rail — add two slots, keep the snapshot

Keep StateSnapshotCard at top. Add below it, in order:

- **"Pending plan" card** (absent if no pending plan). Same item
  list as the inline PlanChecklist but collapsed to a count +
  primary CTA. Click scrolls the inline card into view.
- **Artifacts** (new) — see §6.
- **Recent tests** (exists — keep, expand from 1→3).
- **Connectors / Context** (new — see §8 and §10).
- Admin gear buttons stay at the very bottom.

**Effort.** Each slot is its own session; build incrementally.

---

## §3 Chat centre — patterns to import

Eight patterns the research paper ranks highly that BUILD can adopt
with good fit.

### 3.1 Plan mode before writes — already partially shipped, finish it

**Status.** The `PlanChecklist` + `plan_build_changes` tool +
`BuildTransaction` write-ritual already exists. Ship-gap work:

- **Editability.** Plans today are view-only until Approve. Lovable
  / Cursor's plan mode lets the operator *edit* the plan (strike
  through item 3, add item 4, reorder) before approving. Current
  wiring would require shape-shifting `data-build-plan` into a
  round-trippable editable artifact (or spawning a "revise plan"
  agent turn). Tradeoff: editable plans require a new
  `revise_plan` tool + server validation. Pure operator-impact win
  though — today operators either approve the whole plan or reject
  it and re-prompt, which wastes a turn.
- **Per-item approve / revert.** Current plan is all-or-nothing.
  Granular per-item approval matches how operators mentally
  "cherry-pick" in most real sessions. Requires the transaction
  model to split — write-per-item instead of write-per-plan.
  Non-trivial backend refactor but high UX payoff.
- **Typed-confirm on destructive plans.** Plans that touch
  system_prompt or delete artifacts should require typing "Proceed"
  or pressing Cmd+⏎ twice, per the §1 tiered-permission rule. Trivial
  to add on top.

**Reference.** Research report §2.7 + §5 feature #3 (Plan mode).
Cowork research report §2.6.

**Effort.** 1 session for typed-confirm + preview. 2–3 for editable
plans (adds `revise_plan` tool). Another 2–3 for per-item approval
(touches BuildTransaction shape). Treat them as three separable
sessions.

### 3.2 Tool-call chain chevron — drill-in to outputs

Current chips show tool name + state but no output. An operator
who sees the agent run `fetch_evidence_bundle` and then emit a
conclusion has no way to verify the intermediate — is that
conclusion real, or did the evidence bundle come back empty?

**Proposal.** Click a tool chip → pane-local drawer slides up (or
slide-out to the right within the centre column) showing:

- **Input args** (pretty-printed, syntax highlighted).
- **Output** (if `output-available`, truncated to 1000 chars with
  "show more"; if `output-error`, the error message).
- **Latency.** Ms + model used.
- **"Re-run with edit"** button that seeds a new turn with edited
  args (agent receives "please retry X with …" natural-language
  instruction).

Cowork's pattern is exactly this — click a tool call in the chain,
see the payload that went out and the result that came back. It's
the feature that makes audit possible. BUILD currently has it
hidden behind the admin-only Trace drawer. That's the wrong
permission tier: every operator should be able to see what the
agent saw, even if they can't see the raw system prompt.

**Reference.** Research report §2.3 (Cowork tool-call chain),
§5 feature #2.

**Effort.** 1 session. Drawer component + wire to
`tool-*` data parts' `input` / `output` fields (already on the
data-part shape).

### 3.3 Auto-queued messages during agent work — defer sending

Operators mid-BUILD often have a follow-up question before the
agent finishes replying. Today pressing Enter while `isStreaming`
is disabled (textarea is disabled). Windsurf's pattern: allow the
operator to *queue* a follow-up while the agent is working; queued
message sends automatically after the current turn finishes, with a
visible "queued" indicator.

**Proposal.** Instead of disabling the textarea while streaming,
show a "Queued — sends when this turn finishes" badge inside the
composer, with an `×` to cancel. Queue renders as a small chip
above the composer. Multiple queued messages = multiple chips (but
cap at 3 — this isn't a mailbox).

**Reference.** Research report §3 Windsurf row.

**Effort.** Half session. Non-trivial interaction with useChat's
streaming state but tractable.

### 3.4 Enhance-prompt button — Bolt pattern

Bolt's composer has a "✨ enhance" button that rewrites the
operator's typed prompt into something more structured before
sending. For BUILD this is high-value on first-timer sessions — an
operator types "make the AI nicer" and the enhanced version becomes
"audit the current COORDINATOR system-prompt tone section; if it
reads as transactional, propose an SOP variant that opens warmer for
INQUIRY status."

**Proposal.** ✨ button to the left of Send in the composer. Hover
shows "Rewrite my message as a precise request." Click calls a
GPT-5-Nano endpoint that transforms the draft in-place; operator
sees the rewrite immediately and can accept (Send) or reject
(Cmd+Z reverts).

**Reference.** Research report §3 Bolt row, §5 feature #12.

**Effort.** 1 session. Backend route + composer wiring.

**Caveat.** Add lightly. Bolt's version is designed for code
generation where prompt quality has outsized impact. For BUILD
the real value is teaching new operators what a precise BUILD
request looks like — consider framing it as "suggest a better
phrasing" disclosure rather than a silent rewrite so the operator
learns the pattern.

### 3.5 Typographic attribution — Granola pattern

Today every text character in the chat looks the same regardless of
origin. The `data-suggested-fix` card has before/after but the
operator can still mentally lose track of "was that sentence
something the agent wrote, something I typed, or something quoted
from the existing SOP?"

**Proposal.**

- **Agent-typed text** renders in `inkMuted` grey.
- **Operator-typed text** (in the chat, after the agent has
  echoed it) renders in `ink` black.
- **Quoted existing artifact content** (e.g. what `get_current_state`
  returned) renders in a monospace block with a left-rule attribution
  chip: "From SOP:early-checkin · variant:CONFIRMED".
- **New content the agent is proposing to write** renders with an
  "unsaved" badge — italic grey until the plan is approved, then
  the badge drops.

**Reference.** Research report §2.1 (Granola), §5 feature #1.

**Effort.** 1 session. No data-part shape change — just styling in
the MessageRow/StandalonePart components.

### 3.6 Accept / reject / try-again on every non-trivial AI output

Today only `SuggestedFixCard` has the triple. Other outputs (an
audit row, an interview answer choice, a test-pipeline result) are
terminal — they either commit or don't. Notion's pattern: every
AI-generated artifact affords Accept / Discard / Try again.

**Proposal.** Extend the triple to:

- **Audit rows** — accept "OK, investigate this one" (seeds next
  turn), discard (marks the row as "not interesting" for the
  session), try again (asks the agent to re-audit with a
  different lens).
- **Test-pipeline results** — accept (commits an "approve this
  behaviour" marker — more useful as a soft signal once we have it),
  discard (flags as "this is what I *don't* want"; seeds a
  corrective turn), try again (re-runs the same test_pipeline).

**Reference.** Research report §2.5 (Canvas), §2.8 (Notion).

**Effort.** 1–2 sessions. Adds a lightweight `ai-reaction`
data-part type and per-card action handlers.

### 3.7 Inline citations on factual claims — clickable source links

Every time the agent says "the current check-in SOP is 14:00" or
"FAQ entry 7b247a says …" make the statement clickable. Click opens
the artifact drawer scrolled to the quoted span.

**Proposal.** Agent's system-prompt side already has the data
(get_current_state returns IDs and fields). Add a
post-processing step that rewrites text like "the CONFIRMED variant
of early-checkin says …" into a markdown-link-shaped content part
(`data-artifact-citation` with artifactId + quoteRange), which the
MessageRow can render as an underlined span with cursor: pointer.

**Reference.** Research report §2.9 (Perplexity), §5 feature #5.

**Effort.** 1–2 sessions. Non-trivial because the linter would
need to generate citations reliably. Consider shipping after §6
(artifact drawer) lands, since click-destination needs to exist
first.

### 3.8 Question choices card — keep, polish

Today's `QuestionChoicesCard` is good UX — structured multiple
choice from the agent short-circuits the "chat back and forth" tax.
Two refinements:

- **"Multi-select" mode.** Some questions are "which of these
  statuses does this apply to?" (pick 2+). Requires
  `data-question-choices` to gain an `allowMultiSelect` flag.
- **Keyboard shortcuts.** `1–9` picks the numbered option. Already
  assumed by operator muscle-memory from Linear/Superhuman.

**Effort.** Half session each.

---

## §4 Right rail — make the state snapshot the hero

### 4.1 State snapshot — expand into a live "system description"

Current `StateSnapshotCard` shows scope=summary: posture,
systemPromptStatus + editCount, sops defined/defaulted, faq
counts (global/property-scoped), customTools, properties,
lastBuildSessionAt. This is correct as a glance.

Proposal — expand to a scoped, drillable "system description":

- **Expand-on-click rows.** Each count row ("SOPs: 14 defined, 3
  defaulted") expands inline into a 5-line sparkline-style list
  with the artifact IDs and a click-through to the artifact drawer.
- **Diff-from-last-session badge.** If the most recent BUILD
  session modified a row ("SOPs: 14 → 15"), show a small green
  delta. Fades after 24h.
- **Posture-aware headline.** GREENFIELD: "You haven't set up
  any SOPs yet — 0 of 4 default categories defined." BROWNFIELD:
  "All 4 default SOP categories defined; 3 are using the system
  default vs a custom variant." Don't make the operator read the
  numbers and infer.
- **Health indicators.** Light-red dot next to any row that's in
  a degraded state: prompt > 90 days since last edit, > 50% SOPs
  using default-only (no variants), FAQ corpus below a threshold
  for enabled statuses, unused custom tool (zero invocations in
  last 30 days). These are "polish" signals, not errors — but
  they turn the rail into an ambient health dashboard.

**Reference.** Research report §5 feature #7 (state snapshot) and
§5 feature #11 (ambient health).

**Effort.** 2 sessions. Expandable rows is session one;
health-indicator computation + delta badges is session two (needs
a `/api/build/tenant-state/health` endpoint or enrichment).

### 4.2 Artifacts panel — first-class artifact list

Cowork's right rail has an Artifacts section that lists every
concrete file/asset the agent has touched this session, linked.
BUILD has no equivalent. Today if an agent writes one SOP and
modifies two FAQs in the same session, the operator has to scroll
the chat to find links to them.

**Proposal.** New "Session artifacts" card in the right rail.
Auto-populated from `data-build-plan` approvals and
`data-suggested-fix` accepts. One row per artifact touched:

- Artifact-type icon (SOP / FAQ / system-prompt / tool).
- Title + artifactId (truncated).
- State chip: "modified · 2 min ago", "created · 30 sec ago",
  "reverted · 5 min ago".
- Click opens artifact drawer (§6).

Persists for the lifetime of the session. New session = empty list.

**Reference.** Research report §2.4 (Cowork Artifacts), §5 feature
#9.

**Effort.** 1 session frontend-only (data already lives in
BuildTransaction).

### 4.3 Context card — what the agent can see right now

Show (readonly) which MCP-ish data sources the agent has in its
context for this conversation:

- Tenant: name, isAdmin flag, feature flags.
- Properties: count, selected (if a specific property is scoped).
- Status scope: default ALL vs scoped to a subset.
- Recent conversations: whether conversation summary is in context.

This isn't a connector list (we don't have external connectors on
BUILD) — it's a "what the agent knows about your environment"
disclosure. Operators ask this question constantly in new
sessions.

**Reference.** Research report §2.4 (Cowork Context).

**Effort.** 1 session. Most data already on `/api/build/tenant-state`.

### 4.4 Recent tests card — expand to last 5, with deltas

Today only last 1 test result is shown, truncated to 140 chars.
Proposal:

- Last 5 tests, most recent on top.
- Judge score delta from previous test of the same category
  (↑ 0.12, ↓ 0.04).
- Click row expands to show full output + judge rationale inline.
- "Pin" affordance — pin up to 2 tests so they stay visible as
  new ones push down the list (useful for A/B comparisons).

**Effort.** 1 session.

---

## §5 Write-gating ritual — the non-negotiable

### 5.1 Tiered permissions baked into the plan

Write-ritual today is single-tier: any plan needs one Approve
click. Three tiers that match the research paper's permission
model and GuestPilot's real blast-radius:

- **Tier 0 — reads (auto).** `get_current_state`, `get_context`,
  `fetch_evidence_bundle`, `version_history` always run without
  friction. No UI change.
- **Tier 1 — single-artifact writes (preview + one-click Approve).**
  `create_faq`, `search_replace` on a single FAQ, single-field
  `write_system_prompt` edits. Default behaviour — show diff,
  click Approve. Today's UX.
- **Tier 2 — multi-artifact writes or prompt-scope changes
  (typed-confirm).** Any plan touching system_prompt sections or
  > 1 artifact. Operator types "proceed" in a small input, or
  holds Cmd+⏎ for 600ms (progress-ring pattern). Prevents fat-finger
  approval of system-prompt rewrites.
- **Tier 3 — destructive (typed-confirm + named-thing).** Artifact
  deletion, SOP variant removal, tool-definition deletion. Operator
  types the artifact title. Matches GitHub repo deletion.

**Reference.** Research report §2.2 (Cowork tiered permissions),
§5 feature #13.

**Effort.** 1 session. The classification is straightforward from
plan item types.

### 5.2 Dry-run-before-write default

`test_pipeline` exists as a tool but is optional. Proposal: for
any plan that modifies SOPs or system-prompt, the plan approval
card auto-emits a "before/after test" pair — same guest message,
run through pre-change pipeline and post-change pipeline. Approve
means "I saw the delta and accept it," not just "I saw the plan."

Caveat: this is slow (two test_pipeline invocations). Offer as
opt-in for sprint 050; promote to default after measuring latency.

**Reference.** Research report §2.5 (Canvas diff), §5 feature #8.

**Effort.** 2 sessions (backend: emit the pair + bundle into plan;
frontend: render side-by-side in PlanChecklist).

### 5.3 Rollback as a first-class posture, not a confirm-dialog

Today rollback opens a `ConfirmRollbackDialog`. That's fine for
the first rollback. For a session with multiple approved plans
(common in long BUILD sessions) the operator can't see "which of
my 3 approved plans am I about to roll back?"

**Proposal.** Right-rail "Pending plans / Applied plans" toggle
with Applied showing a history stack. Each applied plan has a
per-card Rollback button. Rolled-back plans move to "Reverted"
section.

**Reference.** Git's `reflog` mental model; Cowork's session
history pattern.

**Effort.** 1 session frontend + small backend addition (filter on
BuildTransaction status).

---

## §6 Artifact drawer model — the missing surface

BUILD has five kinds of artifacts (system prompt, SOP variant, FAQ
entry, tool definition, property override). Operators touch them
constantly. Today there is no generic artifact viewer. Each
artifact type has its own scattered surface:

- System prompt: raw-prompt drawer (admin-only, read-only).
- SOP: `/tuning` sub-pages.
- FAQ: `/tuning/faqs`.
- Tool definition: `/tools`.
- Property override: nested within property settings.

The BUILD agent references these constantly ("the early-checkin
SOP's CONFIRMED variant currently reads…") but can't link to them
in a way that renders inline.

### 6.1 Unified `<ArtifactDrawer>` — slide-out from right

**Proposal.** One slide-out drawer, 480px wide, that opens over the
right rail (not over the chat). Accepts `{ artifact, artifactId }`.
Routes internally to the artifact-type-specific view. From the
chat, any citation link (§3.7) opens this. From the right rail's
Artifacts card (§4.2) ditto.

Contents per type:

- **SOP variant.** Category, status scope, property scope, body
  (markdown-rendered), metadata (last edit, version, edit count),
  "edit in tuning" deep link.
- **FAQ entry.** Question, answer, category, scope, embeddings-status,
  "edit in tuning" deep link.
- **System prompt section.** Section ID, current body, recent diffs
  (5 most recent edits), admin-only full-prompt toggle.
- **Tool definition.** Name, description, JSON schema, webhook
  config (for custom tools), admin-only runtime-flag toggle.
- **Property override.** Property, overridden field, value, fallback.

Every drawer has an "open in full editor" button that deep-links
to the existing dedicated page. The drawer is a *viewer-first*
surface — editing happens in the dedicated pages we already have.

**Reference.** Research report §2.4 (Cowork Artifacts — clickable
artifact cards), §5 feature #9.

**Effort.** 3–4 sessions. Each artifact-type view is a session.
Routing + shell is a half-session.

### 6.2 Diff rendering inside the drawer

Any artifact in the drawer during/after a BUILD session shows a
"view changes" toggle. When on, the body renders with red-strike
/green-underline deltas. Prior versions accessible via a
per-version slider. Matches Cursor's file diff pattern.

**Reference.** Research report §2.5 (Canvas diff).

**Effort.** 1 session per artifact-type (SOPs first, FAQs second,
system-prompt third).

### 6.3 "Compose at cursor" — open-drawer-to-edit

An operator reading an artifact in the drawer sees a spot they
want the AI to rewrite. They select the span, right-click →
"Ask the agent to revise this." Selected text becomes quote-reply
context in the composer with a seeded prompt: "Revise this section
of early-checkin SOP (CONFIRMED variant):\n> …"

**Reference.** Research report §2.5 (Canvas inline AI).

**Effort.** 1 session. Selection capture + composer seeding.

---

## §7 test_pipeline as first-class ritual

`test_pipeline` is currently a tool the agent can invoke. Operators
don't think of it as their own affordance — it's something the
agent might do mid-conversation. That's backwards.

### 7.1 "Try it" composer — always-visible test affordance

**Proposal.** Right-rail card (or bottom bar of centre pane)
titled "Try it" — operator types a sample guest message, picks a
status/property, clicks Test. Backend runs `test-pipeline-runner`
directly without going through the agent. Result renders in the
rail as a TestPipelineResult card.

This turns BUILD into a pipeline playground. Operators can verify
"does my latest change actually fire the SOP I think it does?"
without having to prompt the agent to do it.

**Effort.** 1 session. Direct HTTP route bypasses the agent.

### 7.2 Test matrix — batch comparison

Second-tier affordance: operator saves a set of 5 "canonical" test
cases (representative messages for INQUIRY / CONFIRMED / CHECKED_IN
/ emergency / after-hours). On every approved plan, the matrix
re-runs all 5 and shows a before/after grid with judge scores.

Turns "did my change break anything?" into a compile-time check.

**Effort.** 2–3 sessions. Requires a `TestCanon` table + batch
runner + matrix UI.

### 7.3 Test from conversation — "use this message as a test"

In the inbox today, an operator reads a reply they're unhappy
with. Proposal: context-menu "Test in Studio" on any guest
message. Opens BUILD in a new session pre-seeded with that
message as the test input and the matching conversation ID so
`get_current_state` scopes correctly. Skips the cold-start
"explain the situation to the agent" tax.

**Reference.** Cowork "continue this in agent" cross-surface pattern.

**Effort.** 1–2 sessions. Deep link + seed turn logic.

---

## §8 Raw-prompt editor as a Canvas-style surface

Today the raw-prompt drawer is read-only and admin-gated. Operators
can see but not edit. Moving the needle means making this a Canvas.

### 8.1 Two-column Canvas layout (admin-only)

Left half: editable prompt (structured, section-by-section with
`{VARIABLE}` chip rendering — not a plain textarea). Right half:
the agent. Operator edits a section, asks the agent "does this
section contradict the early-checkin SOP?" — agent reads the edit,
answers. Like Cursor editing a file with the model watching.

**Reference.** Research report §2.5 (Canvas), §5 feature #14.

**Effort.** 3–4 sessions. Full rebuild of the drawer. Big lift.
Defer unless admin-operator usage pressure shows up.

### 8.2 Minimum-viable step — make it editable

Before (or instead of) 8.1, ship the edit path on the existing
drawer. Keep the two-column shell, add a save button. Versions
the prompt through the existing `AiConfigVersion` model. Gated
behind triple-admin-only gate as today.

**Effort.** 1 session.

---

## §9 Trace drawer — promote from admin to operator (selectively)

The Trace drawer today shows per-turn tool call ledger. Admin-only
behind a feature flag. This is a mistake — trace visibility is
*exactly* what builds operator trust in the agent.

### 9.1 Operator-tier trace — redact admin bits

**Proposal.** Split the trace contents:

- **Operator-visible:** tool call name, input args (sanitised —
  no raw API keys), output summary (first 200 chars), latency,
  error if any.
- **Admin-only:** full inputs, full outputs, prompt assembly debug,
  token counts, model version.

Operator toggle in the trace header: "Show all" (admin) vs
"Summary" (default).

**Effort.** 1–2 sessions. Redaction layer + permission split.

### 9.2 Trace as a time-travel surface

Within a trace, the operator sees every tool call. Click a call →
right pane shows *the state of the artifact at the time of the
call* alongside what's current. Makes "the agent wrote this
because at the time the SOP said X; it now says Y" legible.

**Effort.** 2–3 sessions. Needs per-artifact version lookup at
trace timestamps.

---

## §10 Tenant-state posture — a front-door display problem

`BuildTenantState.isGreenfield` is computed correctly. The UI uses
it for (a) an empty-state CTA and (b) seeding the first system
message. Both are subtle. The operator has to notice the copy
changed.

### 10.1 Posture banner — top of centre pane

**Proposal.** Thin (28px) banner pinned to the top of the chat
pane. Two modes:

- **GREENFIELD:** bright, onboarding-flavoured. "You're just
  starting out. I'll walk you through setup one topic at a time."
- **BROWNFIELD:** neutral. Shows 4–5 top stats inline: "14 SOPs ·
  3 defaulted · prompt edited 6 days ago · last BUILD session
  yesterday." Click → expands into the state-snapshot rail card.

Dismissable per session. Reappears on next session.

**Effort.** 1 session.

### 10.2 Posture-aware empty state — already partially there

[`studio-chat.tsx:239–280`](../../../frontend/components/studio/studio-chat.tsx)
already branches on greenfield. Extend:

- GREENFIELD shows a **3-step progress rail** ("Import properties
  · Define SOPs · Customize tone") that the agent ticks off as
  the session progresses. Lovable's onboarding pattern.
- BROWNFIELD shows the audit-prompt button plus a row of **Top 3
  opportunities** computed from state: "Your CHECKED_IN SOP is
  using system default", "No FAQ for emergency contact", etc.
  Each is a one-click seed into a BUILD session.

**Effort.** 2 sessions — heuristics for brownfield opportunities
are the harder half.

---

## §11 Prompt queue — batching the operator's work

Operators often arrive at BUILD with a list of things to change.
Today they have to type each one in sequence, waiting for the agent
to finish. Proposal: an explicit "queue" the operator loads up.

### 11.1 "To-do for this session" list — above the composer

Operator creates 3–5 items as plain-text bullets before any turn.
Agent works through them one at a time, asking clarifying
questions inline, ticking items off as each gets a plan approved.

Halfway between a TodoWrite and a typed prompt — matches the
behaviour of long Claude Code runs that decompose a multi-step
task. 

**Reference.** Research report §2.11 (plan/todo pattern from
Cursor/Claude Code).

**Effort.** 2–3 sessions. Needs a persistent `SessionTodo` model
(or session metadata field) + UI list + agent-prompt integration
so the agent knows to consume the list.

**Caveat.** This can overlap confusingly with the plan-mode
concept. Prompt queue = operator's pre-session to-do list. Plan
mode = agent's per-write change set. Keep them typographically
distinct.

---

## §12 Skill / tool badges — ambient capability signal

Operators never know what the agent *can* do until they ask.
Proposal: collapsed tool shelf above the composer with inert
badges for every tool registered in this conversation's context.
Expand on click, drill into examples.

Unlike the tool-call chain (§3.2) which shows what the agent
*did*, this shows what the agent *could do*.

**Reference.** Research report §2.10 (Raycast skill affordance),
§5 feature #15.

**Effort.** 1 session. Data already on
`/api/build/capabilities` + backend/tools registry.

---

## §13 Memory — session scoping legibility

RejectionMemory cross-session scoping (sprint 047-C) is durable
but invisible. An operator rejects a suggested fix in session A,
starts session B tomorrow, and the agent silently avoids proposing
it again. Good behaviour; bad transparency.

### 13.1 "Remembered preferences" card — right rail

On session start, right-rail card surfaces: "3 things I'll avoid
proposing again: [view]" — click opens the RejectionMemory for
this tenant. Each entry shows the rejected suggestion and a
"clear this memory" button so the operator can unblock a retry.

**Reference.** Research report §5 feature #17.

**Effort.** 1–2 sessions. Endpoint + UI. Also unblocks the
deferred "cleared-rejections UI" from the carried-forward list.

---

## §14 Cross-cutting polish — BUILD-specific

- **Toast failures always actionable.** Every failed write surfaces
  a toast with a "Retry" button that re-runs the exact tool call.
  Sprint 049 added toast surfacing for legacy inbox/copilot; BUILD's
  agent path deserves the same.
- **"Copy prompt for Claude Code" button** on the composer —
  exports the current session as a markdown brief so the operator
  can hand a BUILD session off to a human engineer. Rare but
  useful at the current team size.
- **Loading states are typographic, not spinner-y.** "Agent is
  thinking…" is correct; keep that pattern for every async state
  (no spinners on buttons — just text that changes).
- **Keyboard shortcuts legend** — `?` key shows an overlay listing
  every BUILD shortcut. Most operators never find shortcuts.
- **Dark mode.** BUILD is the only surface without one. Operators
  spend long sessions here; light-on-dark is the canonical
  "concentration mode" preference.
- **Session export.** "Download this session as markdown" button
  in session menu. Useful for auditing, sharing with teammates,
  and the "show me what changed" retrospective workflow.

**Effort.** Each is 0.5–1 session. Batch 2–3 per sprint session.

---

## §15 Prioritisation matrix

| # | Item | Effort (sessions) | Operator impact | Unlocks |
| - | - | - | - | - |
| 1 | Tool-call chain drill-in (§3.2) | 1 | **Very high** — audit becomes possible | Trust + verification feedback loop |
| 2 | Expandable state snapshot + artifacts panel (§4.1 + §4.2) | 2 | **Very high** — right rail becomes real | Every reference to "current state" gets legible |
| 3 | Artifact drawer shell (§6.1) | 3 | **Very high** — first-class artifact click | Citations (§3.7), diff view (§6.2), compose-at-cursor (§6.3) |
| 4 | Tiered permissions (§5.1) | 1 | High — prevents fat-finger rewrites | Table-stakes safety for larger rollouts |
| 5 | "Try it" composer (§7.1) | 1 | High — turns BUILD into a playground | Closes trust loop for operators unsure if write worked |
| 6 | Session-list task board (§2.1) | 1–2 | High — "where was I?" gets answered | Multi-session operator flow |
| 7 | Typographic attribution (§3.5) | 1 | Medium — legibility win | Foundation for citations (§3.7) |
| 8 | Auto-queued follow-ups (§3.3) | 0.5 | Medium — removes a common friction point | Continuous work pattern |
| 9 | Per-item plan approval (§3.1 cont.) | 2–3 | Medium — cherry-pick path | Matches how operators actually think |
| 10 | Posture banner + brownfield opportunities (§10) | 2 | Medium — front-door clarity | Onboarding + re-engagement |
| 11 | Citations (§3.7) | 1–2 | Medium — depends on drawer landing first | Closes click-to-source principle |
| 12 | Test matrix + before/after (§5.2 + §7.2) | 4–5 | Medium — high-quality lift-over time | Converts BUILD into a regression-tested surface |
| 13 | Raw-prompt Canvas (§8.1) | 3–4 | Low today — high if admin-operator usage grows | Defer unless signal |
| 14 | Skill/tool badges (§12) | 1 | Low — discoverability polish | Helps new operators |
| 15 | Dark mode + polish (§14) | 2 | Low — quality-of-life | Retention for power users |
| 16 | Prompt queue (§11) | 2–3 | Low — advanced workflow | Defer until §6 + §7 land |

---

## §16 Top 5 BUILD ship-first recommendations

Bundled so each is a coherent 1–2 session sprint.

### Bundle A — "Make the chain visible" (the audit unlock)

- §3.2 — tool-call chain drill-in.
- §3.5 — typographic attribution.
- §4.2 — session artifacts panel.

**Total:** 3–4 sessions. Single bundle. The product payoff is that
operators can *audit the agent's work before approving it* without
admin flags. This is the single highest-leverage BUILD change
because it unlocks every trust-dependent follow-on.

### Bundle B — "Artifact as a first-class object"

- §6.1 — artifact drawer shell.
- §3.7 — inline citations.
- §6.2 — diff rendering in drawer (SOPs first).

**Total:** 5–6 sessions. Depends on Bundle A landing for
attribution grammar.

### Bundle C — "Trust-but-verify write ritual"

- §5.1 — tiered permissions.
- §7.1 — Try-it composer.
- §5.2 — dry-run-before-write (for system-prompt changes only).

**Total:** 3–4 sessions. Independent of A and B.

### Bundle D — "Reduce friction in long sessions"

- §3.3 — queued follow-ups.
- §2.1 — session-list task board.
- §3.6 — accept/discard/try-again on audit rows and test results.

**Total:** 3–4 sessions. Lowest risk, nice compounding-velocity
items.

### Bundle E — "Onboarding + posture"

- §10.1 + §10.2 — posture banner + brownfield opportunities.
- §13.1 — remembered preferences card.
- §4.3 — context card.

**Total:** 3–4 sessions. Biggest impact on first-time-in-BUILD
experience and on re-engagement ("I opened BUILD and it knew what
was useful to me").

---

## §17 Deferrals — explicitly out of scope here

Items the brainstorm considered and decided against, or held for
later. Documented so they don't get re-litigated:

- **Full raw-prompt Canvas (§8.1).** Operator signal hasn't surfaced
  that admin-operator prompt editing is a bottleneck. Ship §8.2
  (minimum-viable editable drawer) first.
- **Test matrix (§7.2 + §5.2 full version).** High value, big lift.
  Depends on a `TestCanon` model and agreement on what the canonical
  test set is. Hold for after test-from-conversation (§7.3) ships
  and we have organic test cases to harvest.
- **Trace time-travel (§9.2).** Valuable but the prerequisite
  (per-artifact version lookup by timestamp) is a backend project of
  its own. Ship flat operator-visible trace (§9.1) first.
- **Prompt queue (§11).** Overlaps conceptually with plan-mode for
  new operators; wait until post-plan-mode-editable (§3.1) so the
  mental models don't collide.
- **Whole-app dark mode.** Out of scope for the BUILD brainstorm —
  belongs on the global-shell roadmap.
- **Editable plans with `revise_plan` tool (§3.1 advanced).** The
  UX win is real but the backend adds a new agent-path with its own
  set of validators. Hold until we've measured how often plans are
  rejected-and-re-proposed in practice.

---

## §18 Open questions for owner

Before scoping any bundle into a sprint, the brainstorm leaves
these questions on the table:

1. **Should the tool-call drill-in (§3.2) ship at the operator tier
   or stay admin-gated?** The default recommendation above is
   operator-tier because audit is the point — but there's a legit
   argument that some tool payloads leak information the operator
   shouldn't see (raw model outputs, other tenants' data, etc.).
   Sanitisation layer is the cheapest path; confirm it's feasible.
2. **Artifact drawer edit-path (§6.1): viewer-only or inline-edit?**
   Recommendation is viewer-only — edits happen in the dedicated
   Tuning pages we already have. But if the vision is "BUILD is the
   one-stop surface," inline-edit in the drawer is a meaningful
   expansion. Which direction the next two quarters runs changes
   the scoping significantly.
3. **Per-item plan approval (§3.1 cont.) — worth the backend
   refactor?** This is the most backend-heavy single idea in this
   file. Needs a call on how often plans in practice have items
   the operator would approve selectively vs all-or-nothing.
4. **Try-it composer (§7.1): on every session, or opt-in?** On
   every session it's ambient and discoverable. Opt-in it doesn't
   distract from the main chat. Depends on whether BUILD's core
   audience is operator-day-one (needs ambient) or operator-month-3
   (wants a clean surface).
5. **Dry-run-before-write (§5.2) — default on, or explicit?** It
   doubles the latency for every approved plan. Recommendation is
   opt-in initially, then promote to default once we measure. Asks
   for confirmation on the roll-out shape.
6. **How much of this stack belongs behind a feature flag?** The
   artifact drawer, for example, could ship to all operators or
   stay gated while a subset smoke-tests it. Current admin-only
   flag pattern (traceViewEnabled, rawPromptEditorEnabled) is a
   proven primitive — use it or widen?
7. **Sprint 050 pivot vs finish-correctness-first.** The NEXT.md
   carried forward from sprint-049 lists six correctness
   candidates. This brainstorm is UX. Owner decides whether any
   UX bundle jumps the correctness queue or waits behind it.

---

End of BUILD deep-dive brainstorm. Pair file:
[`ui-ux-brainstorm-frontend.md`](./ui-ux-brainstorm-frontend.md).
