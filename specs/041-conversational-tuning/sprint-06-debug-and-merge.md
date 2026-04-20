# Sprint 06 — Debug & Verify

> **You are a fresh Claude Code session with no memory of prior work.** This is a short debug + test session, not a feature sprint. **Do NOT merge to main. Do NOT push.**

## Read-first list

1. `specs/041-conversational-tuning/operational-rules.md`
2. `specs/041-conversational-tuning/sprint-05-v1-tail-report.md` — **read every section**, especially §2 (deviations), §4 (prompt-cache), §5 (browser click-through), §8 (merge strategy), §9 (deploy plan), §12 (test results), §14 (what's left).
3. `specs/041-conversational-tuning/concerns.md`
4. `CLAUDE.md` (repo root)

## Branch

`feat/041-conversational-tuning`. 40 commits. This session may add 1-3 fix commits on top. Do not squash.

## Goal

Three things, in order:

### 1. Investigate and fix the chat message duplication bug

Sprint 05's browser screenshot shows the agent's proactive opener rendered **twice, verbatim** — the full response text + tool chips + markdown table all appear doubled in the chat panel. This is either:

- (a) A stream-bridge bug: `stream-bridge.ts` emits parts during the live stream AND `onFinish` persists them into `TuningMessage.parts`, then `useChat`'s `initialMessages` rehydration re-adds the same parts on the next render cycle.
- (b) A `useChat` double-render: React 19 strict mode double-mounts in dev, causing two SSE subscriptions.
- (c) A message-persistence bug: two `TuningMessage` rows written for the same assistant turn.

**Investigation steps:**

1. Read `backend/src/tuning-agent/stream-bridge.ts` — trace how assistant parts flow from the SDK generator into the Vercel AI SDK's `UIMessageStream`. Check if parts are emitted once (live) and also re-emitted on stream close.
2. Read `backend/src/controllers/tuning-chat.controller.ts` — check how `onFinish` persists assistant messages. Is there a path where the same parts get written twice?
3. Read `frontend/components/tuning/chat-panel.tsx` — check how `initialMessages` (from rehydration) and live-streamed messages merge. Is there a dedup guard?
4. Read `frontend/components/tuning/chat-parts.tsx` — check if the parts renderer has a key collision that could cause React to double-mount.
5. Query the `TuningMessage` table for a conversation that shows the duplication: `SELECT id, role, parts FROM "TuningMessage" WHERE "conversationId" = '<id>' ORDER BY "createdAt"`. If two assistant rows exist for one turn, the bug is backend. If one row exists with doubled parts, the bug is in the persist logic. If one row with correct parts, the bug is frontend rehydration.

**Fix it if you find it.** Commit with `fix(041): prevent duplicate assistant message rendering in chat panel`.

**If the duplication only happens in dev mode** (React strict mode double-mount) and not in production build (`next build && next start`), document it as a dev-only artifact and move on — production is what matters.

### 2. Run the full test + build suite

After any fixes, run everything and confirm green:

```bash
# Backend
cd backend && npx tsc --noEmit
cd backend && npm run build
cd backend && npx tsx --test src/services/tuning/__tests__/*.test.ts src/tuning-agent/__tests__/*.test.ts
cd backend && npx tsx --test src/__tests__/integration/*.test.ts

# Frontend
cd frontend && npx next build

# Route smokes
cd backend && npx tsx scripts/test-041-routes.ts
cd backend && npx tsx scripts/test-041-sprint-04-routes.ts
```

Report every result. If anything fails, fix it and commit the fix.

### 3. Stay on the feature branch

**Do NOT merge to main. Do NOT push.** The merge will happen later at Abdelrahman's discretion.

## What to report back

Write a short summary (not a full report) to stdout:

1. Chat duplication: root cause + fix (or "dev-only artifact").
2. Test suite: all pass / failures + fixes.
3. Any other bugs found during investigation.

## Rules

- Do NOT add features.
- Do NOT refactor anything unrelated to the duplication bug.
- Do NOT merge to main. Do NOT push.
- Commit fixes on `feat/041-conversational-tuning` with `fix(041):` prefix.
