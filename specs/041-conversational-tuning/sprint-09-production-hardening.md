# Sprint 09 — Production Hardening (critical bugs, system prompt gaps, performance)

> **You are a fresh Claude Code session with no memory of prior work.** Read the files listed below, plus all prior sprint reports, before writing code.

## Read-first list (in this order)

1. `specs/041-conversational-tuning/operational-rules.md`
2. `specs/041-conversational-tuning/vision.md`
3. `specs/041-conversational-tuning/concerns.md`
4. Sprint reports (skim §Goal + §Deliverables):
   - `sprint-01-evidence-and-schema-report.md`
   - `sprint-02-taxonomy-and-diagnostic-pipeline-report.md`
   - `sprint-03-tuning-surface-report.md`
   - `sprint-04-conversational-agent-report.md`
   - `sprint-05-v1-tail-report.md`
   - `sprint-07-ui-overhaul-report.md`
   - `sprint-07-expanded-scope-report.md`
   - `sprint-08-v2-foundations-report.md` (if it exists — sprint 08 may still be in progress)
5. `CLAUDE.md` (repo root).

## Branch

`feat/041-conversational-tuning`. Commit on top. **Do NOT merge to main. Do NOT push unless explicitly told.**

## Goal

Fix every critical bug, fill the system prompt context gaps, and resolve the worst performance issues identified in a full-system audit. This sprint is purely corrective — no new features.

## Non-goals

- **No new features.** No new pages, endpoints, or agent tools.
- **No V2 work.** No clustering, no DPO, no shadow eval.
- **No visual changes** beyond fixing the broken KnowledgeCard links and the diff-viewer truncation warning.
- **No pre-existing v5 component TS errors** (C22).

---

## Acceptance criteria

### 1. Fix pending count lie (agent sees wrong queue size)

**File:** `backend/src/tuning-agent/system-prompt.ts` and `backend/src/tuning-agent/runtime.ts`

The system prompt and `get_context` tool both report `pending.length` after a `take: 10` / `take: 8` query, hiding the real queue size.

- [ ] Add a separate `prisma.tuningSuggestion.count({ where: { tenantId, status: 'PENDING' } })` call.
- [ ] Pass the real count into the system prompt's `{p.total} pending suggestions` line.
- [ ] Fix `get_context` tool's `total` field to use the real count, not `items.length`.
- [ ] Keep the `take` limit on the detail array — only the count needs to be accurate.

### 2. Fix TOOL_CONFIG fallback to allTools[0]

**File:** `backend/src/tuning-agent/tools/suggestion-action.ts`

When the `beforeText` lookup fails for TOOL_CONFIG, the code falls back to `allTools[0]` — silently overwriting the wrong tool.

- [ ] Remove the `allTools[0]` fallback.
- [ ] Return an error result to the agent: `"Could not identify which tool to update. The beforeText did not match any existing tool description. Ask the manager to clarify which tool they mean."`.
- [ ] The agent can then ask the manager for clarification instead of corrupting data.

### 3. Add TOOL_CONFIG to cooldown/oscillation protection

**File:** `backend/src/tuning-agent/hooks/pre-tool-use.ts`

The `artifactTargetWhere` switch has no case for `TOOL_CONFIG`. This means TOOL_CONFIG applies have zero cooldown or oscillation protection.

- [ ] Add a case for `TOOL_CONFIG` in `artifactTargetWhere`. The target identifier should be the tool's ID or name (match whatever `propose_suggestion` uses as `targetHint` for TOOL_CONFIG).
- [ ] Add a case for `TOOL_CONFIG` in the oscillation detection block too.

### 4. Fix null confidence oscillation false positive

**File:** `backend/src/tuning-agent/hooks/pre-tool-use.ts`

When both the current and prior suggestion have `null` confidence (mapped to 0), `0 <= 0 * 1.25` evaluates to true, triggering a false oscillation block.

- [ ] Guard the oscillation comparison: if either confidence is null/undefined, skip the oscillation check entirely. Oscillation detection only makes sense when both suggestions have real confidence scores.

### 5. Add rollback compliance check

**File:** `backend/src/tuning-agent/hooks/pre-tool-use.ts`

The `rollback` tool writes to artifacts but has no compliance check. This violates the human-in-the-loop principle.

- [ ] Extend the `detectApplySanction` check (or a similar one) to the `rollback` tool name.
- [ ] The agent must have explicit manager sanction (e.g., "yes, roll that back" or "revert it") before rollback executes.
- [ ] Use the same `compliance.lastUserSanctionedApply` flag or add a parallel `lastUserSanctionedRollback`.

### 6. Fix compliance detection false positives

**File:** `backend/src/tuning-agent/hooks/pre-tool-use.ts`

The regex patterns `/\bconfirm\b/i` and `/\bapply\b/i` match in unrelated contexts ("Can you confirm what the SOP says?", "I need to apply for a visa").

- [ ] Tighten the patterns. Instead of single-word regex, look for intent phrases:
  - Apply: `/\bapply\s+(it|this|that|now|the\s+(change|suggestion|fix))\b/i`, `/\bgo\s+ahead\b/i`, `/\bdo\s+it\b/i`, `/\byes[,.]?\s*(apply|go|do)/i`, `/\bapply\s+now\b/i`
  - Confirm: `/\bconfirm\s+(the\s+)?(change|apply|rollback|revert|edit)\b/i`, `/\bthat'?s?\s+(right|correct|good)\b/i`
  - Keep the existing `/\byes\b/i` and `/\bapprove\b/i` — those are unambiguous.
- [ ] Add a negative test case for "Can you confirm what the SOP says?" — must NOT trigger sanction.
- [ ] Add a negative test case for "I need to apply for a visa" — must NOT trigger sanction.

### 7. Fix global model fallback (permanent degradation)

**File:** `backend/src/services/tuning/diagnostic.service.ts`

Once `fallBackToMini` is called, `_resolvedModel` is permanently set to the fallback for ALL tenants.

- [ ] Replace the permanent global with a TTL-based retry. After fallback, set a `_fallbackUntil = Date.now() + 5 * 60 * 1000` (5 minutes). On the next call after the TTL, try the primary model again.
- [ ] If the primary model succeeds after retry, clear the fallback state.
- [ ] Log each fallback and recovery event.

### 8. Fix accept endpoint race condition

**File:** `backend/src/controllers/tuning-suggestion.controller.ts`

Two concurrent accepts can both pass the PENDING check and double-apply artifacts.

- [ ] Wrap the accept handler's read-check-apply-update sequence in a `prisma.$transaction(async (tx) => { ... })` interactive transaction.
- [ ] Use `SELECT ... FOR UPDATE` semantics (Prisma interactive transactions handle this) so the second concurrent request blocks until the first completes, then sees `status: 'ACCEPTED'` and returns 409.
- [ ] Apply the same pattern to the reject handler.

### 9. Fix AUTO_SUPPRESSED suggestions being permanently stuck

**File:** `backend/src/controllers/tuning-suggestion.controller.ts`

Accept and reject both require `status === 'PENDING'`. AUTO_SUPPRESSED suggestions can never be resolved.

- [ ] Allow accept/reject on suggestions with `status === 'AUTO_SUPPRESSED'` as well as `'PENDING'`.
- [ ] In the accept handler, change the guard from `status !== 'PENDING'` to `!['PENDING', 'AUTO_SUPPRESSED'].includes(status)`.
- [ ] Same for the reject handler.

### 10. Fix SOP cooldown scoping (overly broad)

**File:** `backend/src/services/tuning/suggestion-writer.service.ts`

Cooldown for SOP_CONTENT and SOP_ROUTING scopes by `sopCategory` but not `sopStatus`. A suggestion for `check-in` at `CONFIRMED` blocks a different suggestion for `check-in` at `INQUIRY`.

- [ ] Add `sopStatus` to the cooldown query `where` clause for SOP categories.
- [ ] If the diagnostic result includes `sopStatus` in its target hint, use it. If not, skip the status filter (backwards compatible).

### 11. Fix stream bridge multi-text-block truncation

**File:** `backend/src/tuning-agent/stream-bridge.ts`

If the SDK produces text → tool_use → text, only the first text block gets a proper text-start. The second is silently dropped.

- [ ] Remove the `if (state.textBlockId) continue` guard, or better: increment a block counter and generate unique IDs like `text:${id}:1`, `text:${id}:2`, etc.
- [ ] On each new text block after a tool use, emit a fresh `text-start` + `text-delta` sequence.

### 12. Fix truncateForLog always producing invalid JSON

**File:** `backend/src/tuning-agent/hooks/post-tool-use.ts`

`JSON.parse(s.slice(0, 4000) + '..."TRUNCATED"')` always throws because slicing mid-JSON produces invalid syntax.

- [ ] Replace with: if the string is > 4000 chars, just store the raw truncated string (no JSON.parse). The log field accepts any JSON value — a truncated string is more useful than `{ note: 'unserializable' }`.
- [ ] Or: `JSON.parse(JSON.stringify(parsed).slice(0, 4000))` won't help either. Simplest fix: `typeof input === 'string' && input.length > 4000 ? input.slice(0, 4000) + '…[truncated]' : input`.

### 13. Fix agent page KnowledgeCard links

**File:** `frontend/app/tuning/agent/page.tsx`

All three KnowledgeCards link to `href="/"` instead of the actual SOP/FAQ/Tools pages.

- [ ] Find the correct routes for the SOP editor, FAQ editor, and Tools editor in the app. Check `frontend/app/` for the actual page paths.
- [ ] Update the `href` values to point to the correct pages (likely `/sops`, `/faq`, `/tools` or `/dashboard/sops`, etc.).

### 14. Add diff-viewer truncation warning

**File:** `frontend/components/tuning/diff-viewer.tsx`

The diff silently truncates at 1600 tokens. Long system prompts show incomplete diffs.

- [ ] When either input exceeds 1600 tokens, show a small warning banner above the diff: "Diff truncated to first 1,600 tokens for performance. Full text available in the editor."
- [ ] Style it with `TUNING_COLORS.warnBg` and `TUNING_COLORS.warnFg`, same as other warning banners.

### 15. Enrich the agent's system prompt with missing context

**File:** `backend/src/tuning-agent/system-prompt.ts`

Add the following sections to the static prefix (before the cache boundary), inside the existing `## Domain knowledge` or as a new `## Platform context` section:

- [ ] **SOP status lifecycle:** Explain DEFAULT (fallback), INQUIRY (pre-booking), PENDING (awaiting confirmation), CONFIRMED (booked), CHECKED_IN (in-property), CHECKED_OUT (departed). Each status has its own SOP variant. Property overrides layer on top of status variants.
- [ ] **Tool availability per status:** List which system tools are available at each reservation status (reference the table in CLAUDE.md).
- [ ] **Security rules:** "Never expose access codes (door codes, WiFi passwords) to INQUIRY-status guests. This is a hard safety rule, not a preference."
- [ ] **Escalation rules:** "The main AI uses keyword-based escalation signal detection. Common triggers include: complaints, threats, emergencies, legal mentions, payment disputes, safety concerns. The escalation-enrichment service scans messages for these signals."
- [ ] **Channel differences:** "Airbnb messages have length limits and no rich formatting. Booking.com messages go through their messaging API. WhatsApp supports media. Direct messages have no platform constraints."
- [ ] **Hold firm on NO_FIX:** "When you classify something as NO_FIX and the manager pushes back, hold your position unless they present new evidence. Do not flip to a different category just to be agreeable. Explain your reasoning again, referencing the specific evidence that led to NO_FIX."

### 16. Fix persistedDataParts not reset on session retry

**File:** `backend/src/tuning-agent/runtime.ts`

On session-not-found retry, `persistedDataParts` is not cleared. Data parts from the failed first attempt would be double-persisted.

- [ ] Add `persistedDataParts.length = 0` (or reassign to `[]`) in the retry path, alongside the existing `finalText = ''` and `toolCallsInvoked.length = 0` resets.

### 17. Add missing database indexes

**File:** `backend/prisma/schema.prisma`

- [ ] Add `@@index([tenantId, status, appliedAt(sort: Desc)])` on `TuningSuggestion` — needed by the cooldown query.
- [ ] Add `@@index([tenantId, criticalFailure, createdAt(sort: Desc)])` on `TuningSuggestion` — needed by graduation metrics (sprint 08).
- [ ] Add `@@index([tenantId, role, sentAt(sort: Desc)])` on `Message` — needed by dashboard coverage and graduation metrics queries.
- [ ] Run `npx prisma db push` to apply. Verify no destructive changes.

### 18. Performance: dashboard endpoints should use aggregation

**File:** `backend/src/controllers/tuning-dashboards.controller.ts`

The coverage and graduation metrics endpoints load entire message tables into memory.

- [ ] Replace the coverage endpoint's `findMany` + in-memory filtering with `prisma.message.count()` using appropriate `where` clauses. You need two counts: total AI messages and edited AI messages in each window.
- [ ] Replace the graduation metrics `findMany` for conversation count with `prisma.conversation.count()` using a subquery or `some` filter for conversations with at least one AI message.
- [ ] Keep the edit-magnitude average query — that one legitimately needs row-level data, but add `select: { editMagnitudeScore: true }` to minimize payload.

---

## Report

Write a report at `specs/041-conversational-tuning/sprint-09-production-hardening-report.md` following the same structure as prior sprint reports.

## Commit discipline

- One commit per logical unit. Imperative subjects.
- Co-author line: `Co-Authored-By: Claude <noreply@anthropic.com>`
- No squashing. No force-push. Do not push. Do not merge.
