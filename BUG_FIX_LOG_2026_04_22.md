# Bug Fix Log — 2026-04-22 → 2026-04-23 autonomous run

> Running log of every bug fixed during the overnight autonomous bug-fix
> session. Branch: `chore/studio-demo-fix-loop`. Updated continuously.
> Each row = one commit. Severity legend: CRITICAL / HIGH / MEDIUM / LOW.

## Summary

| Round | Scope | Found | Fixed | Deferred | Investigated–not-bug |
|---|---|---|---|---|---|
| 1 — initial scans | Studio agent backend + frontend + adjacent services | 12 | 5 (2 HIGH, 3 MEDIUM) | 7 LOW (then all 7 fixed in round 1.5) | — |
| 1.5 — LOW round | The 7 deferred LOWs | 7 | 6 + 1 investigated–not-a-bug | — | 1 |

## Round 1 (HIGH + MEDIUM, 2026-04-22)

| # | Severity | SHA | File / Subject |
|---|---|---|---|
| 1 | HIGH | `0d55ff2` | `tools/get-current-state.ts` — exposes BOTH coordinator + screening system-prompt variants (was coord-only) |
| 2 | HIGH | `ce04141` | `lib/artifact-apply.ts` — system_prompt apply parity: 50k cap + history snapshot + `invalidateTenantConfigCache` |
| 3 | MEDIUM | `9500459` | `preview/test-pipeline-runner.ts` — load PROPERTY-scoped FAQs (was GLOBAL-only) |
| 4 | MEDIUM | `ed886ad` | `compose-span.ts` — fixed tenant-scope check for system_prompt + tool + property_override fallbacks |
| 5 | MEDIUM | `0d6bd82` | `studio-chat.tsx` — release queue-flush guard on silent send error + 5s safety timeout |

## Round 1.5 (LOW, 2026-04-22)

| # | Severity | SHA | File / Subject |
|---|---|---|---|
| 6 | LOW | `33354a8` | `services/template-variable.service.ts` — split/join global substitution (no more raw `{VAR}` leaks on duplicate refs) |
| 7 | LOW | `61e4c23` | `services/tenant-state.service.ts` — `isSlotValueFilled` helper; DEFAULT_MARKER applies to strings only (no JSON-stringify false positives) |
| 8 | LOW | `efb8a2b` | `studio-chat.tsx` — keyed `forwardedIds` by stable `${m.id}:${type}:${partIdx}` instead of `p.id` (no streaming double-fire) |
| — | LOW | (no commit) | LOW #2 (auto-naming on queue flush) — INVESTIGATED, not a bug; on-queue callback already covers the scenario. Removed from deferred list. |
| 9 | LOW | `448aaa6` | `tools/__tests__/emit-session-summary-turn-isolation.test.ts` — pinned turnFlags fresh-per-turn contract for direct path; added contract comment in `direct/wire-direct.ts` |
| 10 | LOW | `fc91531` | `__tests__/studio-chat-queue-flush-wedge.test.tsx` — deterministic vitest harness for sync-throw, rejected-promise, and 5s-timeout safety nets |
| 11 | LOW | `1062406` | `specs/045-build-mode/NEXT.md` — codified `tsc --noEmit + npm run build` in after-gate routine |

## Round 2 — HIGH (2026-04-22 → 2026-04-23)

| # | Severity | SHA | Subject |
|---|---|---|---|
| 12 | HIGH | `a79f643` | `services/doc-handoff.service.ts` — atomic optimistic-lock claim before WhatsApp send (no more multi-instance double-sends) |
| 13 | HIGH | `cea2f98` | `controllers/build-controller.ts` — preserve existing history-row metadata when stamping REVERT (no more silent destruction of rationale/buildTransactionId/testResult/version) |
| 14 | HIGH | `8b4cc9a` | `tools/write-system-prompt.ts` — wrap TenantAiConfig upsert + AiConfigVersion insert in `$transaction` (no more un-rollbackable state on partial commit) |
| 15 | HIGH | `0f1ea81` | `tools/suggestion-action.ts` — applyArtifactChangeFromUi single-flight Map + previewId stamped at create-time (close TOCTOU on double-click) |
| 16 | HIGH | `df4ab0b` | `controllers/messages.controller.ts` — tenant-scope PendingAiReply lookup (defence-in-depth) |
| 17 | HIGH | `b896a96` | `services/summary.service.ts` — optional tenantId param + scope every query (defence-in-depth, prompt-injection vector closed) |

## Round 2 — MEDIUM + LOW

(Appended as committed.)

## Test counts

| Snapshot | Backend | Frontend |
|---|---|---|
| Round 1 baseline (before fixes) | 472/472 + 1 env-var fail (or 485/485 0 fail intermittent) | 347/347 |
| After Round 1 (HIGH+MEDIUM) | 509/509 0 fail | 349/349 |
| After Round 1.5 (LOW) | 530/530 0 fail | 352/352 |
| Round 2+ | _running_ | _running_ |
