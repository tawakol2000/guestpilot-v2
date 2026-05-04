# Quickstart: Studio Token Efficiency

**Feature:** 047-studio-token-efficiency
**Companion:** [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

This document is the local-verification cheat sheet for each PR in the implementation sequence. Each PR is independently revertable; verification commands tell you whether that PR's slice landed correctly before moving to the next.

---

## Baseline (run BEFORE PR 1)

Capture current state so we can measure improvements:

```bash
cd backend

# Prompt size baseline (chars + token approximation)
JWT_SECRET=test npx tsx scripts/measure-prompt.ts

# 24h cost baseline
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-cost-audit.ts --hours 24
```

Note current numbers in a scratch file:
- Region A / B / C tokens
- Total cost in last 24h
- Cache hit ratio
- Any rate-limit errors visible in Anthropic console

---

## PR 1 — Per-round Langfuse capture (Lever J)

**Goal:** Every internal `messages.create` round emits its own Langfuse generation with usage. Audit script summed input matches Anthropic console total within 5%.

### Local tests

```bash
cd backend

# Decision-quality eval suite (NEW) — must pass before any PR merges
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts

# SDK runner per-round emit
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/sdk-runner.test.ts

# Cache stability shouldn't regress
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/prompt-cache-stability.test.ts

# Type-check (no errors)
npx tsc --noEmit
```

### Post-deploy verification

After Vercel/Railway deploys the PR, trigger one Studio turn manually (e.g., type "test" in a Studio conversation) then:

```bash
cd backend
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-trace-detail.ts --hours 1
```

**Expected:** the tree under the latest `tuning-agent.query` span shows N child generations (where N is the number of internal rounds), each with monotonic `roundIndex`, fresh input + cache_read + output tokens populated.

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-cost-audit.ts --hours 1
```

**Expected:** "ROUND-TRIPS PER TRACE" table shows `avg=N.N median=N` matching what the Anthropic console showed for that period. "CACHE HIT RATIO" table shows realistic non-zero values.

### Rollback signal

If the audit script still shows `input=17 output=64` style under-reports for non-trivial turns, the per-round emit didn't actually fire. Check:

1. `BUILD_AGENT_DIRECT_TRANSPORT` env-flag value in production (should match what was used in the test)
2. Langfuse SDK version compatibility (should be the version in `backend/package.json`)
3. Console logs for `[Observability] logAgentGeneration(...) failed` warnings

---

## PR 2 — Verbosity in `studio_get_artifact` (Lever A)

**Goal:** Default `verbosity:'concise'` returns ≤1500 tokens for any artifact regardless of underlying body size. Explicit `verbosity:'detailed'` returns full body byte-for-byte.

### Local tests

```bash
cd backend

JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-artifact.test.ts
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts  # MUST still pass
npx tsc --noEmit
```

### Post-deploy verification

After deploy, in a Studio session, ask the agent something that would normally trigger `get_artifact` (e.g., "look at the screening rejection rules"). Then:

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-trace-detail.ts --hours 1
```

**Expected:** `studio_get_artifact` span output size in the recent trace is ≤1500 tokens (was previously 10-30K). The `verbosity` and `fullCharLength` fields appear on the response.

### Rollback signal

If `studio_get_artifact` returns full body when no `verbosity` param is passed, the handler isn't honoring the schema default. Check the handler's `args.verbosity` read.

---

## PR 3 — `mode:'index'` + `section:'<name>'` (Levers B+C)

**Goal:** Section-level drill-down on system prompts (and SOPs with markdown headings) cuts per-fetch tokens by 80-95% when only one section is needed.

### Local tests

```bash
cd backend

JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-artifact.test.ts
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts  # MUST still pass
JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/lib/__tests__/section-extractor.test.ts  # NEW
npx tsc --noEmit
```

### Post-deploy verification

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-trace-detail.ts --hours 1
```

**Expected:** for a TUNE turn that drills into a system prompt section, the trace shows three `studio_get_artifact` calls in sequence: one with `mode:'index'` (~500-1K tokens out), one with `section:'<name>'` (~300-1500 tokens out). Total tool output for that flow ≤2K (was 15-25K).

---

## PR 4 — `<read_budget>` + `<no_speculative_reads>` + `<disabled_artifacts>` (Levers D+E + clarification)

**Goal:** Median reads-per-turn drops from ~3 to ~2 within 24h. Read-budget warning hook attaches `read_budget_exceeded: true` span tag when the cap is exceeded (no block).

### Local tests

```bash
cd backend

JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/system-prompt.test.ts
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts  # MUST still pass
JWT_SECRET=test npx tsx --test src/build-tune-agent/hooks/__tests__/read-budget-warn.test.ts  # NEW
npx tsc --noEmit
```

Verify the prompt blocks render:

```bash
JWT_SECRET=test npx tsx scripts/measure-prompt.ts
# Compare Region A token count to baseline — should grow by ~150-200 tokens
# (the three new sub-blocks: <read_budget>, <no_speculative_reads>, <disabled_artifacts>)
```

### Post-deploy verification

After 24h of normal usage:

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-cost-audit.ts --hours 24
```

**Expected:** "ROUND-TRIPS PER TRACE" median drops from baseline (~3) to ≤2. Look for `read_budget_exceeded` span tag occurrences — should be rare (<10% of turns).

---

## PR 5 — Slim `studio_get_context` (Lever F)

**Goal:** Default `studio_get_context` returns ≤2K tokens (was 7.8K). `verbosity:'detailed'` preserves the v1 shape byte-for-byte.

### Local tests

```bash
cd backend

JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-context.test.ts
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts  # MUST still pass
npx tsc --noEmit
```

### Post-deploy verification

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-trace-detail.ts --hours 1
```

**Expected:** the `tuning-agent.get_context` (or `build-tune-agent.studio_get_context`) span output size is ≤2000 tokens for typical turns.

---

## PR 6 — Per-state tool allow-list (Lever I)

**Goal:** Tools block in scoping state is ≤3K cached tokens (was ~5K). Cache-stability test shows the stable-prefix is byte-identical across states.

### Local tests

```bash
cd backend

JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/sdk-runner.test.ts
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/prompt-cache-stability.test.ts  # extended
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts  # MUST still pass
npx tsc --noEmit
```

### Post-deploy verification

After several Studio turns spanning state transitions:

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-cost-audit.ts --hours 24
```

**Expected:** "CACHE HIT RATIO" rises by ≥5 percentage points compared to PR 5 baseline. State transitions don't cause cache invalidation cascade beyond the tools block.

---

## PR 7 (stretch) — `<conversation_anchor>` Region C block (Lever G)

**Goal:** ≤30% of turns call `studio_get_context` (down from ~95%). Region C grows by ≤2K tokens.

### Local tests

```bash
cd backend

JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/system-prompt.test.ts
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts  # MUST still pass
npx tsc --noEmit
```

### Post-deploy verification

```bash
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-cost-audit.ts --hours 24
```

**Expected:** `studio_get_context` (or `tuning-agent.get_context`) call count drops by ≥70%. Per-turn round count drops by 1 on average.

---

## Final acceptance check (after PR 5)

After PR 5 lands and 7 days of production data accumulates, re-run the audit and compare to baseline:

```bash
cd backend
LANGFUSE_PUBLIC_KEY="<pk>" LANGFUSE_SECRET_KEY="<sk>" \
  npx tsx scripts/langfuse-cost-audit.ts --hours 168  # 7 days
```

Compare against spec § Success Criteria:

| Metric | Baseline | Target (after PR 5) | After PR 7 (stretch) |
|---|---|---|---|
| Median per-round input tokens (SC-001) | ~50K | ≤30K | ≤25K |
| P90 per-round input tokens (SC-002) | ~70K | ≤45K | ≤40K |
| Median rounds-per-turn (SC-003) | ~5 | ≤3 | ≤2.5 |
| Cache hit rate (SC-004) | 57.8% | ≥75% | ≥80% |
| Median per-turn cost (SC-005) | ~$0.08-0.10 | ≤$0.03 | ≤$0.02 |
| Rate-limit errors in 24h (SC-006) | non-zero | 0 | 0 |
| Decision-quality eval suite (SC-007) | n/a | 100% | 100% |

If any metric misses target by >20% after 48h, roll back the most-recent PR and re-evaluate.

---

## Decision-quality eval suite (runs on every PR)

The four named cases live at `backend/src/build-tune-agent/__tests__/decision-quality.test.ts`. They MUST pass on every PR in this feature; CI hard-blocks merges otherwise.

```bash
cd backend
JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts
```

**Test cases:**

1. **gender→family/friends NO_FIX** — Stub LLM response says "this is just rewording," assert `category === 'NO_FIX'`, `editType === 'FRAMING_TONE'`.
2. **screening preferences memory recall** — Memory snapshot includes `preferences/no-sop-for-screening`, assert `consultedMemoryKeys` contains it.
3. **witness_quote presence** — For any non-NO_FIX category, assert `witness_quote` is a non-empty string.
4. **three-field self_report** — On critique-request message, assert response contains `weakest_inference`, `most_fragile_assumption`, `preferred_alternative_classification`.

These tests stub the LLM call (no real API call in CI) and run in <2s.
