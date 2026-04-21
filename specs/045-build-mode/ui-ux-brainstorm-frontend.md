# UI/UX brainstorm — whole-frontend map

> Opinionated, expert-level synthesis across every major operator-facing
> surface in GuestPilot v2. Primary source: the
> [design-patterns research report](/uploads/Design patterns for AI-first operator apps .md)
> cross-referenced with the [sprint-049-explore-report.md](./sprint-049-explore-report.md)
> code-level audit. Partner file for the BUILD/Studio deep-dive is
> [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md).
>
> This is raw material for sprint-050+ UI/UX scoping. Not a
> scope doc — every item here needs owner sign-off before it
> becomes work. Items cite reference patterns by product
> (Cowork, Superhuman, Linear, Granola, etc.) so the provenance
> stays legible.
>
> Not implementation-specific. Reads best as a menu.

---

## §0 Guiding thesis

Treat **every AI draft — and every rule, SOP, FAQ, or tool-config the
agent writes — as a provenanced, editable, rejectable artifact, not as
text in a box.** Every feature decision below should pass that test.
Where it passes: ship. Where it doesn't: defer and rescope.

The central shift is from "AI is a sidebar feature bolted onto a CRUD
inbox" to "the product surface is organised around audit + editable
agent output." This changes layout, keyboard grammar, empty states,
and error handling — not just the Copilot bubble.

---

## §1 Operating principles (apply across every surface)

Seven cross-cutting rules that every surface below inherits. Violations
should surface during design review, not shipping.

1. **Typographic attribution.** AI-generated text is visually distinct
   from human text. Granola's model: human-typed is black (primary
   colour), AI-generated is medium-grey. Editing an AI span flips it to
   black character-by-character. No "AI wrote this" banner, no diff
   viewer, no modal — one type-colour rule replaces five chrome
   layers.
2. **Tiered permission model.** Three tiers: (a) safe reads auto-run,
   (b) writes show preview + one-click confirm, (c) destructive
   actions (send to guest, refund, cancellation, bulk apply) require
   double-confirm via typed "Proceed" or Cmd+⏎. Matches Cowork's
   auto-mode three-tier model. Critically: **do not default to "Always
   allow"** — keep per-action confirm the default until the operator
   explicitly opts into auto mode.
3. **Preview-before-commit default.** AI output NEVER mutates an
   outbound field, editable text, or persisted rule until the
   operator explicitly commits. The Notion pattern: distinct bubble
   with Accept / Discard / Try again. No implicit accept on tab-away.
4. **Context-scoped right rail.** Per Cowork: Progress + Artifacts +
   Context + Connectors re-render when the focused row changes. Not
   a global tool panel. Every surface that shows AI activity has a
   right rail that reflects the _active_ conversation/thread/session.
5. **Keyboard-first for high-volume surfaces.** Inbox, Tuning, and
   Copilot review must be fully operable without a mouse.
   Single-keystroke triage verbs with auto-advance (Linear pattern),
   consistent across surfaces. Palette (Cmd+K) shows mouse
   action + keyboard shortcut side by side.
6. **Click-to-source on every factual claim.** Any AI-generated line
   that cites a fact (check-in time, refund policy, amenity) hyperlinks
   to the exact source region (SOP variant line, FAQ entry, property
   rule). Granola-style: hover shows magnifier; click scrolls source
   to the quoted span. If the AI can't source it, the claim renders
   with an explicit "inferred" badge.
7. **Plan mode before bulk writes.** Any action that affects more than
   one guest, one rule, or one artifact shows a numbered plan (Lovable
   + Cursor pattern) that the operator edits, approves, then watches
   tick to completion. Plan is an editable markdown artifact — not a
   modal dialog.

---

## §2 Inbox — **rebuild target**

Single surface where incremental polish won't close the gap. Operators
live here 8 hours a day processing 200+ conversations across 4
channels. Current inbox (`inbox-v5.tsx`) is a reasonable thread list +
detail split, but the density, keyboard grammar, and pre-computed
draft surface aren't in a state you can layer onto.

**Primary references.** Linear (density + triage), Superhuman (AI +
keyboard grammar), Cowork (right rail), Granola (attribution).

### Thesis
The inbox is the operator's cockpit. It should feel closer to Linear
than to Gmail. Every design decision gets ranked by whether it
preserves 3-5× velocity at 200 threads/day.

### Ideas (ranked by operator impact)

1. **Superhuman-style pre-computed inline drafts with Tab-cycles.**
   On receipt of a new guest message, three full-length AI drafts
   render under the last guest bubble. Tab cycles, Enter sends, any
   other keystroke drops into edit mode with the cycled draft as
   seed. Critical: drafts pre-computed **before** the operator opens
   the thread — perceived latency is zero. Quality floor matters more
   than variety; three shouldn't feel like Russian roulette.
   Effort: **L**. Gotcha: needs debounce-safe pre-compute pipeline
   and cache invalidation on new messages.

2. **Single-line thread rows with metadata ribbon, 28-32px row
   height.** Channel icon | guest name | property chip | arrival-date
   pill | sentiment dot | AI-draft-status dot | last-message snippet.
   Linear standard. Space to peek without leaving list; Enter to open;
   J/K to navigate; selection survives list refresh. Auto Summarize
   line below the guest name (i to expand).
   Effort: **L**. Gotcha: AI-draft-status dot semantics need design
   (drafting / ready / stale / rejected).

3. **Single-keystroke triage verbs with auto-advance.** Linear model:
   `1` send AI draft and close, `2` mark duplicate, `3` escalate
   (forces a free-text note), `H` snooze with smart presets, `E`
   archive. Auto-advance to next row. Commits audit trail per action.
   Effort: **M**. Gotcha: auto-advance must preserve logical selection
   when the list re-sorts — operator mental model breaks if the next
   row is different than expected.

4. **Split Inbox as saved, AI-defined views.** Default tabs: Airbnb /
   Booking / WhatsApp / Direct (1-5 to switch). Plus custom tabs:
   "Arriving today + unresolved," "VIP return guests," "Refund risk,"
   "Awaiting doc." Saved as named views, optionally auto-updated by an
   agent pass. Cap visible tabs at 7; overflow in a picker.
   Effort: **M**. Gotcha: too many tabs creates its own mental tax;
   start with the channel defaults and add custom slowly.

5. **Auto Summarize under every thread row.** One-line AI summary in
   the metadata ribbon (e.g., "Guest asking about late check-in,
   already approved by manager on prior stay"). `i` expands to a
   three-line summary in the detail pane. Refreshes on every new
   message. Superhuman standard. Effort: **M** (needs a cheap
   summarisation pass). Gotcha: stale summaries destroy trust —
   invalidate aggressively.

6. **Cmd+A bulk actions with verb shortcuts.** Select multiple
   threads (Cmd+A / Shift+click / visual-mode J-K-with-shift), then
   apply a verb: `T` tag, `S` snooze, `3` bulk-escalate. Confirmation
   dialog for bulk destructive sends. Matches Linear triage.
   Effort: **M**. Gotcha: bulk send is destructive — mandatory
   double-confirm per the tiered-permission rule.

7. **Persistent live artifacts as operator dashboards.** Cowork's
   MCP-refreshable artifact primitive applied to inbox-adjacent
   surfaces. "Today's flagged conversations," "Tomorrow's
   arrivals," "This week's refund-risk threads" — each a reopenable
   HTML card that refreshes via the PMS/Hostaway connector on every
   open. Sidebar entry "Dashboards" for the reopen list.
   Effort: **L**. Gotcha: artifact sub-agent MCP inheritance is still
   broken per research report §2; tool calls run host-side.

8. **Per-thread context rail (right side).** Scopes to the focused
   thread. Sections: Active Reservation (dates, property, guest
   profile), House Rules excerpts (the specific rules likely to apply),
   Screening Status (passport received, marriage cert pending), Prior
   Interactions, Connected Channels (disconnect per chip). All
   clickable, all link to source.
   Effort: **L**. Gotcha: don't let this become a dumping ground —
   every section earns its slot by proving it's referenced during
   review at least once per 50 threads.

9. **Thread peek without leaving list (Space).** Hold Space to
   preview the thread in an overlay; release to dismiss. Enter to
   open fully. Superhuman + Linear share this pattern.
   Effort: **S**. Gotcha: overlay must respect active composer state
   — don't trap focus.

10. **Visible confidence indicator on pre-computed drafts.**
    Perplexity gap: primary-source-grounded drafts render with a
    green provenance pin; inferred drafts render with an amber pin.
    Operator knows at a glance whether to audit carefully or trust.
    Effort: **M**. Gotcha: requires the AI pipeline to expose a
    confidence/source-type signal — currently implicit.

11. **Dead-thread decay with visible countdown.** Threads untouched
    for N days auto-archive; show countdown in the row ("auto-closes
    in 2d"). Operator can pin to override. Reduces triage load.
    Effort: **S-M**. Gotcha: escalated threads must be excluded;
    pinning UX must be obvious.

### Out-of-scope for now
- Threading multi-reservation conversations into a single row (could
  be valuable; complex data model change; defer).
- Guest-facing reply-quality rating collected in-inbox (valuable for
  tuning loop; separate feature).

---

## §3 Thread view — polish + one selective rebuild

Thread view is the detail pane showing the full conversation + the
Copilot draft. It's half polish (typographic attribution, inline
chips, sticky header) and half rebuild (the Copilot bubble, detailed
in §4).

### Ideas

1. **Granola-style typographic attribution across the full history.**
   AI-sent messages render in a subtle grey-ish tone; manager-edited
   hybrid messages render black; pure human-typed messages render
   black. On an edit of a previously-AI bubble, the edited span flips
   visibly. Effort: **S-M** (mostly CSS + metadata plumbing).
   Gotcha: must survive Markdown / rich-text paste cleanly.

2. **Sticky guest-profile header.** Always-visible one-line summary
   at top of the thread: guest name | property | arrival | VIP?
   refund-risk? | AI-summary one-liner | language. No pagination
   disrupts it. Effort: **S**. Gotcha: don't let it grow — cap at
   one line.

3. **Inline doc chips for screening status.** Passport ✅ | Marriage
   cert ⏳ | Deposit pending. Clickable, opens the doc. Effort: **S**.

4. **Inline translation toggle** (feature 042 already shipped; this
   is a polish pass). Granola-style underline on translated spans;
   tooltip shows source. One keystroke toggles thread-wide.
   Effort: **S**.

5. **Per-message tool-call chain expansion.** Every AI message shows
   a chevron; expand to see "Read reservation #1234 • Checked house
   rules §3 • Applied skill: late-checkout-v3 • Drafted reply."
   Chevron collapsed by default; expand remembers per-message.
   Effort: **M**. Gotcha: noisy with many steps — hide internal
   tools, keep human-readable descriptions.

6. **Jump-to-claim from every factual statement.** Granola-style:
   hover "check-in is at 4pm" → magnifier icon → click scrolls to
   House Rules §3 line 12 in a side drawer. Effort: **M**. Gotcha:
   requires claim-level source tracking — AI must emit spans with
   source anchors, not just text.

7. **Message-level skill badge.** Discrete chip on each AI message:
   "Used: Airbnb late-checkout v3." Click opens source in drawer.
   Effort: **S-M**. Gotcha: version pinning — if the skill moves,
   the badge reference should point at the version used at send
   time, not current.

---

## §4 Copilot bubble (AI draft surface) — polish + one selective rebuild

The single most-viewed AI surface in the product. Every operator sees
it dozens of times per hour. Polish here has the highest visible-impact
per line-of-code ratio in the entire product.

**Primary references.** Granola (attribution), Superhuman (inline
drafts), Canvas (highlight-to-prompt), Notion (preview-before-commit),
Cowork (tool-call chain), Perplexity (follow-up chips).

### Ideas (ranked)

1. **Grey-for-AI typographic attribution inside the bubble.** Every
   character the AI wrote is grey; every character the operator
   types flips black. Edit-on-blur detection, character-granular
   paint. Effort: **S-M**.

2. **Collapsed tool-call chain above the draft.** "Read reservation
   #1234 • Checked house rules • Applied skill: late-checkout-v3 •
   Drafted reply." Chevron expand for per-step detail. Cowork model
   ported in. Effort: **M**. Gotcha: tool naming must be operator-
   facing, not engineer-facing ("Read reservation" not
   "hostaway.getReservationById").

3. **Skill badge with version pin.** Chip on the bubble: "Airbnb
   late-checkout v3." Clickable → opens the skill source in a side
   drawer. Shows version at time of draft. Effort: **S-M**.

4. **3-5 follow-up chips below the draft.** "Make firmer," "Offer
   10% credit," "Translate DE," "Ask for booking ID," "Cite house
   rules §3." One click regenerates with that modifier; original
   draft archived, not overwritten. Perplexity + Bolt pattern.
   Effort: **S-M**. Gotcha: chips must be thread-context-aware, not
   static — a "Translate DE" chip only shows if the thread language
   differs.

5. **Preview-before-commit semantics.** Draft never mutates the
   outbound field. "Send" is an explicit commit; "Accept into
   composer" is the alternative for edit-before-send. Notion model.
   Effort: **S**. Gotcha: avoid Notion's own mistake of duplicate
   CTAs ("Accept" vs "Insert below" — one commits, which?). Pick
   one primary verb and stick with it.

6. **Highlight-to-prompt inline editing — the one rebuild.** Select
   a span in the draft → floating Ask AI button → chip choices
   (Shorten / Lengthen / More formal / Translate) + free-text. On
   apply, changed span briefly highlights green-add + red-strike
   (Canvas style) before commit. Effort: **L**. Gotcha: requires
   selection-scoped regeneration — not the current stack's
   behaviour. Most complex item in this surface; defer if tight.

7. **Destructive-send double-confirm.** For high-stakes sends —
   refunds, cancellations, bulk sends, sends to guests marked
   sensitive — require typed "Send" or Cmd+⏎ after the initial
   click. Cowork deletion-protection model. Effort: **S-M**.
   Gotcha: tune the sensitivity rules or operators will feel
   babysat.

8. **Confidence/provenance dot.** Primary-source-grounded = green
   dot; inferred from context = amber dot; generic = grey dot. Hover
   explains. Effort: **M**. Gotcha: requires pipeline to expose
   provenance signal.

9. **Auto-queued refinement while draft regenerates.** Operator
   types a refinement while the draft is regenerating from the
   previous chip; input joins an ordered queue, visible above the
   composer with delete-X per item. Windsurf pattern. Effort:
   **M**. Gotcha: queue visibility must be obvious or it feels like
   dropped input.

---

## §5 Tuning page — **rebuild target**

Operators reviewing tuning suggestions is where most products fail
silently. A flat list of "approve / reject" rows doesn't surface
enough context to trust the suggestion. Rebuild around the artifact
primitive.

**Primary references.** Cowork (artifacts), Canvas (diff preview),
Notion (preview-before-commit), Perplexity (follow-up chips), Linear
(triage verbs).

### Thesis
Each tuning suggestion is a **reopenable micro-artifact** with a
preview of what would change. Accept promotes to live rule; Dismiss
feeds training signal; operator can edit-before-apply.

### Ideas

1. **Each suggestion renders as an artifact card, not a row.** Card
   shows: proposed change summary (one line), diff preview (Canvas
   green-add/red-strike against current state), source trigger (link
   to the message that generated it), skill/category badge,
   confidence indicator, and three actions: Accept, Edit, Dismiss.
   Effort: **L**. Gotcha: diff preview needs the artifact domain
   (SopVariant / FaqEntry / ToolDefinition / TenantAiConfig) to expose
   a diff-renderable shape.

2. **Canvas-style diff on the artifact.** Current rule on the left,
   proposed on the right; inline green-add / red-strike. For FAQ:
   diff on the answer text. For SOP: diff on the variant body. For
   ToolConfig: diff on the config JSON.
   Effort: **M** once the artifact card is in place.

3. **Edit-before-apply.** Click Edit on the artifact card → inline
   editable composer with the proposed change. Changes the diff
   preview live. Accept commits the edited version, not the
   original. Effort: **M**. Gotcha: "Edit" vs "Accept with edits"
   semantics must be one path, not two.

4. **Explicit confidence indicator.** Every suggestion shows its
   confidence score (derived from EDIT/REJECT similarity bucket +
   acceptance-history bucket). Green / amber / red dot at the top-
   right of the card. Effort: **S-M** (signal exists; needs UI).

5. **Click-to-source on the trigger.** "This was triggered by Thread
   #5821, Message #18,392" → click opens the source thread + jumps
   to the exact message in the inbox detail pane.
   Effort: **S**. Critical for trust.

6. **Follow-up chips on the card.** "Narrow to Miami Beach only,"
   "Require status CHECKED_IN," "Reword more formal," "Split into
   two rules." One click regenerates the suggestion with that
   scope. Effort: **M**. Gotcha: chip semantics per artifact
   domain — FAQ chips differ from SOP chips.

7. **Rationale free-text on reject.** Explore report P2-9 related:
   rejection should capture free-text rationale. Already half-shipped
   on the backend; UI adds an inline text field that commits with
   the Dismiss action. Effort: **S**. Operator impact: huge —
   rationale feeds the cross-session rejection memory.

8. **Suppressed drawer with count badge.** AUTO_SUPPRESSED
   suggestions are hidden by default; a count badge on the nav
   ("23 suppressed this week") opens a drawer. Operator can
   promote any to PENDING. Explore report P2-5.
   Effort: **S-M**.

9. **Bulk triage with verb shortcuts.** Cmd+A to select multiple
   suggestions; `1` accept, `3` dismiss (forced rationale), `S`
   snooze. Matches inbox verbs. Effort: **M**. Gotcha: destructive
   bulk-accept double-confirms.

10. **DB-backed `TUNING_DIAGNOSTIC_FAILURE` badge on the tuning
    nav.** Sprint-049 A7 shipped the log-tag half; sprint-050 §1.6
    NEXT.md candidate is the DB half with badge. Belongs here.
    Effort: **M-L**. Operator impact: turns silent pipeline outages
    into visible signal.

11. **History view: what's been applied, when, by whom.** Chronological
    feed of accepted suggestions, filterable by category/skill/
    tenant/operator. Effort: **M**. Gotcha: merge with existing
    history surfaces (there's already a `/tuning/history` route).

---

## §6 Studio / BUILD page

See [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) for the
full deep dive. Summary: Studio is the single surface most analogous
to Cowork itself and the biggest opportunity for three-pane-agent-UI
patterns.

---

## §7 Properties / Reservations / Screening

Mostly polish work. These surfaces exist as data management screens;
the opportunity is to bring them into the rest of the product as
**context** rather than as separate sub-apps.

### Ideas

1. **Context rail presence on every thread view.** The active
   property, reservation, and screening docs for the focused thread
   appear as chips in the right rail. Click chip → opens the
   underlying record in a side drawer, not a new page. Effort:
   **M**. Gotcha: data model must support "what property is this
   thread about" cleanly.

2. **Property rules as artifacts (reopenable cards).** Each property
   has a rules card: check-in time, Wi-Fi, parking, quiet hours.
   Reopenable, editable, version-tracked. Mirrors the artifact
   primitive from Cowork. Effort: **M-L**.

3. **Screening status as progress rail.** Per-reservation: passport
   ✅ | marriage cert ⏳ | deposit ✅ | damage waiver ○. Clickable.
   Same visual language as Cowork's TodoList widget. Effort:
   **S-M**.

4. **Property custom knowledge base as an artifact.** Today it's a
   JSON field on Property. Surface it as an editable card with
   markdown editing, section-level diff on save. Effort: **M**.

5. **One-click disconnect on channel chips.** Cowork's "Active
   Folders" pattern applied: each connected channel per property
   renders as a chip with a disconnect affordance on hover. Makes
   the connector surface legible. Effort: **S**.

6. **Calendar embed in the reservation detail.** Hostaway calendar
   iframe or native calendar view to show availability around the
   reservation. Operator can see conflicts inline. Effort: **M-L**.

---

## §8 Settings

Flat forms today. Mostly stay that way — operators don't live here.
One meaningful addition: the tiered-permission table.

### Ideas

1. **Tiered-permission table (Cowork auto-mode ported).** Three
   columns: Auto / Confirm / Double-confirm. Rows: every AI action
   the product can take — send to guest, translate, summarise,
   refund, cancel, bulk apply, update rule, delete artifact. Each
   cell is a radio button. Default config is sensible conservatism;
   operator opts into auto where they want it. Effort: **M-L**.
   Gotcha: the underlying action registry must exist — some of these
   actions are currently implicit.

2. **Keyboard shortcut reference sheet.** Cmd+? opens a modal with
   every shortcut grouped by surface. Linear standard. Effort: **S**.

3. **Skill / tool management surface.** Mirror Cowork's Settings →
   Skills: toggle-per-skill with source preview, version history.
   Effort: **M-L**. Gotcha: duplicates the existing Tools
   management page — consolidate.

4. **Permissions audit log.** When an operator changes a
   permission (auto → confirm, or vice versa), log it. Admin view
   shows who changed what when. Effort: **S-M**.

5. **Notification preferences.** Which events push, which email,
   which web-push, which sms. Per category (mentions, escalations,
   bulk-complete, diagnostic failures). Effort: **S-M**.

---

## §9 Global shell

App chrome, nav, keyboard model, command palette, notifications,
theme.

### Ideas

1. **Linear-style command palette (Cmd+K).** Action list with
   **inline keyboard shortcut hints** per entry. Onboarding-by-
   exposure. Effort: **M**. Gotcha: palette entries must be
   context-aware — if the operator is focused in the inbox, inbox
   actions rank first.

2. **Unified notification center.** Replace the push-only model
   with an in-app notification center categorised by type: mentions,
   escalations, scheduled-task-done, tuning-failure, diagnostic-
   failure, system. Effort: **M-L**.

3. **Dense vs comfortable toggle.** Global density setting for the
   inbox list + tuning cards. Linear has this. Effort: **S**.

4. **Dark mode.** Table stakes. Effort: **S-M** (depends on current
   design system). Gotcha: typographic attribution (§1.1) needs a
   grey that works against both palettes.

5. **Breadcrumb + back-stack.** Consistent "where am I / how did I
   get here" across side drawers. Esc always steps back one layer.
   Effort: **S-M**.

6. **Scheduled task surface.** Claude Cowork's Scheduled entry
   pattern — a surface showing scheduled automations (daily digest
   ping, weekly refund-risk sweep, SLA-breach check). Each task is
   reopenable + pauseable. Effort: **M-L**. Gotcha: the debounce poll
   is sort of a scheduled task but not presented that way.

7. **Global activity indicator.** Streaming banner at top when any
   agent action is in flight product-wide ("BUILD running: updating
   late-checkout rule — 12s elapsed"). Clickable to jump to the
   source. Windsurf ambient-surface pattern. Effort: **M**.

---

## §10 Cross-cutting polish

Patterns that aren't surface-specific but need a product-wide
convention.

1. **Toast system standardisation.** Use sonner (already in use).
   One primary toast + max one secondary at a time. No stack of six.
   Dismissable. Consistent placement (bottom-right). Include retry
   action where applicable. Effort: **S**.

2. **Empty state thesis.** Every empty state should be context-
   contingent, not static. "No flagged threads today" → suggests
   "Review yesterday's archived" as the next action. Cowork's
   starter-card pattern. Effort: **S-M** per surface.

3. **Loading state thesis.** Skeletons > spinners. Per-surface
   skeletons that mirror the final layout. Avoid full-screen
   loaders. Effort: **S-M**.

4. **Error state thesis.** Every error is actionable. Show the
   error, the likely cause, a retry button, and a "copy diagnostic"
   action for support. No bare "Something went wrong."
   Effort: **S-M**.

5. **Permission-prompt thesis.** Tier-aware (see §1.2). Readable.
   Keyboard-operable (Esc cancels, Enter confirms, Cmd+Enter
   escalates to auto). Button placement: safer choice is default
   selection. Effort: **S-M**.

6. **Composer-level auto-save.** Any in-progress operator draft
   (inbox reply, tuning rationale, BUILD message) survives tab
   close, network blip, refresh. Draft indicator visible. Effort:
   **M**. Gotcha: draft scope (per-thread, per-tab, per-device) is
   a real product decision.

7. **Focus management.** Modals trap focus; Esc closes; first
   focusable element is the primary action. Currently inconsistent.
   Effort: **S-M** (mostly audit + fix).

8. **Accessibility baseline.** Axe-compliant, keyboard-operable
   everywhere, ARIA roles correct, contrast AA minimum. Audit +
   fix pass. Effort: **M-L**.

---

## §11 Prioritisation — impact × effort

Rough map. "Impact" = operators hitting it at 200 threads/day;
"Effort" = implementation days rough-order. Items lower and to the
left ship first.

```
high ↑                  (4, 6, 9, 21) ← Top 4 picks
impact  |  (2, 5, 11, 15)   (1, 3, 14, 17, 22)
        |
        |  (7, 8, 12)       (10, 13, 18, 19, 23)
        |
 low    |  (16, 20)         (24, 25)
        └──────────────────────────→ high effort
```

Numbered (mapping to the item lists above, §-prefixed):

1. §4.1 Copilot grey-for-AI attribution
2. §4.3 Skill badge with version pin
3. §4.4 Follow-up chips below draft
4. §4.2 Tool-call chain above draft
5. §4.5 Preview-before-commit semantics
6. §4.1 (repeat — yes it's that important)
7. §3.1 Typographic attribution across history
8. §3.5 Per-message tool-call chain expansion
9. §5.1 Tuning suggestions as artifact cards
10. §5.2 Canvas-style diff on artifact
11. §5.4 Confidence indicator on suggestions
12. §5.5 Click-to-source on trigger
13. §5.7 Rationale free-text on reject
14. §2.3 Single-keystroke triage verbs
15. §2.5 Auto Summarize per thread
16. §2.1 Superhuman-style pre-computed inline drafts
17. §2.2 Single-line rows with metadata ribbon
18. §2.6 Cmd+A bulk actions
19. §2.7 Persistent live artifacts (dashboards)
20. §2.8 Per-thread context rail
21. §7.1 Context rail on every thread view
22. §8.2 Keyboard shortcut reference sheet
23. §9.1 Command palette (Cmd+K)
24. §9.4 Dark mode
25. §10.8 Accessibility baseline

---

## §12 Top 10 — ship-these-first recommendations

If I had to pick the ten items that unlock the most operator-felt
value per sprint, in ship order:

1. **Copilot bubble polish pack** (grey-for-AI attribution + tool-
   call chain + skill badge + follow-up chips + preview-before-commit).
   Single session, ~3 days. Highest visible-impact per LOC in the
   product. [Items §4.1-§4.5 + §4.7.]
2. **Linear-style keyboard grammar + command palette** with inline
   shortcut hints. Once shipped, operators adapt fast. [§2.3 + §9.1 +
   §8.2.] Single session.
3. **Typographic attribution across thread history** + **sticky
   guest-profile header**. Polish pass that compounds with item 1.
   [§3.1 + §3.2.]
4. **Tuning rebuild — phase 1: suggestion cards with diff preview.**
   Rebuild shift on the single surface that's most broken for trust.
   [§5.1 + §5.2 + §5.5.] One session.
5. **Per-thread context rail on inbox detail view.** [§2.8 + §7.1.]
   One session.
6. **Tuning rebuild — phase 2: confidence + follow-up chips +
   rationale.** [§5.4 + §5.6 + §5.7.] Half session after phase 1.
7. **Inbox density pass: single-line rows + Auto Summarize + Space
   peek.** Plumbing for the full rebuild. [§2.2 + §2.5 + §2.9.]
   One session.
8. **Split Inbox tabs + saved views.** Depends on item 7. [§2.4.]
   One session.
9. **Pre-computed inline drafts (Superhuman-style).** Depends on
   item 7 + pipeline. [§2.1.] One-plus session.
10. **Tiered-permission table in settings.** [§8.1.] Paired with an
    audit of every "silent write" in the product. One session.

---

## §13 Deferrals — worth doing, not soon

Ideas that are good but should not distract from the top 10.

- Full inbox rebuild-to-Linear-density (items beyond item 7 above).
- Full Tuning rebuild beyond phase 2.
- Highlight-to-prompt inline editing in the Copilot bubble (§4.6).
- Live artifacts / dashboards (§2.7).
- Calendar embed in reservation detail (§7.6).
- Notification center unification (§9.2).
- Dark mode (§9.4).
- Accessibility baseline pass (§10.8).
- Global activity indicator banner (§9.7).
- Scheduled-task surface (§9.6).

---

## §14 Open questions for owner

Surface-level decisions I can't make without operator input.

1. **Pre-computed drafts pipeline budget.** Three drafts per inbound
   message has a real token cost. Does the budget hold for 200+
   messages/day/tenant?
2. **Artifact persistence model for tuning.** Do accepted suggestions
   remain reopenable indefinitely, or do they roll off after N days?
3. **Keyboard grammar consistency.** Do we want `1 2 3` as triage
   verbs (Linear), or named-keys (`A R D` — accept/reject/dismiss)?
   Affects muscle memory portability.
4. **Permission defaults.** What's the default tier for a freshly-
   onboarded tenant? Conservative (everything confirm) or generous
   (sends auto)? Determines the onboarding arc.
5. **Typographic attribution — the exact grey.** Needs design/QA on
   both light and dark modes; Granola uses #787878-ish; ours needs
   to pass AA contrast while still reading as "subordinate."
6. **Follow-up chip generation model.** Static per-surface chips, or
   AI-generated per-context? Static is cheaper; AI-generated is
   richer. Suggest starting static.

---

End of brainstorm.
