# Sprint 03 — Design Notes

> Source of visual/UX truth for the `/tuning` surface implementation.
> Two design passes consolidated below: (a) the general-purpose design subagent
> (architecture + typography/spacing/color tokens) and (b) the
> `ui-ux-pro-max:ui-ux-pro-max` skill (Swiss Modernism 2.0 direction, rule
> checklist).

## Core thesis

Lab notebook, not ticketing queue. Managers arrive maybe twice a day, spend
90 seconds per suggestion thinking, then leave. Surface earns its keep
through legibility, not density. References: **Claude Console** (generous
single-column gutter, restrained accent blue), **Linear changelog** (serif
headline + sans body rhythm, timestamp micro-meta), **Stripe Docs** (calm
monospace code blocks on hairline borders).

Serif (Playfair Display) reserved for identity moments (page H1, dashboard
titles). Everywhere else is Plus Jakarta Sans.

## Information architecture

Three regions at 1280+:

- **Left rail** (280px, sticky): pending-suggestions queue grouped by
  trigger event. A reserved lower section titled "Conversations" is ghosted
  for sprint 04. A slim top strip holds `Tuning · History · Capability
  requests` as quiet text links.
- **Center** (fluid, max-w-3xl centered): detail panel. One suggestion at a
  time, vertical scroll, no horizontal overflow except inside DiffViewer.
- **Right rail** (320px, collapsible, auto-collapsed <1024px): Velocity on
  top, Graduation below, hairline separator.

`/tuning/history` and `/tuning/capability-requests` are full-bleed sibling
pages — same top nav, no left rail, same max-w-3xl center column. Turning
pages in a notebook, not switching apps.

Below 768px the left rail becomes a top drawer (Sheet) triggered by a
queue-count chip.

## Typography scale

| Role | Class | Face |
|---|---|---|
| Page H1 | `text-3xl font-normal tracking-tight` | Playfair |
| Section H2 | `text-lg font-medium` | Jakarta |
| Card / suggestion title | `text-base font-medium` | Jakarta |
| Body / rationale prose | `text-[15px] leading-7` | Jakarta |
| Caption / label | `text-sm` | Jakarta |
| Micro-meta | `text-xs tracking-wide uppercase text-muted-foreground` | Jakarta |
| Code / diff | `font-mono text-[13px] leading-6` | ui-monospace stack |

## Spacing scale

Habitual steps: 4 / 6 / 8 / 12 / 16 / 24. Rule: every content block gets at
least `py-6` internal and `space-y-8` between blocks in the detail panel.
Queue items stay tight (`gap-3` — navigation, not reading). The air between
the detail column and the rails is the single most important editorial
signal.

## Color tokens (added on top of existing `--background: #FAFAF9`)

| Token | Hex | Use |
|---|---|---|
| canvas | `#FAFAF9` | page background (existing `--background`) |
| surface-raised | `#FFFFFF` | detail panel card, dashboard cards |
| surface-sunken | `#F5F4F1` | diff viewer gutter, code blocks, empty pills |
| ink | `#0C0A09` | primary text (existing `--foreground`) |
| ink-muted | `#57534E` | secondary text (darker than `--muted-foreground`) |
| hairline | `#E7E5E4` | borders, separators (existing `--border`) |
| accent | `#1E3A8A` | primary interactive — warm ink blue |
| accent-soft | `#EEF2FF` | selected queue item, hover wash |
| diff-add-fg | `#065F46` | insertion text |
| diff-add-bg | `#ECFDF5` | insertion background |
| diff-del-fg | `#9F1239` | deletion text |
| diff-del-bg | `#FEF2F2` | deletion background |

**Category pills** (all `text-[11px] px-2 py-0.5 rounded-full`):

| Category | bg / text |
|---|---|
| SOP_CONTENT | `#FEFCE8` / `#854D0E` |
| SOP_ROUTING | `#FFF7ED` / `#9A3412` |
| FAQ | `#F0FDFA` / `#115E59` |
| SYSTEM_PROMPT | `#EFF6FF` / `#1E40AF` |
| TOOL_CONFIG | `#F5F3FF` / `#5B21B6` |
| MISSING_CAPABILITY | `#FDF2F8` / `#9D174D` |
| PROPERTY_OVERRIDE | `#ECFEFF` / `#155E75` |
| NO_FIX | `#F5F4F1` / `#57534E` (sunken — featureless) |
| Legacy (null) | `#F5F4F1` / `#57534E` — reuses NO_FIX treatment, reads "Edit" |

Accent justification: warm ink blue pairs with cream without going
navy-corporate; obsidian removes the interactive signal on primary CTAs.

## Component hierarchy

- **QueueGroupHeader** — collapsible trigger-event header, count badge, chevron
- **QueueItem** — row: category pill (or plain "Edit" legacy), one-line
  title, relative time, optional confidence bar
- **DetailPanel** — center card; hosts Title → Meta row → RationaleBlock →
  DiffViewer → EvidencePane trigger → AcceptControls
- **DiffViewer** — word-level diff, monospace, sunken gutter, copy button
- **RationaleBlock** — prose; `prose prose-stone` overrides
- **EvidencePane** — right-side Sheet, tree of source messages/SOPs with inline excerpts
- **AcceptControls** — primary "Apply now", secondary "Queue for next batch",
  tertiary ghost "Edit proposal"
- **CategoryDispatchDialog** — shared Dialog shell; body swaps between SOP
  (status + property selects) and Tool picker
- **StatPill / ConfidenceBar / RelativeTime / CategoryPill** — atomic.
  ConfidenceBar is a 48px hairline bar, not a percentage number
- **VelocityDashboard / GraduationDashboard** — small-multiple sparklines,
  no axes, one headline number each
- **HistoryRow / CapabilityRow** — single-line, inline actions on hover

## Interaction patterns

- **Keyboard:** `j`/`k` queue selection, `Enter` focus detail, `a` accept,
  `e` edit, `r` reject, `?` shortcuts sheet
- **Empty state:** center-aligned, serif, "All caught up." + one line of
  neutral copy, no illustration
- **Loading:** Skeleton on first paint of queue only; in-panel transitions
  use a 150ms opacity fade
- **Errors:** inline banner above the affected block,
  `bg-rose-50 text-rose-900`, dismissable — never a modal
- **Cooldown:** soft italic caption under AcceptControls — "Recently
  accepted. Next tuning window in 12 min." — no disabled button spinner

## Chat seam (sprint 04)

Left rail reserves a lower section below the queue, separated by a
full-width Separator, header "Conversations" in micro-meta style, single
muted line: **"Coming soon — chat with your tuner."** Height ~120px so
sprint 04 can drop a ScrollArea of conversations in without reflowing the
queue.

## Micro-copy register

Voice: calm, literate, first-person-plural when editorial, second-person
when actionable. No exclamation marks.

- Empty: *"All caught up. We'll surface the next suggestion when one's ready."*
- Accept toast: *"Applied. The guest-messaging AI will use this on the next reply."*
- Rollback warning: *"Rolling back restores the previous version verbatim.
  Any suggestions accepted since will remain in history but won't be
  re-applied."*
- Reject: *"Dismissed. Similar suggestions will be less likely."*

## Legacy-row fallback rules (non-negotiable)

- `diagnosticCategory === null` → render category pill as neutral "Edit"
  using the Legacy treatment; do NOT show sub-label or confidence
- `confidence === null` → omit the ConfidenceBar entirely, not "0%"
- `diagnosticSubLabel === null` → omit the micro-meta line
- `triggerType === null` → group under a "Legacy" trigger at the bottom of
  the queue; collapsible the same way as other groups
- `evidenceBundleId === null` → hide the "View evidence" affordance; the
  detail panel still renders rationale + diff (if `beforeText`/`proposedText`
  are present). If neither is present, detail panel shows a calm note:
  *"This is a legacy suggestion. Accept/Reject still work."*

## UX rule references (ui-ux-pro-max skill)

Applied from the rule quick-reference:
- **§1 Accessibility:** focus rings visible, keyboard nav preserves order,
  aria-labels on icon-only buttons, WCAG AA on text
- **§5 Layout:** mobile-first breakpoints (375/768/1024/1440); no horizontal
  scroll; container `max-w-3xl` in the detail; z-index scale 0/10/20/40/100
- **§6 Typography:** line-height 1.5+ on prose, line-length 65-75ch in the
  rationale block, semantic color tokens (defined above)
- **§7 Animation:** 150-300ms micro-interactions; only transform/opacity;
  respect prefers-reduced-motion
- **§8 Forms:** visible labels, inline validation on blur, aria-live on
  error regions, confirm before destructive rollback

## Reference images

- Claude Console (console.anthropic.com) — gutter generosity, restrained blue
- Linear changelog (linear.app/changelog) — serif headline + sans body
- Stripe Docs (stripe.com/docs) — monospace code blocks, hairline borders

## ui-ux-pro-max system output (raw, for traceability)

Pattern: Swiss Modernism 2.0 direction — grid system, modular, mathematical
spacing, editorial. Avoid excessive decoration. Pre-delivery checklist:
no emojis as icons; cursor-pointer on all clickables; hover transitions
150-300ms; WCAG AA; focus visible; reduced-motion respected; responsive
breakpoints covered.
