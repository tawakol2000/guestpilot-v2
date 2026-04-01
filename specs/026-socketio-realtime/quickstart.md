# Quickstart: Socket.IO Real-Time Messaging

## Prerequisites

- Backend running on Railway (or locally)
- Frontend running on Vercel (or locally)
- Redis available (for multi-instance support + connection state recovery)
- A tenant with active conversations

## Test 1: Instant Message Delivery (P1)

1. Open the GuestPilot inbox in your browser
2. Verify the connection status indicator shows "connected" (green dot)
3. Send a guest message through Hostaway
4. **Verify**: The message appears in the inbox within 1 second — no page refresh
5. **Verify**: The sidebar preview updates (last message, timestamp)
6. **Verify**: A notification sound plays for the guest message

## Test 2: AI Response Delivery

1. With autopilot on, send a guest message
2. **Verify**: Typing indicator appears
3. **Verify**: AI streaming text appears progressively
4. **Verify**: Final AI message appears in the conversation
5. All without any page refresh

## Test 3: Reconnection After Network Drop (P2)

1. Open the inbox
2. Open browser DevTools → Network → toggle "Offline" (or disconnect WiFi)
3. **Verify**: Connection status indicator changes to "disconnected" within 5 seconds
4. Send 2-3 guest messages through Hostaway while disconnected
5. Re-enable network
6. **Verify**: Status indicator changes to "reconnecting" then "connected"
7. **Verify**: All missed messages appear automatically in the correct order
8. **Verify**: A brief "Back online" notification appears

## Test 4: Reconnection After Server Deploy

1. Open the inbox
2. Deploy the backend (Railway redeploy or local server restart)
3. **Verify**: Status indicator shows "reconnecting"
4. **Verify**: Within 5 seconds, it shows "connected" again
5. Send a guest message
6. **Verify**: Message appears instantly — the reconnection recovered the session

## Test 5: Tab Backgrounding (Mobile/Desktop)

1. Open the inbox
2. Switch to another browser tab for 5+ minutes
3. During this time, send a guest message via Hostaway
4. Switch back to the GuestPilot tab
5. **Verify**: The message appears within 2 seconds of switching back (connection recovery)

## Test 6: Multi-Tenant Isolation

1. Open two browser windows with different tenant accounts
2. Send a guest message in tenant A's conversation
3. **Verify**: The message appears in tenant A's inbox
4. **Verify**: Tenant B's inbox shows NO new messages and NO activity

## Test 7: Connection Status Indicator (P3)

1. Open the inbox
2. **Verify**: Green "connected" indicator visible in the header
3. Go offline (DevTools or WiFi)
4. **Verify**: Indicator changes to yellow "reconnecting" or red "disconnected"
5. Go back online
6. **Verify**: Indicator returns to green "connected"
7. **Verify**: A brief toast says "Back online — messages synced"

## Test 8: Long Outage Fallback (>1 hour)

1. Open the inbox
2. Go offline for 61+ minutes (or simulate by restarting the server to clear the event buffer)
3. During this time, send several guest messages via Hostaway
4. Go back online
5. **Verify**: Socket.IO reconnects but state recovery fails (>1 hour buffer exceeded)
6. **Verify**: The client falls back to REST API fetch — all messages appear
7. **Verify**: No messages are lost

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/services/socket.service.ts` | Socket.IO server — replaces sse.service.ts |
| `backend/src/server.ts` | HTTP server creation + Socket.IO attach |
| `frontend/lib/socket.ts` | Socket.IO client singleton |
| `frontend/components/inbox-v5.tsx` | Event handlers (socket.on) |
| `frontend/components/ui/connection-status.tsx` | Connection status indicator |
