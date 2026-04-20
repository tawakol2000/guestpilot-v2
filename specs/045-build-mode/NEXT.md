# Sprint 046 — backlog + session handoff

> Written at sprint-045 close (2026-04-20). Sprint 045 shipped via direct
> branch deploy on `feat/045-build-mode` — no PR, no merge to main.
> `ENABLE_BUILD_MODE` is off in every environment default; flip manually
> on Railway after deploy when ready to expose BUILD.
>
> Previous session's handoff archived at
> [`NEXT.sprint-045.archive.md`](NEXT.sprint-045.archive.md) — read that
> for the Gate-by-Gate narrative of sprint 045.
>
> Owner: Abdelrahman (ab.tawakol@gmail.com).

---

## 1. First moves of sprint 046

Pick one of these as the opening task depending on what the BUILD rollout
surfaces first. None block each other; all three are worth doing before
BUILD-mode public beta.

### 1.1 Live cache-hit capture + decision revisit

Deferred from Gate 7.2 (session 6). As soon as `ENABLE_BUILD_MODE=true`
flips on in a real Railway environment and a few TUNE-only + BUILD-only
+ mixed sessions run through, pull `cache_read_input_tokens` counts per
layer from Langfuse and check them against the spec's targets:

| Layer                         | Baseline tokens | Target hit-rate |
|-------------------------------|-----------------|-----------------|
| tools-array only              | 2,399           | ≥0.95           |
| tools + shared prefix         | 5,255           | ≥0.995          |
| full BUILD/TUNE cacheable     | 3,748 / 3,475   | ≥0.998 TUNE, ≥0.995 mixed |

If the mixed-session hit-rate comes in <0.95, **the Gate-1 "automatic
prefix caching" decision is the one to reopen** (see
`PROGRESS.md` → "Decisions made this sprint" → "Cache breakpoints:
automatic, not explicit"). The fallback is to bypass the Claude Agent
SDK's `systemPrompt: string` surface and call `@anthropic-ai/sdk`
directly with explicit `cache_control: { type: 'ephemeral' }` blocks
on the three region boundaries. Non-trivial rewrite (~1 day) but the
code sits in `backend/src/build-tune-agent/runtime.ts` in one place.

If hit-rate comes in ≥0.98 on mixed, record the number in a new
"Cache metrics — confirmed in prod" section of PROGRESS.md and move on.

### 1.2 Lean `invalidateTenantConfigCache` extraction

Deferred from Gate 2 (session 2) — also captured in PROGRESS.md
"Decisions made this sprint". Current symptom:

- `tenant-config.service.ts` transitively drags `ai.service.ts` →
  `socket.service.ts` → `middleware/auth.ts` into any module that wants
  to invalidate the cache, and `auth.ts` calls `process.exit(1)`
  without `JWT_SECRET`. So BUILD tools (`write_system_prompt`,
  `create_tool_definition`) rely on the 60s TTL rather than importing
  the invalidator.
- Acceptable for BUILD-in-manager-interview (the manager is still in
  preview during the TTL window) but fragile for public beta.

Extraction target: move `invalidateTenantConfigCache` + the cache Map
into a new `services/tenant-config-cache.service.ts` that has zero
dependencies except Node's `Map`. Have `tenant-config.service.ts`
import from it (keeping the public API surface). Then BUILD tools can
import the lean module and invalidate synchronously. ~2 hours of work;
zero behaviour change.

### 1.3 BUILD-mode cooldown + oscillation semantics

When the manager hits "rollback" on a transaction and then immediately
prompts the agent again ("try again, but gentler"), the agent should
NOT re-propose the exact same plan within a short window. The
sprint-045 rollback tool reverts the artifacts but leaves no signal
that the manager disagreed with the prior approach — the agent can
and will re-propose it.

Design sketch:

- On rollback, write an `AgentMemory` entry
  `session/{conv}/rolled-back/{txId}` with the plannedItems snapshot.
- In `plan_build_changes`'s pre-execution path, diff the proposed
  items against any recent rolled-back plans for this conversation.
  If overlap >50%, return an error telling the agent the manager
  already rejected this shape and it must ask clarifying questions
  first.
- The `PreToolUse` hook is the natural home for this check — it can
  short-circuit the tool call before the agent wastes a turn.

Cross-links:

- Existing hook at `backend/src/build-tune-agent/hooks/pre-tool-use.ts`.
- Existing memory service at
  `backend/src/build-tune-agent/memory/service.ts`.
- Gate 045-§11 kept this explicitly out of scope ("BUILD-mode cooldown
  / oscillation semantics — sprint 046").

---

## 2. Medium-sized follow-ups (take any opportunity)

### 2.1 `/build` UX polish

Session-5 shipped the 3-pane layout but a few rough edges remain; the
live Gate-7.1 walkthrough (deferred with the rest of Part 2) is where
these will become visible:

- **Propagation banner timing.** Currently shows a fixed 60s countdown
  after approve. That number is decoupled from the actual
  `tenant-config` TTL (also 60s), which is the real gate on when
  new prompts hit the main pipeline. If §1.2 lands, collapse the
  banner the moment the cache is actually invalidated.
- **Rollback confirm modal.** Clicking "Roll back" on
  `TransactionHistory` fires the API call with no intermediate
  confirm. For pilot that's fine; for beta add a confirm modal that
  lists what will be deleted (pull from `plannedItems` on the
  transaction row).
- **GREENFIELD onboarding smoothing.** The hero copy renders from
  `isGreenfield`, but the first-turn prompt doesn't pre-fill anything.
  Consider a 3-chip starter ("I run short-term rentals", "Property
  manager agency", "Boutique hotel") that seed the interview opener
  rather than a blank textarea.
- **Transaction-history pagination.** Only shows the most recent
  transaction (`tenantState.lastBuildTransaction`). Listing more
  needs a new `GET /api/build/plans` endpoint with limit/offset and
  a small list view in `TransactionHistory`.
- **Tenant-state aggregator cache.** `getTenantStateSummary` fires 6
  parallel `count` queries per BUILD turn. Fine for pilot, 30s
  in-memory cache keyed by `tenantId` before public beta.

### 2.2 Cross-mode PreToolUse sanction gate

Today, attempting a BUILD tool from TUNE mode (or vice versa) returns
an `allowed_tools` denial from the SDK — ugly and non-actionable. The
research brief calls for a confirm-to-switch flow: when the agent
tries a tool that isn't in the current mode's allow-list, the hook
returns a `data-mode-switch-requested` part to the UI, which shows a
banner asking the manager to confirm switching modes. On confirm, the
next turn runs in the other mode.

This is a visible-to-users change and needs a spec update + a new SSE
data part, so it's its own small sprint-046 track.

---

## 3. Longer-tail / "when a customer asks"

Straight carry-over from MASTER_PLAN §sprint-047+ — **do not start
these in sprint 046** unless a paying customer explicitly pulls.

- **Batch preview subsystem** (golden-set + adversarial generator +
  deterministic rubric + LLM judging). Deferred from sprint 045 on
  2026-04-19; trigger is a paying customer asking for multi-scenario
  batch testing before apply, or D7-retention / default-override-rate
  data showing `test_pipeline` single-message loop is letting
  regressions through.
- Billing, plan tiers, per-tenant token budgets.
- Multi-language BUILD interview (Spanish, Portuguese, Arabic).
- Templated onboarding flows per sub-vertical.
- Platform-aggregate SFT from preference pairs.
- Admin surface for harness maintenance.
- Self-serve signup + Hostaway OAuth import inside `/build`.

---

## 4. Open design questions carried into sprint 046

Answered as data from the live rollout comes in:

- **Slot-persistence proof.** Is the BUILD addendum's
  `memory.create`-with-key instruction honored at rate ≥90%? If
  Langfuse traces show skipping, tighten the addendum in
  `backend/src/build-tune-agent/system-prompt.ts`. Currently the
  entire InterviewProgress widget assumes the agent follows it.
- **Approve-then-execute gating.** Today: record `approvedByUserId` +
  `approvedAt`, trust the agent's BUILD addendum to wait. Stricter:
  reject follow-up `create_*` calls on a PLANNED transaction whose
  `approvedAt` is null. Pilot rule works; public-beta rule may need
  the server-side gate. Decide after first live flows — if the agent
  runs past approval with today's rule, flip.
- **Terminal-recap location.** V2 defaulted to `dynamic_suffix` per
  the spec tiebreaker. Re-evaluate if rule adherence <80% in prod
  Langfuse.
- **Activation-funnel metrics.** Instrumentation deferred to sprint
  046; reporting deferred to sprint 047+. Targets in MASTER_PLAN §7.

---

## 5. Hard constraints still in force

- `ENABLE_BUILD_MODE` stays **off** in `.env.example` and every
  config default. Manual flip only, after deploy, scoped to a single
  environment at a time.
- Do not modify Prisma tables outside what sprint 045 already shipped
  (`BuildTransaction` + 5 nullable FK columns + `approvedByUserId` +
  `approvedAt`). Any new field needs a spec entry first.
- TUNE behaviour must remain intact at every commit. Run
  `JWT_SECRET=test OPENAI_API_KEY=sk-test npx tsx --test $(find src/build-tune-agent -name "*.test.ts")`
  before every commit.
- Frontend must keep using `components/tuning/tokens.ts` verbatim — no
  main-app blue palette import.
- Do not add SSE part types beyond `data-build-plan` +
  `data-test-pipeline-result` (+ the existing TUNE parts) without
  backend changes and an updated spec §11.
- No PR / merge-to-main automation. Branch-to-branch deploys continue
  per the `feat/045-build-mode` model until the user decides otherwise.
