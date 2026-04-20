# Sprint 07 — Design Direction Document

> **Read this before touching any code.** This document contains a forensic visual analysis of two reference products and a specific critique of every current GuestPilot /tuning component. It is the design bible for the UI overhaul.

## Reference analysis: Claude Console (Managed Agents)

### What makes it feel premium

1. **Typography is entirely sans-serif.** Clean, modern, no decorative fonts. Headers are bold sans, body is regular sans, code is monospace. No mixing.

2. **Color palette is purposefully restrained.** Black for primary text. Cool gray (`#6B7280`-ish) for secondary. White backgrounds. One accent color (Anthropic's purple/coral) used ONLY for interactive elements: buttons, active states, links. Category colors exist but are muted.

3. **Sidebar navigation is a masterclass in hierarchy.**
   - Section groups use small semibold labels ("Build", "Analytics", "Manage") — never uppercase screaming.
   - Active item has a subtle background tint + bold text. Not a heavy indicator.
   - Icons are 16px, muted, consistent stroke weight.
   - Generous 8-12px vertical spacing between items.

4. **The session timeline is beautiful.**
   - Color-coded event chips: Agent (green), Model (gray), User (orange) — each a `rounded-full` pill with just an icon/label.
   - Events flow vertically with clean timestamps right-aligned.
   - Clicking an event opens a clean right panel with JSON — no modal, no overlay, just a smooth slide-in.
   - The timeline bar at the top (horizontal, multi-colored) is a genius density visualization — you see the conversation shape at a glance.

5. **The "Ask Claude" button is delightful.**
   - Purple accent, clean rounded shape.
   - On hover, a dropdown appears smoothly with options ("Chat with Claude").
   - It feels like a feature invitation, not a generic button.

6. **JSON display** uses consistent monospace, subtle syntax coloring (keys in one shade, strings in another), and proper indentation. Not a raw dump.

7. **Whitespace is generous.** Cards have 20-24px padding. Sections have 16-24px gaps. Nothing feels crammed.

8. **Transitions are subtle but present.** Panel opens smooth. Hover states transition in ~150ms. Nothing jitters.

### Key takeaways for GuestPilot

- Kill the serif font. All sans.
- Use ONE accent color (we'll use a refined purple `#6C5CE7` — close to Anthropic's but distinguishable).
- Sidebar items need hierarchy from SIZE and WEIGHT, not from UPPERCASE SCREAMING.
- Tool/agent activity should render as a clean vertical stream with status chips, not cluttered inline text.
- Right panels slide in smoothly, don't pop.
- JSON/code displays use proper syntax awareness.

---

## Reference analysis: OpenAI Platform

### What makes it feel premium

1. **The sidebar groups navigation logically.** "Create" (Chat, Agent Builder, Audio, Images, Videos, Assistants), "Manage" (Usage, API keys, etc.), "Optimize" (Evaluation, Fine-tuning). Each group has a small bold label. Items are clean rows with icons.

2. **The editor area is spacious.** The prompt editor card has generous padding, clean header with model selector, and a clear visual boundary (subtle shadow, not a border).

3. **The model selector** is a small clean dropdown — `text-sm`, subtle chevron, no heavy styling.

4. **"+ Add" buttons** for Variables and Tools are minimal: just text + icon, muted color, clean rounded shape.

5. **The "Compare / Optimize / Evaluate" action bar** in the header uses outlined pills — not heavy buttons. They sit at the same visual weight as navigation, not as primary CTAs.

6. **The developer-message textarea** has a clean border that emphasizes on focus, generous padding, and a small edit icon to indicate it's editable.

7. **Typography scale is tight and intentional:**
   - Page title: `text-xl font-semibold`
   - Section labels: `text-sm font-medium text-gray-500`
   - Body: `text-sm text-gray-900`
   - Hints: `text-xs text-gray-400`
   - Code: `text-sm font-mono`

8. **The color palette is almost monochrome.** Black, white, grays. Green accent for the "Update" button only. Everything else is neutral. This makes the content the hero, not the chrome.

### Key takeaways for GuestPilot

- Action bars at the top of panels (like "Compare / Optimize / Evaluate") are a pattern we can adopt for the detail panel header.
- Textarea/input styling with focus emphasis is a must.
- The tight, intentional typography scale prevents visual noise.
- Near-monochrome base palette with accent only on interactive elements.

---

## Forensic critique of current GuestPilot /tuning UI

### Problem 1: Serif display font (Playfair)

`font-[family-name:var(--font-playfair)]` is used on:
- Suggestion titles in the detail panel
- The "Tuning" brand text in top-nav
- Empty state headings
- Section headers

This makes the UI feel like a lifestyle blog, not a professional tool. Playfair is a beautiful font for editorial print; it's wrong for a SaaS dashboard.

**Fix:** Remove every instance. Use Plus Jakarta Sans with weight variation for hierarchy.

### Problem 2: UPPERCASE labels everywhere

`uppercase tracking-[0.14em]` appears on:
- "PENDING SUGGESTIONS"
- "LEGACY"
- "CONVERSATIONS"
- "TUNING AGENT"
- "TUNING CHAT"
- "CONVERSATION CONTEXT"
- "PROPOSED CHANGE"
- "DASHBOARDS"
- "COVERAGE — UNEDITED SENDS"
- "ACCEPTANCE RATE BY CATEGORY"
- "EDIT RATE", "EDIT MAGNITUDE", "ESCALATION RATE", "ACCEPTANCE RATE"

This creates a wall of SCREAMING that flattens hierarchy. When everything is uppercase, nothing stands out.

**Fix:** Sentence case everywhere. Use font-size + font-weight for hierarchy instead. One narrow exception: tiny section labels INSIDE cards (like "Conversation context" inside the detail panel) can use `text-[10px] uppercase tracking-wider text-[inkMuted]` as a deliberate design pattern — but only there.

### Problem 3: Border overload

Almost every element has `border` or `border-[#E7E5E4]`:
- Queue items have full borders
- Dashboard stat cards have full borders
- The diff viewer has borders
- Chat messages have borders
- The whole layout has column borders

This creates a spreadsheet/wireframe aesthetic. Professional products use **shadows for elevation** and **space for separation**.

**Fix:** Replace borders with `shadow-sm` on elevated cards. Use `divide-y divide-[hairlineSoft]` for lists (thinner than individual borders). Use whitespace between sections.

### Problem 4: Warm stone palette feels washed out

The current palette (`#FAFAF9`, `#0C0A09`, `#57534E`, `#E7E5E4`) is warm-toned stone. This was sprint-03's "editorial" direction but in practice it reads as beige/dull. The reference products all use cool neutrals (pure grays, blue-grays).

**Fix:** Shift to cool neutrals: `#F9FAFB` canvas, `#1A1A1A` ink, `#6B7280` muted, `#E5E7EB` borders. More contrast, more clarity.

### Problem 5: No transitions or animations

Nothing moves. Panels swap instantly. Hovers snap. Collapsibles jump. This makes the UI feel like a prototype rendered in HTML — functional but lifeless.

**Fix:** Add `transition-all duration-200 ease-out` to every interactive element. Collapsibles use `max-height` + `overflow-hidden` transitions. Panel swaps use a subtle fade or slide.

### Problem 6: Chat experience is rough

- "TUNING AGENT" header is heavy.
- "+ REASONING" toggle looks like a developer debug control, not a consumer feature.
- Tool chips (`⚙ get_context  DONE`) are functional but ugly.
- Agent responses render as plain text blocks with no visual framing.
- The chat input is a plain textarea with no focus treatment.
- **The duplication bug** makes the opener render twice (separate fix in sprint 06).

**Fix:** Messages in bubbles with shadows. Reasoning as a smooth collapsible with accent border. Tool chips as modern pills with spinner→checkmark animation. Input with inner shadow, focus ring, and a circular send button.

### Problem 7: Dashboard stats look like a wireframe

Heavy borders around each stat, 0.0% values with no visual treatment, "Failed to fetch" in red, harsh uppercase labels. This looks like a developer's debug panel.

**Fix:** Stats as large numbers with small labels below, grouped on a shared card surface. No individual borders per stat. Error states show a subtle muted message with a retry affordance — never red text for a non-critical fetch failure.

### Problem 8: Queue items lack visual hierarchy

Every queue item shows an "Edit" pill (the category), a summary line, and a timestamp — all at roughly the same visual weight. Nothing draws the eye to the most important items.

**Fix:** Category as a narrow left-side color bar (3px). Summary as `font-medium`. Sub-text as `text-xs text-[inkMuted]`. Timestamp right-aligned and muted. Selected item with accent background. Hover with subtle gray lift.

---

## Fonts

**Keep:** Plus Jakarta Sans (`--font-jakarta`) as the only font family.
**Remove:** Playfair (`--font-playfair`) from all tuning components.
**Keep:** System monospace for code/diff contexts.

## Typography scale

| Role | Size | Weight | Color |
|------|------|--------|-------|
| Page title | text-xl (20px) | font-semibold | ink |
| Section heading | text-base (16px) | font-semibold | ink |
| Card title | text-sm (14px) | font-semibold | ink |
| Body | text-sm (14px) | font-normal | ink |
| Secondary | text-sm (14px) | font-normal | inkMuted |
| Caption / label | text-xs (12px) | font-medium | inkMuted |
| Micro label (inside cards only) | text-[10px] | font-medium uppercase tracking-wider | inkSubtle |
| Code / diff | text-sm (14px) | font-mono | ink |
| Stat number | text-2xl (24px) | font-semibold | ink |
| Stat label | text-xs (12px) | font-normal | inkMuted |

## Spacing scale

| Context | Value |
|---------|-------|
| Card internal padding | 20-24px |
| Between cards/sections | 16-20px |
| Between list items | 0 (use `divide-y`) |
| List item internal padding | 12-16px |
| Button padding | px-4 py-2 (standard), px-5 py-2.5 (primary) |
| Input padding | px-4 py-3 |
| Page horizontal margin | 24-32px |

## Shadow scale

| Level | Value | Use |
|-------|-------|-----|
| Flat | none | Backgrounds, sunken areas |
| Card | `shadow-sm` or `0 1px 3px rgba(0,0,0,0.06)` | Cards, elevated surfaces |
| Hover | `shadow-md` or `0 4px 6px rgba(0,0,0,0.07)` | Card hover states |
| Modal/overlay | `shadow-xl` or `0 10px 25px rgba(0,0,0,0.1)` | Evidence pane, drawers |
| Deep | `shadow-2xl` | Full-screen overlays |

## Animation specs

| Trigger | Duration | Easing | Property |
|---------|----------|--------|----------|
| Hover bg/shadow | 150ms | ease-out | background-color, box-shadow |
| Collapsible open/close | 250ms | ease-in-out | max-height, opacity |
| Panel slide | 200ms | ease-out | transform, opacity |
| Spinner rotate | 800ms | linear (infinite) | transform |
| Checkmark appear | 200ms | ease-out | opacity, transform (scale) |
| Focus ring | 150ms | ease-out | box-shadow |
