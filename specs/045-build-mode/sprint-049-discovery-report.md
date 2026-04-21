# Sprint 049 — pre-session discovery

> Read-only audit against `feat/048-session-a` @ `c206db0`. No code changes.
> Cross-checked the 11 findings from the prior Explore pass, then swept
> sections A–H for anything it missed. Every line reference below was
> read in this session.

## Audit verification (11 findings from prior Explore pass)

### #1 — `approveSuggestion` skips tuning diagnostic — **CONFIRMED (but no live impact)**

Verified in `backend/src/controllers/conversations.controller.ts:517-592`. The
handler never imports `runDiagnostic` / `writeSuggestionFromDiagnostic` /
`semanticSimilarity` / `shouldProcessTrigger` (compare against
`messages.controller.ts:18-21,170-205`).

Called only from `frontend/components/inbox-v5.tsx:5091-5095`, where the pill's
arrow button posts `editedText = aiSuggestion` verbatim. The new pill-side
**Edit** affordance at `inbox-v5.tsx:5067-5089` seeds the textarea via
`seedReplyFromDraft` and routes through `messages.controller.send` (which
*does* fire the diagnostic), so `editedText !== suggestion` never actually
hits this endpoint today. **Dead path waiting to bite any future UX that adds
"edit-then-approve on the arrow button".** Matches sprint-049 NEXT.md §2.4.
Fix shape: copy the EDIT/REJECT split from `messages.controller:176-205`.

### #2 — `approveSuggestion` Hostaway failure orphans DB state — **PROMOTED to P0**

Order of writes in `conversations.controller.ts:540-580`:
1. L545 — `pendingAiReply.update({ fired: true, suggestion: null })`
2. L560 — `hostawayService.sendMessageToConversation(...)` ← throws
3. L563 — `prisma.message.create(...)` (never reached)
4. L575-578 — `lastMessageAt` bump (never reached)

A throw at step 2 is caught by the outer `try` at L588 and returns a bare
`500 { error: 'Internal server error' }`. But step 1 already ran: the
`PendingAiReply.suggestion` is **null** and `fired=true`, so the operator's
retry finds nothing to approve (L536 returns 404). Compare to
`messages.controller.send:77-92` which catches the Hostaway failure and still
saves the local message with `deliveryStatus=failed`.

Also: **no `cancelPendingAiReply(id)` call** (divergence from
`messages.controller:168`). If a second `PendingAiReply` exists for the
conversation without `suggestion`, only the most-recent `suggestion != null`
row is marked fired — the debounce row keeps ticking and may fire an
unrelated AI reply on top of the just-sent manual one.

Fix shape: reorder to match `messages.controller.send` — Hostaway first with
status capture, then create `Message` with `deliveryStatus`, then clear the
pending row, then `cancelPendingAiReply(id)`. Return 502 when Hostaway fails
so the UI can re-show the suggestion.

### #3 — Dead `/tuning/agent` link in playground — **CONFIRMED**

`frontend/app/tuning/playground/page.tsx:363` renders a `<Link href="/tuning/agent">Edit agent →</Link>`
in the sidebar footer. `frontend/app/tuning/` contents: `capability-requests/`,
`history/`, `layout.tsx`, `pairs/`, `playground/`, `sessions/` — **no `agent/`
subdirectory**. Click → Next.js 404.

### #4 — Dead `/tuning/agent` link in top-nav — **PROMOTED**

`frontend/components/tuning/top-nav.tsx:8-16`: unconditional link list. Two
routes in that list are 404s:
- `/tuning` (line 9, "Suggestions") — `app/tuning/` has **no `page.tsx`**,
  only `layout.tsx` + subdirs. The layout with no page 404s.
- `/tuning/agent` (line 10, "Agent") — no directory.

Both are always rendered on every tuning page. A manager clicking either
lands on a 404. Promoted: two dead routes in the default navigation, not one.
Fix shape: either remove them or ship the missing pages.

### #5 — CLAUDE.md lists torn-down `tuning-analyzer.service.ts` — **CONFIRMED**

Glob `backend/src/services/tuning-analyzer.service.ts` → **no files found**.
CLAUDE.md Key Services table still lists it at the Feature 040 line. Teardown
comment at `backend/src/app.ts:42-44` already acknowledges the removal.
Stale documentation. Fix: drop the row from CLAUDE.md.

### #6 — Divergence from `messages.controller` — **FALSE POSITIVE (duplicate of #1)**

Same symptom, same file, same fix. Merge into #1.

### #7 — `inbox-v5` `.catch(console.error)` on checklist writes — **PARTIAL**

Verified grep lines don't match audit's ~2590/2610/2760/2780. Real hits:

| Line | Call | Verdict |
|------|------|---------|
| `inbox-v5.tsx:3030` | `apiUpdateConversationChecklist({ passportsReceived })` | **needs-toast** — optimistic UI update at L3031 *assumes* success; a failed write leaves the UI showing the checkmark with DB unchanged |
| `inbox-v5.tsx:3058` | `apiUpdateConversationChecklist({ marriageCertReceived })` | **needs-toast** — same pattern |
| `inbox-v5.tsx:4645,4667` | `apiRateMessage(msg.id, newRating)` | **fine-as-is** — thumbs-up/down is telemetry, silent failure tolerable |
| `inbox-v5.tsx:4793` | `apiRateMessage(msg.id, 'negative', correctionLabels)` | **fine-as-is** |
| `inbox-v5.tsx:1892,1943,1958,2033,2070` | background polls, audio autoplay | **fine-as-is** — cosmetic / best-effort |

Fix shape: wrap the two checklist mutations in `toast.error` on failure and
revert the optimistic state update.

### #8 — Doc-handoff gating — **CONFIRMED GATED (by inertia)**

`schema.prisma:73` — `docHandoffEnabled Boolean @default(false)`, so new
tenants ship with the feature off. Service `doc-handoff.service.ts:321` does
explicit `if (!tenant.docHandoffEnabled) finalize(SKIPPED_FEATURE_OFF)`.
Recipients (`docHandoffManagerRecipient`, `docHandoffSecurityRecipient`) are
both nullable, and `isValidRecipient` gates `SKIPPED_NO_RECIPIENT` at L334.
The WAsender provider itself is env-gated via `isWasenderEnabled()` at L325.

Four layers of gate, all default-off. "Feature 044 code exists" but is
inert for anyone who hasn't flipped both the tenant flag *and* configured
recipients. Worth adding a configure-AI UI check in sprint 049 that the
toggle is discoverable — otherwise it's a permanently-disabled feature.

### #9 — `BuildTransaction.finalize` swallows errors — **DEMOTED (intentional)**

Read `build-tune-agent/tools/build-transaction.ts:31-187` end-to-end. The
two `.catch(() => {})` blocks at L66 and L139 guard optimistic status flips
(`PLANNED → EXECUTING`, `EXECUTING → COMPLETED`). Both are race-safe by
design — the next `validateBuildTransaction` or
`finalizeBuildTransactionIfComplete` call re-reads the status, and terminal
states (`COMPLETED / PARTIAL / ROLLED_BACK`) short-circuit further writes at
L52-56 and L122-132. The outer `try/catch` at L146 is `console.warn`-only,
which does hide the failure from anyone not tailing logs — but by that point
the transaction state machine is already self-healing on the next turn.

Real bug risk is zero. Observability is thin. Not worth a session.

### #10 — Feature 043 scheduled-time — **CONFIRMED (minor shape risk)**

`scheduled-time.service.ts:28-31`: `within()` uses lexicographic string
compare on HH:MM. Safe iff inputs are zero-padded 24-h ("18:00", not
"8:00"). Comment at L25-27 tells callers to regex-validate — doesn't say
whether the LLM output is validated anywhere upstream. Single-character hour
("8:00") compares `> "18:00"` lexicographically, flipping the check.

Not urgent (schema enforcement upstream should hold), but worth a 10-minute
regex guard in `within()` to fail-closed on malformed input rather than
silently misrouting an auto-accept. Otherwise: confirmed functional.

### #11 — Prefix-cache production claims — **DEMOTED (non-code)**

`PROGRESS.md:41-104` documents the cache-stability baselines with a
regression test at `backend/src/build-tune-agent/__tests__/prompt-cache-stability.test.ts`.
Not a bug, just a Langfuse-observability TODO for sprint 050+.

---

## Additional findings (sweep A–H)

### P1

**F1 — Dead API route `POST /api/tuning/complaints`.**
`backend/src/routes/tuning-complaint.ts:20` exposes `router.post('/complaints',
complaintCtrl.create)` behind JWT auth. Grep of `frontend/` for any caller:
zero hits. The companion `GET /category-stats` also appears unused from
frontend (grep `category-stats` → zero frontend hits). Feature 041 sprint 02
wired the route, but the UI never picked it up.
Fix shape: either delete the router + controller, or land a frontend Complaint
affordance in one of the `/tuning` sub-pages. If a future session will use
it, add a TODO next to the mount in `app.ts` so it isn't deleted by
mistake.

**F2 — `apiApproveSuggestion` failure swallowed on inbox pill.**
`inbox-v5.tsx:5091-5095`: `try { await apiApproveSuggestion(...) } catch {
setAiSuggestion(s) }` — the restore of the pill is good UX, but there's no
`toast.error` and no surface of the 500 reason. Combined with #2's server-side
orphan, an operator who hits the arrow button and sees the pill re-appear has
zero signal about whether the guest got the message or not. Fix shape: add a
sonner `toast.error('Couldn\'t send — tap Edit to retry manually')` in the
catch.

### P2

**E1 — Admin flags documented but not surfaced.**
`ENABLE_BUILD_MODE`, `ENABLE_BUILD_TRACE_VIEW`, `ENABLE_RAW_PROMPT_EDITOR` all
gate routes correctly (hard 404 at the router tier, verified at
`backend/src/routes/build.ts:4` and `controllers/build-controller.ts:127,303`).
No dead flags. But `NEXT.md §1.2` still carries the Railway env + SQL
commands as a manual post-deploy step. Worth a `/api/me` surface of
`buildModeEnabled` so the UI can render a "build mode disabled" banner
instead of a 404, and a one-liner admin-flip admin endpoint rather than raw
SQL. Out of scope for 049 but lists well for 050.

**D1 — Webhook auto-create drop-through.**
`webhooks.controller.ts:279-314`: when neither the initial lookup nor the
auto-create can resolve a conversation for an inbound guest message, line
310-314 drops the message with just a `console.warn`. Narrow window (requires
auto-create itself to fail, which is rare) but a true data-loss path — the
guest message is never persisted, never retried. Fix shape: write a
`WebhookLog` row with `status=dropped` so it's at least recoverable from
logs; or push into a dead-letter queue for manual re-drive.

**H1 — No frontend type narrowing on shadow-mode preview broadcasts.**
`ai.service.ts:2455-2458` emits `aiMeta.autopilotDowngraded` inline in the
SSE, but the Prisma column that feeds `GET /api/conversations/:id` is
`Message.aiConfidence` only — `autopilotDowngraded` lives on
`AiApiLog.ragContext` and is re-derived by `conversations.controller.ts:121-127`.
Works today because the read path's 60-second closest-log heuristic finds
the right log, but it's a soft coupling — if log retention ever drops below
60s or the ragContext schema changes, the downgrade flag silently vanishes
on refresh. Fix shape: persist `autopilotDowngraded` to a dedicated Message
column (or into `Message.aiConfidence` as a signed sentinel), not via the log
lookup.

### P3

**G1 — Feature 043 `within()` lexicographic compare.**
Already covered in #10 above. Minor. 10-min guard.

**A1 — `backend/src/services/debounce.service.ts:171` swallow.**
`prisma.pendingAiReply.delete({ where: { id: activeFired.id } }).catch(() => {})`.
Safe: the row may have been deleted by a concurrent guest-message handler.
Intentional.

All other empty-catches in backend/src were verified as deliberate
graceful-degrade paths (list omitted — matches CLAUDE.md rule #2).

### Clean sweeps (no new findings)

- **C — `lastMessageAt` bumps** (sweep): every `prisma.message.create` path
  on the HOST/AI write side was verified to bump `lastMessageAt` on the same
  conversation. Clean.
- **E — Feature flags**: only the three `ENABLE_BUILD_*` flags; all actively
  read and route-gated. Clean.
- **G — `aiMeta` shape**: writer in `ai.service.ts:2455,2519`, reader in
  `conversations.controller.ts:121-127` + frontend types at
  `api.ts:141` and `inbox-v5.tsx:168` — all aligned on
  `{ sopCategories, toolName, toolNames, confidence, autopilotDowngraded }`.
  Only soft edge is H1 above.
- **H — strictNullChecks**: `cd frontend && tsc --noEmit` and
  `cd backend && tsc --noEmit` both exit 0. No drift since sprint 047-C.

---

## Summary

**Counts by priority:**
- **P0:** 1 (#2 approveSuggestion orphan — promoted from P0-candidate)
- **P1:** 4 (#1 divergence, #3+#4 dead `/tuning/*` routes, #5 stale
  CLAUDE.md, #7 checklist toast gap, F1 dead `/tuning/complaints` route,
  F2 swallowed approve failure) — call it 6 if you count #3/#4 separately
- **P2:** 3 (#8 doc-handoff UI discoverability, D1 webhook drop, H1
  aiMeta log-coupling, E1 admin-flag surface)
- **P3:** 3 (#9 build-tx, #10 lex compare, #11 cache telemetry)

**Recommended Session A bundle (coherent, single-sprint):**
Pick **#1 + #2 + #4 + #7 + F2** — all five are "legacy copilot +
tuning-surface hardening" and share `conversations.controller.ts`,
`messages.controller.ts`, `inbox-v5.tsx`, and `top-nav.tsx` as the touched
surface. That gives the operator a coherent story: *"the copilot pill no
longer orphans state on send failures, surfaces errors visibly, the inbox
checklist toggle is honest about failures, and tuning top-nav no longer
leads to 404s."* Estimate: 1.5–2 days. Scope is tight because the fixes are
mostly port-over from the `messages.controller.send` pattern and a sonner
toast sprinkle.

**Deferred to Session B / sprint 050:**
- **F1** (dead `/tuning/complaints`) — delete-only, but needs a product call
  on whether to ship the frontend affordance or rip it out. Don't bundle
  with A.
- **#8 + E1** — doc-handoff UI + admin-flag surface, a small Settings
  pass.
- **D1** — webhook dead-letter handling, infrastructure-ish.
- **H1** — aiMeta persistence refactor, touches schema.prisma.
- **#3 + #5** — trivial docs/nav cleanup, roll into whichever session is
  hot.
- **#9 + #10 + #11** — all P3, none urgent.

**Explicitly NOT in scope for 049:**
- Anything touching `ai.service.ts` (CLAUDE.md critical rule #1).
- Any `prisma db push` migration (defer to when schema really has to move).
- The three sprint-048 §2 carry-forward candidates (raw-prompt editor,
  retention sweep, reject-rationale) — Session A bundle above supersedes
  them only if operator pressure on the copilot path is higher than on the
  raw-prompt editor. That's a product call for kickoff.

End of discovery.
