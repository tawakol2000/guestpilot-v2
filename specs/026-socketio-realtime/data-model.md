# Data Model: Socket.IO Real-Time Messaging

## Schema Changes

**None.** This feature replaces the transport layer (SSE → Socket.IO) without changing the database schema. No new models, fields, or indexes.

## Runtime Entities (In-Memory / Redis)

### Socket Connection

Managed by Socket.IO — not persisted in the database.

| Property | Type | Purpose |
|----------|------|---------|
| `socket.id` | string | Unique connection identifier (auto-generated) |
| `socket.data.tenantId` | string | Tenant from JWT, set by auth middleware |
| `socket.data.userId` | string | User ID from JWT |
| `socket.rooms` | Set<string> | Rooms this socket belongs to (auto-managed) |

### Tenant Room

Logical grouping of connections for broadcast isolation.

| Property | Type | Purpose |
|----------|------|---------|
| Room name | `tenant:${tenantId}` | All sockets for a tenant join this room on connection |
| Members | Set<Socket> | Auto-managed by Socket.IO — sockets leave on disconnect |

### Event Buffer (Connection State Recovery)

Managed by Socket.IO + Redis Streams adapter. Not custom code.

| Property | Type | Purpose |
|----------|------|---------|
| Stream key | `socket.io:stream:*` | Redis Streams keys used by the adapter |
| Retention | 10 minutes | `maxDisconnectionDuration` config |
| Content | Serialized events | All events broadcast during the retention window |

### Event Catalog (Unchanged)

All 16 existing event types are preserved with identical payload structures:

| Event | Payload Shape | Direction |
|-------|--------------|-----------|
| `message` | `{ conversationId, message: { id?, role, content, sentAt, channel, imageUrls }, lastMessageRole, lastMessageAt }` | Server → Client |
| `ai_typing_text` | `{ conversationId, delta, done }` | Server → Client |
| `ai_typing_clear` | `{ conversationId }` | Server → Client |
| `ai_suggestion` | `{ conversationId, suggestion }` | Server → Client |
| `reservation_created` | `{ reservationId }` | Server → Client |
| `reservation_updated` | `{ reservationId, conversationIds, status, checkIn?, checkOut?, guestCount? }` | Server → Client |
| `ai_toggled` | `{ conversationId, aiEnabled }` | Server → Client |
| `ai_mode_changed` | `{ conversationId, aiMode }` | Server → Client |
| `conversation_starred` | `{ conversationId, starred }` | Server → Client |
| `conversation_resolved` | `{ conversationId, status }` | Server → Client |
| `property_ai_changed` | `{ propertyId, aiMode }` | Server → Client |
| `task_updated` | `{ conversationId, task }` | Server → Client |
| `new_task` | `{ conversationId, task }` | Server → Client |
| `knowledge_suggestion` | `{ conversationId }` | Server → Client |
| `knowledge_suggestion_updated` | `{ id }` | Server → Client |
| `ping` | `{}` | Replaced by Socket.IO built-in heartbeat |

**Removed**: `ai_typing` (dead event — broadcast but never consumed), `connected` (replaced by Socket.IO `connect` event), `ping` (replaced by Socket.IO built-in heartbeat).
