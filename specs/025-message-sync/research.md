# Research: Hostaway Message Sync

## R1: Hostaway Outgoing Message Webhook

**Decision**: Use polling (no webhook available)
**Rationale**: Hostaway supports only 3 webhook event types: `reservation.created`, `reservation.updated`, `message.received`. There is no `message.sent` or outgoing message webhook. A community feature request exists but has no timeline.
**Alternatives considered**:
- Wait for Hostaway to add webhook → No timeline, blocks the feature indefinitely
- Use polling via `GET /v1/conversations/{id}/messages` → Works, returns both incoming and outgoing messages with `isIncoming` flag

## R2: Hostaway API Rate Limits

**Decision**: Budget background sync at max 5 conversations per 2-minute cycle
**Rationale**: Rate limits are 15 req/10s per IP, 20 req/10s per account. All endpoints share the pool. Normal operations (webhook processing, message sending, reservation lookups) consume ~30-40 req/min. Background sync at 5 conv/2min = 2.5 req/min = ~3% of budget. Pre-response sync adds ~5 req/min. Total sync overhead: ~8% of budget, well under the 10% cap.
**Alternatives considered**:
- Aggressive polling (every 30s, all conversations) → Would consume 50%+ of rate budget
- On-demand only (no background sync) → Inbox would be stale, managers must manually refresh

## R3: Hostaway Messages Endpoint Capabilities

**Decision**: Fetch 100 messages per sync call, no pagination needed
**Rationale**: `GET /v1/conversations/{id}/messages?limit=100` returns up to 100 messages (both directions). No cursor/offset support. For sync purposes, 100 messages covers all recent activity. The AI only uses the last 10 messages for context, so missing very old messages has no practical impact.
**Alternatives considered**:
- Custom pagination loop → Hostaway doesn't support it, would require multiple calls with no offset param
- Smaller limit (20-50) → Might miss messages in very active conversations

## R4: Prisma Partial Unique Index

**Decision**: Use Prisma 5.22 `partialIndexes` preview feature with `@@unique(..., where: raw(...))`
**Rationale**: Prisma 5.22 supports partial unique indexes via the `partialIndexes` preview feature. The partial unique index `Message_conv_hostaway_msg_unique` already exists in the database from a prior raw SQL migration. Adding it to the Prisma schema formalizes it and prevents drift. Syntax: `@@unique([conversationId, hostawayMessageId], where: raw("\"hostawayMessageId\" != ''"))`.
**Alternatives considered**:
- Keep raw SQL only → Schema doesn't reflect reality, risk of loss on `db push --force-reset`
- Full unique constraint with placeholder IDs → Too invasive, requires migrating all empty `hostawayMessageId` values

## R5: SSE Broadcasting for Synced Messages

**Decision**: Reuse existing `message` SSE event type with identical payload shape
**Rationale**: The frontend already handles `message` events by appending to the conversation timeline, updating sidebar preview, and managing unread counts. Synced messages are structurally identical to webhook-received messages. Using the same event type means zero frontend changes for message display — only the sync indicator is new.
**Alternatives considered**:
- New `synced_message` event type → Would require new frontend handler, adds complexity for no benefit
- Batch event with multiple messages → Frontend processes one message at a time, would need refactoring

## R6: Background Job Pattern

**Decision**: Follow `aiDebounce.job.ts` pattern with `setInterval` in `server.ts`
**Rationale**: The project uses `setInterval`-based polling jobs registered in `server.ts`. The debounce job runs every 30s; the sync job will run every 120s (2 min). Both use the same factory pattern: `startXxxJob(prisma): NodeJS.Timeout`. This is consistent and understood. BullMQ is optional (Redis may not be available), so `setInterval` is the reliable path.
**Alternatives considered**:
- BullMQ repeatable job → Redis is optional, would need fallback anyway
- Cron library (node-cron) → New dependency for a simple interval

## R7: Retry Wrapper for Messages Endpoint

**Decision**: Add `retryWithBackoff` wrapper to `listConversationMessages()` call
**Rationale**: The existing `hostaway.service.ts` has a `retryWithBackoff` utility (3 attempts, exponential backoff) used by `sendMessageToConversation`, `getReservation`, etc. But `listConversationMessages` currently calls `client.get()` directly without retry. Since sync runs frequently and Hostaway may occasionally 429, adding retry is essential.
**Alternatives considered**:
- No retry (fail fast) → Would cause unnecessary sync failures on transient rate limit hits
- Custom retry specific to sync → Unnecessary when existing utility works

## R8: Host-Already-Responded Detection

**Decision**: After sync, check if the latest non-GUEST message is HOST and occurred after the pending guest messages
**Rationale**: When a manager responds directly through Hostaway, the sync discovers their HOST message. If this HOST message's timestamp is after the last GUEST message that triggered the AI reply, the manager already handled it. The AI reply should be cancelled (both autopilot and copilot). This prevents duplicate/contradictory responses.
**Alternatives considered**:
- Only cancel if HOST message explicitly "answers" the guest (content analysis) → Too complex, fragile
- Never auto-cancel, always let AI respond → Defeats the purpose of the feature
- Cancel only in autopilot, still generate copilot suggestion → User clarified: cancel in all modes
