# Sprint 059 — Session A kickoff (draft — pick a target, then write the spec)

> **Runner:** Opus 4.7 with 1M context, unsupervised overnight run.
> **Parent branch:** `feat/058-session-a` (tip `48d022b`) stacked on `feat/057-session-a` (`a1fdf87`) → 056 → 055 → ... → main.
> Sprint-058 close-out lives in `NEXT.sprint-058-session-a.archive.md` and `PROGRESS.md`.

---

## Sprint-058 outcome (for context)

Nine gates, all landed. 5 of 6 screenshot regressions fixed. Two operator-owned items deferred into 059 candidacy:

1. **F1 runtime transport swap** — the contract-tested skeleton shipped but the actual runtime switch (direct `@anthropic-ai/sdk` call with MCP loop + hooks + session persistence) was deferred per spec §6 MCP-risk. If the user wants the `cached_fraction ≥ 0.70` deliverable shipped, this is the priority sprint.
2. **F9a React #310 root-cause pass** — error boundary ships but the hook-order bug still fires intermittently. Needs staging-repro to identify which 057 commit introduced it. Small but important.

---

## Candidates for sprint-059

Pick one. If no signal from the user by dispatch time, default to **A (F1 transport swap)** — it's the biggest unresolved deliverable from 058 and has a clear numerical acceptance criterion.

### A. F1 runtime transport swap + MCP reproduction (default)

**Why this one:** 058 shipped the scaffold; this sprint lands the actual cache fix. Every BUILD turn has been reading ~14k system-prompt tokens at full price for four sprints and counting. Numerical target: `cached_fraction ≥ 0.70` on turn 2 of a fresh conversation.

**Scope (sketch — spec needed):**
- `backend/src/build-tune-agent/runtime-direct.ts` — flip the param-builder into a streaming `@anthropic-ai/sdk` call
- MCP tool-call loop reproduction in the direct path (mcp__* names routed to MCP client; tool_use blocks handled; tool_result roundtrips)
- Hook dispatch (`preToolUse`, `postToolUse`, etc.) replayed from the event stream
- Session persistence — the SDK manages `sdk-session-id.json` today; direct path must either preserve or bypass this
- `stream-bridge.ts` shape parity between SDK and direct paths (snapshot test is required)
- Fallback: if any piece of the reproduction breaks a BUILD integration test, stop and report — this sprint MUST NOT ship a silent tool-use regression

**Risk:** spec §6 of 058 flagged this explicitly. One sprint MAY not be enough if the SDK's internal hook/session wiring is deeper than anticipated. Budget: 1 sprint of overnight Opus; if not done, land what's shipped gated behind `BUILD_AGENT_DIRECT_TRANSPORT=true` + a staging canary.

### B. Mobile-responsive Studio

**Why:** Operator is desktop-locked today. The Studio surface (`studio-chat.tsx`, `studio-surface.tsx`, `artifact-drawer.tsx`, `versions-tab.tsx`, `plan-checklist.tsx`) all assume ≥1024px viewports with the sidebar + main pane + drawer all visible. On a phone, the drawer overflows, the session list is hidden, the composer is cramped.

**Scope:** responsive breakpoints at 640px / 768px / 1024px. Drawer becomes a full-screen overlay on mobile. Session list collapses behind a hamburger menu. Composer wraps buttons. Versions tab becomes a stacked view instead of side-by-side. Artifact Preview + Versions tabs become a swipe-able carousel on mobile.

**Risk:** broad surface; lots of visual polish. Unit testing responsiveness is thin. Needs a Playwright mobile-viewport smoke pass at close.

### C. Agent-consumed operator-rationale feedback loop

**Why:** 055-A added `metadata.operatorRationale` to every artifact edit. 058 added version tags. None of this feeds back into future BUILD turns. The agent re-makes the same mistake the operator fixed yesterday, because it never sees the "why you rejected my version" text.

**Scope:** on BUILD-mode turn start, inject the last N operator rationales for this tenant into the system prompt (Region C, not cached). Agent SEES: "Here's what the manager has corrected about your previous work." Scope-gated to top-3 most recent rationales per artifact type, truncated to 300 chars each.

**Risk:** prompt bloat. Needs careful token-budget management. Also raises the question of "how far back does context go" which could surface privacy / locality concerns.

### D. Multi-operator real-time presence

**Why:** two managers editing the same SOP right now step on each other silently. No presence indicator, no lock, no "operator B is also editing this" banner.

**Scope:** SSE presence channel. When operator A opens an artifact drawer, broadcast `{tenantId, artifactId, operatorId}` to all connected tenant clients. When another operator opens the same artifact, show a "operator B is also here — don't overwrite each other" pill in the drawer header. No lock — just visibility. Optimistic-concurrency-control on apply: if the artifact body changed server-side between drawer open and apply, show a conflict dialog.

**Risk:** SSE fan-out infrastructure doesn't exist for this shape today. Presence hub is new work.

### E. Cross-artifact version tags

**Why:** F6 in 058 is single-artifact. Operator can't tag a SET of artifacts as "pre-launch-snapshot" and revert the whole set.

**Scope:** new `BuildArtifactSnapshot` model that groups N `BuildArtifactHistory` rows under a named label. Endpoint to create + list + revert-snapshot. Versions tab gets a "Snapshots" sub-tab. Revert-snapshot invokes the apply-layer N times atomically (or rolls back on partial failure).

**Risk:** rollback atomicity is the risky bit. Partial failures need a clear story.

---

## How to pick

Default is **A**. The user should say otherwise by the morning if they want B/C/D/E.

---

## Pre-flight for whichever target lands

- Branch `feat/059-session-a` off `feat/058-session-a` (`48d022b`).
- Run baseline tests: `cd frontend && npm test -- --run` (expect 347) + `cd backend && find src -name "*.test.ts" -not -path "*/integration/*" | xargs npx tsx --test` (expect 423 passing + 1 env-var failure).
- Write the spec into `specs/045-build-mode/sprint-059-session-a.md` before dispatching anything. Overnight discipline holds.
