# 006-ai-flow-audit — Consolidated Research

**Date**: 2026-03-20
**Sources**: 3 code audits (webhook, AI pipeline, classifier/topic-state), production database analysis (30 logs), known bugs from live testing, spec clarification decisions.

---

## Summary

**Total findings: 61 unique bugs** across all pipeline stages.

| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH     | 9 |
| MEDIUM   | 27 |
| LOW      | 21 |

**Already fixed (deployed):** 2 items marked [FIXED].
**Not a bug (by design):** 5 empty AI responses (`guest_message:""`) are conversation closers — the system prompt explicitly instructs Claude to return empty for messages like "thank you". NOT a defect.

### Verification Notes (post-review corrections)

The following items were independently verified against source code:

- **AUD-001** VERIFIED: No `@unique` constraint on `hostawayMessageId` in schema.
- **AUD-002** VERIFIED: Host messages do NOT call `cancelPendingAiReply`.
- **AUD-009** VERIFIED: `markFired()` is a plain update, not atomic — no `fired: false` guard.
- **AUD-022** VERIFIED: `_lastClassifierResult` IS written at rag.service.ts line 352. Concurrent overwrite is a real thread-safety issue.
- **AUD-023** CORRECTED: Downgraded HIGH → MEDIUM. The ai.service.ts call is a retry after rag.service's Tier 2 returned empty (`tier2_needed`), not a true duplication. Still a design concern (redundant retry with same input).
- **AUD-025** VERIFIED: `getSopContent` missing `propertyAmenities` in HIGH/MEDIUM paths.
- **AUD-040** VERIFIED: Escalation signals are logged but NEVER injected into Claude's prompt.
- **AUD-052** VERIFIED: `judge.service.ts` creates Anthropic client at module load (line 14) — violates graceful degradation rule. `intent-extractor.service.ts` does it correctly with lazy init.

**Production data highlights (30 log sample):**
- 4/30 had duplicate SOP chunks
- 23/30 used knn_rerank (old engine), only 5 used lr_sigmoid (new)
- 2 embedding failures
- 4 door code exposures (to non-confirmed guests)
- 10/30 had Tier 3 re-injections, only 1 topic switch detected
- 24/30 had confidenceTier: undefined (old backend version)
- 2 guests named "New Guest" (enrichment failure)

---

## Stage 1: Webhook Entry

**File**: `backend/src/controllers/webhooks.controller.ts`

### AUD-001 — CRITICAL: Message deduplication bypass + missing unique constraint

**Lines**: 351-391
**Root cause**: `hostawayMessageId` has no `@unique` constraint in Prisma schema. When `data.id` is `undefined` or `0`, `String(data.id || '')` produces `''`, skipping the dedup check entirely. Even when `data.id` IS present, concurrent duplicate webhooks pass the `findFirst` check (TOCTOU race) and the P2002 catch is dead code because the unique constraint doesn't exist.
**Production data**: Confirmed — duplicate messages exist in production logs.
**Fix**: Add `@@unique([conversationId, hostawayMessageId])` compound constraint to the Message model. Guard against empty `hostawayMessageId` by returning early or generating a synthetic ID.

### AUD-002 — HIGH: Host outgoing messages don't cancel pending AI replies

**Lines**: 393-416
**Root cause**: When a HOST sends a message (`isIncoming !== 1`), the code only updates `lastMessageAt`. It does NOT call `cancelPendingAiReply`. The AI reply fires after the debounce window, sending a potentially contradictory response after the human host already replied.
**Production data**: Likely contributor to some of the observed response quality issues.
**Fix**: When an outgoing host message is detected, call `cancelPendingAiReply(conversationId)` and delete/mark-fired the PendingAiReply.
**Spec**: Confirmed as FR-011.

### AUD-003 — HIGH: `aiMode` not checked before scheduling AI reply

**Lines**: 403-406
**Root cause**: Only `aiEnabled` is checked. When `aiMode === 'off'` but `aiEnabled === true`, an AI reply is scheduled, creating a PendingAiReply, a BullMQ job, and broadcasting a false "AI is typing..." indicator to the frontend. The debounce job eventually skips it, but the false typing indicator is already shown.
**Fix**: Add `&& reservation.aiMode !== 'off'` to the scheduling guard.

### AUD-004 — MEDIUM: Silent message drop when `conversationId` is `0`

**Lines**: 196-197
**Root cause**: `String(data.conversationId || '')` converts `0` to `''`, which fails the truthy check and silently drops the message with no logging.
**Fix**: Use `String(data.conversationId ?? '')` (nullish coalescing) to preserve `0` as `"0"`.

### AUD-005 — MEDIUM: Resync never updates guest name corrections

**Lines**: 273-288, 296-347
**Root cause**: `enrichGuestFromHostaway` fetches fresh data from Hostaway but the resync block only updates the reservation record. Guest name corrections only trigger if `guest.name === 'Unknown Guest'`, so a correction from "John Smit" to "John Smith" never propagates.
**Production data**: 2 guests named "New Guest" — enrichment failure confirmed.
**Fix**: Update guest name from Hostaway data during resync when it differs from the stored value.

### AUD-006 — MEDIUM: `parseHostawayDate` returns Invalid Date for malformed input

**Lines**: 82-85
**Root cause**: `new Date("invalidZ")` produces `Invalid Date`, which is passed to `prisma.message.create` at `sentAt`, causing a Prisma error or storing an invalid timestamp.
**Fix**: Add a validity check after parsing; fall back to `new Date()` if invalid.

### AUD-007 — LOW: `Object.assign` stale updatedAt in local reference

**Line**: 329
**Root cause**: Mutating the in-memory Prisma object doesn't update `updatedAt`. Only affects the current request context; DB is correct.
**Fix**: Not urgent. Cosmetic only.

### AUD-008 — LOW: Race between auto-create and concurrent reservation webhook

**Lines**: 232-261
**Root cause**: Both `handleNewMessage` and `reservation.created` can create the same guest/reservation/conversation. The fallback chain with upsert + P2002 catch + reservationId lookup handles this correctly.
**Fix**: No fix needed — existing fallback logic is adequate.

---

## Stage 2: Debounce & Scheduling

**Files**: `backend/src/services/debounce.service.ts`, `backend/src/jobs/aiDebounce.job.ts`

### AUD-009 — CRITICAL: Poll job double-fire with BullMQ worker

**File**: `aiDebounce.job.ts`, lines 25-27
**Root cause**: The BullMQ worker uses an atomic claim pattern (`updateMany where fired: false`), but the poll job calls `markFired()` as a plain `update` with no guard. If the BullMQ worker claims a record between the poll job's `getDuePendingReplies` fetch and `markFired` call, the poll job still processes the already-fired record, sending a duplicate AI reply.
**Production data**: Redis is enabled in production — double-fire is possible.
**Fix**: Add atomic claim guard to poll job: `updateMany({ where: { id: pending.id, fired: false }, data: { fired: true } })`. Skip if `count === 0`.
**Spec**: Confirmed as FR-014.

### AUD-010 — HIGH: Fire-and-forget `generateAndSendAiReply` with no retry in poll mode

**File**: `aiDebounce.job.ts`, lines 53-79
**Root cause**: The AI reply call is not awaited. If it fails (API error, timeout), the PendingAiReply is already marked `fired: true` and the guest never gets a reply. BullMQ has `attempts: 3` with backoff, but the poll job has no retry mechanism.
**Fix**: Await the call and implement a retry counter or re-queue on failure.

### AUD-011 — MEDIUM: Inconsistent `aiMode` check between poll job and BullMQ worker

**File**: `aiDebounce.job.ts`, line 36
**Root cause**: Poll job uses blacklist (`aiMode === 'off'`), BullMQ worker uses whitelist (`aiMode in ['autopilot', 'auto', 'copilot']`). A new aiMode value would be handled differently by each path.
**Fix**: Unify to whitelist approach in both paths.

### AUD-012 — MEDIUM: DST transition causes 1-hour offset in deferred replies

**File**: `debounce.service.ts`, lines 83-98
**Root cause**: `nextWorkingHoursStart` adds exactly `24 * 60 * 60 * 1000` ms to jump to tomorrow. On DST spring-forward (23h day) or fall-back (25h day), the result is off by 1 hour.
**Fix**: Compute tomorrow's midnight using timezone-aware date arithmetic instead of adding 86400000ms.

### AUD-013 — MEDIUM: `getTodayMidnightInTimezone` relies on implementation-specific Date parsing

**File**: `debounce.service.ts`, lines 39-65
**Root cause**: Constructs a Date from `toLocaleString('en-US', ...)` + `' UTC'`. Parsing `"3/16/2025, 12:00:00 AM UTC"` is implementation-dependent and may return `Invalid Date` on some Node.js versions. Falls back to UTC midnight silently.
**Fix**: Use `Intl.DateTimeFormat` with explicit parts extraction, or use a dedicated timezone library.

### AUD-014 — LOW: `deleteMany fired:true` is redundant dead code

**File**: `debounce.service.ts`, lines 122-125
**Root cause**: The `@@unique([conversationId])` constraint ensures only one PendingAiReply per conversation. The upsert replaces it, making the deleteMany a no-op.
**Fix**: Remove dead code for clarity.

---

## Stage 3: Classifier

**File**: `backend/src/services/classifier.service.ts`

### AUD-015 — MEDIUM: No dimension validation in LR inference — NaN propagation

**Lines**: 264-269
**Root cause**: If LR weights were trained with Cohere 1024d embeddings but runtime uses OpenAI 1536d, `coefficients[i][j]` is `undefined` for `j >= coefficients[i].length`, producing `NaN`. Cascades through sigmoid to produce `NaN` confidence scores and unpredictable label ordering.
**Fix**: Add dimension check at inference time: `if (embedding.length !== coefficients[0].length) throw`.

### AUD-016 — MEDIUM: `cosineSimilarity` has no dimension mismatch guard

**Lines**: 502-507
**Root cause**: If vectors `a` and `b` have different lengths (e.g., provider swap mid-session), the loop reads `b[i]` as `undefined`, producing `NaN` that propagates through topic switch detection.
**Fix**: Add length validation at the top of `cosineSimilarity`.

### AUD-017 — MEDIUM: `initializeClassifier` does not call `loadLrWeightsMetadata`

**Lines**: 195-242
**Root cause**: After initialization, `lrWeights` is `null`. `classifyMessage()` throws `'LR classifier not trained...'`. Only `reinitializeClassifier()` does both. The startup path must call `loadLrWeightsMetadata()` separately — fragile contract.
**Fix**: Call `loadLrWeightsMetadata()` at the end of `initializeClassifier()`.

### AUD-018 — LOW: `loadLrWeightsMetadata` silently discards weights when `_state` is null

**Lines**: 176-182
**Root cause**: If called before `initializeClassifier()`, `_state` is null and weights are discarded. The success log still prints, making it appear weights loaded correctly.
**Fix**: Log a warning when `_state` is null.

### AUD-019 — LOW: `reinitializeClassifier` failure is swallowed silently

**Lines**: 524-620
**Root cause**: Error caught and logged inside `doReinit()`, but the returned promise resolves (not rejects). Callers cannot detect failure.
**Fix**: Low priority — fire-and-forget pattern is intentional.

### AUD-020 — LOW: `_initializingPromise` not cleared on success

**Lines**: 199-242
**Root cause**: Resolved promise object retained indefinitely. Minor memory consideration.
**Fix**: Set to `null` after successful initialization.

### AUD-021 — LOW: `batchClassify` is sequential despite name

**Lines**: 628-649
**Root cause**: Each message classified sequentially with its own `embedText` call. Performance issue for large batches (e.g., gap analysis).
**Fix**: Low priority — consider `Promise.all` with concurrency limiter.

---

## Stage 4: RAG Pipeline

**File**: `backend/src/services/rag.service.ts`

### AUD-022 — HIGH: `_lastClassifierResult` is a process-global — not safe for concurrent requests

**File**: `rag.service.ts`, line 36; consumed at `ai.service.ts` lines 1242, 1816
**Root cause**: Module-level global variable. If two concurrent requests are processed (overlapping async I/O), request A's classifier result can be overwritten by request B. Wrong metadata gets logged to ragContext, and wrong data passed to judge service — potentially causing auto-fix of training data based on the wrong conversation.
**Fix**: Return classifier result directly from `retrieveRelevantKnowledge()` instead of using a module-global.

### AUD-023 — MEDIUM: Redundant Tier 2 intent extractor retry (design concern)

**Files**: `rag.service.ts` lines 419-427, `ai.service.ts` lines 1292-1373
**Root cause**: When LOW path fires intent extractor and it returns empty SOPs, `tier` is set to `'tier2_needed'`. Then `ai.service.ts` checks `ragResult.tier === 'tier2_needed'` and calls `extractIntent()` again. This is NOT a true duplication — `tier2_needed` means the first call already ran but returned no results. The second call is a retry with the same input, which will almost certainly fail again. This wastes a Haiku API call (~$0.0001 + ~300-500ms latency) with no new information.
**Note**: Downgraded from HIGH to MEDIUM after verification — this is a redundant retry, not a duplicate call producing duplicate data.
**Fix**: When rag.service's LOW path runs the intent extractor, set a flag (e.g., `intentExtractorRan: true`) in the return object. Skip the retry in ai.service if the flag is set.

### AUD-024 — HIGH: Stale `_lastClassifierResult` when classifier throws

**File**: `rag.service.ts`, lines 349-511
**Root cause**: If classifier catch fires at line 508, `_lastClassifierResult` retains the value from a PREVIOUS request. The pgvector fallback path never updates it. Judge service evaluates based on stale metadata from a different conversation.
**Fix**: Clear `_lastClassifierResult` at the start of each call, or return it directly (same fix as AUD-022).

### AUD-025 — MEDIUM: `getSopContent` called without `propertyAmenities` in HIGH and MEDIUM paths

**File**: `rag.service.ts`, lines 375-386, 393
**Root cause**: HIGH confidence path calls `getSopContent(label)` without `propertyAmenities`. MEDIUM path same. The `{PROPERTY_AMENITIES}` placeholder resolves to "No amenities data available" even when data exists. Only Tier 2/3 paths in ai.service.ts pass amenities correctly.
**Production data**: Confirmed — amenity-related SOPs show placeholder text in HIGH confidence responses.
**Fix**: Pass `propertyAmenities` to `retrieveRelevantKnowledge()` and forward to `getSopContent()` in all paths.
**Spec**: Confirmed as FR-013.

### AUD-026 — MEDIUM: `confidenceTier`/`topCandidates` missing from pgvector fallback return

**File**: `rag.service.ts`, lines 514-606
**Root cause**: pgvector fallback returns `{ chunks, topSimilarity, tier }` without `confidenceTier` or `topCandidates`. Downstream checks for `ragResult.confidenceTier === 'low'` (auto-escalation) and `=== 'medium'` (LLM override) are always `undefined`, so both features are silently disabled on fallback.
**Fix**: Return a synthetic `confidenceTier` based on similarity score, or set a dedicated `isFallback` flag.

### AUD-027 — MEDIUM: pgvector fallback compares cosine similarity against LR threshold

**File**: `rag.service.ts`, line 600
**Root cause**: `topSimilarity > HIGH_CONFIDENCE_THRESHOLD` where `topSimilarity` is cosine similarity (0-1 scale) and `HIGH_CONFIDENCE_THRESHOLD` is calibrated for LR sigmoid confidence (default 0.85). These are completely different scales. Result: almost always returns `'tier2_needed'`, triggering unnecessary Tier 2 calls.
**Fix**: Use a separate threshold calibrated for cosine similarity, or always return `'tier2_needed'` for pgvector fallback.

### AUD-028 — MEDIUM: LOW confidence path returns `tier2_needed` without flagging intent extractor already ran

**File**: `rag.service.ts`, lines 417-455
**Root cause**: When LOW path fires intent extractor and it returns empty SOPs, `tier` is returned as `'tier2_needed'` without any flag that the extractor already ran. ai.service.ts then retries it with the same input — a redundant call that will almost certainly fail again (see AUD-023).
**Fix**: Add `intentExtractorRan: true` flag to the return object.

---

## Stage 5: Topic State Cache

**File**: `backend/src/services/topic-state.service.ts`

### AUD-029 — HIGH: Keyword topic switch uses substring matching — false positives

**Line**: 108
**Root cause**: `ALL_SWITCH_KEYWORDS.some(kw => textLower.includes(kw.toLowerCase()))` matches substrings. "also" matches inside "Gonzalo", "what about" matches in unrelated phrases. Short keywords like "also", "oh and" produce false topic switches.
**Production data**: 10/30 had Tier 3 re-injections, but only 1 topic switch detected — keyword detection may be triggering incorrectly or not at all.
**Fix**: Replace keyword substring matching with centroid-only detection. Keep keywords ONLY as fallback when centroids unavailable.
**Spec**: Confirmed as FR-015.

### AUD-030 — HIGH: Centroid topic switch skipped when Tier 1 is HIGH confidence

**File**: `ai.service.ts` (Tier 3 path); `topic-state.service.ts` lines 117-140
**Root cause**: `getReinjectedLabels()` only fires when `ragResult.tier !== 'tier1'`. If Tier 1 classifies with HIGH confidence, centroid detection never runs — defeating the purpose of detecting silent topic switches where the new topic also has high classifier confidence.
**Production data**: Only 1/10 Tier 3 re-injections detected a topic switch — most switches missed.
**Fix**: Run centroid check independently of Tier 1 confidence. Check should run BEFORE or in parallel with the confidence gate.
**Spec**: Confirmed as FR-009.

### AUD-031 — MEDIUM: Topic cache Map is unbounded — no max size cap

**Line**: 31 (cache Map)
**Root cause**: `_cache` grows without limit. Cleanup timer removes expired entries every 5 minutes, but during high-volume periods, thousands of entries can accumulate.
**Fix**: Add a max size cap (e.g., LRU eviction at 10,000 entries).

### AUD-032 — LOW: "yes also" bypasses not-switch check then hits "also" keyword

**Lines**: 100, 108
**Root cause**: Not-switch signals use exact match (`textLower === sig`). "yes also" doesn't match "yes" exactly, falls through to keyword detection, matches "also" → false topic switch.
**Fix**: Use `startsWith` for not-switch signals, or add "yes also" to the not-switch list.

---

## Stage 6: Intent Extractor

**File**: `backend/src/services/intent-extractor.service.ts`

### AUD-033 — MEDIUM: No rate limiting on Tier 2 Haiku calls

**Lines**: 63-126
**Root cause**: Call count tracked for observability but no actual rate limiting. Burst of low-confidence messages can exhaust the shared Anthropic API key rate limit, affecting the main AI pipeline.
**Fix**: Add a semaphore or token bucket limiter (e.g., max 10 concurrent Tier 2 calls).

### AUD-034 — LOW: `BAKED_IN_CATEGORIES` exported but never used (dead code)

**Lines**: 44-47
**Root cause**: Defined and exported but SOP validation at line 107 only checks against `RAG_CATEGORIES`. Dead code.
**Fix**: Remove or integrate into validation.

### AUD-035 — LOW: `STATUS` and `URGENCY` values not validated against allowed union types

**Lines**: 111-112
**Root cause**: Haiku can return unexpected values like `"escalated"` or `"critical"`. The `||` fallback only triggers on falsy values. Invalid non-empty strings pass through.
**Fix**: Validate against allowed values; fall back to defaults for invalid values.

### AUD-036 — LOW: Anthropic client never handles API key rotation

**Lines**: 54-61
**Root cause**: Client created once and cached. API key rotation requires process restart. Minor operational concern.
**Fix**: Low priority.

---

## Stage 7: AI Service Core

**File**: `backend/src/services/ai.service.ts`

### AUD-037 — MEDIUM: No cross-tier deduplication of retrievedChunks

**Lines**: 1238, 1279, 1319, 1359
**Root cause**: Chunks from RAG (Tier 1), Tier 3 re-injection, and Tier 2 are all appended via `retrievedChunks.push(...)`. Same SOP from multiple tiers appears multiple times in the prompt.
**Production data**: 4/30 logs had duplicate SOP chunks — confirmed.
**Fix**: Deduplicate `retrievedChunks` by `category` or `sourceKey` after all tiers complete, before prompt building.
**Spec**: Confirmed as FR-001.

### AUD-038 — MEDIUM: `ragQuery` can be empty string on image-only messages

**Lines**: 1222-1224
**Root cause**: If guest sends image-only message with `content: ''`, `currentMsgsText` is `"Guest: "` (passes trim check) but `ragQuery` is `''`. Empty string sent to classifier and embeddings produces garbage results.
**Fix**: Check `ragQuery.trim()` length before calling RAG. Fall back to a generic embedding or skip RAG for image-only messages.

### AUD-039 — MEDIUM: Image branch missing T019 escalation validation

**Lines**: 1633-1667 vs 1506-1554
**Root cause**: Text branch validates `escalation.urgency` against allowed values and truncates `title`/`note`. Image branch has no such validation.
**Fix**: Extract validation into shared helper; call from both branches.

### AUD-040 — MEDIUM: Escalation signals detected but never injected into prompt

**Lines**: 1377-1380
**Root cause**: `detectEscalationSignals()` detects keyword signals and logs them, records in `ragContext`, but never adds them to the content blocks sent to Claude. The AI has no visibility into these signals — keyword-based escalation enrichment has zero effect on AI responses.
**Fix**: Inject detected signals as system hints in the content blocks (e.g., "SYSTEM SIGNAL: refund_request detected").
**Spec**: Confirmed as FR-012.

### AUD-041 — MEDIUM: 30-minute webhook delivery buffer may re-address old messages

**Line**: 1172
**Root cause**: `WEBHOOK_DELIVERY_BUFFER_MS = 30 * 60 * 1000` extends the message window 30 minutes before `windowStartedAt`. If a guest had a separate conversation 20 minutes earlier, those messages are treated as current and responded to again.
**Fix**: Reduce buffer to 5-10 minutes, or implement a "last AI reply" cutoff.

### AUD-042 — LOW: `_prismaRef` DB persist uses fire-and-forget without await

**Lines**: 181-198, 269-288
**Root cause**: AiApiLog writes not awaited. If process exits immediately or DB is slow, log entries are lost. No backpressure on pile-up.
**Fix**: Low priority — intentional performance trade-off.

### AUD-043 — LOW: `WEBHOOK_DELIVERY_BUFFER_MS` — see AUD-041 (same issue, lower-severity secondary effect)

**Line**: 1172
**Root cause**: Secondary effect — the large buffer also means the AI sees messages that may have already been responded to in a previous cycle, potentially generating redundant or confused responses.
**Fix**: Same as AUD-041.

---

## Stage 8: System Prompts & Content Blocks

**Files**: `backend/src/services/ai.service.ts` (hardcoded prompts), `backend/src/config/ai-config.json`

### AUD-044 — MEDIUM: No instruction to cross-reference SOP rules with reservation dates

**Root cause**: Neither hardcoded nor JSON config prompts tell Claude to check reservation dates against current date when applying conditional SOP rules (e.g., "within 2 days of check-in → escalate"). The AI must infer this, which fails for edge cases (guest checking in tomorrow gets the ">2 days" branch).
**Production data**: Confirmed — AI picked wrong SOP branch for early check-in when guest was checking in the next day.
**Fix**: Add explicit system prompt instruction: "When an SOP has date-based conditions, always compare against the check-in/check-out dates in the reservation details and the current local time."
**Spec**: Confirmed as FR-003 (via SOP text improvement + system prompt instruction).

### AUD-045 — MEDIUM: Hardcoded prompts are dead code — JSON config is runtime version

**Lines**: 333-815 vs `ai-config.json`
**Root cause**: `OMAR_SYSTEM_PROMPT` and `OMAR_SCREENING_SYSTEM_PROMPT` constants are defined but not used in the main pipeline. Runtime uses `personaCfg.systemPrompt` from JSON config. The hardcoded versions have more detailed instructions (early check-in 2-day rules, cleaning examples) that the JSON config lacks.
**Fix**: Either remove the dead code constants or migrate their content into `ai-config.json`.

### AUD-046 — MEDIUM: `injectImageHandling` relies on exact string match — fragile

**Lines**: 305-329
**Root cause**: `basePrompt.replace('---\n\n## OUTPUT FORMAT', ...)` depends on exact pattern. If separator changes (extra whitespace, different dashes), image handling section is silently not injected. Works with current config but breaks on any prompt modification.
**Fix**: Use a more robust injection mechanism (e.g., template variable `{IMAGE_HANDLING}`).

### AUD-047 — LOW: screeningAI template missing `openTasks`/`knowledgeBase` placeholders

**File**: `ai-config.json`, screeningAI contentBlockTemplate
**Root cause**: Template has no `{{openTasks}}` or `{{knowledgeBase}}` placeholders. Open tasks and approved knowledge fetched from DB never reach the screening AI.
**Fix**: Add placeholders if screening should have this context; otherwise document as intentional.

### AUD-048 — LOW: Missing space in `### CURRENT LOCAL TIME###` header

**File**: `ai-config.json`, lines 10, 18
**Root cause**: Cosmetic — missing space before closing `###`. Consistent across both personas but could confuse LLM section parsing.
**Fix**: Add space: `### CURRENT LOCAL TIME ###`.

### AUD-049 — LOW: Screening prompt hardcodes amenities list — ignores property data

**File**: Screening prompt (hardcoded + JSON config)
**Root cause**: Hardcoded amenities list ("Baby crib, extra bed, hair dryer...") doesn't come from actual property data. Different properties get incorrect amenities information during screening.
**Fix**: Use a `{PROPERTY_AMENITIES}` placeholder mechanism similar to guestCoordinator SOPs.

### AUD-050 — LOW: Screening AI escalation always uses `'info_request'` urgency

**Lines**: 1499, 1626
**Root cause**: All screening escalations hardcoded to `'info_request'`. Guest disputes during screening treated as low-priority. The screening output format has no urgency field.
**Fix**: Add urgency field to screening AI output format, or map title patterns to urgency levels.

### AUD-051 — LOW: Screening prompt says `"guest message"` (space), guestCoordinator uses `"guest_message"` (underscore)

**Lines**: 1496 vs 1507
**Root cause**: Inconsistent JSON key naming between personas. Works correctly since each prompt matches its parser, but maintenance risk for shared parsing code.
**Fix**: Low priority — harmonize naming in next prompt revision.

---

## Stage 9: Judge & Self-Improvement

**File**: `backend/src/services/judge.service.ts`

### AUD-052 — HIGH: Top-level Anthropic client crashes if `ANTHROPIC_API_KEY` missing

**Line**: 14
**Root cause**: `const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })` at module load. If env var is undefined, SDK throws or creates broken client. Violates critical rule: "Missing env vars → fall back silently, never crash."
**Fix**: Use lazy initialization pattern like intent-extractor.service.ts (null check + create on first use).

### AUD-053 — MEDIUM: Auto-fix can add training examples with empty labels

**Lines**: 351, 361
**Root cause**: `validLabels = judgeResult.correctLabels.filter(l => VALID_CHUNK_IDS.includes(l))`. If judge returns labels not in `VALID_CHUNK_IDS` (e.g., baked-in categories), all filtered out → `validLabels = []`. `addExample()` called with empty array, polluting training data with label-less examples.
**Fix**: Add guard: `if (validLabels.length > 0)` before `addExample()`.

### AUD-054 — MEDIUM: Low-confidence reinforcement has same empty-labels bug

**Lines**: 392-393
**Root cause**: Same issue as AUD-053 — `reinforceLabels` can be empty after filtering. No guard before `addExample()`.
**Fix**: Same — add length check.

### AUD-055 — MEDIUM: Per-tenant rate limit but global `reinitializeClassifier`

**Lines**: 42-58, 281, 375
**Root cause**: Rate limit `MAX_FIXES_PER_HOUR = 10` is per tenant. But `reinitializeClassifier()` re-embeds ALL training examples globally. 5 tenants x 10 fixes = 50 reinitializations/hour, each re-embedding everything. Significant API cost under multi-tenant load.
**Fix**: Debounce reinitializations globally (e.g., coalesce within 5-minute windows), or make reinit incremental.

### AUD-056 — LOW: High-confidence misclassifications logged but never surfaced for review

**Lines**: 345-380
**Root cause**: In `evaluate_all` mode, judge evaluates everything but auto-fix threshold still applies. High-confidence wrong classifications are flagged in logs but no mechanism surfaces them for human review.
**Fix**: Low priority — add a review queue or dashboard alert for flagged entries.

---

## Stage 10: Frontend Pipeline Display

**File**: `frontend/components/ai-pipeline-v5.tsx`

### AUD-057 — MEDIUM: ragContext truncates chunk content to 200 characters [PIPELINE LOG]

**File**: `ai.service.ts` ragContext building (line ~1400s)
**Root cause**: ragContext stored in AiApiLog truncates chunk content to 200 chars. Operators cannot see full SOP text that Claude received, making debugging impossible.
**Fix**: Store full chunk content in ragContext. Add UI-level truncation with expand/collapse in frontend.
**Spec**: Confirmed as FR-007.

### AUD-058 — MEDIUM: Pipeline feed missing LLM override data

**File**: `ai-pipeline.ts` feed endpoint
**Root cause**: When MEDIUM confidence triggers LLM override (classifier pick vs LLM pick), the override data is not passed to the frontend.
**Fix**: Include override fields in pipeline feed response.
**Spec**: Confirmed as FR-008.

### AUD-059 — MEDIUM: No centroid similarity score in pipeline display

**Root cause**: Pipeline display shows "topic switch: Yes/No" but no numeric data — no centroid distance, threshold, or which centroid was compared.
**Fix**: Return similarity score from `getReinjectedLabels()`, pass through ragContext to pipeline feed.
**Spec**: Confirmed as FR-005 and FR-006.

### [FIXED] AUD-060 — Pipeline feed missing `classifierConfidence` and `confidenceTier`

**Fixed in**: commit `77a97dc`
**Root cause**: Fields not passed in pipeline feed endpoint. Frontend `isLrEntry` check required them → empty display.
**Status**: Deployed and verified.

### [FIXED] AUD-061 — Door code exposed to PENDING guest

**Fixed in**: commit `e659d82`
**Root cause**: `mapReservationStatus()` defaulted to CONFIRMED for missing/unknown status. Gate was not allowlist-based.
**Status**: Fixed — default is now INQUIRY, gate is CONFIRMED + CHECKED_IN only.
**Production data**: 4 door code exposures found in historical logs (pre-fix).

---

## Design Clarification Decisions (from spec)

These are confirmed design requirements to be implemented, not bugs:

### FR-011: Host reply cancels pending AI

When a host sends a message in a conversation, immediately cancel any pending AI reply. Human replies always take priority over AI. (Implements fix for AUD-002.)

### FR-012: Escalation signals injected into prompt

Detected escalation signals (refund_request, complaint, emergency, etc.) must be injected into Claude's prompt as system hints. (Implements fix for AUD-040.)

### FR-013: `propertyAmenities` in all SOP paths

`getSopContent()` must receive property amenities data in ALL confidence paths (HIGH, MEDIUM, LOW), not just Tier 2/3. (Implements fix for AUD-025.)

### FR-014: Atomic claim guard for poll job

Poll job must use an atomic claim guard (`updateMany where fired: false`) before processing a PendingAiReply, preventing double-fire with BullMQ worker. (Implements fix for AUD-009.)

### FR-015: Centroid-only topic switch (keywords as fallback only)

Topic switch detection must use centroid distance as the primary method. Keyword substring matching is replaced entirely. Keywords kept ONLY as fallback when centroids are unavailable (no trained model). (Implements fix for AUD-029.)

---

## Cross-Reference: Production Data vs Bugs

| Production Finding | Related Bug(s) |
|---|---|
| 4/30 duplicate SOP chunks | AUD-037 (no cross-tier dedup) |
| 23/30 used knn_rerank (old engine) | Not a bug — old backend version still processing most traffic |
| 2 embedding failures | AUD-016 (dimension mismatch), AUD-027 (pgvector threshold) |
| 5 empty AI responses | NOT A BUG — conversation closers by design |
| 4 door code exposures | AUD-061 [FIXED] |
| 10/30 Tier 3 re-injections, 1 switch | AUD-029 (keyword false positives), AUD-030 (centroid skipped) |
| 24/30 confidenceTier: undefined | Old backend — AUD-060 [FIXED] for new backend |
| 2 guests "New Guest" | AUD-005 (enrichment failure) |

---

## Additional Findings (Final Verification Scan)

### Frontend

#### FE-001 — HIGH: `lmOverride` typo in pipeline type definition
**File**: `frontend/components/ai-pipeline-v5.tsx`, lines 121, 710, 882
**Root cause**: Type field named `lmOverride` but backend sends `llmOverride` (two L's). LLM override badge never renders.
**Fix**: Rename to `llmOverride` in type definition and all usages.

#### FE-002 — MEDIUM: Missing `topCandidates` in pipeline feed type
**File**: `frontend/components/ai-pipeline-v5.tsx`, line ~113
**Root cause**: Backend sends `topCandidates` in ragContext but frontend type doesn't include it.
**Fix**: Add `topCandidates?: Array<{ label: string; confidence: number }> | null` to type.

#### FE-003 — LOW: Dead `engineType` ternaries after KNN removal
**File**: `frontend/components/ai-pipeline-v5.tsx`, lines 1351-1352, 1641, 1649-1653
**Fix**: Remove `engineType` variable, hardcode LR-only paths.

#### FE-004 — LOW: Unused `classifierType` state in classifier-v5.tsx
**File**: `frontend/components/classifier-v5.tsx`, line 859
**Fix**: Remove unused state variable.

#### FE-005 — LOW: `knnDiagExpanded` naming inconsistency
**File**: `frontend/components/ai-pipeline-v5.tsx`, line 596
**Fix**: Rename to `diagnosticsExpanded`.

### Database

#### DB-002 — MEDIUM: Missing index on AiApiLog.conversationId
**File**: `backend/prisma/schema.prisma`
**Root cause**: Pipeline feed queries AiApiLog by conversationId with no index — full table scan.
**Fix**: Add `@@index([tenantId, conversationId])` to AiApiLog model.

### Verified OK

- SSE `ai_typing_clear` event handling in inbox-v5.tsx — correct, no action needed.
