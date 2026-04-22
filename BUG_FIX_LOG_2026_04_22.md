# Bug Fix Log — 2026-04-22 → 2026-04-23 autonomous run

> Running log of every bug fixed during the overnight autonomous bug-fix
> session. Branch: `chore/studio-demo-fix-loop`. Updated continuously.
> Each row = one commit. Severity legend: CRITICAL / HIGH / MEDIUM / LOW.

## Summary

| Round | Scope | Found | Fixed | Deferred | Investigated–not-bug |
|---|---|---|---|---|---|
| 1 — initial scans | Studio agent backend + frontend + adjacent services | 12 | 5 (2 HIGH, 3 MEDIUM) | 7 LOW (then all 7 fixed in round 1.5) | — |
| 1.5 — LOW round | The 7 deferred LOWs | 7 | 6 + 1 investigated–not-a-bug | — | 1 |
| 2 — broader scans | Studio depth + non-studio backend | 26 | 21 (6 HIGH + 13 MED + 2 LOW) | 4 (3 need user input, 1 in code as KNOWN-GAP) | — |
| 3 — webhooks/workers/middleware/inbox | Below-the-fold backend + inbox | 9 | 8 (5 MED + 3 LOW) | 1 (WebhookLog retention — needs user input) | — |

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

## Round 2 — MEDIUM (2026-04-23)

| # | Severity | SHA | Subject |
|---|---|---|---|
| 18 | MEDIUM | `a8094b4` | `controllers/conversations.controller.ts` — aiToggleAll status filter (no AI on cancelled/checked-out); aiToggleProperty preserves aiMode (no silent autopilot promotion) |
| 19 | MEDIUM | `476fcc0` (file-1) | `services/faq.service.ts` — getFaqForProperty added scope:'PROPERTY' filter (no global+property duplicate) |
| 20 | MEDIUM | `476fcc0` (file-2) | `services/faq-suggest.service.ts` — fingerprint length unified to 50 (no false-pass through dedup → silent FAQ loss); FALLBACK_CATEGORY runtime check |
| 21 | MEDIUM | `476fcc0` (file-3) | `tools/create-tool-definition.ts` — KNOWN-GAP comment for availableStatuses silent drop (deferred) |
| 22 | MEDIUM | `476fcc0` (file-4+5) | `lib/sanitise-artifact-payload.ts` — slug-detection filters added (hyphen + vowel ratio) so legitimate webhook URLs / kebab-case identifiers aren't middle-redacted |
| 23 | MEDIUM | `a11bbc4` (file-1) | `services/hostaway.service.ts` — getAccessToken in-flight Promise dedup (no thundering herd on token expiry) |
| 24 | MEDIUM | `a11bbc4` (file-2) | `services/debounce.service.ts` — getTodayMidnightInTimezone uses Intl parts (was non-spec-compliant toLocaleString-as-Date; broken across DST) |
| 25 | MEDIUM | `a11bbc4` (file-3) | `lib/artifact-history.ts` — appendVerificationResult wrapped in $transaction (no race-drop of variants on parallel test_pipeline calls) |
| 26 | MEDIUM | `a11bbc4` (files 4-6) | `tools/create-{faq,sop,tool-definition}.ts` — handle benign P2002 BEFORE markBuildTransactionPartial (no plan-blocking on duplicate retry) |
| 27 | MEDIUM | `da1c070` (file-1) | `controllers/build-controller.ts` listArtifactHistory — accept artifactType + artifactId server-side filters (drawer Versions tab no longer renders empty on busy tenants) |
| 28 | MEDIUM | `da1c070` (file-2) | `controllers/conversations.controller.ts` inquiryAction — local-update retry-on-error with 207 fallback (Hostaway commit no longer desyncs from local DB on transient blip) |
| 29 | MEDIUM | `da1c070` (file-3) | `controllers/tuning-history.controller.ts` pickPromptText — surfaces ambiguous flag; rollback rejects with 400 (no silent wrong-variant restore on legacy snapshots) |
| 30 | MEDIUM | `da1c070` (file-4) | `jobs/aiDebounce.job.ts` — catch resets fired=false + bumps scheduledAt for retry (5min cap); no more permanently-lost AI replies on no-Redis path |

## Round 2 — LOW (2026-04-23)

| # | Severity | SHA | Subject |
|---|---|---|---|
| 31 | LOW | `62f24b2` | `services/translation.service.ts` — 3-attempt exponential backoff on 408/425/429/5xx/timeout |
| 32 | LOW | `62f24b2` | `services/scheduled-time.service.ts` within() — defensive HHMM regex guard against silent lex-comparison auto-approve on malformed input |

## Round 3 — MEDIUM + LOW (2026-04-23)

| # | Severity | SHA | Subject |
|---|---|---|---|
| 33 | MEDIUM | `cb848de` | `frontend/components/inbox-v5.tsx` — `property_ai_changed` handler now actually refreshes (was a no-op due to wrong response-shape check) |
| 34 | MEDIUM | `cb848de` | `services/extend-stay.service.ts` — Hostaway price lookup wrapped in try/catch; Hostaway 5xx no longer crashes the AI tool turn |
| 35 | MEDIUM | `cb848de` | `jobs/messageSync.job.ts` — module-scope overlap guard prevents pile-up when ticks exceed the 120s interval |
| 36 | MEDIUM | `cb848de` | `services/document-checklist.service.ts` — both updateChecklist + manualUpdateChecklist wrap read-modify-write in `$transaction` (no race-drop of receivedDocs entries on concurrent uploads) |
| 37 | MEDIUM | `cb848de` | `controllers/webhooks.controller.ts` — replaced `empty-${Date.now()}` fallback id with content-hash so Hostaway retry duplicates collide on the unique index |
| 38 | LOW | `cb848de` | `backend/src/app.ts` — CORS_ORIGINS comma-split now trims + filters empty entries (parity with socket.service) |
| 39 | LOW | `cb848de` | `backend/src/server.ts` — 10s hard-shutdown deadline so Railway redeploy doesn't leak prisma connections behind long-lived WebSocket clients |
| 40 | LOW | `cb848de` | `frontend/lib/api.ts` — module-scope `_redirecting` guard against the concurrent-401 redirect storm (silences React Query / SWR error flash) |

## Test counts

| Snapshot | Backend | Frontend |
|---|---|---|
| Round 1 baseline (before fixes) | 472/472 + 1 env-var fail (or 485/485 0 fail intermittent) | 347/347 |
| After Round 1 (HIGH+MEDIUM) | 509/509 0 fail | 349/349 |
| After Round 1.5 (LOW) | 530/530 0 fail | 352/352 |
| Mid round 2 (post-HIGH) | 509/509 0 fail | 349/349 |
| End round 2 (post-LOW + non-studio) | 538/538 0 fail | 352/352 |
| End round 3 | 538/538 0 fail | 352/352 |
