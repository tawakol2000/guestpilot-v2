# Studio Demo Fix Loop — Bug Log

Branch: `chore/studio-demo-fix-loop` (off `feat/059-session-a`).
Harness: `./scripts/demo.sh` → opens `http://localhost:3000/dev-login?tenantId=<demo>&conversationId=<demo>`.

## Bugs found and fixed

| #  | Seen in          | Symptom                                                    | Root cause                                                                                                                              | Fix layer | Commit      |
| -- | ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------- |
| 1  | harness startup  | `ts-node` refused to compile the seed.                      | `FaqEntry.enabled` doesn't exist on the shipped schema (it's `status: FaqStatus`), and `TuningConversationTriggerType` has no `BUILD` value. | seed      | `a2b2681`   |
| 2  | harness startup  | Backend crashed on boot (`JWT_SECRET` / `OPENAI_API_KEY`).  | Only `DATABASE_URL` was set in `backend/.env`. Other required vars absent — `ai.service.ts:40` constructs the OpenAI client at module load. | local env  | (uncommitted — `.env` gitignored) |
| 3  | harness startup  | `express-rate-limit` IPv6 validation warning (non-fatal).  | Newer package version; keyGenerator doesn't call `ipKeyGenerator` helper.                                                               | —         | documented only |
| 4  | Studio lock-card | "Build mode is not enabled for this deployment."          | Backend endpoints behind `ENABLE_BUILD_MODE` env gate. Local `.env` had it off.                                                         | local env  | (uncommitted) |
| 5  | Studio tab       | ErrorBoundary: `Cannot read properties of undefined (reading 'faqsGlobal')`. | Seed emitted `data-state-snapshot` with legacy flat `{tenantState, counts}` shape. Shipped `StateSnapshotCard` reads `data.summary.faqsGlobal` etc. | seed      | `719d9aa`   |
| 6  | mid-conversation | `(unsupported card: data-build-history)` placeholder leaked into a message body. | `StandalonePart` switch in `studio-chat.tsx` had no branch for `data-build-history` — the part is consumed internally by `PlanChecklist` to populate `appliedItems` and has no standalone UI. Same pattern as `data-state-snapshot` (return null). | frontend  | `719d9aa`   |
| 7  | msg-10 (test)    | Test pipeline card showed `0/0 passed`, `Per-variant detail (0)`. | Seed emitted legacy single-variant shape (`guestMessage/reply/judgeScore` flat). Shipped card reads `data.variants[]` with full `TestPipelineVariant` records. | seed      | `21d0c2c`   |
| 8  | msg-06 (plan)    | TOOL row showed ✓ done instead of × cancelled even with `cancelledItemIndexes: [2]` on the plan data. | Two bugs stacked. (a) `PlanChecklist` initialised `cancelledIndexes` state as empty Set — never seeded from `data.cancelledItemIndexes`. (b) `deriveRowState` checked the linear `idx < firstPending` fallback BEFORE `cancelledIndexes.has(idx)`. When same-session writes land for non-plan artifacts under the same transactionId, `appliedItems.length` inflates past the plan's own items and the cancelled row's idx falls under the fallback. | frontend  | `21d0c2c`, `f9adcc7` |
| 9  | msg-16 (end)     | Session-diff card rendered nothing.                       | Seed used legacy fields (`artifactsTouched`, `testsRun`, `plansApproved`, `durationMinutes`). Shipped `SessionDiffCard` reads `written/tested/plans/note` and bails via `hasAnyActivity=false` when all fields are zero. | seed      | `6495a24`   |
| 10 | chat load        | Chat loaded scrolled mid-transcript, missing the intro.   | `StudioChat` auto-scrolled to bottom on every new-messages effect, including the very first one fired by `initialMessages`. Deferred child mounts nudged the browser past our `scrollTo` when we tried to fix it synchronously. | frontend  | `6495a24`, `c48866f` |
| 11 | top banner + rail pill | "BROWNFIELD" / "GREENFIELD" internal jargon leaked into two operator surfaces. | Tenant-state banner and Current State card both printed the enum verbatim.                                                               | frontend  | `c48866f`   |
| 12 | msg-2 text       | Agent prose said "we're in brownfield mode" — inconsistent with renamed UI labels. | Seed-written narrative still used engineering jargon.                                                                                    | seed      | (final)     |
| 13 | console          | `403 GET /api/build/sessions/<id>/artifacts` flooded the browser console. | Endpoint is admin-only. Demo tenant had `isAdmin: false`. Rail still populated via fallback, but the 403 was noise. | seed      | (final)     |

## Non-issues investigated

- **403 on `/api/build/sessions/.../artifacts`** — turned out to be intentional admin-gated endpoint (bug #13 above — fixed by flipping demo tenant to admin).
- **`ERR_ERL_KEY_GEN_IPV6` warning** — transient, non-fatal. Backend boots through it.

## Acceptance against plan

Plan acceptance criteria (from the kickoff):

- ✅ No React console errors or hydration warnings.
- ✅ No empty/half-rendered `data-*` parts — every shipped part type (plan, state snapshot, test pipeline, suggested fix, audit report, advisory, session diff, artifact quote, build-history) renders correctly.
- ✅ No `"Unknown part"` or `"unsupported card"` fallback visible.
- ✅ All tool chain summaries render with both input and output states.
- ✅ Typographic origin attribution (`data-origin="user"` blue, `data-origin="agent"` muted grey, `data-origin="quoted"` monospace left-rule).
- ✅ Plan checklist: 3 items, index 2 struck through as **×** cancelled, indexes 0/1 as **✓** done.
- ✅ `BuildArtifactHistory` ledger: right-rail SESSION ARTIFACTS panel shows the 3 SOP + 2 system-prompt rows.
- ✅ No horizontal scroll at 1440×900.
- ✅ No layout-shift jitter — initial load lands at the top, intro message visible.
- ✅ 0 console warnings, 0 4xx responses on final iteration.
