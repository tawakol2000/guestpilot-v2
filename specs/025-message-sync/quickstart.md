# Quickstart: Hostaway Message Sync

## Testing the Feature

### Prerequisite

- A tenant with Hostaway credentials configured
- At least one active conversation (CONFIRMED or CHECKED_IN reservation)
- Access to the Hostaway dashboard for that tenant

### Test 1: Pre-Response Sync (P1 — Core Feature)

1. Open the Hostaway dashboard
2. Find an active conversation with a guest
3. Send a message as the host directly through Hostaway (e.g., "Hi, your early check-in is confirmed for 1pm")
4. Now send a guest message through GuestPilot's sandbox chat or via Hostaway (simulating the guest replying "Great, thank you! What's the door code?")
5. Wait for the AI to respond
6. **Verify**: The AI's response should acknowledge the manager's earlier message about early check-in, not re-introduce the topic

### Test 2: Manager Already Responded (P1 — Cancel AI)

1. Send a guest message through GuestPilot
2. Before the AI responds (within the debounce window), quickly switch to Hostaway dashboard and reply as the manager
3. **Verify**: The AI reply should be cancelled — no AI response sent, no copilot suggestion generated
4. **Verify**: The manager's message appears in the GuestPilot inbox with correct HOST attribution

### Test 3: Background Sync (P2)

1. Open the GuestPilot inbox to an active conversation
2. Switch to Hostaway and send a host message in that conversation
3. Wait up to 2 minutes (background sync interval)
4. **Verify**: The message appears in the GuestPilot inbox timeline without any manual refresh
5. **Verify**: The sidebar preview updates with the new message

### Test 4: On-Demand Sync (P3)

1. Send a host message through Hostaway in a conversation you haven't opened in GuestPilot yet
2. Open that conversation in GuestPilot
3. **Verify**: The message appears within 2 seconds of opening
4. **Verify**: The circular sync indicator is visible and shows a countdown

### Test 5: Sync Indicator Click (P3)

1. While viewing a conversation, click the circular sync indicator
2. **Verify**: An immediate sync triggers (the indicator animates/refreshes)
3. **Verify**: Any new messages from Hostaway appear in the timeline

### Test 6: Deduplication

1. Send a guest message → let the AI respond in autopilot mode
2. Check the conversation in GuestPilot — the AI's message should show with role AI
3. Trigger a manual sync (click indicator)
4. **Verify**: No duplicate of the AI message appears — the sync correctly identifies it via `hostawayMessageId`

### Test 7: Graceful Failure

1. Temporarily break Hostaway credentials (change API key to invalid)
2. Send a guest message
3. **Verify**: The AI still responds (using local messages only)
4. **Verify**: A sync failure is logged but does not block the response
5. Restore credentials

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/services/message-sync.service.ts` | Core sync logic — single function all triggers call |
| `backend/src/jobs/messageSync.job.ts` | Background sync polling (every 2 min) |
| `backend/src/services/ai.service.ts` | Pre-response sync injection point |
| `backend/src/controllers/conversations.controller.ts` | `POST /:id/sync` endpoint |
| `backend/prisma/schema.prisma` | `lastSyncedAt` field, partial unique index |
| `frontend/components/ui/sync-indicator.tsx` | Circular countdown indicator |
| `frontend/components/inbox-v5.tsx` | Sync indicator integration, SSE handling |
