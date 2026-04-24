# Quickstart — Studio Redesign

Verification runbook for 046-studio-redesign. Walks through every user story and success criterion so reviewers and QA can reproduce the acceptance path.

---

## 0. Pre-reqs

```bash
# Backend (unchanged — starts same as main)
cd backend && npm install && npm run dev

# Frontend
cd frontend && npm install && npm run dev
```

You need:
- A tenant with **at least one property** and **at least one existing SOP + FAQ** (for the Reference picker to have content).
- Both an **admin** tenant login (`isAdmin: true`, `rawPromptEditorEnabled: true`, `traceViewEnabled: true`) and a **non-admin** tenant login (all three flags false).
- A modern evergreen browser, viewport ≥1440×900 for the primary audit.

---

## 1. Visual smoke check (US1 AS1)

1. Sign in as the admin tenant.
2. Navigate to Studio (the "Studio" tab in the main nav).
3. Confirm:
   - Three panels: left rail 260px, center pane flex, right panel 340px.
   - Font: Inter Tight everywhere; mono text (file paths in artifact-ref cards, numeric readouts) is JetBrains Mono.
   - Canvas: pure white; left rail: `#fafafa`; right panel: `#fafafa`; active session row: `#f4f5f7`.
   - Primary accent shows up only on the Send button (when the composer has text), on active-tab indicators, on diff-added line markers, and on the Plan tab's progress bar.
   - Right panel defaults to the **Plan** tab.

**Pass criterion**: SC-005 (design conformance). Use the design handoff HTML in `/Users/at/Downloads/design_handoff_studio/Studio.html` side-by-side.

---

## 2. Full tuning loop (US1 AS2–AS4 → SC-001, SC-010)

1. In the composer, type: `tighten our late check-in replies — shorter, warmer, mention the key box code 4829`.
2. Press Enter.
3. Confirm immediately (≤500ms):
   - Your message appears as a right-aligned ink-filled bubble.
   - An assistant scaffold appears with a blinking cursor + status text.
   - A **reasoning toggle** appears above the body ("Thought for Ns") within half a second of the first token.
4. As tokens stream:
   - Tool-call rows flip from **running → done** with a duration readout.
   - Inline **artifact reference cards** render when the agent drafts artifacts.
5. Click an artifact-ref card. Confirm:
   - The **artifact drawer** slides in from the right over the right-panel tab content (200ms ease-out).
   - The drawer shows kind / title / file path / body (SOP or diff).
   - Close it (Esc or the × button). Focus returns to the clicked card.
6. On the Plan tab, click the **Apply** button (inside the plan checklist). Confirm:
   - The **PropagationBanner** appears above the conversation.
   - The Plan tab reflects the applied state.

**Pass criteria**: SC-001 (first-token ≤500ms), SC-010 (no AI-pipeline regressions — byte-identical tool-call traces vs. pre-redesign).

---

## 3. Right-panel tabs (US2 → SC-004)

1. **Plan tab** (default): while a turn is in-flight, watch the task checklist's dots flip running → done and the progress bar animate. "CONTEXT IN USE" lists the artifacts the agent read from.
2. **Preview tab**:
   - Type a guest message in the inline input at the top (e.g. `my wifi doesn't work`).
   - Click **Send test**.
   - A test result renders:
     - Guest bubble (right-aligned, `#f4f5f7`).
     - Agent bubble (left-aligned, `#f4f7ff`, with 1px accent-alpha border).
     - Latency / tokens / cost 3-card row under the bubbles.
3. **Tests tab**:
   - The latest test renders as `TEST SUITE — {runLabel} · {N} cases`.
   - Each variant is a case row with a status dot + name + duration.
   - Click a row → it expands in place with the existing `TestPipelineResult` detail (pipeline output + judge verdict).
   - Click the same row again → it collapses.
4. **Collapse/expand**:
   - Click the `panel-right` icon → panel shrinks to 40px.
   - Click the expand icon in the strip → panel returns to 340px.
   - Confirm the previously active tab is still selected.

**Pass criterion**: SC-004 (time-to-last-test-result ≤5s via Tests tab).

---

## 4. Left rail (US3)

1. With ≥5 sessions, confirm:
   - **Recent** section (updated ≤7 days ago) and **Earlier** section rendered with the specified eyebrow labels.
   - Each row shows title + `{tenant} · {relative time}` meta (sessions are tenant-scoped; the first meta segment is the tenant / workspace name — per-property scoping is a deferred follow-up).
   - Active session has `#f4f5f7` bg + `#ink` 500-weight title.
2. Type `late` into the search input. Confirm the list filters to matching titles (case-insensitive) within ~150ms.
3. Click **New chat**. Confirm:
   - A new session is created.
   - Center pane lands in the empty-state illustration (48px blue-soft message icon + "Start a new thread" + Back button).
4. Confirm the **footer property row** renders read-only — property glyph + name + "{N} properties · operator" — with NO chevron and NO click handler.
5. Flip the "Show empty sessions" toggle. Confirm zero-message sessions older than 1h reappear.

---

## 5. Admin surfaces (US4 → SC-009)

Still signed in as the admin tenant:

1. Confirm the right-panel tab bar shows **four** tabs: Plan / Preview / Tests / **Ledger**.
2. Click **Ledger**. Confirm:
   - Rows render via the existing `WriteLedgerCard`.
   - Clicking a row opens the **ArtifactDrawer** scrolled to the Verification section, with the rationale card above the diff.
   - Clicking a row's revert → the two-step preview+confirm flow fires (dry-run, then `window.confirm`, then commit).
3. At the bottom of the right panel (below the active tab, above the panel edge), confirm two utility buttons:
   - **Agent trace** → opens `TraceDrawer`.
   - **Raw system prompt** → opens `RawPromptDrawer`.

Sign out and sign back in as a **non-admin** tenant:

4. Confirm the Ledger tab is **not rendered at all** (no disabled stub).
5. Confirm the two utility buttons are **not rendered**.
6. Confirm every other tab (Plan / Preview / Tests) still works.

---

## 6. Composer chips (FR-025a, FR-025b)

1. In the composer, click the **Reference** chip.
2. A popover opens with segments: SOPs / FAQs / Prompt / Tools / Properties.
3. Pick a SOP → the popover closes → a citation chip is inserted into the textarea at the cursor position.
4. Send the message. The assistant should see the citation in context (behavior unchanged from today).
5. Type a fresh message like `try hi guest, are you sure you can check in at 3pm?` and click the **Test** chip.
6. Confirm:
   - The right panel jumps to the **Preview** tab.
   - The Preview tab's input is populated with that text.
   - The test-pipeline fires immediately and the result renders.
   - The composer textarea is **unchanged** (the chip copied, not consumed).

---

## 7. Responsive reflow (US5 → SC-007)

1. Resize the window to ≤899px wide.
2. Confirm:
   - Left rail collapses behind a hamburger toggle (off-canvas).
   - Right panel defaults to the 40px strip.
   - No horizontal scroll anywhere.
3. Resize up to 1920px. Confirm no horizontal scroll, all three panels at spec widths.

---

## 8. Accessibility spot-check (SC-006)

1. Run axe-core via the devtools panel on the main Studio view, the open Preview tab, the open Tests tab with a row expanded, and the artifact drawer open.
2. Confirm zero WCAG AA violations on each.
3. Tab-key traversal: every interactive surface is reachable and has a visible focus ring. Left/Right arrows move between right-panel tabs.
4. The clarifying-question radio (when present in a conversation) is keyboard-operable.

---

## 9. Test suite (SC-002)

```bash
cd frontend
npx jest components/studio
npx jest components/build
```

Both suites must be **green**. Selector updates are allowed in `__tests__/*.test.tsx` only where the new shell renames a role/testid; no assertions are deleted.

---

## 10. Design audit (SC-005)

Take a full-page screenshot of the Studio surface at 1440×900 and compare side-by-side with `/Users/at/Downloads/design_handoff_studio/Studio.html` rendered in the same viewport.

Check:
- Spacing deltas ≤ 2px.
- Palette: no ad-hoc hex outside the v2 token set.
- Border-radii: ±1 unit tolerance.
- Icon stroke: 1.6px at 16px.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Fonts look wrong / system-ish | `next/font` not wired in `app/layout.tsx` | Re-check the loader config + Tailwind `@theme` variables |
| Right panel stuck collapsed at ≥900px | `useIsNarrow` default mis-set | Check the hook's initial value (it should use `window.matchMedia` at mount, not stale `false`) |
| Ledger tab visible for a non-admin | Capabilities fetch returning a stale cached value | Clear the capabilities cache on logout |
| Composer Test chip not switching tabs | `StudioShellContext.runPreview` not called — chip handler skipping the context | Verify `onTestChip` forwards through `StudioShellContext` |
| Artifact-drawer focus doesn't return on close | Shell portaled the drawer outside the opener's React tree | Keep `artifactDrawerOpenerRef` at `StudioSurface` level; the new shell doesn't replace it |
