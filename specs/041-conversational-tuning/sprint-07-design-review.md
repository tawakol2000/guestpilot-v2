# Sprint 07 — Design Review

> Review of `sprint-07-ui-overhaul-design-direction.md` and `sprint-07-ui-overhaul.md` against what ships in top-tier 2026 SaaS (Linear, Stripe, Vercel, Claude Console, OpenAI Platform). Written as a PR-style critique. Citations point at line numbers in the two briefs and at the current `frontend/components/tuning/` files.

---

## 1. Overall verdict

The direction is **fundamentally sound and overdue**. The three critiques that anchor the doc — (a) Playfair is wrong for a tooling surface, (b) uppercase/tracking is a wall of SCREAMING that flattens hierarchy, and (c) warm-stone reads as washed-out beige — are all correct, and fixing them alone would move the surface up a full tier.

Two cautions:

- The doc reads like a visual refresh, but several bullets (Problem 5 "add transitions everywhere", SuggestionCard rebuild, ThinkingSection collapsible with `max-height`) are actually **render/DOM changes**, not CSS. The brief says "no logic changes" (sprint-07-ui-overhaul.md:30) but several of its own instructions require conditional rendering to become always-rendered with `max-height: 0`. Flag below under §6.
- The brief leans on Claude Console and OpenAI Platform, both of which are **builder tools for developers**. GuestPilot `/tuning` is a tool for *property managers* reviewing AI behavior. A little more warmth/friendliness than strict Anthropic-gray would probably land better with that audience. The cool-neutral shift is right; going fully monochrome like OpenAI Platform is not.

Net: ship 70%, iterate on the rest.

---

## 2. Token critique

### Color — `TUNING_COLORS` proposal (design-direction.md:170-190, ui-overhaul.md:55-86)

| Token | Proposed | Verdict |
|-------|----------|---------|
| `canvas: #F9FAFB` | good — Tailwind gray-50, industry default | keep |
| `surfaceRaised: #FFFFFF` | good | keep |
| `surfaceSunken: #F3F4F6` | good | keep |
| `ink: #1A1A1A` | **slightly off**. Linear uses `#0A0A0A`, Stripe `#0A2540`. `#1A1A1A` on `#F9FAFB` is fine (contrast 14.9:1) but softer than the reference. Consider `#111827` (Tailwind gray-900) for a touch more crispness — still 17:1 contrast. | tweak |
| `inkMuted: #6B7280` | good — Tailwind gray-500, 4.83:1 on white. Passes WCAG AA for body. | keep |
| `inkSubtle: #9CA3AF` | **fails AA for body text** (2.85:1 on white). Fine for decorative/hint text ≥ 14px/medium, NOT fine for the message timestamps the brief applies it to. Flag: timestamps are legitimate UI text, not decoration. | document the contract — "use only ≥ 12px medium and only as secondary metadata" |
| `hairline: #E5E7EB` | good | keep |
| `hairlineSoft: #F3F4F6` | **identical to `surfaceSunken`**. If a divider equals a background, it disappears on that background. Separate them: `hairlineSoft: #EEF0F3` or just drop the token and use `divide-y divide-gray-100`. | fix |
| `accent: #6C5CE7` | 4.43:1 on white — **just barely below AA for normal text (4.5:1)**. On a primary button (white-on-accent) it's 4.43:1, which marginally fails. Darken to `#5B4CDB` (contrast 5.31:1) for button bg, keep `#6C5CE7` for underlines/dots/active-rail. The doc doesn't define an `accentStrong`/`accentDarker` — it references `hover:bg-[accentDarker]` in accept-controls.md:135 but `accentDarker` doesn't exist in the token map. | **define `accentStrong: #5B4CDB`**; ui-overhaul.md:135 uses undefined token |
| `accentSoft: #F0EEFF` | good for selected-row bg | keep |
| `accentMuted: #A29BFE` | only 2.7:1 on white — **decorative only**. Fine as a gradient endpoint or left-border-accent. Document. | keep, with contract |
| `diffAddBg: rgba(16,185,129,0.08)` + `diffAddFg: #059669` | 4.54:1 — AA for normal text. Good. | keep |
| `diffDelBg: rgba(239,68,68,0.08)` + `diffDelFg: #DC2626` | 4.83:1 — AA. Good. | keep |
| `warnBg: #FFFBEB` + `warnFg: #D97706` | `#D97706` on `#FFFBEB` is 3.67:1 — **fails AA for body text**. If used only for icons + ≥16px semibold it's OK. Otherwise darken to `#B45309` (5.79:1). | tweak |

### Category palette (ui-overhaul.md:92-101)

- All backgrounds are Tailwind `*-100`-ish pastels; all foregrounds are `*-700`-ish. That's consistent and correct — each pair is AA.
- But **SOP_CONTENT (`#FEF9C3` + `#A16207`)** is the weakest pair at 4.51:1 — right at the edge. Under monitor calibration drift it could fail. Consider `#854D0E` (yellow-800, 6.88:1) as the `fg`.
- Eight categories × pastel + dark-text creates a **hospital-wristband rainbow** when the queue has many items at once. The doc's instruction in queue.md:114-117 ("drop the bordered 'Edit' pill entirely, use a 3px left color bar") is the right call — don't render the pastel pill in the queue list, only in the detail panel where there's one at a time. This conflicts with keeping `CategoryPill` around for queue-row hierarchy. Pick one.

### Typography scale (design-direction.md:170-183)

The scale is tight and right — it mirrors OpenAI Platform's intentional jumps (12→14→16→20→24). Two gaps:

- **No hover/link treatment defined.** If accent is only for buttons, what does a text link look like? Needs a row.
- **`font-mono` size is `text-sm (14px)`** but diff content is dense. 14px mono looks heavy next to 14px sans on the same line. Consider `text-[13px] font-mono` for the diff viewer.
- **No explicit line-heights** — but `leading-relaxed` is mentioned in prose spots. Define once: `leading-6 (24px) for body, leading-5 for captions, leading-7 for prose`.

### Spacing (design-direction.md:186-196)

Clean. The `12-16px` list-item padding is right. **Card internal padding 20-24px conflicts with `shadow-sm rounded-xl p-6`** in detail-panel.md:126 — `p-6` = 24px, at the upper bound. Just pick one target (`p-6` = 24px) and stop specifying ranges.

### Shadows (design-direction.md:199-205)

Fine. One missing level: **focus ring**. `shadow-[0_0_0_3px_rgba(108,92,231,0.25)]` — the doc mentions "focus-within:ring-2 focus-within:ring-[accentSoft]" for the chat input (ui-overhaul.md:146) but doesn't generalize. See §7.

### Animation (design-direction.md:208-216)

- **200ms default is correct.** It's the industry consensus (Linear, Stripe).
- **Hover 150ms** is right for snap.
- **Collapsible 250ms ease-in-out**: good choice of easing (in-out feels organic for reveal). Can feel laggy on long content — consider capping the transition to what's needed (`transition-[max-height,opacity] 200ms ease-out` is snappier).
- **Panel slide 200ms ease-out**: good.
- **Missing**: reduced-motion fallback (see §7), stagger for list items, route transitions.

---

## 3. Component spec critique

### top-nav (ui-overhaul.md:104-112)
Clear enough. One gap: **"active link: underline with accent color, border-b-2"** — on a top nav with backdrop blur, `border-b-2` will clip against the blur boundary. Use `shadow-[inset_0_-2px_0_0_var(--accent)]` or an absolute `::after` for a cleaner underline.

### queue (ui-overhaul.md:114-122)
- Good. But the "3px wide left color bar" pattern + "selected state `bg-[accentSoft]` + `border-l-2 border-[accent]`" **collide on the same 3px channel**. What happens when a selected SOP_CONTENT row needs both the yellow category bar AND the purple selection bar? The doc doesn't say. Recommend: selected state replaces the category bar with the accent bar, and the category appears as a small dot to the right of the title instead.
- "Loading skeleton: 4 shimmer blocks with smooth pulse animation" — current uses `animate-pulse` (queue.tsx:58). Fine.
- "Empty state 'All caught up': keep the italic but drop the serif" — italic sans looks amateurish. Drop italic entirely or render it as a very subtle `text-inkMuted`. The Playfair italic was carrying that pattern; without it, italic sans reads as a typo.

### detail-panel (ui-overhaul.md:124-132)
- The "ONE exception for uppercase micro-labels inside cards" (design-direction.md:112, ui-overhaul.md:127) is a **self-inflicted inconsistency**. Once you make that exception, engineers won't know where the line is. Either uppercase-everywhere or nowhere. Recommend: nowhere, use `text-xs font-semibold text-ink` for section headers inside cards — still reads as a label.
- "ANCHOR badge: a small subtle pill, accent-colored" — but accent is also the apply-button color. Two different meanings on the same color. Use a separate neutral pill (`bg-gray-100 text-gray-700`) with a pin icon.

### accept-controls (ui-overhaul.md:134-140)
- References `accentDarker` which isn't in the token palette. Define or replace.
- "Dismiss (reject): ghost red" — semantic red for a non-destructive *review* action is loud. It's not "delete user data"; it's "this suggestion is not useful". Try `text-inkMuted hover:text-red-600` — red on hover only.

### chat-panel (ui-overhaul.md:142-148)
- User bubbles right-aligned with `bg-[accent] text-white` — **the white-on-purple contrast is 4.43:1**, on the borderline. Either darken to `accentStrong` or accept that long messages in user bubbles are a contrast liability.
- "Send button: circular, `bg-[accent]` when there's text, `bg-[hairline]` when empty" — good, but no loading state defined. What does it look like while the agent is responding? Add a spinner variant.

### chat-parts — ThinkingSection (ui-overhaul.md:151)
**Biggest implementation risk.** Current (chat-parts.tsx:36-65) uses `open ? <pre> : null` — conditional render. The spec says "smooth height transition (max-height + overflow-hidden + transition-all duration-300)". That requires **always rendering** the `<pre>` and animating `max-height` from 0 → `max-h-96`. This is a logic change, not a CSS change. Flag loudly to the engineer — they may implement CSS-only and wonder why it snaps.

### chat-parts — ToolCallPart (ui-overhaul.md:152)
- "tiny spinner (CSS only, 12px)... Done state: small green check `✓` with a fade-in transition" — the current code (chat-parts.tsx:89-93) renders text "running…" / "done". Going from text to icon + animated state transition is a component rewrite. Not trivial. Worth its own commit.

### chat-parts — SuggestionCard (ui-overhaul.md:153-158)
- "Should feel like a GitHub PR review card" — good north star. But the current implementation (chat-parts.tsx:115-176) already has shadow-sm + rounded + action buttons. The delta is mostly: header bar with sunken bg, better button hierarchy. Be specific — "wrap the existing header in a `-mx-4 -mt-4 px-4 py-3 bg-[surfaceSunken] border-b border-[hairlineSoft]`" is what would actually ship.

### conversation-list (ui-overhaul.md:164-169)
- "Anchor indicator: a small 📌 or a subtle pin icon, not ⚓" — **prefer the lucide icon over an emoji always**. Emoji rendering is OS-dependent and breaks visual consistency across Mac/Win/Linux.

### dashboards (ui-overhaul.md:172-178)
- The spec is solid. One gap: **no sparklines specified**. Stripe/Linear metric cards have tiny trend sparklines. If we want "looks like Stripe", this is the move. Otherwise stats read static.
- Current `Stat` component (dashboards.tsx:30-54) uses `font-mono text-base` for values. Spec says `text-2xl font-semibold` — **that's a bigger change than "no borders"**. Engineer needs to resize the whole dashboard layout.

### diff-viewer (ui-overhaul.md:181-187)
- Good, but "add `line-through opacity-70`" for deletions — `line-through` + `opacity-70` on a translucent red background produces muddy color. Either line-through OR opacity, not both.

### category-pill (ui-overhaul.md:190-192)
- "Drop the sub-label from inside the pill" — clean call. But current `CategoryPill` is called from `queue.tsx:124`, `detail-panel.tsx:91`, and `chat-parts.tsx:134` with subLabel passed in. Dropping the sublabel from the pill means all three call sites need layout changes. Flag.

### confidence-bar (ui-overhaul.md:195-199)
- "Gradient from accent to accentMuted for values > 0.7, gray for low confidence" — **what's the cutoff for "low"?** < 0.4? < 0.5? The brief implies a three-zone scale (low/mid/high) but only defines two. Specify the mid-range color too.

### evidence-pane (ui-overhaul.md:201-206)
- "JSON tree: keys in `text-[accent]`" — purple keys on white is ~4.43:1, passes for 12px medium but is **visually loud** in a code context. Typical JSON viewers use muted color for keys (gray/dark teal), accent for strings. Re-check.

---

## 4. Hierarchy & IA concerns

Removing Playfair + UPPERCASE is right, but **the doc doesn't prescribe the replacement hierarchy clearly enough**. With everything now Jakarta in various weights, how does the eye find the anchor on a dense detail panel?

Proposed hierarchy contract (missing from the doc, please add):

1. **Page title** — `text-xl font-semibold`
2. **Primary card title** — `text-base font-semibold`
3. **Section header inside a card** — `text-sm font-semibold text-ink`
4. **Micro-label / tag** — `text-xs font-medium text-inkMuted` (sentence case)
5. **Body** — `text-sm text-ink`
6. **Metadata** — `text-xs text-inkMuted`
7. **Hint** — `text-xs text-inkSubtle`

Column differentiation: the brief preserves three columns but **doesn't differentiate their surface treatment**. Risk: three equally-white columns with `shadow-sm` cards look like a spreadsheet. Recommend:

- Left rail (queue): `bg-canvas` (gray-50), no card shadow, just dividers
- Center (detail): `bg-canvas` with a single elevated `shadow-sm rounded-xl` card
- Right rail (chat): `bg-surfaceRaised` (white), no card (the messages are the cards)

This gives each column a distinct visual role without borders.

---

## 5. Motion/transitions

- **200ms default**: correct baseline.
- **Hover states at 150ms**: right.
- **Panel slide 200ms**: right.
- **Things that should be snappier (100-150ms)**: button hover bg, checkbox/radio toggle, tab switch. The doc defaults everything to 200ms which is slightly too syrupy for clicks.
- **Things that should be softer (300ms)**: drawer/modal open, evidence pane slide-in. The doc pegs "panel slide" at 200ms but the evidence pane is a heavier UI element — 300ms feels more intentional.
- **Things the doc misses**:
  - `prefers-reduced-motion` — must short-circuit all transitions to 0ms or skip `max-height` anim entirely.
  - Stagger for list reveal. Not essential, but tasteful.
  - Spinner→checkmark crossfade (the tool-chip state). The doc says "fade-in" but not how the spinner exits.

Verdict: animations are tasteful, not excess, **if** the engineer adds reduced-motion fallback and doesn't animate everything at 200ms uniformly.

---

## 6. Risk flags (things that break under literal execution)

1. **ThinkingSection `max-height` anim** — current code conditionally renders. This is a DOM change, not CSS. (chat-parts.tsx:36-65 vs ui-overhaul.md:151)
2. **ToolCallPart spinner→check** — current is a text label. Adding animated icons is a component rewrite. (chat-parts.tsx:80-93)
3. **Stat card resize (`font-mono text-base` → `text-2xl font-semibold`)** — affects dashboard grid proportions. (dashboards.tsx:42-52 vs ui-overhaul.md:175)
4. **`accentDarker` undefined** — ui-overhaul.md:135 references a token not in the palette.
5. **`hairlineSoft` equals `surfaceSunken`** — divider disappears when placed on sunken surfaces.
6. **Queue selected-state + category color bar collision** — both compete for the 3px left edge.
7. **`ConfidenceBar compact` prop** — queue.tsx:129 passes a `compact` prop; the redesign spec (ui-overhaul.md:195-199) doesn't say what compact means in the new design. Engineer will guess.
8. **"Drop serif italic" on empty state** — italic sans looks wrong; drop italic entirely.
9. **Playfair still loaded in `app/layout.tsx` and `globals.css`** — the acceptance criteria check `font-[family-name:var(--font-playfair)]` usage inside `/tuning` components only. The font file is still downloaded. Minor perf/bundle win if the font variable is gated or removed.
10. **CategoryPill call-site changes** — dropping the sub-label from the pill requires updating 3 call sites to render the sub-label adjacent. ui-overhaul.md:191-192 doesn't flag this.

---

## 7. Net-new suggestions (things a senior designer would add)

- **Focus-visible rings**: `focus-visible:ring-2 focus-visible:ring-[accentSoft] focus-visible:ring-offset-2` on every interactive element. Keyboard users will not use this tool without it. The doc mentions this only for the chat input.
- **`prefers-reduced-motion`**: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0ms !important; animation-duration: 0ms !important; } }` globally scoped to `/tuning`.
- **Dark mode**: not in scope per the brief, but the token file (`TUNING_COLORS` as a flat const) makes this hard later. Recommend restructuring as CSS variables driven by `data-theme` before the overhaul, even if dark values aren't set yet. Otherwise retrofit is painful.
- **Skeleton loading** for detail-panel and chat-panel (brief only specifies queue skeletons).
- **Empty states**: queue has one ("All caught up") but chat-panel, conversation-list, evidence-pane don't. Each needs a deliberate empty-state with icon + short copy + optional CTA.
- **Error states**: the doc correctly kills "red 0.0%" errors but doesn't propose the replacement pattern. Propose one: `bg-amber-50 border-l-2 border-amber-400 text-amber-800 px-3 py-2 rounded-r text-xs` + retry link.
- **Toast/notification pattern**: after Apply Now / Dismiss, the user needs feedback. Not specified. Use `sonner` (already in shadcn) positioned `bottom-right`, auto-dismiss 3s, accent color for success.
- **Keyboard shortcuts cheat-sheet**: if `j/k` exists (need to check), document in a `?`-popover.
- **Scroll shadows** on the queue and chat panels — fade-out at top/bottom indicates more content. Small touch, big polish.
- **Command palette (Cmd-K)**: Linear/Stripe/Raycast have trained users to expect this. Worth deferring but worth naming.
- **Accent-ramp tokens**: `accent-50/100/500/600/700`. `accentSoft` + `accentMuted` + `accent` isn't enough for hover/active/disabled states across buttons/pills/rails.

---

## 8. Priority order (70% that earns the premium feel)

If the engineer only has one sprint:

### Must-ship (earns the premium feel)
1. **Token overhaul** — kill Playfair, cool palette, new `ink`/`inkMuted`/`inkSubtle`, accent `#6C5CE7` + `accentStrong #5B4CDB`. One commit, one file, huge visual delta.
2. **Kill every `uppercase tracking-[0.14em]`** — sentence case everywhere, including the "exception" (just make it `text-xs font-semibold`). One find/replace pass.
3. **Queue items: 3px category bar + selected state + hover lift + divider instead of border.** Highest-traffic component, biggest ROI.
4. **Detail panel: card with `shadow-sm rounded-xl p-6`, no border.** Centerpiece of the page.
5. **Chat bubbles: user right/accent, agent left/white-shadow, input with focus ring, circular send button.** This is what people spend time looking at.
6. **Diff viewer polish: header bar, translucent diff colors, no `line-through + opacity` combo.** Quick win.
7. **Focus-visible rings + prefers-reduced-motion.** Accessibility table stakes.

### Nice-to-have (skip if time is tight)
8. Dashboard stat resize to `text-2xl`.
9. ThinkingSection smooth collapse (current snap-open is functionally fine; the animation is polish).
10. ToolCallPart spinner→checkmark animation (current text label is functionally fine).
11. Evidence pane JSON syntax coloring.
12. Scroll shadows, sparklines, command palette.

### Avoid
- **Don't try to redesign all 15 components in lockstep** — the brief's commit-by-commit list is right; ship one component per commit.
- **Don't introduce dark mode this sprint** — token restructuring is a trap that eats the week.
- **Don't add `framer-motion`** — CSS transitions cover every motion in this spec. The dep isn't earned.

---

## TL;DR for the engineer

The design direction is right. The execution will succeed if you:

1. Define `accentStrong`, fix `hairlineSoft`, resolve the category-bar/selected-bar collision before writing CSS.
2. Treat ThinkingSection, ToolCallPart, and SuggestionCard as **component rewrites**, not CSS passes.
3. Add focus-visible + reduced-motion globally before per-component work.
4. Ship tokens + queue + detail-panel + chat-panel first. That's 70% of the premium feel.
5. Hold the line on one accent color used sparingly. It's the single most-violated rule in dashboard redesigns.
