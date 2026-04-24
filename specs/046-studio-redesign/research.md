# Phase 0 — Research: Studio Redesign

Resolves every `NEEDS CLARIFICATION` from the plan's Technical Context and documents the architectural decisions the rest of the implementation will ride on.

---

## R1 — Font loading: Inter Tight + JetBrains Mono

**Decision**: Use `next/font/google` at the app root (`frontend/app/layout.tsx`) with `display: "swap"`, expose them as CSS variables (`--font-inter-tight`, `--font-jetbrains-mono`), wire Tailwind 4's `@theme` block to pick up the variables, and apply `font-sans` / `font-mono` utilities on Studio surfaces.

**Rationale**:
- Next.js 16's `next/font/google` self-hosts the font files at build time — zero runtime network fetch, zero layout shift — the design handoff's "no layout shift" note is a free win here.
- Exposing as CSS variables lets Studio override globally-loaded fonts with no prop drilling. Every chat-part, drawer, composer, and right-panel tab picks up Inter Tight without touching any component beyond `layout.tsx` + `tailwind.config`.
- `display: "swap"` means initial paint uses the system fallback stack; the Inter Tight swap-in is imperceptible on a warm connection and still usable on a cold one.

**Alternatives considered**:
- Google Fonts `<link>` tag in `<head>` — rejected. Adds a network hop, third-party caching varies, violates the handoff's "no layout shift" assumption.
- Self-hosted `.woff2` in `public/` — rejected. `next/font/google` already does this; reinventing it is noise.
- Ship only Inter Tight, leave JetBrains Mono on the system fallback — rejected. The handoff uses mono heavily for file paths, diff lines, and latency / tokens / cost cards; a consistent mono is load-bearing.

---

## R2 — Token v2 coexistence with existing `STUDIO_COLORS`

**Decision**: Add a new `STUDIO_TOKENS_V2` export in `frontend/components/studio/tokens.ts` alongside the current `STUDIO_COLORS`. New Studio chrome imports **only** v2. Legacy paths (the `TUNING_COLORS` compat surface used by `/tuning/{pairs,history,sessions,…}`) keep importing `STUDIO_COLORS` and continue to work. A follow-up feature can retire v1 once the `/tuning/*` routes are removed in a later sprint.

**Rationale**:
- The user asked for "everything from color … from the design doc." The design hex values (`#0a5bff`, `#eaf1ff`, `#f4f7ff`, `#d7d9df`) differ from the current Studio palette (`#0070F3`, `#E6F0FF`, …). A hard replacement would reskin half the codebase by accident.
- The `tokens.ts` comment block explicitly warns against a "second source of truth for tuning chrome." A v2 namespace keeps one source of truth per surface: v1 for legacy, v2 for new Studio.
- The blast radius of the change stays strictly inside the new Studio components.

**Alternatives considered**:
- Overwrite `STUDIO_COLORS` with the spec values and hope no callsite breaks — rejected. The compat re-export into `TUNING_COLORS` propagates any change to the legacy routes.
- Ship a full CSS-variable system with a `[data-theme]` switcher — rejected. Unnecessary given dark mode is out of scope (spec Clarifications); adds complexity with no runtime benefit this sprint.

**Concrete v2 tokens** (copied verbatim from the handoff):

```ts
export const STUDIO_TOKENS_V2 = {
  bg: '#ffffff',
  surface: '#fafafa',
  surface2: '#f4f5f7',
  surface3: '#eceef2',
  border: '#e7e8ec',
  borderStrong: '#d7d9df',
  ink: '#0a0a0b',
  ink2: '#2a2b30',
  muted: '#6b6d76',
  muted2: '#9b9ea6',
  blue: '#0a5bff',
  blueHover: '#004fe8',
  blueSoft: '#eaf1ff',
  blueTint: '#f4f7ff',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  // diff overlays at the handoff's specified alpha
  diffAddBg: 'rgba(10, 91, 255, 0.06)',
  diffAddFg: '#0a5bff',
  diffDelBg: 'rgba(220, 38, 38, 0.05)',
  diffDelFg: '#dc2626',
  // radii, shadows, stroke — mirrored from the handoff
  radiusSm: 7,
  radiusMd: 8,
  radiusLg: 12,
  radiusXl: 14,
  shadowSm: '0 1px 2px rgba(10,12,20,0.04)',
  shadowMd: '0 2px 8px rgba(10,12,20,0.06)',
  iconStroke: 1.6,
} as const
```

---

## R3 — Tab controller state persistence

**Decision**: Per-mount in-memory state only. No `localStorage`, no URL param. Spec FR-055 explicitly says "within a session mount"; a page reload resets the active tab to Plan and the panel to expanded.

**Rationale**:
- Spec is explicit. Scope-limiting to in-memory avoids the "which tab is which user on what machine" persistence rabbit hole.
- An operator who reloads Studio has typically hit a real page change (nav tab swap, URL edit). Defaulting to Plan on reload is the safer affordance — Plan is the zero-state tab.

**Alternatives considered**:
- `localStorage` keyed by tenantId — rejected. Minor UX win, larger test-matrix burden, conflicts with spec FR-055 scope.
- `useSearchParams()` sync — rejected. Creates history-entry pollution when the operator flips tabs.

---

## R4 — Preview-tab input vs. composer `Test` chip (two entry points, one pipeline)

**Decision**: `StudioShell` owns a single `previewInput` state bag. Both entry points write into it:
- Preview-tab inline input → user types → `previewInput.text = newValue`; clicking Send calls `runTestPipeline(previewInput.text)`.
- Composer `Test` chip → reads composer textarea → `setPreviewInput({ text, isSending: true })` → `setActiveTab('preview')` → immediately fires `runTestPipeline(text)`.

The pipeline itself is `apiRunTestPipeline(tenantId, conversationId, { message })` — the existing endpoint behind today's shadow-mode preview. The spec's "bypass caches" guarantee (from `test-pipeline-runner.ts`) is already in the server path.

**Rationale**:
- Single source of truth. Both entry points converge on the same state, the same fetch, and the same render path.
- The `Test` chip must change tabs — the operator expects to see the result immediately. Switching to Preview while a test is running is the cue that the result will land there.
- Preserving the composer textarea contents after a test (spec FR-025b) means the chip does NOT consume the text — it only copies it. The operator's draft message to the build agent is safe.

**Alternatives considered**:
- Two independent states (Preview owns its own input, chip owns a transient) — rejected. Two code paths, two bugs, duplicated pipeline calls under double-click.
- Chip sends through the main-chat SSE — rejected. Wrong pipeline (build agent, not reply agent).

---

## R5 — Tests-tab in-place expansion (accordion, one-at-a-time)

**Decision**: Single-expanded accordion. `TestsTab` owns `expandedVariantId: string | null`. Clicking a row sets it; clicking the same row again or clicking a different row toggles. The expanded region mounts the existing `<TestPipelineResult variant={selected}/>` component verbatim beneath the row header, still inside the Tests tab's scroll container.

**Rationale**:
- Matches the screenshot the user shared: compact row list, expand-in-place on click.
- `TestPipelineResult` is already the canonical renderer for a variant (pipeline output + judge verdict + rationale). Reusing it keeps feature parity at zero cost.
- Single-expanded avoids a variable-height scroll container growing unbounded when the operator starts comparing many variants.

**Alternatives considered**:
- Multi-expanded accordion — rejected. Makes the Tests tab scroll become a two-dimensional surface (vertical + per-row expand) that's hard to scan.
- Side-by-side diff within Tests tab — rejected. Too much for a 340px-wide panel.

---

## R6 — Reference picker data sources

**Decision**: The Reference chip opens a single popover anchored below the chip. Inside the popover is a small horizontal segment control (SOPs / FAQs / Prompt / Tools / Properties) — each segment hydrates from its existing list endpoint via a lightweight client query. Selecting an entry closes the popover and inserts a citation chip into the composer textarea at the current cursor via `citation-parser.ts` existing helpers.

Endpoints reused:
- SOPs: `apiListSops(tenantId)` — existing
- FAQs: `apiListFaq(tenantId)` — existing
- System prompt: `apiGetTenantSystemPrompt(tenantId)` — existing (single-artifact, no list)
- Tools: `apiListTools(tenantId)` — existing
- Property overrides: `apiListPropertyOverrides(tenantId)` — existing

**Rationale**:
- Every list endpoint already exists; no server work.
- Using the existing citation-chip format means the AI agent receives citations in the format it already parses — no prompt changes.
- Segment control inside a single popover keeps the trigger surface to one chip (matches the design).

**Alternatives considered**:
- Five separate chips (one per artifact type) — rejected. Chip rail becomes cluttered; design specifies two chips + send button.
- A modal picker — rejected. Modals break the flow; the design's paperclip-style chip implies a popover.

---

## R7 — Focus-return & keyboard-operable tabs

**Decision**: Keep `StudioSurface`'s existing `artifactDrawerOpenerRef` behavior unchanged — the new shell mounts the drawer at the same level, so the ref still sees the opener. Tab bar uses `role="tablist"` + per-tab `role="tab"` + `aria-selected` with Left/Right arrow-key navigation per WAI-ARIA Authoring Practices. Tab panels use `role="tabpanel"` + `aria-labelledby` pointing at the tab button.

**Rationale**:
- ARIA tabs pattern is well-trodden; React Testing Library + axe-core verify correctness.
- Keyboard parity is called out in FR-063 + SC-006.

**Alternatives considered**:
- Use shadcn/ui `<Tabs/>` primitive — evaluated, compatible, likely to use it for the default a11y wiring. Final call is in `contracts/ui-contracts.md`: we prefer shadcn/ui Tabs for the a11y scaffold and restyle through the v2 tokens.

---

## R8 — 900px reflow trigger

**Decision**: Mixed — CSS container queries handle layout (three → two → one panel); a `useIsNarrow(maxPx = 900)` hook drives imperative behavior (default-collapse the right panel, mount the left rail as an off-canvas `<Drawer/>`).

**Rationale**:
- CSS container queries are available in Tailwind 4 and every browser we target, so layout changes are render-time and free of JS.
- Some behavior (the default-collapsed right panel below 900px, off-canvas hamburger toggle) needs JS because it affects a ref-owned transient state.

**Alternatives considered**:
- JS-only breakpoints with `window.matchMedia` — rejected. Duplicates what Tailwind container queries do and misses the CSS-only fast path.
- CSS-only (no hook) — rejected. Can't drive the off-canvas drawer's mount/unmount cleanly.

---

## R9 — Retirement of redundant right-rail components

The current right rail stacks `StateSnapshotCard`, `SessionArtifactsCard`, a "Recent test" card, `WriteLedgerCard`, and admin utility buttons. The new design subsumes each:

- `StateSnapshotCard` → **subsumed** by the Plan tab's `CURRENT PLAN` header + `CONTEXT IN USE` list. Keep the component file for now (it's used by the Plan tab internally), drop its render in `StudioSurface`.
- `SessionArtifactsCard` → **retired** from the rail. Session artifacts surface as inline artifact-ref cards in the conversation + in the Plan tab's `CONTEXT IN USE`.
- "Recent test" inline block → **retired**. Superseded by the Tests tab.
- `WriteLedgerCard` → **moved** into the new `LedgerTab` (admin-only 4th tab).
- "Agent trace" / "Raw system prompt" utility buttons → **moved** to a compact utility area pinned at the bottom of the right panel (below the active tab), visible only when the corresponding admin flags are set.

No component files are deleted in this sprint — only their render sites move. Retirement sweep happens in a follow-up cleanup after tests pass.

---

## R10 — Test migration strategy

**Decision**: Every test in `frontend/components/studio/__tests__/*.test.tsx` and `frontend/components/build/__tests__/*.test.tsx` continues to run. Where a test selects by `role` or `data-testid` against the old shell (e.g. `getByTestId('show-empty-sessions-toggle')`), we keep that same `data-testid` on the new implementation — the tests themselves are not rewritten. Where a test asserts DOM structure (uncommon in this codebase), we update the assertion to match the new tree.

**Rationale**:
- Spec SC-002 requires zero regressions.
- The current tests are mostly behavioral (user sends → message appears; citation click → drawer opens), not structural — so most pass unmodified.

**Alternatives considered**:
- Snapshot the old render tree and re-snapshot — rejected. The design is literally changing; snapshots would all "pass" with a human green-light and offer nothing.

---

## Summary

Every `NEEDS CLARIFICATION` resolved. No blocking questions remain. The plan proceeds to Phase 1 with:

- Font loader decision (R1).
- Token v2 namespace decision (R2).
- State persistence scope (R3).
- Preview input architecture (R4).
- Tests-tab accordion decision (R5).
- Reference picker sources (R6).
- A11y tab pattern + shadcn primitive (R7).
- Responsive reflow strategy (R8).
- Right-rail subsume/retire map (R9).
- Test migration plan (R10).
