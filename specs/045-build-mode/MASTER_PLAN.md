# GuestPilot — Unified Build+Tune Agent — Master Plan

> Living doc. Updated as sprints land and the picture sharpens.
> Last touched: 2026-04-20 (sprint 045 shipped)
> Owner: Abdelrahman (ab.tawakol@gmail.com)

---

## 1. North-Star vision

**Vibe-code your AI chatbot through chat.**

A property manager opens GuestPilot, describes their business in natural
language, and in under an hour has a production-quality AI handling guest
messages across Airbnb, Booking.com, WhatsApp, and direct channels — no
forms, no developer, no weeks of configuration. When the AI makes
mistakes, the same conversational surface is where they tune it. Setup
and refinement become the same action.

The model is what Lovable did for web apps, Cursor did for code, Sierra's
Ghostwriter did for enterprise support agents — applied to the one
vertical where the harness is tight enough to ship with real quality
guarantees: short-term-rental hospitality.

## 2. The strategic bet

Sierra launched Ghostwriter in March 2026. Chat-to-build is no longer
novel. The moat is not the chat surface — that's table stakes by late
2026. The moat is the **opinionated hospitality harness**:

- A **canonical hospitality template** (`GENERIC_HOSPITALITY_SEED.md`)
  that encodes what a good serviced-apartments AI knows out of the box.
- A **shipped golden set** of 30 canonical hospitality messages per
  property type that every new configuration is tested against on
  graduation.
- A **property-type-specific adversarial suite** (50-100 messages) that
  probes prompt injection, PII solicitation, policy edge cases, urgency
  misclassification — run automatically every time configuration changes.
- A **DECISIONS.md schema** that captures why each policy was chosen,
  surfaced to the tune agent only when a new correction conflicts with an
  earlier decision — Nielsen's recognition-over-recall applied to
  multi-month configuration drift.
- A **preference-pair capture** (already built in the tuning agent) that
  aggregates at platform scale into eval anchors and few-shot retrieval.

Build this right, and BUILD mode stops being a setup wizard and becomes
**the product**.

## 3. Why this matters now

GuestPilot today is a working, revenue-ready product for one operator
(Abdelrahman's properties). It has:

- A sophisticated main AI pipeline (coordinator + screening, 28-step
  flow, 6 system tools, SOPs with status variants and property overrides,
  FAQ knowledge base).
- A production-grade tuning agent (10 tools, 4 hooks, 8-category
  diagnostic, cached XML-tagged system prompt at 0.999 cache hit rate,
  sprint 01-09 shipped, sprint 10 partially shipped).
- Best-in-class observability (Langfuse spans throughout, preference
  pair capture, message compaction, confidence tracking).

What it doesn't have is a zero-to-one path for a *new* operator. Today,
becoming a GuestPilot tenant means: connect Hostaway → fill out forms →
wait for someone to hand-tune your prompts → iterate manually. That's
not a vibe-code experience. That's 2022 onboarding.

Build mode closes that gap. Combined with the existing tuning agent,
GuestPilot becomes the first hospitality AI platform where a non-technical
manager can go from "I have 5 apartments" to "my AI is handling guest
messages end-to-end" in under an hour.

## 4. Design thesis (from the research brief)

> "BUILD mode is a **surface** problem, not an **agent** problem. The
> mistake would be to bolt on a second prompt with a router. The right
> move is one persona, two tool surfaces gated by UI context, a second
> cache-control breakpoint at the mode-addendum boundary, and a
> synthetic-conversation eval loop that closes the trust gap Cursor,
> Bolt, and Replit never closed for their users."

Concretely:

- **One agent, two modes.** Same Claude Sonnet 4.6. Same Claude Agent SDK.
  Same hooks. Same persona. Mode addenda (~500-800 tokens each) describe
  posture and tool visibility. Three cache breakpoints.
- **UI-toggled explicit mode.** Entry from `/build` → BUILD. Entry from
  editing a reply → TUNE. No classifier turn, no LLM router.
- **`allowed_tools` gates visibility.** All tools always loaded in the
  cached `tools` array. Per-request allow-list. Cache survives mode
  switches.
- **Plan-first multi-artifact orchestration.** The agent surfaces a
  reviewable checklist (`plan_build_changes`) before executing. One
  transaction ID per plan, atomic rollback.
- **Preview loop as done-oracle.** Every significant BUILD change runs
  `preview_ai_response` against the golden set + agent-generated
  adversarial. Opus judges Sonnet's output (self-enhancement bias
  mitigation). Failures surface only; pass-rate gates graduation.
- **DECISIONS.md handoff** surfaces a BUILD decision into TUNE only when
  a correction would conflict with it. Surface on conflict, hide on
  agreement.

## 5. Sprint ladder

Three sprints to a complete product. Each sprint is a visible unit.

### Sprint 045 — Build mode foundations (Ship 1 + Ship 2 bundled)

**This sprint.** Visible `/build` page. Mode architecture, 4 new BUILD
tools, plan-first orchestration, preview loop.

- Mode architecture: 3 cache breakpoints, persona collapse, principles
  surgery, BUILD and TUNE addenda, tenant-state detection,
  terminal recap.
- 4 new BUILD tools: `create_sop`, `create_faq`, `write_system_prompt`,
  `create_tool_definition`.
- 2 new orchestration tools: `plan_build_changes`, `preview_ai_response`.
- Transaction-ID rollback across artifact types.
- Canonical `GENERIC_HOSPITALITY_SEED.md` template, ~20 slots.
- Golden set of 30 hospitality messages + adversarial generator.
- `/build` page, three-pane layout from the mockup.
- 3 empirical validations (allowed_tools cache, terminal recap location,
  default markers round-trip).

Spec: `specs/045-build-mode/spec.md`.
System prompt: `specs/045-build-mode/system-prompt.md`.
Status: **shipped 2026-04-20** — all 7 gates green on
`feat/045-build-mode`. Shipped via direct branch deploy rather than PR
by user decision; merge to main deferred. `ENABLE_BUILD_MODE` remains
**off** in every environment default and in `.env.example` — the user
flips it manually per-environment when ready to expose BUILD. Gate 7.2
cache-metrics walkthrough + Gate 7.3 PR wrap skipped; the sprint-045
E2E regression moat lives at
`backend/tests/integration/build-e2e.test.ts` and runs on every
`tsx --test` invocation (live live-agent path opt-in via
`RUN_BUILD_E2E_LIVE=true`).
See `specs/045-build-mode/PROGRESS.md` for the gate-by-gate closeout
and `specs/045-build-mode/NEXT.md` for the sprint-046 backlog.

### Sprint 046 — Continuity and handoff (Ship 3)

Makes BUILD feel like part of the product instead of a setup wizard.

- `ONBOARDING_STATE.md` — session resumption mid-interview. PreCompact
  hook snapshots state; SessionStart `source: "resume"` injects
  one-paragraph summary. Aggressive re-read of facts, aggressive skip of
  dialogue.
- `DECISIONS.md` — written at BUILD graduation with path-scoped sections
  per taxonomy category. TUNE-mode PreToolUse hook surfaces the relevant
  section when a correction conflicts.
- `view_state` tool callable in both modes — "what did I tell you about
  X" always returns the stored fact, never a paraphrase.
- Cross-mode PreToolUse sanction gate (replace `allowed_tools` denial
  with a confirm-to-switch flow).
- BUILD-mode cooldown and oscillation semantics for the `create_*` tools.
- Mobile-optimised `/build` layout.
- Full activation-funnel instrumentation (time-to-first-reply, completion
  rate, D7 retention, default-override rate).

Spec: `specs/046-continuity/spec.md` (not yet written).
Target: 2 weeks post-045.

### Sprint 047+ — Commercial hardening (rolling)

Unlocks revenue beyond Abdelrahman's own operation.

- **Batch preview subsystem** (golden-set + adversarial generator +
  deterministic rubric + LLM judging). Deferred from sprint 045 on
  2026-04-19 after the decision to ship a single-message
  `test_pipeline` tool first. Re-confirmed at sprint-045 close on
  2026-04-20 — still in the backlog, still gated on the same trigger.
  Trigger to build: a paying customer explicitly asks for
  multi-scenario batch testing of AI behaviour before apply, or
  D7-retention / default-override-rate data shows the single-message
  loop is letting regressions through. Until then, `test_pipeline`
  handles single-message verification.
- Billing, plan tiers, per-tenant token budgets.
- Multi-language BUILD interview support (Spanish, Portuguese, Arabic
  at minimum — serviced-apartments markets).
- Templated onboarding flows per sub-vertical (boutique hotels,
  co-living, vacation rentals, long-stay corporate).
- Platform-aggregate SFT from preference pairs (LIMA-style curated set
  across all tenants).
- Admin surface for harness maintenance (golden-set editing, adversarial
  suite tuning, DECISIONS schema evolution).
- Self-serve signup flow + Hostaway OAuth import wizard inside `/build`.
- Red-team eval dashboard per tenant.

No single sprint; these land as market feedback prioritises.

### Longer-term — independent service extraction (TBD)

The `backend/src/build-tune-agent/` folder is a clean module boundary.
Extract into its own service when one or more of these is true:

- Agent traffic materially competes with main-pipeline traffic on infra.
- Selling the agent standalone to a different vertical (e-commerce,
  insurance, healthcare) is on the roadmap.
- The team maintaining the agent is large enough that deploy coupling
  with the main app becomes a bottleneck.

None of these are true today. Revisit at the end of sprint 046.

## 6. Product principles (non-negotiable)

These are the rules every sprint is measured against.

1. **Vibe-code experience.** The manager never fills a form they don't
   want to. The agent asks one thing at a time, summarises back, and
   only writes artifacts after confirmation.
2. **Honesty over agreement.** The agent names conflicts explicitly.
   Never opens with "Great question." Never fills a default silently.
   Leads with failure when a preview fails.
3. **Human-in-the-loop for writes, forever.** Every artifact write
   requires explicit manager sanction. The hook enforces this; the LLM
   cannot bypass.
4. **Never break the main guest-messaging flow.** BUILD and TUNE are
   additive. If any path regresses guest-facing AI, the change reverts.
5. **Graceful degradation.** Missing env vars, missing API keys, missing
   Redis — the app keeps working. Tuning and BUILD surfaces disable
   with a calm banner, not a stack trace.
6. **The harness ships with the product.** Canonical template, golden
   set, adversarial suite, DECISIONS schema — all in-repo, versioned,
   updated sprint by sprint as we learn what good hospitality AI looks
   like.
7. **Observability is first-class.** Every AI call logs to Langfuse with
   a transaction ID, every hook decision logs with a reason, every
   preview failure logs with a plain-language summary. If it isn't in
   Langfuse, it didn't happen.
8. **Vocabulary discipline.** SOPs, FAQs, system prompt, tools —
   managers see these words. The agent explains what each is when
   asked. We don't hide the artifacts behind euphemisms.

## 7. Success metrics (North-Star-aligned)

Activation-funnel metrics, instrumented in sprint 046, reported from
sprint 047 onwards.

1. **Time to first-guest-reply** (TTFV). Interview start → first AI reply
   sent to a real guest. Target: <60 min median for a solo manager.
   Benchmark: form-based config is 3-5 hours.
2. **Completion rate.** Started BUILD → graduated. Target: >70%. Below
   50% means the interview is too long or tacit-knowledge elicitation
   is failing.
3. **D7 retention.** Sent ≥1 AI reply/day for 7 consecutive days
   post-graduation. Target: >60%. This is the activation metric that
   matters.
4. **First-100-replies quality.** BUILD-configured AI vs (a) pre-BUILD
   manual baseline, (b) no-BUILD defaults-only. Target: beat defaults-only
   on ≥80% of replies, match manager-manual on ≥70% (LLM-judge, rubric
   double-check).
5. **Graduation-time distribution.** Investigate any tail beyond p90.
6. **Default-override rate in first 30 days.** % of default-marked slots
   that get corrected in TUNE. Target: <40%. Low means defaults are
   fine; high means the interview isn't extracting enough.

## 8. Spec index (this folder)

- `MASTER_PLAN.md` — this file. Vision, sprint ladder, principles.
- `research-prompt.md` — the prompt sent to Claude AI for deep research.
- `spec.md` — sprint 045 spec (Ship 1 + Ship 2 bundled).
- `system-prompt.md` — Claude Code session prompt for sprint 045.
- `ui-mockup.html` — locked-in three-pane layout.
- (pending, sprint 045 deliverables)
  - `validation/V1-result.md` — allowed_tools cache check.
  - `validation/V2-result.md` — terminal-recap location A/B.
  - `validation/V3-result.md` — default markers round-trip.
  - `PROGRESS.md` — gate status, updated as the sprint lands.
  - `NEXT.md` — handoff doc for sprint 046.

Related specs elsewhere in the repo:

- `specs/041-conversational-tuning/` — the original tuning agent spec,
  sprints 01-10. Spec 041 introduces the taxonomy, hook layer, and
  cached system-prompt architecture that sprint 045 extends.
- `specs/041-conversational-tuning/tuning-research-recommendations.md` —
  master research reference from sprint 041's paper. Some DEFERRED items
  unblock here.
- `specs/main-ai-system-prompt-rewrite.md` — main AI prompt rewrite.
  Not in sprint 045 scope; independent track.
- `specs/main-ai-pipeline-improvements.md` — main AI pipeline work.
  Partially shipped. Not in sprint 045 scope.

## 9. Decisions that have been made (do not re-litigate)

Stamped from the architecture brief + this sprint's planning
conversation. If you find yourself debating one of these, stop — the
decision is already in.

1. Unified persona, two mode addenda. Not two prompts + router.
2. All tools always loaded. `allowed_tools` per-request gates visibility.
   Not conditional tool loading.
3. Distinct `create_*` tools. Not `upsert_artifact(type, content)`.
4. Judge ≠ generator. Opus 4.6 or deterministic rubric for
   `preview_ai_response`. Never Sonnet grading Sonnet.
5. Template-with-slots for seed generation. Not final-big-generation or
   pure incremental accumulation.
6. Defaults-as-markers (`<!-- DEFAULT: change me -->`). Not silent
   defaults or forced full-interview.
7. Monorepo module boundary. Not independent service — not yet.
8. Keep SOP / FAQ / system prompt vocabulary exposed. Not
   "policies / answers / personality."
9. UI-toggled explicit mode with `allowed_tools` denial for cross-mode.
   Full PreToolUse cross-mode gate deferred to sprint 046.
10. Hospitality-locked. No e-commerce or other verticals in this or next
    sprint.
11. Claude Sonnet 4.6 for the agent. GPT-5.4 for the TUNE diagnostic.
    No fine-tuning at SMB scale. Preference pairs for eval + retrieval,
    not DPO.

## 10. Open questions that we DO revisit (every sprint close)

1. Is the canonical template converging? Slot count right? Default
   quality acceptable?
2. Is the golden set + adversarial suite catching real failures? Are
   false-positive rates tolerable?
3. Is the activation funnel hitting targets? Which step is the bottleneck?
4. Is DECISIONS.md being read and respected by the TUNE agent? Is the
   surface-on-conflict discipline working?
5. Is the `allowed_tools` mechanic still the right dispatch primitive
   as the tool count grows beyond 16?
6. When does independent-service extraction become the right call?
7. When do we unlock a second vertical?

Track these in `specs/045-build-mode/NEXT.md` (sprint 045) →
`specs/046-continuity/NEXT.md` (sprint 046) → etc. Each sprint closes
by answering them with evidence from that sprint's run.

---

## Appendix — reference reads

For new contributors, in order of priority.

1. `CLAUDE.md` — project orientation.
2. This file.
3. `specs/045-build-mode/spec.md`.
4. The research brief at `/sessions/charming-festive-babbage/mnt/uploads/BUILD + TUNE- architecture brief for a unified serviced-apartments agent.md`.
5. `backend/src/tuning-agent/system-prompt.ts` (will be renamed to
   `build-tune-agent` during sprint 045).
6. `specs/041-conversational-tuning/` — the original tuning-agent spec
   lineage.
7. `SPEC.md` at the repo root — full system specification.
8. `AI_SYSTEM_FLOW.md` at the repo root — main AI pipeline detail.

---

## Sprint 046 — shipped (2026-04-21)

Four sessions on `feat/046-studio-unification` (branched off
`feat/045-build-mode`; sprint 045 is not yet merged to main, so 046
builds on top of it). Net surface change:

- **Unified Studio tab** — `/build`, `/tuning`, `/tuning/agent` folded
  into one hash-state tab inside the main app shell (`inbox-v5.tsx`).
  The old top-level routes survive one sprint as 302 redirect stubs
  (deletion deferred to sprint 047). Main-app palette replaces the
  violet-forward tuning chrome.
- **Grounding-aware agent** — new `get_current_state` tool + forced
  first-turn call gives the agent full artifact text instead of
  counts-only. Response Contract (7 rules) + Triage Rules in both
  mode addenda push the agent toward card-first, single-top-finding
  outputs.
- **Enforcement linter** — post-turn output linter; R1 (long prose)
  and R2 (multiple suggested-fix) now enforce via `data-advisory`
  emits + first-wins interception, not log-only. R3 stays log-only.
- **Cleanup sweep** — 48h cooldown deny retired to a recent-edit
  advisory; oscillation deny flipped to advisory; session-scoped
  rejection memory for dismissed fixes; legacy
  `data-suggestion-preview` retired; back-compat shims
  (`tuning-agent/`, `components/tuning/tokens.ts`) deleted; orphaned
  `components/build/*` files swept.

See `PROGRESS.md` "Sprint 046" sections A + B + C + D + closing
paragraph for the full gate tables, cache baselines, and deferrals.
Sprint-047 carry-over (primarily D9's `BuildToolCallLog` admin trace
view + the redirect-stub deletion + dashboards merge) is scoped in
the fresh `NEXT.md` written at sprint 046's close.
