# Socket.IO Event Contracts

## Connection

### Client → Server: Connect

```typescript
// Client connects with JWT auth
const socket = io(BACKEND_URL, {
  transports: ['websocket'],
  auth: { token: '<JWT>' },
});
```

### Server → Client: Connect Success

On successful connection, the server:
1. Verifies JWT, extracts `tenantId`
2. Joins socket to room `tenant:${tenantId}`
3. If `socket.recovered === true`, missed events were already replayed automatically
4. If `socket.recovered === false`, client should fetch current state via REST API

### Server → Client: Connect Error

```typescript
socket.on('connect_error', (err) => {
  // err.message: 'Authentication required' | 'Invalid token'
});
```

## Server → Client Events (All 15 Active Events)

All events are broadcast to `tenant:${tenantId}` room. Payload shapes are identical to the current SSE system.

### message
```json
{
  "conversationId": "string",
  "message": {
    "id": "string?",
    "role": "GUEST | HOST | AI | AI_PRIVATE | MANAGER_PRIVATE",
    "content": "string",
    "sentAt": "ISO 8601",
    "channel": "AIRBNB | BOOKING | WHATSAPP | DIRECT | OTHER",
    "imageUrls": "string[]"
  },
  "lastMessageRole": "string",
  "lastMessageAt": "ISO 8601"
}
```

### ai_typing_text
```json
{ "conversationId": "string", "delta": "string", "done": "boolean" }
```

### ai_typing_clear
```json
{ "conversationId": "string" }
```

### ai_suggestion
```json
{ "conversationId": "string", "suggestion": "string" }
```

### reservation_created
```json
{ "reservationId": "string" }
```

### reservation_updated
```json
{
  "reservationId": "string",
  "conversationIds": "string[]",
  "status": "string",
  "checkIn": "string?",
  "checkOut": "string?",
  "guestCount": "number?"
}
```

### ai_toggled
```json
{ "conversationId": "string", "aiEnabled": "boolean" }
```

### ai_mode_changed
```json
{ "conversationId": "string", "aiMode": "string" }
```

### conversation_starred
```json
{ "conversationId": "string", "starred": "boolean" }
```

### conversation_resolved
```json
{ "conversationId": "string", "status": "string" }
```

### property_ai_changed
```json
{ "propertyId": "string", "aiMode": "string" }
```

### task_updated
```json
{ "conversationId": "string", "task": "object" }
```

### new_task
```json
{ "conversationId": "string", "task": "object" }
```

### knowledge_suggestion
```json
{ "conversationId": "string" }
```

### knowledge_suggestion_updated
```json
{ "id": "string" }
```

## Removed Events

| Event | Reason |
|-------|--------|
| `ai_typing` | Dead — broadcast but never consumed by frontend |
| `connected` | Replaced by Socket.IO built-in `connect` event |
| `ping` | Replaced by Socket.IO built-in heartbeat/ping-pong |
