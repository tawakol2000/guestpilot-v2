# Sprint 046 — Raw Issue List

> Captured verbatim from user feedback after sprint-045 deploy + screenshots
> review. Not yet grouped by severity; that happens in the plan doc. This
> file is the source-of-truth for "what actually hurts right now" — any
> refinement spec must resolve every item below or explicitly defer it.
>
> Captured: 2026-04-20. Owner: Abdelrahman.

---

## 1. Structural / Integration

1. **Frontend not merged.** The BUILD+TUNE agent backend is unified (one
   `build-tune-agent` package, shared system prompt, shared tools). The
   frontend is still two disconnected surfaces: `/build` and `/tuning`.
   Target: one surface (`/studio`).
2. **`/build` lives outside the main app shell.** No GuestPilot top nav,
   no shared sidebar, different palette (violet vs main blue). Reads as
   a separate product.
3. **`/tuning` is a legacy shell too.** Its own top-nav + sidebar system,
   not reusing the main app's chrome. Same disconnection problem.
4. **Sprint-045 spec explicitly forbade using the main-app palette** —
   that was meant to distinguish from TUNE, but ended up distancing
   `/build` from the whole product. Constraint is stale and must be
   dropped.

## 2. Agent quality / intelligence

5. **Agent can't see the full current system prompt** — gets truncated
   somewhere in its context. Impacts every edit decision; makes
   "review my setup" unreliable.
6. **Agent spits walls of markdown instead of structured responses** —
   tables, emoji bullets, numbered lists, open-ended questions at the
   end. No UI affordances. See: "Recommended Next Steps" screenshot.
7. **No triage.** On "review my setup" the agent enumerates every
   finding at once instead of ranking by leverage and surfacing the
   highest-priority fix first.
8. **No conversation memory.** Agent will re-propose something the
   manager already rejected earlier in the same session.
9. **Context bloat.** Agent dumps large state into its working context
   instead of pulling what it needs via tools.
10. **No targeting in proposed edits.** Agent says "update the system
    prompt" without specifying which slot/section/artifact in a
    machine-readable way that the UI could render as a chip.
11. **Questions are prose, not choices.** "Want to start on the system
    prompt now?" — no buttons, no recommended default. Forces typing.
12. **Agent doesn't use tools correctly / doesn't know when to.**
    Anecdotal from screenshots; needs empirical trace review.

## 3. Tuning-specific blockers

13. **48-hour cooldown between edits.** Legacy Shadow-Mode autopilot
    safety net. Makes zero sense for manager-driven conversational
    editing. Kill or demote to soft warning.
14. **Tuning surface has complex legacy UI (pairs / sessions /
    playground / capability-requests / history)** that doesn't map
    onto the unified-agent model. Needs a migration path.

## 4. UI / visual language

15. **"Androidy" aesthetic.** Reasoning chevron, emoji status pills
    (🟢🟡❌), rounded-2xl everywhere, chat-bubble drop shadows,
    gradient CTA buttons. Reads cheap. Reference taste: Linear /
    Raycast restraint.
16. **Suggested fixes render as markdown text.** No diff viewer, no
    before/after, no accept/reject buttons inline with the proposed
    change.
17. **Audit output is one huge text bubble.** 600+ words of markdown.
    Should be a compact card with status rows + "View" / "Fix" buttons
    per row.
18. **Pending-suggestions queue not surfaced in the agent chat.** The
    agent mentions "18 pending suggestions" but has no card to render
    them; manager has to navigate elsewhere.
19. **Reasoning chevron is intrusive.** Should be a single muted
    one-liner ("Thought for 4s"), inline, not a chevron block.

## 5. What we already agreed (from prior turns)

20. **Merge `/build` + `/tuning` into one surface.** User confirmed
    Option B.
21. **Linear/Raycast as the visual reference.** User confirmed.
22. **Forced `get_current_state` on first turn of every conversation**
    is acceptable — small latency hit in exchange for grounding.
23. **Priority ranking of card types:** Suggested Fix > Question >
    Audit. Then Plan, Pending Suggestions, Test Result, Slot Progress.

---

## Notes for the refinement plan

- Every issue above must be addressed or explicitly deferred with
  rationale. No silent drops.
- Acceptance criteria for sprint 046 should be stated in user-outcome
  terms ("a manager can go from zero to a working prompt in under 10
  minutes inside the main app shell") — not gate-ticking ("ship card
  X"). Sprint 045 made the opposite mistake.
- Backend agent is unchanged enough to keep; most of the work is:
  (a) frontend shell integration, (b) new SSE part types + card
  components, (c) system-prompt response contract + triage rules,
  (d) new tools (`get_current_state`, better targeting), (e) killing
  stale constraints (48h cooldown, violet palette).
