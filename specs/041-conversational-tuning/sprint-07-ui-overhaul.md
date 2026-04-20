# Sprint 07 — UI Overhaul

> **You are a fresh Claude Code session with no memory of prior work.** This sprint is purely visual — no backend changes, no new features. You are redesigning the `/tuning` surface to match the polish of Claude Console (Managed Agents) and OpenAI Platform.

## Read-first list

1. `specs/041-conversational-tuning/sprint-07-ui-overhaul-design-direction.md` — **read this FIRST.** It contains a detailed visual analysis of two reference products (Claude Console Managed Agents, OpenAI Platform) and a component-by-component critique of the current UI with specific instructions for each. This is your design bible.
2. `specs/041-conversational-tuning/operational-rules.md`
3. `specs/041-conversational-tuning/sprint-05-v1-tail-report.md` — §5 for what the current UI looks like.
4. `CLAUDE.md` (repo root).
5. `frontend/components/tuning/tokens.ts` — current design tokens.
6. Every file in `frontend/components/tuning/` — you are rewriting the styles, not the logic.
7. `frontend/app/tuning/page.tsx`, `frontend/app/tuning/layout.tsx`.
8. `frontend/app/globals.css` — current theme variables and fonts.
9. `frontend/components/ui/` — available shadcn primitives.

## Branch

`feat/041-conversational-tuning`. Commit on top. Do NOT merge. Do NOT push.

## Goal

Make the `/tuning` surface look and feel like a product shipped by Anthropic or OpenAI — not a developer prototype. The current UI is functionally complete but visually rough. Every component needs a styling pass. No logic changes, no new endpoints, no backend work.

## Non-goals

- Do NOT change any backend code.
- Do NOT add new features or API calls.
- Do NOT change the three-column layout structure (left rail, center, right rail). The architecture is correct.
- Do NOT change the data flow, state management, or API integration.
- Do NOT break any existing functionality. Every button, every flow, every keyboard shortcut must still work after the overhaul.
- Do NOT add new npm dependencies unless absolutely necessary for animation (e.g. `framer-motion` is acceptable if it earns its keep; CSS transitions preferred).

## Design principles (non-negotiable)

1. **No serif display font.** Remove all uses of `font-[family-name:var(--font-playfair)]`. Use the existing `Plus Jakarta Sans` (var `--font-jakarta`) everywhere. If you need a display weight, use Jakarta at `font-semibold` or `font-bold` — never a serif.
2. **Sentence case, not UPPERCASE.** Replace every `uppercase tracking-[0.14em]` label with normal sentence-case or title-case text. "PENDING SUGGESTIONS" → "Pending suggestions". "TUNING AGENT" → "Tuning agent". "CONVERSATION CONTEXT" → "Conversation context". Uppercase micro-labels are a crutch for weak hierarchy — fix hierarchy with size, weight, and color instead.
3. **Cards with subtle shadows, not hairline borders.** The current UI uses `border` on everything, creating a spreadsheet feel. Replace with `shadow-sm` or `shadow-[0_1px_3px_rgba(0,0,0,0.06)]` on elevated surfaces. Keep borders ONLY for intentional dividers (e.g. between queue items in a list) and make them nearly invisible (`border-[#F0EFED]` or `opacity-50`).
4. **Smooth transitions everywhere.** Every hover state, every expand/collapse, every panel swap needs `transition-all duration-200 ease-out` minimum. The current UI feels static — make it feel alive.
5. **Generous whitespace.** Increase padding inside cards and sections. The current 12-16px padding on most elements is cramped. Go to 16-24px. Let content breathe.
6. **Professional color hierarchy.** Primary text `#1A1A1A` (near-black, not the warm stone `#0C0A09`). Secondary text `#6B7280` (cool gray, not the warm `#57534E`). Tertiary/hint text `#9CA3AF`. Background `#F9FAFB` (cool neutral, not warm stone `#FAFAF9`). Surface `#FFFFFF`. Accent `#6C5CE7` (a refined purple like Claude's, not the cold blue `#1E3A8A`).
7. **One accent color, used sparingly.** Accent appears on: the active nav tab underline, the primary action button, the selected conversation highlight, active queue item indicator. Nowhere else. Not on every badge, not on every label.
8. **Tool chips should be quiet and modern.** Not `⚙ get_context  DONE` in a bordered pill. Instead: a small rounded chip with a muted background, the tool name in `text-xs font-medium`, and a subtle animated spinner → checkmark for state.
9. **The chat input should feel premium.** Rounded, with a subtle inner shadow on focus, a send button that pulses subtly when there's content, placeholder text in light gray.
10. **Reasoning sections should feel like Claude's.** Collapsible with a smooth height animation, a subtle left border accent, muted background, and a clean disclosure arrow — not a "+ REASONING" button.
11. **Dashboard stats should look like Stripe or Linear metrics.** Large number, small label below, optional trend indicator. No heavy borders around each stat. Group them on a clean card with internal spacing.
12. **The diff viewer needs refinement.** Keep the word-level diff logic but: add a thin header bar with "Before → After" or "Draft → Proposed", use monospace only for the diff content (not the header), tighten the insertion/deletion colors (use opacity overlays, not solid tints), add slightly more line-height for readability.

## Component-by-component instructions

### `tokens.ts` — Design tokens overhaul

Replace the warm-stone palette with a cool professional palette:

```typescript
export const TUNING_COLORS = {
  // Backgrounds
  canvas: '#F9FAFB',          // cool neutral page bg
  surfaceRaised: '#FFFFFF',    // cards, modals
  surfaceSunken: '#F3F4F6',    // inset areas, code blocks
  
  // Text
  ink: '#1A1A1A',              // primary text
  inkMuted: '#6B7280',         // secondary text
  inkSubtle: '#9CA3AF',        // tertiary text, hints
  
  // Borders
  hairline: '#E5E7EB',         // primary divider
  hairlineSoft: '#F3F4F6',     // subtle divider
  
  // Accent
  accent: '#6C5CE7',           // primary purple (Claude-like)
  accentSoft: '#F0EEFF',       // selected state bg
  accentMuted: '#A29BFE',      // hover, secondary accent
  
  // Diffs
  diffAddBg: 'rgba(16, 185, 129, 0.08)',  // translucent green
  diffAddFg: '#059669',
  diffDelBg: 'rgba(239, 68, 68, 0.08)',   // translucent red
  diffDelFg: '#DC2626',
  
  // Semantic
  warnBg: '#FFFBEB',
  warnFg: '#D97706',
  successFg: '#059669',
};
```

Update `CATEGORY_STYLES` to use the new cool palette — softer pastel backgrounds with stronger text:

```typescript
export const CATEGORY_STYLES = {
  SOP_CONTENT:       { bg: '#FEF9C3', fg: '#A16207', label: 'SOP content' },
  SOP_ROUTING:       { bg: '#FFEDD5', fg: '#C2410C', label: 'SOP routing' },
  FAQ:               { bg: '#CCFBF1', fg: '#0F766E', label: 'FAQ' },
  SYSTEM_PROMPT:     { bg: '#DBEAFE', fg: '#1D4ED8', label: 'System prompt' },
  TOOL_CONFIG:       { bg: '#EDE9FE', fg: '#7C3AED', label: 'Tool config' },
  MISSING_CAPABILITY:{ bg: '#FCE7F3', fg: '#BE185D', label: 'Capability' },
  PROPERTY_OVERRIDE: { bg: '#CFFAFE', fg: '#0E7490', label: 'Property' },
  NO_FIX:            { bg: '#F3F4F6', fg: '#6B7280', label: 'No fix' },
};
```

### `top-nav.tsx` — Navigation

- Remove the serif "Tuning" italic brand text on the right.
- Nav links: sentence case ("Tuning", "History", "Capability requests").
- Active link: underline with accent color, `border-b-2`, no uppercase.
- "← Inbox" link: subtle, muted text, no arrow character — use a small chevron-left icon (lucide-react `ChevronLeft`).
- The backdrop blur and bg-opacity are good — keep them.
- Mobile hamburger: use lucide `Menu` icon, clean.

### `queue.tsx` — Suggestion queue

- Remove "PENDING SUGGESTIONS" uppercase header → "Pending suggestions" in `text-sm font-medium`.
- Group headers ("Legacy", "Edit triggered", etc.) → sentence case, `text-xs font-medium text-[inkMuted]`, with a clean count badge (not a collapsing arrow by default — default open, arrow to collapse).
- Queue items: remove the bordered "Edit" pill on every item. Instead, show a narrow left-side color indicator (3px wide, `rounded-full`, using the category color). The item body is: first line = suggestion title/summary in `text-sm font-medium`, second line = sub-label or rationale excerpt in `text-xs text-[inkMuted]`, right-aligned relative time.
- Selected item: `bg-[accentSoft]` + `border-l-2 border-[accent]`. Not the full blue left border.
- Hover: `bg-gray-50` with smooth transition.
- Loading skeleton: use 4 shimmer blocks with smooth pulse animation.
- Empty state "All caught up": keep the italic but drop the serif. Use `text-base font-normal text-[inkMuted]`, centered.

### `detail-panel.tsx` — Suggestion detail

- Card wrapper with `shadow-sm rounded-xl p-6` on a white surface. No border.
- Header: category pill (refined, see below) + confidence inline + relative time. All on one line, clean spacing.
- Section labels ("Conversation context", "Proposed change", "Rationale"): `text-xs font-medium text-[inkMuted] uppercase tracking-wider mb-3` — this is the ONE place uppercase works (small section labels inside a card, like Stripe).
- Conversation context messages: clean card bubbles with `rounded-xl` and subtle background. AI messages `bg-[surfaceSunken]`, Guest messages white with hairline border. No heavy "AI · 12H AGO" label — just a small muted tag.
- "ANCHOR" badge on the anchor message: a small subtle pill, accent-colored, not a big red tag.
- Diff viewer: see §diff-viewer below.
- Evidence "View evidence" link: clean text button with `→` arrow, not a heavy affordance.

### `accept-controls.tsx` — Action buttons

- Primary "Apply now": `bg-[accent] text-white rounded-lg px-5 py-2.5 font-medium shadow-sm hover:shadow-md hover:bg-[accentDarker] transition-all duration-200`.
- Secondary "Queue": outlined style, `border border-[hairline] rounded-lg px-4 py-2 hover:bg-[surfaceSunken] transition-all`.
- "Edit": ghost style, just text + underline on hover.
- "Dismiss" (reject): ghost red, subtle. `text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg px-3 py-2 transition-all`.
- Buttons should be in a row with consistent spacing, not crammed.

### `chat-panel.tsx` — Chat experience

- Message bubbles: user messages right-aligned with `bg-[accent] text-white rounded-2xl rounded-br-md px-4 py-3`. Agent messages left-aligned with `bg-white shadow-sm rounded-2xl rounded-bl-md px-4 py-3`.
- No heavy "TUNING AGENT" header. Just a subtle "Tuning agent" label at the top of the chat panel in muted text.
- Auto-scroll should be smooth (`behavior: 'smooth'`).
- The input area: `rounded-xl border border-[hairline] shadow-inner focus-within:border-[accent] focus-within:ring-2 focus-within:ring-[accentSoft] transition-all duration-200 px-4 py-3`. Placeholder: "Tell your tuner what you see..." in `text-[inkSubtle]`.
- Send button: circular, `bg-[accent]` when there's text, `bg-[hairline]` when empty, smooth transition. Use lucide `ArrowUp` icon inside.

### `chat-parts.tsx` — Message parts

- **ThinkingSection** (Reasoning): Replace "+ REASONING" with a clean collapsible. Closed state: a small pill `Reasoning ▸` in muted text with a subtle left accent border. Open state: smooth height transition (`max-height` + `overflow-hidden` + `transition-all duration-300`), light `bg-[surfaceSunken]` with `border-l-2 border-[accentMuted]`, the reasoning text in `text-sm text-[inkMuted] leading-relaxed`.
- **ToolCallPart**: Small inline chip with `rounded-full bg-[surfaceSunken] px-3 py-1 text-xs font-medium`. Tool name in `text-[inkMuted]`. Running state: a tiny spinner (CSS only, 12px). Done state: a small green check `✓` with a fade-in transition. Error state: red `✕`.
- **SuggestionCard**: This is the big one.
  - Card with `shadow-md rounded-xl border border-[hairlineSoft] overflow-hidden`.
  - Header bar: light `bg-[surfaceSunken]` with category pill + confidence + "Suggestion preview" label.
  - Body: rationale in readable prose, then the diff.
  - Footer: action buttons (Apply / Queue / Edit / Dismiss) — same style as accept-controls but slightly smaller.
  - The whole card should feel like a GitHub PR review card.
- **EvidenceInline**: Clean summary card with `rounded-lg bg-[surfaceSunken] p-4`. No heavy borders. Key-value pairs with `text-xs font-medium` labels and `text-sm` values. Subtle icon decorations if helpful.
- **FollowUpPart**: Italic muted text, slightly indented. Fine as-is but drop any serif.
- **AgentDisabledCard**: Warning card with `bg-amber-50 border border-amber-200 rounded-xl p-4`. Clean icon + message.

### `conversation-list.tsx` — Conversations sidebar

- "Conversations" label: sentence case, `text-sm font-medium`, with "+ New" button as a small `rounded-lg` outlined button.
- Search input: `rounded-lg` with a subtle search icon inside (lucide `Search`), `text-sm`.
- Conversation items: clean rows with `hover:bg-gray-50 transition-colors`. Title "Untitled conversation" in `text-sm font-medium`, message count + time in `text-xs text-[inkMuted]`. Anchor indicator: a small `📌` or a subtle pin icon, not `⚓`.
- Selected item: `bg-[accentSoft]` with `border-l-2 border-[accent]`.
- "No conversations yet" / "Failed to fetch": muted text, centered, no red color for the error (just muted + a retry button).

### `dashboards.tsx` — Metrics panel

- Complete visual overhaul. Reference: Stripe Dashboard metrics.
- Collapse trigger: a clean `Dashboards` label with a small chevron that rotates on toggle. Not a heavy button.
- Stat cards: NO borders. Instead, a shared card container (`bg-white shadow-sm rounded-xl p-5`) with stats laid out in a 2×2 grid inside. Each stat: large number (`text-2xl font-semibold`), small label below (`text-xs text-[inkMuted]`), optional trend indicator (small colored text `↑ 5%` or `↓ 2%`).
- Velocity section: "Tuning velocity" as a `text-sm font-semibold` header. Coverage as a prominent stat. Category bars as thin horizontal bars with rounded ends and the category color — no heavy labels on each bar.
- Graduation section: "Graduation" header. Four stats in a 2×2 grid. Warning indicator: a subtle amber dot, not a text arrow.
- The collapsed state (arrow + "Dashboards" label) should animate the panel height smoothly.

### `diff-viewer.tsx` — Diff display

- Keep the word-level diff algorithm (it's good).
- Add a thin header: `"Draft → Proposed"` in `text-xs font-medium text-[inkMuted]` with a `font-mono` label, right-aligned `"word-level diff"` tag.
- Diff container: `rounded-lg bg-[surfaceSunken] p-4 font-mono text-sm leading-relaxed`.
- Insertions: `bg-[diffAddBg] text-[diffAddFg] rounded-sm px-0.5` — the rounded-sm and slight padding make each insertion feel like an inline highlight, not a wall of color.
- Deletions: same with red. Add `line-through opacity-70` for a cleaner struck-through look.
- If no diff: "No changes" in muted centered text. Not "No diff available".

### `category-pill.tsx` — Category badges

- `rounded-full px-2.5 py-0.5 text-xs font-medium` with the category-specific bg/fg.
- Drop the sub-label from inside the pill — it crowds it. Sub-label goes next to the pill as separate muted text.

### `confidence-bar.tsx` — Confidence indicator

- Keep the horizontal bar but make it thinner (3px height, not 6px).
- `rounded-full` on both the track and the fill.
- Track `bg-[hairline]`, fill uses a gradient from `accent` to `accentMuted` for values > 0.7, gray for low confidence.
- Numeric label: `text-xs font-mono text-[inkMuted]` next to the bar, not on top.

### `evidence-pane.tsx` — Evidence modal

- Keep the slide-over pattern but:
  - `shadow-2xl` instead of `shadow-xl`.
  - Header with `border-b border-[hairline] p-5` and a clean close button (lucide `X`).
  - JSON tree: use consistent indentation, `text-xs font-mono`, subtle key/value color differentiation (keys in `text-[accent]`, values in `text-[ink]`).

### `relative-time.tsx` — No changes needed.

### `auth-gate.tsx` — No changes needed.

### Mobile drawer

- The `Sheet` approach is correct. Just ensure the drawer content gets the same styling updates as the desktop sidebar.
- Drawer handle: add a small `rounded-full bg-gray-300 w-10 h-1 mx-auto mt-2` at the top of the sheet — a visible drag handle.

## Process notes

- **Spawn a design subagent first** (general-purpose agent) with the design-direction doc. Ask it to review your token choices and component specs BEFORE you start writing CSS. Pull its feedback into a `sprint-07-design-review.md` for reference.
- **Work component by component.** Don't try to update everything at once. Start with `tokens.ts`, then `top-nav.tsx`, then work through the list. Commit after each component.
- **Test visually after each component.** Run `next build && next start` and screenshot. If something looks wrong, fix before moving on.
- **Do not break functionality.** Every onClick, every API call, every keyboard shortcut must still work. This is a CSS/styling sprint, not a logic sprint.
- **Preserve all accessibility.** ARIA labels, focus states, keyboard navigation — all must survive.

## Acceptance criteria

- [ ] Zero uses of `font-[family-name:var(--font-playfair)]` remain in tuning components.
- [ ] Zero uses of `uppercase tracking-[0.14em]` remain (except the one documented exception: section labels inside the detail card).
- [ ] `tokens.ts` updated to the new cool palette.
- [ ] Every component listed above has been restyled per its instructions.
- [ ] `npm run build` passes (frontend).
- [ ] `npx tsc --noEmit` passes (frontend).
- [ ] No new backend changes.
- [ ] Visual screenshots of each major surface saved to `specs/041-conversational-tuning/sprint-07-smoke/`:
  - Queue with items (empty + populated)
  - Detail panel with a suggestion selected
  - Chat panel with agent response (tool chips, reasoning, suggestion card)
  - Mobile drawer
  - Dashboards panel (open + collapsed)
  - History page
  - Capability requests page

## Commits

1. `style(041): overhaul design tokens to cool professional palette`
2. `style(041): restyle top navigation and layout shell`
3. `style(041): restyle suggestion queue with modern card items`
4. `style(041): restyle detail panel with card layout and refined sections`
5. `style(041): restyle accept controls with consistent button hierarchy`
6. `style(041): restyle chat panel with modern message bubbles`
7. `style(041): restyle chat parts (reasoning, tool chips, suggestion card, evidence)`
8. `style(041): restyle conversation list with clean rows`
9. `style(041): restyle dashboards as Stripe-style metric cards`
10. `style(041): refine diff viewer, category pill, confidence bar, evidence pane`
11. `style(041): restyle history and capability-requests pages`
12. `style(041): smooth transitions and hover states across all components`

## Report

Write `specs/041-conversational-tuning/sprint-07-ui-overhaul-report.md`:

1. What changed (component by component).
2. Design decisions and rationale.
3. Before/after comparison notes.
4. Screenshots.
5. Any functionality preserved / tested.
6. Files touched.
7. Commits.
